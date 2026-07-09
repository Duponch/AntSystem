// Rendu des fourmis 100 % GPU-driven :
//
//   VAT (cycle de marche baké, voir vat.js)
//   + LOD à 3 niveaux (plein / décimé / silhouette) par clustering
//   + frustum culling PAR FOURMI et classement par distance dans un compute
//   + draws INDIRECTS : le compute écrit les instanceCount, compacte les
//     listes d'indices — le CPU n'apprend jamais combien de fourmis se
//     dessinent, il n'y a ni readback ni réallocation.
//
// Chaque mesh LOD k lit son record indirect (5 × u32 à l'octet k*20) et
// remappe instanceIndex (slot compacté, firstInstance=0) → id de fourmi via
// la liste lodList[k*MAX + slot].
//
// CASTES : mêmes hashs et uniforms que le kernel (sim.casteOf) — couleur et
// gabarit par caste, REINE (index 0) rendue par un mesh dédié hors pipeline
// LOD (échelle libre, anim propre, jamais cullée par erreur).
// SOUTERRAIN : le bit 3 d'antState fait lire la profondeur du plancher dans
// la carte du layout — grain porté, halo, hitbox et cônes en héritent.

import * as THREE from 'three/webgpu';
import {
	Fn, If, instanceIndex, uniform, varyingProperty, storage, instancedArray,
	attribute, positionLocal, cameraPosition,
	vec2, vec3, vec4, mat3, float, int, ivec2, uint,
	cos, sin, fract, floor, mix, hash, select, min, abs, normalize, cross, smoothstep, uv,
	textureLoad, atomicAdd, atomicStore, atomicLoad, clamp,
} from 'three/tsl';

import { loadAntVAT, buildLodGeometry } from './vat.js';
import { GRID, WORLD, MAX_ANTS, params, gfx } from './config.js';

const LOD_DIST = [ 16, 42 ];          // limites LOD0→1 et LOD1→2 (unités monde)
const CULL_MARGIN = 1.6;              // rayon de sécurité autour d'une fourmi

export async function createAnts( sim ) {

	const vat = await loadAntVAT( '/AntRigged.glb', { frames: 20, targetLength: 0.95 } );
	const layout = sim.layout;
	const depthSize = layout.depthTexture.image.width;

	// trois niveaux de détail partageant la MÊME texture d'animation
	const lod1 = buildLodGeometry( vat, 0.045 );
	const lod2 = buildLodGeometry( vat, 0.13 );
	const lodGeos = [ vat.geometry, lod1.geometry, lod2.geometry ];
	console.info(
		`AntSystem LOD : ${vat.geometry.index.count / 3} / ${lod1.triangles} / ${lod2.triangles} triangles`,
	);

	// ------------------------------------------------------------------
	// Buffers du pilotage GPU
	// ------------------------------------------------------------------
	// records indirects : [indexCount, instanceCount, firstIndex, baseVertex, firstInstance] × 3
	const indirectArray = new Uint32Array( 15 );
	for ( let k = 0; k < 3; k ++ ) indirectArray[ k * 5 ] = lodGeos[ k ].index.count;
	const indirectAttr = new THREE.IndirectStorageBufferAttribute( indirectArray, 1 );

	const indirectNode = storage( indirectAttr, 'uint', 15 ).toAtomic();
	const lodList = instancedArray( 3 * MAX_ANTS, 'uint' );

	// uniforms de classement (mis à jour chaque frame depuis la caméra)
	const u = {
		view: uniform( new THREE.Matrix4() ),
		tanX: uniform( 1 ),
		tanY: uniform( 1 ),
		far: uniform( 400 ),
		lod0: uniform( gfx.lodDist0 || LOD_DIST[ 0 ] ),
		lod1: uniform( gfx.lodDist1 || LOD_DIST[ 1 ] ),
		budget0: uniform( gfx.lodBudget ),        // plein détail max
		budget1: uniform( gfx.lodBudget * 4 ),    // LOD intermédiaire max
	};

	const uPhase = uniform( 0 );
	// vue souterraine ouverte (0..1) : fermée, les souterraines sont SAUTÉES
	// par le classement (invisibles sous le sol opaque : ni VAT ni ombres)
	const uReveal = uniform( 0 );
	let phaseAcc = 0;

	const texel = WORLD / GRID;
	const framesF = float( vat.frames );

	// --- état packé : masquer les bits hauts avant toute comparaison ---
	const stateOf = ( antId ) => sim.antState.element( antId ).bitAnd( uint( 7 ) );
	const underOf = ( antId ) => sim.antState.element( antId ).bitAnd( uint( 8 ) ).notEqual( uint( 0 ) );

	// profondeur du plancher souterrain au point (texels grille)
	const floorDepth = ( gp ) => {

		const lc = clamp(
			ivec2( gp.sub( vec2( layout.origin.x, layout.origin.y ) ) ),
			ivec2( 0 ), ivec2( depthSize - 1 ),
		);
		return textureLoad( layout.depthTexture, lc ).x;

	};

	// gabarit par caste (mêmes hashs que le kernel — reine hors pipeline)
	const casteScale = ( antId ) => {

		const { isNurse, isSoldier, isScout } = sim.casteOf( antId );
		return select( isSoldier, float( 1.45 ),
			select( isNurse, float( 0.85 ),
				select( isScout, float( 0.92 ), float( 1 ) ) ) );

	};

	// id de caste pour la teinte (0 ouvrière, 1 soldate, 2 nourrice, 3 éclaireuse)
	const casteId = ( antId ) => {

		const { isNurse, isSoldier, isScout } = sim.casteOf( antId );
		return select( isSoldier, float( 1 ),
			select( isNurse, float( 2 ),
				select( isScout, float( 3 ), float( 0 ) ) ) );

	};

	// ------------------------------------------------------------------
	// Kernels : remise à zéro des compteurs puis classement/compaction
	// ------------------------------------------------------------------
	const kReset = Fn( () => {

		atomicStore( indirectNode.element( instanceIndex.mul( 5 ).add( 1 ) ), uint( 0 ) );

	} )().compute( 3 );

	const kClassify = Fn( () => {

		If( instanceIndex.toFloat().lessThan( sim.u.antCount ), () => {

			// la reine (index 0, colonie active) a son mesh dédié
			const isQueenSlot = sim.u.colonyOn.greaterThan( 0.5 ).and( instanceIndex.equal( uint( 0 ) ) );
			const under = underOf( instanceIndex );
			// vue fermée → les souterraines sont invisibles sous le sol opaque
			const hidden = under.and( uReveal.lessThan( 0.01 ) );

			If( isQueenSlot.not().and( hidden.not() ), () => {

				const a = sim.antData.element( instanceIndex );
				const y = select( under, floorDepth( a.xy ), float( 0 ) );
				const world = vec3(
					a.x.mul( texel ).sub( WORLD / 2 ),
					y.add( 0.3 ),
					a.y.mul( texel ).sub( WORLD / 2 ),
				);

				// test de frustum en espace vue (marge = rayon d'une fourmi)
				const v = u.view.mul( vec4( world, 1 ) );
				const depth = v.z.negate();
				const visible = depth.greaterThan( - CULL_MARGIN )
					.and( depth.lessThan( u.far ) )
					.and( abs( v.x ).lessThan( depth.mul( u.tanX ).add( CULL_MARGIN ) ) )
					.and( abs( v.y ).lessThan( depth.mul( u.tanY ).add( CULL_MARGIN ) ) );

				If( visible, () => {

					// niveau souhaité par distance, puis RÉTROGRADATION si le budget
					// du niveau est plein : le pire cas reste borné quel que soit le zoom
					const lodV = select( depth.lessThan( u.lod0 ), uint( 0 ),
						select( depth.lessThan( u.lod1 ), uint( 1 ), uint( 2 ) ) ).toVar();
					const placed = uint( 0 ).toVar();

					If( lodV.equal( uint( 0 ) ), () => {

						const s = atomicAdd( indirectNode.element( uint( 1 ) ), uint( 1 ) ).toVar();

						If( s.toFloat().lessThan( u.budget0 ), () => {

							lodList.element( s ).assign( instanceIndex );
							placed.assign( uint( 1 ) );

						} ).Else( () => {

							lodV.assign( uint( 1 ) );

						} );

					} );

					If( placed.equal( uint( 0 ) ).and( lodV.equal( uint( 1 ) ) ), () => {

						const s = atomicAdd( indirectNode.element( uint( 6 ) ), uint( 1 ) ).toVar();

						If( s.toFloat().lessThan( u.budget1 ), () => {

							lodList.element( uint( MAX_ANTS ).add( s ) ).assign( instanceIndex );
							placed.assign( uint( 1 ) );

						} );

					} );

					If( placed.equal( uint( 0 ) ), () => {

						const s = atomicAdd( indirectNode.element( uint( 11 ) ), uint( 1 ) ).toVar();
						lodList.element( uint( MAX_ANTS * 2 ).add( s ) ).assign( instanceIndex );

					} );

				} );

			} );

		} );

	} )().compute( MAX_ANTS );

	// les compteurs dépassent les budgets (les fourmis en trop sont replacées
	// ailleurs) : on tronque les instanceCount avant le draw
	const kFinalize = Fn( () => {

		const word = instanceIndex.mul( 5 ).add( 1 );
		const budget = select( instanceIndex.equal( uint( 0 ) ), u.budget0, u.budget1 );
		const count = atomicLoad( indirectNode.element( word ) ).toVar();
		atomicStore( indirectNode.element( word ), min( count.toFloat(), budget ).toUint() );

	} )().compute( 2 );

	// ------------------------------------------------------------------
	// Transformation d'une fourmi (partagée corps/grain/halo/hitbox) —
	// une souterraine est posée sur le plancher de sa galerie
	// ------------------------------------------------------------------
	const antTransform = ( antId ) => {

		const a = sim.antData.element( antId );
		const gp = a.xy;
		const angle = a.z;

		const yaw = float( Math.PI / 2 ).sub( angle );
		const c = cos( yaw );
		const s = sin( yaw );
		const rot = mat3(
			vec3( c, 0, s.negate() ),
			vec3( 0, 1, 0 ),
			vec3( s, 0, c ),
		);

		const y = select( underOf( antId ), floorDepth( gp ).add( 0.04 ), float( 0 ) );

		const world = vec3(
			gp.x.mul( texel ).sub( WORLD / 2 ),
			y,
			gp.y.mul( texel ).sub( WORLD / 2 ),
		);

		return { rot, world };

	};

	// ------------------------------------------------------------------
	// Corps : 3 meshes indirects (matériaux jumeaux → même pipeline en cache)
	// ------------------------------------------------------------------
	const uBodyColor = uniform( new THREE.Color( gfx.antColor ) );
	const uAccentColor = uniform( new THREE.Color( gfx.antAccentColor ) );
	const uSoldierColor = uniform( new THREE.Color( gfx.soldierColor ) );
	const uNurseColor = uniform( new THREE.Color( gfx.nurseColor ) );
	const uScoutColor = uniform( new THREE.Color( gfx.scoutColor ) );
	const uQueenColor = uniform( new THREE.Color( gfx.queenColor ) );

	// animMode : 0 = interpolation lisse, 1 = frame la plus proche (toujours
	// animée, sans mélange), 2 = pose figée (au-delà de la distance d'animation,
	// une fourmi fait ~3 px : invisible, et moitié moins de lectures de texture)
	function makeBodyMaterial( lodBase, animMode ) {

		const material = new THREE.MeshStandardNodeMaterial( { roughness: 0.6, metalness: 0.0 } );
		const base = uniform( lodBase );

		material.positionNode = Fn( () => {

			const antId = lodList.element( base.toUint().add( instanceIndex ) );
			const { rot, world } = antTransform( antId );

			const vatIdx = attribute( 'vatIndex', 'float' ).toInt();
			varyingProperty( 'float', 'vAntAccent' ).assign(
				select( vatIdx.lessThan( int( vat.counts[ 0 ] ) ), 0, 1 ),
			);

			// caste : gabarit + teinte propres (mêmes hashs que la simulation)
			const bodyScale = casteScale( antId );
			varyingProperty( 'float', 'vCaste' ).assign( casteId( antId ) );

			let animated;

			if ( animMode === 2 ) {

				animated = textureLoad( vat.texture, ivec2( vatIdx, int( 0 ) ) ).xyz;

			} else {

				// phase de marche accumulée + décalage par fourmi
				const cycle = uPhase.add( hash( antId.add( uint( 1013 ) ) ) );
				const ff = fract( cycle ).mul( framesF );
				const f0 = floor( ff ).toInt();

				if ( animMode === 1 ) {

					animated = textureLoad( vat.texture, ivec2( vatIdx, f0 ) ).xyz;

				} else {

					const f1 = f0.add( 1 ).mod( int( vat.frames ) );
					const w = fract( ff );
					const p0 = textureLoad( vat.texture, ivec2( vatIdx, f0 ) ).xyz;
					const p1 = textureLoad( vat.texture, ivec2( vatIdx, f1 ) ).xyz;
					animated = mix( p0, p1, w );

				}

			}

			// envenimation : la marche se fige progressivement (paralysie) ; un
			// varying porte la charge de venin (0..1) pour teinter le corps
			const venom = sim.antVital.element( antId ).x.clamp( 0, 1 );
			animated = mix( animated, textureLoad( vat.texture, ivec2( vatIdx, int( 0 ) ) ).xyz, venom );
			varyingProperty( 'float', 'vVenom' ).assign( venom );

			// cadavre (état 2) : pose figée retournée sur le dos, posée au sol
			const state = stateOf( antId );
			const dead = state.equal( uint( 2 ) );
			varyingProperty( 'float', 'vDead' ).assign( select( dead, 1, 0 ) );

			// dévorée (état 3) : le cadavre a été mangé → sommet dégénéré, invisible
			const consumed = state.equal( uint( 3 ) );

			const local = animated.mul( bodyScale ).mul( select( consumed, float( 0 ), float( 1 ) ) ).toVar();

			If( dead, () => {

				const rest = textureLoad( vat.texture, ivec2( vatIdx, int( 0 ) ) ).xyz.mul( bodyScale );
				// roulis de π autour de l'axe avant : (x,y) → (−x,−y), puis relevé
				// de la hauteur du corps pour reposer sur le dos, pattes en l'air
				local.assign( vec3(
					rest.x.negate(),
					rest.y.negate().add( float( vat.bounds.height ).mul( bodyScale ) ),
					rest.z,
				) );

			} );

			return rot.mul( local ).add( world );

		} )();

		material.colorNode = Fn( () => {

			const caste = varyingProperty( 'float', 'vCaste' );
			// teinte par caste (mélange doux pour garder la matière commune)
			const body = mix( vec3( uBodyColor ), vec3( uSoldierColor ),
				clamp( float( 1 ).sub( abs( caste.sub( 1 ) ) ), 0, 1 ).mul( 0.85 ) ).toVar();
			body.assign( mix( body, vec3( uNurseColor ),
				clamp( float( 1 ).sub( abs( caste.sub( 2 ) ) ), 0, 1 ).mul( 0.8 ) ) );
			body.assign( mix( body, vec3( uScoutColor ),
				clamp( float( 1 ).sub( abs( caste.sub( 3 ) ) ), 0, 1 ).mul( 0.8 ) ) );

			const col = mix( body, vec3( uAccentColor ), varyingProperty( 'float', 'vAntAccent' ) ).toVar();
			// envenimée : teinte blafarde proportionnelle à la charge de venin
			col.assign( mix( col, vec3( 0.55, 0.78, 0.66 ), varyingProperty( 'float', 'vVenom' ).mul( 0.7 ) ) );
			// cadavre : couleur assombrie / grisée
			return col.mul( mix( float( 1 ), float( 0.5 ), varyingProperty( 'float', 'vDead' ) ) );

		} )();

		return material;

	}

	const group = new THREE.Group();
	const bodies = [];

	for ( let k = 0; k < 3; k ++ ) {

		const igeo = new THREE.InstancedBufferGeometry();
		igeo.index = lodGeos[ k ].index;
		igeo.attributes = lodGeos[ k ].attributes;
		igeo.instanceCount = 1;                       // le vrai compte vit sur GPU
		igeo.setIndirect( indirectAttr, k * 20 );     // offset en octets

		const mesh = new THREE.Mesh( igeo, makeBodyMaterial( k * MAX_ANTS, k ) );
		mesh.frustumCulled = false;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		group.add( mesh );
		bodies.push( mesh );

	}

	// ------------------------------------------------------------------
	// LA REINE : mesh dédié hors pipeline LOD (1 « instance », échelle libre,
	// anim ralentie — pas de patinage — et jamais de rétrogradation LOD).
	// Gaster allongé (physogastrie) : échelle non uniforme sur l'axe du corps.
	// ------------------------------------------------------------------
	const uQueenScale = uniform( gfx.queenScale );

	const queenMat = new THREE.MeshStandardNodeMaterial( { roughness: 0.5, metalness: 0.0 } );

	queenMat.positionNode = Fn( () => {

		const { rot, world } = antTransform( uint( 0 ) );

		const vatIdx = attribute( 'vatIndex', 'float' ).toInt();
		varyingProperty( 'float', 'vQAccent' ).assign(
			select( vatIdx.lessThan( int( vat.counts[ 0 ] ) ), 0, 1 ),
		);

		// démarche lente : cadence divisée par le gabarit (pas de patinage)
		const cycle = uPhase.div( uQueenScale ).mul( 0.55 );
		const ff = fract( cycle ).mul( framesF );
		const f0 = floor( ff ).toInt();
		const f1 = f0.add( 1 ).mod( int( vat.frames ) );
		const p0 = textureLoad( vat.texture, ivec2( vatIdx, f0 ) ).xyz;
		const p1 = textureLoad( vat.texture, ivec2( vatIdx, f1 ) ).xyz;
		const animated = mix( p0, p1, fract( ff ) );

		// gabarit royal : corps élargi, gaster étiré vers l'arrière (−z)
		const stretch = clamp( positionLocal.z.negate().mul( 2 ), 0, 1 );
		const local = animated.mul( uQueenScale )
			.mul( vec3( 1.05, 1.05, float( 1 ).add( stretch.mul( 0.5 ) ) ) );

		// masquée si la colonie est coupée (l'index 0 redevient une ouvrière)
		const on = sim.u.colonyOn;

		return rot.mul( local.mul( on ) ).add( world );

	} )();

	queenMat.colorNode = Fn( () => {

		return mix( vec3( uQueenColor ), vec3( uAccentColor ), varyingProperty( 'float', 'vQAccent' ) );

	} )();

	const queen = new THREE.Mesh( vat.geometry, queenMat );
	queen.frustumCulled = false;
	queen.castShadow = true;
	queen.visible = !! params.colony;
	group.add( queen );

	// ------------------------------------------------------------------
	// Grain porté + halo luciole (géométrie triviale : pilotés par antCount)
	// ------------------------------------------------------------------
	const grainGeo = new THREE.InstancedBufferGeometry();
	const ico = new THREE.IcosahedronGeometry( 0.1, 0 );
	grainGeo.index = ico.index;
	grainGeo.attributes = ico.attributes;
	grainGeo.instanceCount = params.antCount;

	const grainMat = new THREE.MeshStandardNodeMaterial( {
		color: new THREE.Color( gfx.foodColor ),
		emissive: new THREE.Color( gfx.foodColor ),
		emissiveIntensity: 2.2,
		roughness: 0.4,
	} );

	grainMat.positionNode = Fn( () => {

		const { rot, world } = antTransform( instanceIndex );
		const carrying = select( stateOf( instanceIndex ).equal( uint( 1 ) ), float( 1 ), float( 0 ) );
		// grain caché avec sa porteuse : souterraine + vue fermée
		const hidden = underOf( instanceIndex ).and( uReveal.lessThan( 0.01 ) );
		const show = carrying.mul( select( hidden, float( 0 ), float( 1 ) ) );
		const bodyScale = casteScale( instanceIndex );
		const offset = rot.mul( vec3( 0, vat.bounds.height * 0.62, vat.bounds.headZ * 0.9 ).mul( bodyScale ) );

		return positionLocal.mul( show ).add( offset ).add( world );

	} )();

	const grain = new THREE.Mesh( grainGeo, grainMat );
	grain.frustumCulled = false;

	const uGrainHalo = uniform( gfx.haloSize );
	const uGrainHaloIntensity = uniform( gfx.haloIntensity );
	const uHaloColor = uniform( grainMat.emissive );

	const haloGeo = new THREE.InstancedBufferGeometry();
	const haloQuad = new THREE.PlaneGeometry( 1, 1 );
	haloGeo.index = haloQuad.index;
	haloGeo.attributes = haloQuad.attributes;
	haloGeo.instanceCount = params.antCount;

	const haloMat = new THREE.MeshBasicNodeMaterial( {
		transparent: true,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
		toneMapped: false,
		fog: false,
	} );

	haloMat.positionNode = Fn( () => {

		const { rot, world } = antTransform( instanceIndex );
		const carrying = select( stateOf( instanceIndex ).equal( uint( 1 ) ), float( 1 ), float( 0 ) );
		const hidden = underOf( instanceIndex ).and( uReveal.lessThan( 0.01 ) );
		const show = carrying.mul( select( hidden, float( 0 ), float( 1 ) ) );
		const center = rot.mul( vec3( 0, vat.bounds.height * 0.62, vat.bounds.headZ * 0.9 ) ).add( world );

		const view = normalize( cameraPosition.sub( center ) );
		const right = normalize( cross( vec3( 0, 1, 0 ), view ) );
		const up = cross( view, right );
		const size = show.mul( 0.9 ).mul( uGrainHalo );

		return center
			.add( right.mul( positionLocal.x.mul( size ) ) )
			.add( up.mul( positionLocal.y.mul( size ) ) );

	} )();

	haloMat.colorNode = Fn( () => {

		const d = uv().sub( vec2( 0.5, 0.5 ) ).length().mul( 2 );
		const glow = smoothstep( 1, 0, d ).pow( 2.2 );
		return uHaloColor.mul( glow ).mul( uGrainHaloIntensity ).mul( 0.5 );

	} )();

	const grainHalo = new THREE.Mesh( haloGeo, haloMat );
	grainHalo.frustumCulled = false;

	// hitbox de DÉBOGAGE : sphère cyan translucide sur le corps de chaque fourmi.
	// Avec la sphère jaune de l'araignée, permet de VOIR si, au moment de la morsure,
	// le corps de la fourmi touche bien celui de l'araignée (et pas une patte avant).
	// Masquée pour les fourmis dévorées (état 3).
	const uAntHitR = uniform( params.antRadius );
	const hbGeo = new THREE.InstancedBufferGeometry();
	const hbIco = new THREE.IcosahedronGeometry( 1, 2 );
	hbGeo.index = hbIco.index;
	hbGeo.attributes = hbIco.attributes;
	hbGeo.instanceCount = params.antCount;
	const hbMat = new THREE.MeshBasicNodeMaterial( { color: new THREE.Color( 0x36ffd5 ), transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false } );
	hbMat.positionNode = Fn( () => {

		const { rot, world } = antTransform( instanceIndex );
		const bodyScale = casteScale( instanceIndex );
		const hide = select( stateOf( instanceIndex ).equal( uint( 3 ) ), float( 0 ), float( 1 ) );
		const center = rot.mul( vec3( 0, vat.bounds.height * 0.45, 0 ).mul( bodyScale ) ).add( world );
		return positionLocal.mul( uAntHitR.mul( bodyScale ).mul( hide ) ).add( center );

	} )();
	const antHitbox = new THREE.Mesh( hbGeo, hbMat );
	antHitbox.frustumCulled = false;
	antHitbox.visible = !! gfx.debugSpider;

	group.add( grain, grainHalo, antHitbox );

	// ------------------------------------------------------------------
	const renderer = sim.renderer;
	const fovTmp = { tan: Math.tan };

	return {
		group,
		grainMat,
		uBodyColor,
		uAccentColor,
		uSoldierColor,
		uNurseColor,
		uScoutColor,
		uQueenColor,
		uQueenScale,
		uGrainHalo,
		uGrainHaloIntensity,
		uReveal,
		queen,
		lodInfo: { full: vat.geometry.index.count / 3, lod1: lod1.triangles, lod2: lod2.triangles },
		uAntHitR,
		setHitboxVisible( v ) { antHitbox.visible = !! v; },
		setCount( n ) {

			grainGeo.instanceCount = n;
			haloGeo.instanceCount = n;
			hbGeo.instanceCount = n;

		},
		setShadows( on ) {

			for ( const b of bodies ) b.castShadow = on;

		},
		// chaque frame : phase de marche + classement LOD/frustum
		tick( simDt, camera ) {

			phaseAcc = ( phaseAcc + simDt * params.moveSpeed * params.walkAnim * 0.14 ) % 1;
			uPhase.value = phaseAcc;

			camera.updateMatrixWorld();
			u.view.value.copy( camera.matrixWorldInverse );
			u.tanY.value = fovTmp.tan( ( camera.fov * Math.PI / 180 ) / 2 );
			u.tanX.value = u.tanY.value * camera.aspect;
			u.far.value = camera.far;
			u.lod0.value = gfx.lodDist0;
			u.lod1.value = gfx.lodDist1;
			u.budget0.value = gfx.lodBudget;
			u.budget1.value = gfx.lodBudget * 4;

			renderer.compute( kReset );
			renderer.compute( kClassify );
			renderer.compute( kFinalize );

		},
	};

}
