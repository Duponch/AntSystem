// Rendu des fourmis 100 % GPU-driven :
//
//   VAT (cycle de marche baké + pose de mort, voir vat.js)
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
// TOUTE la transformation d'un corps (position monde, attitude quaternion,
// gabarit, phase de démarche, teintes, drapeaux) vient d'un SEUL buffer,
// `antPose`, rempli une fois par fourmi et par frame par la passe kPose
// (pose.js). Le vertex shader ne fait plus que trois lectures contiguës et une
// rotation par quaternion : plus de hash de caste, plus de trigonométrie, plus
// de lecture de la carte de profondeur par sommet.
//
// SOUTERRAIN : le drapeau « sous terre » de la pose fait sauter la fourmi au
// classement quand la fosse est fermée (invisible sous le sol opaque).

import * as THREE from 'three/webgpu';
import {
	Fn, If, instanceIndex, uniform, varyingProperty, storage, instancedArray,
	attribute, positionLocal, cameraPosition,
	vec2, vec3, vec4, float, int, ivec2, uint,
	fract, floor, mix, hash, select, min, abs, normalize, cross, smoothstep, uv,
	textureLoad, atomicAdd, atomicStore, atomicLoad, clamp,
} from 'three/tsl';

import { loadAntVAT, buildLodGeometry } from './vat.js';
import { createPose, qrot } from './pose.js';
import { GRID, WORLD, MAX_ANTS, params, gfx } from './config.js';

const LOD_DIST = [ 16, 42 ];          // limites LOD0→1 et LOD1→2 (unités monde)
const CULL_MARGIN = 1.6;              // rayon de sécurité autour d'une fourmi

export async function createAnts( sim ) {

	const vat = await loadAntVAT( '/AntRigged.glb', { frames: 20, targetLength: 0.95 } );

	// passe de pose : la source unique de vérité du rendu
	const pose = createPose( sim, vat );
	const antPose = pose.antPose;
	const uPivot = pose.u.pivotY;
	const uPhysOn = sim.u.physOn;

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

	const framesF = float( vat.frames );

	// ------------------------------------------------------------------
	// Kernels : remise à zéro des compteurs puis classement/compaction
	// ------------------------------------------------------------------
	const kReset = Fn( () => {

		atomicStore( indirectNode.element( instanceIndex.mul( 5 ).add( 1 ) ), uint( 0 ) );

	} )().compute( 3 );

	const kClassify = Fn( () => {

		If( instanceIndex.toFloat().lessThan( sim.u.antCount ), () => {

			const P = pose.read( instanceIndex );
			// vue fermée → les souterraines sont invisibles sous le sol opaque ;
			// la reine (index 0, colonie active) a son mesh dédié ; une fourmi
			// RAGDOLLÉE est dessinée par son propre pipeline (sinon elle
			// apparaîtrait deux fois)
			const hidden = P.under.and( uReveal.lessThan( 0.01 ) );

			If( P.isQueen.not().and( hidden.not() ).and( P.ragdolled.not() ), () => {

				// centre de la sphère de culling : on retire le pivot pour rester
				// sur le même point qu'avant le passage par antPose (sinon les
				// bascules de LOD se décalent d'une caste à l'autre)
				const world = vec3(
					P.world.x,
					P.world.y.sub( uPivot.mul( P.scale ) ).add( 0.3 ),
					P.world.z,
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
			const P = pose.read( antId );

			const vatIdx = attribute( 'vatIndex', 'float' ).toInt();
			varyingProperty( 'float', 'vAntAccent' ).assign(
				select( vatIdx.lessThan( int( vat.counts[ 0 ] ) ), 0, 1 ),
			);
			varyingProperty( 'float', 'vCaste' ).assign( P.caste );
			varyingProperty( 'float', 'vVenom' ).assign( P.venom );
			varyingProperty( 'float', 'vDead' ).assign( select( P.dead, 1, 0 ) );

			let animated;

			if ( animMode === 2 ) {

				animated = textureLoad( vat.texture, ivec2( vatIdx, int( 0 ) ) ).xyz;

			} else {

				// PHASE DE DÉMARCHE : en mode physique elle est propre à chaque
				// fourmi et pilotée par la DISTANCE qu'elle a réellement parcourue
				// (fin du patinage) ; en mode historique c'est l'horloge globale.
				const cycle = select( uPhysOn.greaterThan( 0.5 ),
					P.gait, uPhase.add( hash( antId.add( uint( 1013 ) ) ) ) );
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

			// envenimation : la marche se fige progressivement (paralysie)
			animated = mix( animated, textureLoad( vat.texture, ivec2( vatIdx, int( 0 ) ) ).xyz, P.venom );

			const local = animated.toVar();

			If( P.dead, () => {

				// CADAVRE : pose de mort bakée — pattes recroquevillées sous le
				// corps, tête et gastre retombés. En mode historique on garde la
				// vieille pose de repos plaquée (le témoin de comparaison).
				const rowDead = textureLoad( vat.texture, ivec2( vatIdx, int( vat.deathRow ) ) ).xyz;
				const rowRest = textureLoad( vat.texture, ivec2( vatIdx, int( 0 ) ) ).xyz;
				local.assign( select( uPhysOn.greaterThan( 0.5 ), rowDead, rowRest ) );

			} );

			// dévorée : sommet dégénéré, invisible
			const vis = select( P.gone, float( 0 ), float( 1 ) );

			// le corps tourne autour de son PIVOT anatomique (articulation « root »),
			// pas autour de ses pieds : sans ça une fourmi qui bascule s'enfonce
			return qrot( P.q, local.sub( vec3( 0, uPivot, 0 ) ).mul( P.scale ).mul( vis ) )
				.add( P.world );

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

		const P = pose.read( uint( 0 ) );

		const vatIdx = attribute( 'vatIndex', 'float' ).toInt();
		varyingProperty( 'float', 'vQAccent' ).assign(
			select( vatIdx.lessThan( int( vat.counts[ 0 ] ) ), 0, 1 ),
		);

		// démarche lente : en mode physique la cadence découle de sa vraie
		// vitesse et de son gabarit (le facteur magique 0,55 disparaît)
		const cycle = select( uPhysOn.greaterThan( 0.5 ),
			P.gait, uPhase.div( uQueenScale ).mul( 0.55 ) );
		const ff = fract( cycle ).mul( framesF );
		const f0 = floor( ff ).toInt();
		const f1 = f0.add( 1 ).mod( int( vat.frames ) );
		const p0 = textureLoad( vat.texture, ivec2( vatIdx, f0 ) ).xyz;
		const p1 = textureLoad( vat.texture, ivec2( vatIdx, f1 ) ).xyz;
		const animated = mix( p0, p1, fract( ff ) );

		// gabarit royal : corps élargi, gaster étiré vers l'arrière (−z)
		const stretch = clamp( positionLocal.z.negate().mul( 2 ), 0, 1 );
		const local = animated.sub( vec3( 0, uPivot, 0 ) ).mul( uQueenScale )
			.mul( vec3( 1.05, 1.05, float( 1 ).add( stretch.mul( 0.5 ) ) ) );

		// masquée si la colonie est coupée (l'index 0 redevient une ouvrière) ;
		// son pivot est relevé à SON échelle, pas à celle d'une ouvrière
		const on = sim.u.colonyOn;
		const world = vec3(
			P.world.x,
			P.world.y.sub( uPivot.mul( P.scale ) ).add( uPivot.mul( uQueenScale ) ),
			P.world.z,
		);

		return qrot( P.q, local.mul( on ) ).add( world );

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

	// offset de la mandibule, exprimé RELATIVEMENT AU PIVOT (le grain est porté
	// à la bouche : il suit donc le tangage et le roulis du corps)
	const mouthOffset = ( scale ) => vec3(
		float( 0 ),
		float( vat.bounds.height * 0.62 ).sub( uPivot ),
		float( vat.bounds.headZ * 0.9 ),
	).mul( scale );

	grainMat.positionNode = Fn( () => {

		const P = pose.read( instanceIndex );
		// grain caché avec sa porteuse : souterraine + vue fermée
		const hidden = P.under.and( uReveal.lessThan( 0.01 ) );
		const show = select( P.carrying.and( hidden.not() ), float( 1 ), float( 0 ) );
		const offset = qrot( P.q, mouthOffset( P.scale ) );

		return positionLocal.mul( show ).add( offset ).add( P.world );

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

		const P = pose.read( instanceIndex );
		const hidden = P.under.and( uReveal.lessThan( 0.01 ) );
		const show = select( P.carrying.and( hidden.not() ), float( 1 ), float( 0 ) );
		const center = qrot( P.q, mouthOffset( P.scale ) ).add( P.world );

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
	// Elle suit la POSITION SIMULÉE (antData via antPose) — donc elle reste
	// honnête quand un cadavre est projeté : c'est bien là que l'araignée
	// testera le contact.
	const uAntHitR = uniform( params.antRadius );
	const hbGeo = new THREE.InstancedBufferGeometry();
	const hbIco = new THREE.IcosahedronGeometry( 1, 2 );
	hbGeo.index = hbIco.index;
	hbGeo.attributes = hbIco.attributes;
	hbGeo.instanceCount = params.antCount;
	const hbMat = new THREE.MeshBasicNodeMaterial( { color: new THREE.Color( 0x36ffd5 ), transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false } );
	hbMat.positionNode = Fn( () => {

		const P = pose.read( instanceIndex );
		const hide = select( P.gone, float( 0 ), float( 1 ) );
		const center = qrot( P.q,
			vec3( 0, float( vat.bounds.height * 0.45 ).sub( uPivot ), 0 ).mul( P.scale ) ).add( P.world );
		return positionLocal.mul( uAntHitR.mul( P.scale ).mul( hide ) ).add( center );

	} )();
	const antHitbox = new THREE.Mesh( hbGeo, hbMat );
	antHitbox.frustumCulled = false;
	antHitbox.visible = !! gfx.debugSpider;

	group.add( grain, grainHalo, antHitbox );

	// ------------------------------------------------------------------
	const fovTmp = { tan: Math.tan };
	const renderer = sim.renderer;
	// tableau STABLE (three suit les passes par identité d'objet) : les quatre
	// noyaux partent en UN seul command buffer au lieu de trois.
	const PASSES = [ pose.kPose, kReset, kClassify, kFinalize ];

	return {
		group,
		pose,
		vat,
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
		passes: PASSES,
		setHitboxVisible( v ) { antHitbox.visible = !! v; },
		setCount( n ) {

			grainGeo.instanceCount = n;
			haloGeo.instanceCount = n;
			hbGeo.instanceCount = n;

		},
		setShadows( on ) {

			for ( const b of bodies ) b.castShadow = on;

		},
		// chaque frame : horloge de pose + phase historique + classement LOD/frustum
		// (les dispatches eux-mêmes sont encodés par main.js, en un seul submit)
		tick( simDt, camera ) {

			pose.tick( simDt );

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

			// ORDRE IMPOSÉ : kPose lit ce que kAnt vient d'écrire, kClassify lit
			// ce que kPose vient d'écrire. En mode profilage on encode une passe
			// par command buffer, sinon les chronos GPU se recouvrent et three
			// leur donne le même identifiant (mesures écrasées).
			if ( gfx.perfHud ) {

				for ( const p of PASSES ) renderer.compute( p );

			} else {

				renderer.compute( PASSES );

			}

		},
	};

}
