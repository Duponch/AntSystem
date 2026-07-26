// LE NID COMME VOLUME — champ de distance signé 3D, écrit par un compute.
//
// POURQUOI CHANGER D'APPROCHE. Le rendu précédent creusait des cuvettes dans
// une carte de hauteurs et en dessinait la surface. Trois choses en découlaient,
// toutes fatales :
//   • une carte de hauteurs ne produit que des formes à symétrie de révolution
//     — des cylindres. Aucun réglage ne peut les rendre organiques ;
//   • une surface trouée n'est pas un volume : dès qu'on regardait par le côté,
//     on voyait à travers, et la skybox apparaissait ;
//   • deux sommets voisins, l'un dans une chambre profonde et l'autre dans la
//     terre pleine, engendraient un triangle vertical de toute la hauteur du
//     nid — les rideaux parasites.
//
// Ici le nid n'est plus une surface, c'est un CHAMP : pour chaque point de
// l'espace, la distance signée à la cavité la plus proche (négative dedans,
// positive dans la terre). La terre devient un volume PLEIN qu'on traverse au
// rayon. Conséquences directes :
//   - les chambres emploient une union douce pour des raccords organiques ;
//     les capsules des tunnels restent en union dure, identique a l'oracle CPU,
//     afin que les pistes de contact et la bouche gardent leur surface exacte ;
//   • il n'y a plus de « derrière » : on ne peut pas voir à travers de la terre
//     pleine ;
//   • aucun maillage, donc aucun artefact de maillage.
//
// Le champ est baké UNE FOIS par géométrie de nid dans une Storage3DTexture
// (rgba16float : storage-writable ET filtrable en WebGPU), puis simplement
// échantillonné par le raymarcheur. La simulation partage avec lui les mêmes
// axes et surfaces propres précompilés ; aucune projection SDF par fourmi.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, instanceIndex, uniform, uniformArray, uvec3, ivec3,
	float, int, uint, vec3, vec4,
	abs, min, max, clamp, length, dot, select, textureStore, mx_noise_float,
} from 'three/tsl';

import { TEXEL, NEST, GRID, WORLD, MIN_NEST_DEPTH, gfx } from './config.js';
import { K_MAX } from './nest.js';
import { SDF_RADIUS_SCALE } from './navigation/corridor-network.js';
import {
	chamberPrimitive,
	corridorCapsuleSegments,
	SDF_SEGS_PER_CORRIDOR,
} from './navigation/support-geometry.js';
import {
	assessNestVolumeBakeFreshness,
	nestVolumeLayoutSignature,
	NEST_VOLUME_GPU_PROBE_ID,
	runNestVolumeGpuProbe,
} from './navigation/nest-volume-probe.js';

// Résolution du volume. Le nid fait ~45 unités de large pour ~20 de profondeur ;
// à 128×64×128 un voxel vaut ~0,4 unité, soit trois voxels en travers d'un
// tunnel. C'est le minimum pour que l'interpolation trilinéaire donne des
// parois lisses. Coût mémoire : 128·64·128·4·2 = 8 Mo.
export const VOL_X = 128, VOL_Y = 64, VOL_Z = 128;


// Nombre fixe de capsules par tunnel. Chaque voxel les evalue pendant le bake ;
// seize segments bornent le cout et partagent exactement les primitives CPU.
// +1 inclut l'entree vers le vestibule.
const MAX_CORRIDORS = K_MAX + 1;
const MAX_SEGS = MAX_CORRIDORS * SDF_SEGS_PER_CORRIDOR;

export function createNestVolume( { renderer, layout } ) {

	// rgba16float : l'un des rares formats à la fois inscriptible par un compute
	// ET filtrable — indispensable, un SDF non filtré donne des parois en escalier
	const volume = new THREE.Storage3DTexture( VOL_X, VOL_Y, VOL_Z );
	volume.format = THREE.RGBAFormat;
	volume.type = THREE.HalfFloatType;
	volume.minFilter = THREE.LinearFilter;
	volume.magFilter = THREE.LinearFilter;
	volume.wrapS = volume.wrapT = volume.wrapR = THREE.ClampToEdgeWrapping;

	// --- bornes monde du volume (mises à jour à chaque reconstruction) ---
	const uMin = uniform( new THREE.Vector3() );
	const uSize = uniform( new THREE.Vector3( 1, 1, 1 ) );
	const uChamberCount = uniform( 0 );
	const uSegCount = uniform( 0 );
	// rayon de fusion : c'est LUI qui fait que deux chambres voisines se fondent
	// en une poche unique aux contours mous au lieu de deux boules tangentes
	const uBlend = uniform( gfx.nestBlend );
	const uNoiseAmp = uniform( gfx.nestNoise );
	const uNoiseFreq = uniform( 0.35 );
	let bakeRevision = 0;
	let layoutRevision = 0;
	let bakeState = null;
	// A publication invalidates the previous bake immediately. The listener is
	// dormant during normal frames and runs only for a rare geometry mutation.
	layout.onPublished?.( () => { layoutRevision ++; } );

	// primitives : allouées à la taille MAXIMALE (la longueur d'un uniformArray
	// est figée à la compilation du shader), bornées à l'exécution par un compteur
	const chamberA = Array.from( { length: K_MAX }, () => new THREE.Vector4() );  // xyz + demi-axe x
	const chamberB = Array.from( { length: K_MAX }, () => new THREE.Vector4() );  // demi-axes y, z + plancher
	const segA = Array.from( { length: MAX_SEGS }, () => new THREE.Vector4() );   // xyz + rayon
	const segB = Array.from( { length: MAX_SEGS }, () => new THREE.Vector4() );   // xyz du 2e point
	const uChamberA = uniformArray( chamberA );
	const uChamberB = uniformArray( chamberB );
	const uSegA = uniformArray( segA );
	const uSegB = uniformArray( segB );

	// ------------------------------------------------------------------
	// Primitives de distance
	// ------------------------------------------------------------------
	// ellipsoïde : la distance exacte n'a pas de forme fermée, on utilise la
	// borne classique de Quilez — sous-estimée, donc SÛRE pour le sphere tracing
	const sdEllipsoid = ( p, r ) => {

		const k0 = length( p.div( r ) );
		const k1 = length( p.div( r.mul( r ) ) );
		return k0.mul( k0.sub( 1 ) ).div( max( k1, 1e-5 ) );

	};

	const sdCapsule = ( p, a, b, r ) => {

		const pa = p.sub( a ), ba = b.sub( a );
		const h = clamp( dot( pa, ba ).div( max( dot( ba, ba ), 1e-5 ) ), 0, 1 );
		return length( pa.sub( ba.mul( h ) ) ).sub( r );

	};

	// union DOUCE : le cœur de l'organicité. Deux primitives distantes de moins
	// de `k` se raccordent par un congé au lieu d'une arête.
	const smin = ( a, b, k ) => {

		const h = clamp( max( k.sub( abs( a.sub( b ) ) ), 0 ).div( k ), 0, 1 );
		return min( a, b ).sub( h.mul( h ).mul( k ).mul( 0.25 ) );

	};

	// ------------------------------------------------------------------
	// Bake : un thread par voxel
	// ------------------------------------------------------------------
	const kBake = Fn( () => {

		const i = instanceIndex;
		const vx = i.mod( uint( VOL_X ) );
		const vy = i.div( uint( VOL_X ) ).mod( uint( VOL_Y ) );
		const vz = i.div( uint( VOL_X * VOL_Y ) );

		// centre du voxel en coordonnées monde
		const p = uMin.add( vec3(
			vx.toFloat().add( 0.5 ).div( VOL_X ),
			vy.toFloat().add( 0.5 ).div( VOL_Y ),
			vz.toFloat().add( 0.5 ).div( VOL_Z ),
		).mul( uSize ) ).toVar();

		// Le bruit est calculé une seule fois par voxel. Il ne déforme que les
		// chambres, et s'annule progressivement au voisinage de leur plancher.
		// Les tunnels et les zones de contact restent donc exactement ceux que
		// les rails de navigation décrivent.
		const n1 = mx_noise_float( p.mul( uNoiseFreq ) );
		const n2 = mx_noise_float( p.mul( uNoiseFreq.mul( 2.7 ) ).add( 31.7 ) );
		const organicNoise = n1.mul( uNoiseAmp )
			.add( n2.mul( uNoiseAmp.mul( 0.35 ) ) );
		const dChambers = float( 1e6 ).toVar();
		const dChambersClean = float( 1e6 ).toVar();

		Loop( { start: uint( 0 ), end: uChamberCount.toUint(), type: 'uint', condition: '<' }, ( { i: c } ) => {

			const A = uChamberA.element( c.toInt() );
			const B = uChamberB.element( c.toInt() );
			const local = p.sub( A.xyz );
			// Voute ellipsoidale coupee par un demi-espace : B.z est le plancher
			// physique plat partage avec les deplacements dans la chambre.
			const clean = max(
				sdEllipsoid( local, vec3( A.w, B.x, B.y ) ),
				B.z.sub( p.y ),
			);
			const floorProgress = clamp(
				p.y.sub( B.z ).div( max( B.x.mul( 0.45 ), 1e-5 ) ), 0, 1 );
			const floorMask = floorProgress.mul( floorProgress )
				.mul( float( 3 ).sub( floorProgress.mul( 2 ) ) );
			dChambers.assign( smin( dChambers,
				clean.sub( organicNoise.mul( floorMask ) ), uBlend ) );
			dChambersClean.assign( min( dChambersClean, clean ) );

		} );

		// Capsules propres : la tortuosité vient de l'axe 3D lui-même. Ne pas
		// rajouter ici un bruit visuel que les fourmis ne pourraient pas suivre.
		const dTunnels = float( 1e6 ).toVar();
		Loop( { start: uint( 0 ), end: uSegCount.toUint(), type: 'uint', condition: '<' }, ( { i: c } ) => {

			const A = uSegA.element( c.toInt() );
			const B = uSegB.element( c.toInt() );
			// Hard union kept identical to the CPU oracle and exact at the mouth.
			dTunnels.assign( min( dTunnels, sdCapsule( p, A.xyz, B.xyz, A.w ) ) );

		} );

		const dClean = min( dChambersClean, dTunnels );
		// Autour des corridors, le champ revient progressivement à la forme
		// propre utilisée par la projection des pistes. Le relief organique reste
		// visible sur le reste des chambres, mais jamais sous les pattes.
		const tunnelProtection = clamp(
			float( 1 ).sub( max( dTunnels, 0 ).div( 2.5 ) ), 0, 1 );
		const stableChambers = dChambers.mul( float( 1 ).sub( tunnelProtection ) )
			.add( dChambersClean.mul( tunnelProtection ) );
		const dOrganic = min( stableChambers, dTunnels );
		// Le plafond empêche une expansion organique de repercer le terrain. Le
		// champ propre est réuni ensuite : il garde la bouche procédurale ouverte
		// et garantit que le support contractuel n'est jamais mangé par le bruit.
		const ceiling = p.y.add( 0.55 ).add( n1.mul( 0.45 ) );
		const dSafe = min( max( dOrganic, ceiling ), dClean );
		textureStore( volume, ivec3( vx.toInt(), vy.toInt(), vz.toInt() ),
			vec4( dSafe, dClean, 0, 0 ) ).toStack();


	} )().compute( VOL_X * VOL_Y * VOL_Z );

	// ------------------------------------------------------------------
	// Remplissage des primitives depuis le registre, puis bake
	// ------------------------------------------------------------------
	const cx = ( NEST.x / GRID - 0.5 ) * WORLD;
	const cz = ( NEST.y / GRID - 0.5 ) * WORLD;
	const dimensions = Object.freeze( { x: VOL_X, y: VOL_Y, z: VOL_Z } );
	const cloneBounds = ( bounds ) => ( {
		min: { ... bounds.min },
		size: { ... bounds.size },
	} );

	function currentGeometryState() {

		const units = layout.units || [];
		const K = Math.min( layout.K || 0, K_MAX );
		const deepestNavigationPoint = Math.min( 0,
			... ( layout.navigation?.nodes || [] ).map( ( node ) => node.depth ) );
		const radius = ( layout.radiusWorld || 20 ) + 4;
		const depth = Math.max(
			layout.depthMax || MIN_NEST_DEPTH, - deepestNavigationPoint ) + 3;
		const bounds = {
			min: { x: cx - radius, y: - depth, z: cz - radius },
			size: { x: radius * 2, y: depth + 1.7, z: radius * 2 },
		};
		return {
			K,
			bounds,
			layoutRevision,
			layoutSignature: nestVolumeLayoutSignature( {
				layout, bounds, dimensions, texel: TEXEL, world: WORLD, grid: GRID,
				chamberCount: K,
			} ),
		};

	}

	function rebuild() {

		const units = layout.units || [];
		const geometry = currentGeometryState();
		const K = geometry.K;

		// La borne et l'empreinte sont issues du même snapshot logique que les
		// uniforms ci-dessous. Une publication ultérieure invalide ce bake.
		uMin.value.set(
			geometry.bounds.min.x, geometry.bounds.min.y, geometry.bounds.min.z );
		uSize.value.set(
			geometry.bounds.size.x, geometry.bounds.size.y, geometry.bounds.size.z );

		// --- chambres : lentilles aplaties ---
		for ( let k = 0; k < K; k ++ ) {

			const u = units[ k ];
			const primitive = chamberPrimitive( u );
			chamberA[ k ].set(
				( u.x / GRID - 0.5 ) * WORLD, primitive.centerDepth,
				( u.y / GRID - 0.5 ) * WORLD, primitive.radiusX );
			chamberB[ k ].set( primitive.radiusY, primitive.radiusZ, primitive.floorDepth, 0 );

		}
		uChamberCount.value = K;

		// --- tunnels : capsules le long de l'arc réel ---
		const navigation = layout.navigation;

		if ( ! navigation || ! Array.isArray( navigation.corridors ) )
			throw new Error( 'Nest volume requires layout.navigation.corridors' );

		let n = 0;

		for ( const corridor of navigation.corridors ) {

			if ( ! corridor ) continue;
			const width = corridor.tunnelW ?? corridor.radius
				?? navigation.tunnelW ?? layout.tunnelW ?? 7;
			const tw = Math.max( 0.6, width * TEXEL * SDF_RADIUS_SCALE );

			for ( const [ a, b ] of corridorCapsuleSegments( corridor ) ) {

				if ( n >= MAX_SEGS ) throw new Error( `Nest corridor segment capacity exceeded (${ MAX_SEGS })` );
				segA[ n ].set( ( a.x / GRID - 0.5 ) * WORLD, a.depth, ( a.y / GRID - 0.5 ) * WORLD, tw );
				segB[ n ].set( ( b.x / GRID - 0.5 ) * WORLD, b.depth, ( b.y / GRID - 0.5 ) * WORLD, 0 );
				n ++;

			}

		}
		uSegCount.value = n;

		renderer.compute( kBake );
		bakeRevision ++;
		bakeState = {
			bakeRevision,
			layoutRevision: geometry.layoutRevision,
			layoutSignature: geometry.layoutSignature,
			bounds: cloneBounds( geometry.bounds ),
		};
		return { ... bakeState, bounds: cloneBounds( bakeState.bounds ) };

	}

	function staleProbeReport( freshness, error ) {

		return {
			id: NEST_VOLUME_GPU_PROBE_ID,
			pass: false,
			fresh: false,
			stale: true,
			error,
			coverage: false,
			counts: { corridor: 0, chamber: 0 },
			freshness,
			bakeRevision: freshness.bakeRevision,
			layoutRevision: freshness.bakedLayoutRevision,
			layoutSignature: freshness.bakedLayoutSignature,
		};

	}

	// Explicit diagnostic only: normal frames never dispatch a readback. The
	// signature is checked on both sides so a concurrent rebuild cannot mix
	// texels from two geometry revisions into one apparently valid proof.
	async function probeCleanSurface( options = {} ) {

		const currentBefore = currentGeometryState();
		const freshnessBefore = assessNestVolumeBakeFreshness( bakeState, currentBefore );
		if ( ! freshnessBefore.pass ) return staleProbeReport(
			freshnessBefore,
			`${ NEST_VOLUME_GPU_PROBE_ID } rejected a missing or stale nest-volume bake`,
		);

		const snapshot = bakeState;
		const { corridorCount = 3, chamberCount = 2 } = options;
		const report = await runNestVolumeGpuProbe( {
			renderer,
			texture: volume,
			layout,
			bounds: cloneBounds( snapshot.bounds ),
			dimensions,
			texel: TEXEL,
			world: WORLD,
			grid: GRID,
			corridorCount,
			chamberCount,
		} );

		const currentAfter = currentGeometryState();
		const freshnessAfter = assessNestVolumeBakeFreshness( snapshot, currentAfter );
		const bakeUnchanged = bakeState === snapshot;
		const fresh = freshnessBefore.pass && freshnessAfter.pass && bakeUnchanged;
		const freshness = {
			pass: fresh,
			checks: {
				beforeReadback: freshnessBefore.pass,
				afterReadback: freshnessAfter.pass,
				bakeUnchanged,
			},
			before: freshnessBefore,
			after: freshnessAfter,
		};
		return {
			... report,
			pass: report.pass && fresh,
			fresh,
			stale: ! fresh,
			freshness,
			bakeRevision: snapshot.bakeRevision,
			layoutRevision: snapshot.layoutRevision,
			layoutSignature: snapshot.layoutSignature,
		};

	}
	return {
		volume, rebuild, probeCleanSurface,
		uMin, uSize,
		u: { blend: uBlend, noiseAmp: uNoiseAmp, noiseFreq: uNoiseFreq },
		get bakeState() {

			return bakeState
				? { ... bakeState, bounds: cloneBounds( bakeState.bounds ) }
				: null;

		},
		get bounds() {

			return {
				min: uMin.value.clone(),
				max: uMin.value.clone().add( uSize.value ),
			};

		},
	};

}
