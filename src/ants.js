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

import * as THREE from 'three/webgpu';
import {
	Fn, If, instanceIndex, uniform, varyingProperty, storage, instancedArray,
	attribute, positionLocal, cameraPosition,
	vec2, vec3, vec4, mat3, float, int, ivec2, uint,
	cos, sin, fract, floor, mix, hash, select, min, abs, normalize, cross, smoothstep, uv,
	textureLoad, atomicAdd, atomicStore,
} from 'three/tsl';

import { loadAntVAT, buildLodGeometry } from './vat.js';
import { GRID, WORLD, MAX_ANTS, params, gfx } from './config.js';

const LOD_DIST = [ 16, 42 ];          // limites LOD0→1 et LOD1→2 (unités monde)
const CULL_MARGIN = 1.6;              // rayon de sécurité autour d'une fourmi

export async function createAnts( sim ) {

	const vat = await loadAntVAT( '/AntRigged.glb', { frames: 20, targetLength: 0.95 } );

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
		lod0: uniform( LOD_DIST[ 0 ] ),
		lod1: uniform( LOD_DIST[ 1 ] ),
	};

	const uPhase = uniform( 0 );
	let phaseAcc = 0;

	const texel = WORLD / GRID;
	const framesF = float( vat.frames );

	// ------------------------------------------------------------------
	// Kernels : remise à zéro des compteurs puis classement/compaction
	// ------------------------------------------------------------------
	const kReset = Fn( () => {

		atomicStore( indirectNode.element( instanceIndex.mul( 5 ).add( 1 ) ), uint( 0 ) );

	} )().compute( 3 );

	const kClassify = Fn( () => {

		If( instanceIndex.toFloat().lessThan( sim.u.antCount ), () => {

			const a = sim.antData.element( instanceIndex );
			const world = vec3(
				a.x.mul( texel ).sub( WORLD / 2 ),
				0.3,
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

				const lod = select( depth.lessThan( u.lod0 ), uint( 0 ),
					select( depth.lessThan( u.lod1 ), uint( 1 ), uint( 2 ) ) );

				const slot = atomicAdd( indirectNode.element( lod.mul( 5 ).add( 1 ) ), uint( 1 ) ).toVar();
				lodList.element( lod.mul( uint( MAX_ANTS ) ).add( slot ) ).assign( instanceIndex );

			} );

		} );

	} )().compute( MAX_ANTS );

	// ------------------------------------------------------------------
	// Transformation d'une fourmi (partagée corps/grain/halo)
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

		const world = vec3(
			gp.x.mul( texel ).sub( WORLD / 2 ),
			0,
			gp.y.mul( texel ).sub( WORLD / 2 ),
		);

		return { rot, world };

	};

	// ------------------------------------------------------------------
	// Corps : 3 meshes indirects (matériaux jumeaux → même pipeline en cache)
	// ------------------------------------------------------------------
	const uBodyColor = uniform( new THREE.Color( gfx.antColor ) );
	const uAccentColor = uniform( new THREE.Color( gfx.antAccentColor ) );

	function makeBodyMaterial( lodBase ) {

		const material = new THREE.MeshStandardNodeMaterial( { roughness: 0.6, metalness: 0.0 } );
		const base = uniform( lodBase );

		material.positionNode = Fn( () => {

			const antId = lodList.element( base.toUint().add( instanceIndex ) );
			const { rot, world } = antTransform( antId );

			const vatIdx = attribute( 'vatIndex', 'float' ).toInt();
			varyingProperty( 'float', 'vAntAccent' ).assign(
				select( vatIdx.lessThan( int( vat.counts[ 0 ] ) ), 0, 1 ),
			);

			// phase de marche accumulée + décalage par fourmi
			const cycle = uPhase.add( hash( antId.add( uint( 1013 ) ) ) );
			const ff = fract( cycle ).mul( framesF );
			const f0 = floor( ff ).toInt();
			const f1 = f0.add( 1 ).mod( int( vat.frames ) );
			const w = fract( ff );

			const p0 = textureLoad( vat.texture, ivec2( vatIdx, f0 ) ).xyz;
			const p1 = textureLoad( vat.texture, ivec2( vatIdx, f1 ) ).xyz;
			const animated = mix( p0, p1, w );

			return rot.mul( animated ).add( world );

		} )();

		material.colorNode = Fn( () => {

			return mix( uBodyColor, uAccentColor, varyingProperty( 'float', 'vAntAccent' ) );

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

		const mesh = new THREE.Mesh( igeo, makeBodyMaterial( k * MAX_ANTS ) );
		mesh.frustumCulled = false;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		group.add( mesh );
		bodies.push( mesh );

	}

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
		const carrying = sim.antState.element( instanceIndex ).toFloat();
		const offset = rot.mul( vec3( 0, vat.bounds.height * 0.62, vat.bounds.headZ * 0.9 ) );

		return positionLocal.mul( carrying ).add( offset ).add( world );

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
		const carrying = sim.antState.element( instanceIndex ).toFloat();
		const center = rot.mul( vec3( 0, vat.bounds.height * 0.62, vat.bounds.headZ * 0.9 ) ).add( world );

		const view = normalize( cameraPosition.sub( center ) );
		const right = normalize( cross( vec3( 0, 1, 0 ), view ) );
		const up = cross( view, right );
		const size = carrying.mul( 0.9 ).mul( uGrainHalo );

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

	group.add( grain, grainHalo );

	// ------------------------------------------------------------------
	const renderer = sim.renderer;
	const fovTmp = { tan: Math.tan };

	return {
		group,
		grainMat,
		uBodyColor,
		uAccentColor,
		uGrainHalo,
		uGrainHaloIntensity,
		lodInfo: { full: vat.geometry.index.count / 3, lod1: lod1.triangles, lod2: lod2.triangles },
		setCount( n ) {

			grainGeo.instanceCount = n;
			haloGeo.instanceCount = n;

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

			renderer.compute( kReset );
			renderer.compute( kClassify );

		},
	};

}
