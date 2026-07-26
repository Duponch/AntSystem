// LE SURVEILLANT (warden) — tests d'intégration GPU de la navigation v2.
//
// Usage : URL ?test=warden (au chargement) ou console : __antsys.warden.run().
// Chaque scénario avance la simulation par pas manuels et contrôle chaque
// fourmi. Le rapport consolidé est publié en console et sur window.__antwarden.
//
// ORACLES STRICTS (noyau kWatch, une invocation par fourmi et par pas) :
//   1 POSE INTRINSÈQUE — reconstruction indépendante depuis corridor, progrès,
//     voie et profondeur ; tout écart au corridor échoue.
//   2 CINÉMATIQUE 3D — déplacement couvert par la distance curviligne accumulée,
//     majorée par l'étirement géométrique mesuré des voies.
//   3 WARP XZ — aucun saut planaire inexpliqué par la progression de route.
//   4 TOUPIE / BLOCAGE — fenêtre de 8 s hors repos et destination atteinte ;
//     une transition surface/sous-sol est d'abord validée au contact exact de
//     la bouche, puis ouvre une nouvelle fenêtre.
//   5 BORNES DU VOLUME — aucune souterraine hors du volume réellement compilé,
//     y compris avec le jitter des chambres profondes.
//   6 MORT EN TOUPIE — corrélation entre anomalie et mort ultérieure.
//   7 POSE/SUPPORT 3D — après kPose : données finies, pivot sur la normale du
//     contact, quaternion unitaire et axes du corps cohérents avec le repère.
//
// Un échantillon CPU conserve chemins, états, énergie et traces intrinsèques.
// Les verdicts n'acceptent aucune anomalie structurelle ; les indicateurs
// biologiques stochastiques restent diagnostiques et séparés.
//
// Coût en jeu normal : nul. Ces noyaux et leurs tampons ne sont dispatchés que
// pendant une campagne Warden ; les lectures GPU sont sérialisées par chunks.

import {
	Fn, If, instanceIndex, uniform, instancedArray, textureLoad,
	uint, int, float, vec2, vec3, vec4, ivec2,
	abs, min, max, sqrt, length, dot, cross, cos, sin, atan, select, PI2, atomicAdd, atomicStore, atomicLoad,
	hash,
} from 'three/tsl';

import { params, gfx, WORLD, TEXEL, MAX_ANTS, MIN_NEST_DEPTH, MAX_NEST_DEPTH } from './config.js';
import { nestUnit, buildNest, K_MAX, MIN_TUNNEL_WIDTH } from './nest.js';
import {
	corridorSurfaceLengthTSL,
	sampleCorridorSurfaceTSL,
} from './navigation/corridor-sampling-tsl.js';
import { NEST_VOLUME_GPU_PROBE_ID } from './navigation/nest-volume-probe.js';

export { NEST_VOLUME_GPU_PROBE_ID };
export const WARDEN_ENTRANCE_PROOF_ID = 'NAV-ENTRANCE-RUNTIME-001';
export const WARDEN_VOLUME_PROOF_CASES = Object.freeze( [
	'initial-current',
	'depth-min',
	'depth-max',
	'tunnel-min',
	'tunnel-wide',
	'growth',
	'restored-current',
] );

export function isFreshNestVolumeProof( proof ) {

	return proof?.pass === true
		&& proof.fresh === true
		&& proof.stale !== true
		&& proof.freshness?.pass === true
		&& Number.isInteger( proof.bakeRevision ) && proof.bakeRevision > 0
		&& Number.isInteger( proof.layoutRevision ) && proof.layoutRevision >= 0
		&& typeof proof.layoutSignature === 'string'
		&& proof.layoutSignature.length > 0;

}

export function buildVolumeGpuProofVerdict(
	proofs, requiredCases = WARDEN_VOLUME_PROOF_CASES ) {

	const source = Array.isArray( proofs ) ? proofs : [];
	const checks = {};
	for ( const caseId of requiredCases ) {

		const matching = source.filter( ( proof ) => proof?.caseId === caseId );
		checks[ caseId ] = matching.length === 1
			&& isFreshNestVolumeProof( matching[ 0 ] );

	}
	const passed = Object.values( checks ).filter( Boolean ).length;
	const coverage = Object.keys( checks ).length === requiredCases.length
		&& source.every( ( proof ) => requiredCases.includes( proof?.caseId ) )
		&& requiredCases.every( ( caseId ) =>
			source.filter( ( proof ) => proof?.caseId === caseId ).length === 1 );
	return {
		id: NEST_VOLUME_GPU_PROBE_ID,
		pass: coverage && passed === requiredCases.length,
		fresh: coverage && passed === requiredCases.length,
		stale: source.some( ( proof ) => proof?.stale === true ),
		coverage,
		counts: { passed, total: requiredCases.length },
		requiredCases: [ ... requiredCases ],
		checks,
		cases: source,
	};

}

export function buildWardenVerdict( unit, scenarios, transitionCoverage, volumeGpuProbe ) {

	const unitPass = unit.length > 0 && unit.every( ( result ) => result.pass );
	const scenariosPass = scenarios.length > 0 && scenarios.every( ( result ) => result.pass );
	const transitionPass = transitionCoverage?.allerRetourObserve === true;
	const volumeGpuPass = volumeGpuProbe?.pass === true;
	const passed = unit.filter( ( result ) => result.pass ).length
		+ scenarios.filter( ( result ) => result.pass ).length
		+ ( transitionPass ? 1 : 0 )
		+ ( volumeGpuPass ? 1 : 0 );
	const total = Math.max( unit.length, 1 ) + Math.max( scenarios.length, 1 ) + 2;

	return {
		pass: unitPass && scenariosPass && transitionPass && volumeGpuPass,
		score: `${ passed }/${ total }`,
		checks: {
			unitaires: unitPass,
			scenarios: scenariosPass,
			[ WARDEN_ENTRANCE_PROOF_ID ]: transitionPass,
			[ NEST_VOLUME_GPU_PROBE_ID ]: volumeGpuPass,
		},
	};

}
const N_EVENTS = 256;         // anneau d'événements d'anomalies relus par le CPU
const SPIN_T = 8.0;           // fenêtre toupie/blocage (s sim)
const DY_TELEPORT = 1.0;      // saut vertical suspect (u monde)
const DXZ_WARP = 8.0;         // warp planaire suspect (texels)
const SPIN_ROT = 2 * Math.PI; // rotation cumulée de toupie sur la fenêtre (rad) :
                              // un tour complet en 8 s quasi sur place — lent
                              // mais anormal pour une fourmi en déplacement
const SPIN_MOVE = 3.0;        // … avec moins de ça de déplacement (texels)
const STUCK_MOVE = 0.5;       // déplacement de blocage sur la fenêtre (texels)
const POSE_LATERAL_EPS = 0.006; // erreur monde orthogonale à la normale
const POSE_HEIGHT_EPS = 0.012;  // tolérance sur pivot + semelle + rebond
const POSE_SCALE_EPS = 0.002;
const POSE_QNORM_EPS = 0.02;
// Les coups/venin ajoutent volontairement jusqu'à ~1 rad de roulis. Ces seuils
// détectent une pose « lacet seul » sur mur/plafond sans condamner ce titubement.
const POSE_UP_DOT_MIN = 0.25;
const POSE_FORWARD_DOT_MIN = 0.70;

// types d'événements (colonne « type » du rapport)
const EV = {
	TELEPORT: 1, WARP: 2, NAPPE: 3, TOUPIE: 4, BLOQUE: 5, HORS_NID: 6,
	SURFACE: 7, MORT_TOUPIE: 8, POSE_NAN: 9, POSE_SUPPORT: 10,
	POSE_ORIENTATION: 11, ENTREE_DISCONTINUE: 12,
};
const EV_NOMS = [
	'', 'dépassement cinématique 3D', 'warp XZ', 'hors corridor', 'toupie',
	'bloquée', 'sous le nid', 'en surface', 'mort en toupie',
	'pose non finie', 'pivot hors support', 'orientation hors repère',
	'transition bouche discontinue',
];

const rotateByQuaternion = ( q, v ) =>
	v.add( cross( q.xyz, cross( q.xyz, v ).add( v.mul( q.w ) ) ).mul( 2 ) );
const finiteScalar = ( v ) => v.equal( v ).and( abs( v ).lessThan( 1e6 ) );
const finiteVec3 = ( v ) => finiteScalar( v.x ).and( finiteScalar( v.y ) ).and( finiteScalar( v.z ) );
const finiteVec4 = ( v ) => finiteVec3( v.xyz ).and( finiteScalar( v.w ) );

export function createWarden( { sim, colony, ants, cones, renderer, nestVolume } ) {

	const layout = sim.layout;

	// ------------------------------------------------------------------
	// Tampons dédiés (jamais lus par le jeu normal)
	// ------------------------------------------------------------------
	// état précédent : (x, y texels, distance-route sous terre / cap en surface,
	// profondeur sous terre / marqueur surface / -999 au reset)
	const prevData = instancedArray( MAX_ANTS, 'vec4' );
	// fenêtre toupie : (rotation cumulée, déplacement cumulé, chrono, drapeaux)
	// drapeaux : 1 toupie · 2 bloquée · 4 mort-en-toupie comptée · 8 nappe empruntée
	const spinAcc = instancedArray( MAX_ANTS, 'vec4' );
	const counters = instancedArray( 16, 'uint' ).toAtomic();
	const evCursor = instancedArray( 1, 'uint' ).toAtomic();
	const events = instancedArray( N_EVENTS, 'vec4' );
	// contexte de l'événement : (x, y texels, goal+node·8, nappe) — pour
	// LOCALISER les toupies/blocages dans le nid (diagnostic, pas juste compter)
	const evExtra = instancedArray( N_EVENTS, 'vec4' );

	const uDt = uniform( 1 / 60 );
	const uSimTime = uniform( 0 );
	const uDepthMax = uniform( MIN_NEST_DEPTH );
	const uLaneStretch = uniform( layout.navigation?.maxLaneStretch || 1 );

	// NAV-ENTRANCE-RUNTIME-001 — preuve courte, déterministe et sans dépendance
	// aux décisions stochastiques : #1 est placée à 0,05 texel de la sortie et
	// #2 à 0,05 texel devant sa bouche de piste, porteuse et orientée vers elle.
	// Le premier pas surveillé doit donc exercer les deux changements de monde.
	const kEntranceProofSetup = Fn( () => {

		If( instanceIndex.equal( uint( 1 ) ), () => {

			const edge = int( 1 );
			const meta = textureLoad( layout.corridorMetaTexture, ivec2( edge, int( 0 ) ) );
			const from = meta.x.add( 0.5 ).toInt();
			const to = meta.y.add( 0.5 ).toInt();
			const rootAtStart = from.equal( int( 0 ) );
			const other = select( rootAtStart, to, from );
			const direction = select( rootAtStart, float( - 1 ), float( 1 ) );
			const trackLength = corridorSurfaceLengthTSL( layout, edge, instanceIndex );
			const deltaT = min( float( 0.05 ).div( max( trackLength, 1e-5 ) ), 0.01 );
			const progress = select( rootAtStart, deltaT, float( 1 ).sub( deltaT ) );
			const support = sampleCorridorSurfaceTSL(
				layout, edge, progress, direction, instanceIndex );
			const layer = textureLoad( layout.nodeTexture, ivec2( other, int( 0 ) ) )
				.w.add( 0.5 ).toUint();

			sim.antData.element( instanceIndex ).assign( vec4(
				support.position, atan( support.tangent.y, support.tangent.x ), 0 ) );
			sim.antState.element( instanceIndex ).assign(
				uint( 8 ).bitOr( uint( 4 ).shiftLeft( uint( 4 ) ) )
					.bitOr( other.toUint().shiftLeft( uint( 7 ) ) )
					.bitOr( layer.shiftLeft( uint( 14 ) ) ) );
			sim.antVital.element( instanceIndex ).assign( vec4( 0, 0, 0.1, 0 ) );
			sim.antDyn.element( instanceIndex ).assign( vec4(
				float( 1 ), progress, support.depth, float( 0 ) ) );

		} ).ElseIf( instanceIndex.equal( uint( 2 ) ), () => {

			const mouth = sampleCorridorSurfaceTSL(
				layout, int( 1 ), float( 0 ), float( 1 ), instanceIndex );
			const radialRaw = mouth.position.sub( sim.u.nest );
			const radial = radialRaw.div( max( length( radialRaw ), 1e-5 ) );
			const inward = radial.negate();
			const start = mouth.position.add( radial.mul( 0.05 ) );

			sim.antData.element( instanceIndex ).assign( vec4(
				start, atan( inward.y, inward.x ), 0 ) );
			// état 1 = porteuse : candidate inconditionnelle à la descente.
			sim.antState.element( instanceIndex ).assign( uint( 1 ) );
			sim.antVital.element( instanceIndex ).assign( vec4( 0, 0, 1, 0 ) );
			sim.antDyn.element( instanceIndex ).assign( vec4(
				inward.mul( sim.u.moveSpeed ), 0, 0 ) );

		} );

	} )().compute( 3 );

	const kWatch = Fn( () => {

		If( instanceIndex.toFloat().lessThan( sim.u.antCount ), () => {

			const st = sim.antState.element( instanceIndex );
			const state = st.bitAnd( uint( 7 ) );
			const alive = state.lessThan( uint( 2 ) );
			const under = st.bitAnd( uint( 8 ) ).notEqual( uint( 0 ) );
			const caste = sim.casteOf( instanceIndex );
			const a = sim.antData.element( instanceIndex );
			const pos = a.xy;
			const yaw = a.z;
			// contexte pour la localisation des événements
			const goalE = st.shiftRight( uint( 4 ) ).bitAnd( uint( 7 ) ).toFloat();
			const nodeE = st.shiftRight( uint( 7 ) ).bitAnd( uint( 127 ) ).toFloat();
			const layerE = st.shiftRight( uint( 14 ) ).bitAnd( uint( 3 ) ).toFloat();
			const prev = prevData.element( instanceIndex ).toVar();
			const acc = spinAcc.element( instanceIndex ).toVar();
			const fl = acc.w.toUint().toVar();          // drapeaux en entier
			const prevOk = prev.w.greaterThan( - 900 ); // prev.w = plancher | -999
			const prevUnder = prev.w.lessThan( 0 );
			const sameMode = prevOk.and( prevUnder.equal( under ) );
			// plancher résolu CE pas : −999 tant que la fourmi n'est pas
			// souterraine — un passage surface→nid ne peut pas être pris pour
			// une téléportation (pas de plancher de référence)
			const floorNow = float( - 999 ).toVar();

			function emitEvent( type, magnitude ) {

				const c = atomicAdd( evCursor.element( 0 ), uint( 1 ) ).mod( uint( N_EVENTS ) );
				events.element( c ).assign(
					vec4( instanceIndex.toFloat(), float( type ), magnitude, uSimTime ) );
				evExtra.element( c ).assign(
					vec4( pos.x, pos.y, goalE.add( nodeE.mul( 8 ) ),
						select( under, sim.antDyn.element( instanceIndex ).x.add(
							sim.antDyn.element( instanceIndex ).y.mul( 0.001 ) ), layerE ) ) );

			}

			// A mode change is not exempt from kinematics. Reconstruct the exact
			// track-specific mouth and require both frame endpoints, as well as the
			// complete 3D displacement, to fit in one legal movement budget.
			If( prevOk.and( sameMode.not() ), () => {

				const mouth = sampleCorridorSurfaceTSL(
					layout, int( 1 ), float( 0 ), float( 1 ), instanceIndex );
				const dynNow = sim.antDyn.element( instanceIndex );
				// Underground stores depth; surface stores height above y=0 plus a
				// tiny positive mode marker. Preserve both in the 3D transition check.
				const previousDepth = select( prevUnder, prev.w,
					max( prev.w.sub( 1e-6 ), 0 ) );
				const currentDepth = dynNow.z;
				const horizontal = length( pos.sub( prev.xy ) ).mul( TEXEL );
				const vertical = currentDepth.sub( previousDepth );
				const displacement3d = sqrt(
					horizontal.mul( horizontal ).add( vertical.mul( vertical ) ) );
				const previousMouthXZ = length( prev.xy.sub( mouth.position ) ).mul( TEXEL );
				const previousMouthY = previousDepth.sub( mouth.depth );
				const previousToMouth = sqrt( previousMouthXZ.mul( previousMouthXZ )
					.add( previousMouthY.mul( previousMouthY ) ) );
				const currentMouthXZ = length( pos.sub( mouth.position ) ).mul( TEXEL );
				const currentMouthY = currentDepth.sub( mouth.depth );
				const currentToMouth = sqrt( currentMouthXZ.mul( currentMouthXZ )
					.add( currentMouthY.mul( currentMouthY ) ) );
				const casteSpeedMax = max(
					max( sim.u.scoutSpeed, sim.u.soldierSpeed ), float( 1 ) );
				const movementBudget = sim.u.moveSpeed.mul( uDt )
					.mul( casteSpeedMax ).mul( 1.45 )
					.mul( uLaneStretch ).mul( TEXEL ).add( 0.003 );
				const transitionError = max( displacement3d,
					max( previousToMouth, currentToMouth ) );
				const surfaceHeight = select( prevUnder,
					max( currentDepth, 0 ), max( previousDepth, 0 ) );

				If( transitionError.greaterThan( movementBudget )
					.or( surfaceHeight.greaterThan( 1e-4 ) ), () => {

					atomicAdd( counters.element( 11 ), uint( 1 ) );
					emitEvent( EV.ENTREE_DISCONTINUE, max( transitionError, surfaceHeight ) );

				} );
				If( prevUnder, () => {

					atomicAdd( counters.element( 13 ), uint( 1 ) );

				} ).Else( () => {

					atomicAdd( counters.element( 12 ), uint( 1 ) );

				} );

				// Distance de route et cap n'ont pas la même sémantique de part et
				// d'autre de la bouche : la fenêtre suivante repart proprement.
				acc.x.assign( 0 ); acc.y.assign( 0 ); acc.z.assign( 0 );
				fl.assign( fl.bitAnd( uint( 0xFFFFFFFC ) ) );

			} );

			If( alive.and( under ), () => {

				// L'oracle reconstruit la pose monde depuis l'état intrinsèque. Il ne
				// consulte jamais la vieille heightmap : une divergence nav/rendu devient
				// donc une erreur mesurable au lieu d'être masquée par le même modèle.
				const dyn = sim.antDyn.element( instanceIndex );
				floorNow.assign( dyn.z );
				const edge = dyn.x.add( 0.5 ).toInt();
				const corridorFault = float( 0 ).toVar();
				const corridorError = float( 0 ).toVar();

				If( edge.greaterThan( int( 0 ) ), () => {

					If( edge.lessThan( int( layout.MAX_NODES ) ), () => {

						const meta = textureLoad( layout.corridorMetaTexture, ivec2( edge, int( 0 ) ) );
						const from = meta.x.add( 0.5 ).toInt();
						const to = meta.y.add( 0.5 ).toInt();
						const nodeI = nodeE.add( 0.5 ).toInt();
						const incident = from.equal( nodeI ).or( to.equal( nodeI ) );
						const validT = dyn.y.greaterThanEqual( - 1e-5 ).and( dyn.y.lessThanEqual( 1.00001 ) );
						const direction = select( from.equal( nodeI ), float( 1 ), float( - 1 ) );

						const expected = sampleCorridorSurfaceTSL(
							layout, edge, dyn.y, direction, instanceIndex );
						const horizontalError = length( pos.sub( expected.position.xy ) ).mul( TEXEL );
						const error3d = sqrt( horizontalError.mul( horizontalError )
							.add( dyn.z.sub( expected.depth ).mul( dyn.z.sub( expected.depth ) ) ) );
						corridorError.assign( error3d );
						If( incident.not().or( validT.not() ).or( error3d.greaterThan( 0.002 ) ), () => {

							corridorFault.assign( 1 );

						} );

					} ).Else( () => {

						corridorFault.assign( 1 );
						corridorError.assign( dyn.x );

					} );

				} ).Else( () => {

					const here = textureLoad( layout.navNodeTexture,
						ivec2( nodeE.add( 0.5 ).toInt(), int( 0 ) ) );
					const roomDistance = length( pos.sub( here.xy ) );
					const roomRadius = select( caste.isQueen, max( sim.u.queenR.sub( 2.5 ), 4 ),
						max( here.w.mul( 1.25 ), 4 ) );
					const depthError = abs( dyn.z.sub( here.z ) );
					corridorError.assign( max( roomDistance.sub( roomRadius ).mul( TEXEL ), depthError ) );
					If( dyn.x.lessThan( - 0.01 ).or( roomDistance.greaterThan( roomRadius ) )
						.or( depthError.greaterThan( 0.002 ) ), () => {

						corridorFault.assign( 1 );

					} );

				} );

				If( corridorFault.greaterThan( 0.5 ), () => {

					atomicAdd( counters.element( 2 ), uint( 1 ) );
					If( fl.bitAnd( uint( 8 ) ).equal( uint( 0 ) ), () => {

						fl.assign( fl.bitOr( uint( 8 ) ) );
						emitEvent( EV.NAPPE, corridorError );

					} );

				} ).Else( () => {

					fl.assign( fl.bitAnd( uint( 0xFFFFFFF7 ) ) );

				} );

				If( sameMode, () => {

					const dxz = length( pos.sub( prev.xy ) );
					const dxzWorld = dxz.mul( TEXEL );
					const dy = abs( floorNow.sub( prev.w ) );
					const displacement3d = sqrt( dxzWorld.mul( dxzWorld ).add( dy.mul( dy ) ) );
					const travelledWorld = abs( dyn.w.sub( prev.z ) ).mul( TEXEL );
					const kinematicBound = travelledWorld.mul( uLaneStretch ).add( 0.003 );

					If( displacement3d.greaterThan( kinematicBound ), () => {

						atomicAdd( counters.element( 0 ), uint( 1 ) );
						emitEvent( EV.TELEPORT, displacement3d );

					} );
					const warpBound = max( float( DXZ_WARP ), abs( dyn.w.sub( prev.z ) ).mul( uLaneStretch ) );
					If( dxz.greaterThan( warpBound ), () => {

						atomicAdd( counters.element( 1 ), uint( 1 ) );
						emitEvent( EV.WARP, dxz );

					} );

				} );

				If( floorNow.greaterThan( 0.01 ), () => {

					atomicAdd( counters.element( 6 ), uint( 1 ) );
					emitEvent( EV.SURFACE, floorNow );

				} );
				If( floorNow.lessThan( uDepthMax.negate().sub( 3 ) ), () => {

					atomicAdd( counters.element( 5 ), uint( 1 ) );
					emitEvent( EV.HORS_NID, floorNow );

				} );

				// --- 7 · POSE/SUPPORT 3D -----------------------------------------
				// kWatch lit ici le buffer produit par kPose juste avant lui. L'oracle
				// reconstruit le contact et le repère depuis l'état intrinsèque ; il ne
				// relit donc ni la matrice de rendu ni un résultat intermédiaire de pose.
				If( a.w.greaterThanEqual( 0 ), () => {

					const poseBase = instanceIndex.mul( uint( 3 ) );
					const posePosition = ants.pose.antPose.element( poseBase );
					const poseQuaternion = ants.pose.antPose.element( poseBase.add( uint( 1 ) ) );
					const poseMetadata = ants.pose.antPose.element( poseBase.add( uint( 2 ) ) );
					const expectedContact = vec3(
						a.x.mul( TEXEL ).sub( WORLD / 2 ), dyn.z,
						a.y.mul( TEXEL ).sub( WORLD / 2 ),
					).toVar();
					const expectedSupport = vec3( 0, 1, 0 ).toVar();
					const expectedForward = vec3( cos( a.z ), 0, sin( a.z ) ).toVar();

					If( edge.greaterThan( int( 0 ) ).and( edge.lessThan( int( layout.MAX_NODES ) ) ), () => {

						const poseMeta = textureLoad(
							layout.corridorMetaTexture, ivec2( edge, int( 0 ) ) );
						const poseDirection = select(
							poseMeta.x.add( 0.5 ).toInt().equal( nodeE.add( 0.5 ).toInt() ),
							float( 1 ), float( - 1 ),
						);
						const surface = sampleCorridorSurfaceTSL(
							layout, edge, dyn.y, poseDirection, instanceIndex );
						expectedContact.assign( vec3(
							surface.position.x.mul( TEXEL ).sub( WORLD / 2 ),
							surface.depth,
							surface.position.y.mul( TEXEL ).sub( WORLD / 2 ),
						) );
						expectedSupport.assign( surface.support );
						expectedForward.assign( surface.forward );

					} );

					const poseFinite = finiteVec4( posePosition )
						.and( finiteVec4( poseQuaternion ) )
						.and( finiteVec4( poseMetadata ) )
						.and( finiteVec3( expectedContact ) )
						.and( finiteVec3( expectedSupport ) )
						.and( finiteVec3( expectedForward ) );

					If( poseFinite.not(), () => {

						atomicAdd( counters.element( 8 ), uint( 1 ) );
						emitEvent( EV.POSE_NAN, 1 );

					} ).Else( () => {

						const expectedScale = select( caste.isSoldier, float( 1.45 ),
							select( caste.isNurse, float( 0.85 ),
								select( caste.isScout, float( 0.92 ), float( 1 ) ) ) );
						const expectedPivot = select( caste.isSoldier,
							ants.pose.u.soldierPivotY, ants.pose.u.pivotY );
						const offset = posePosition.xyz.sub( expectedContact );
						const supportHeight = dot( offset, expectedSupport );
						const lateralError = length( offset.sub(
							expectedSupport.mul( supportHeight ) ) );
						const baseHeight = expectedPivot.mul( expectedScale ).add( 0.018 );
						const maxHeight = baseHeight.add(
							abs( ants.pose.u.bobAmp ).mul( expectedScale ) );
						const heightError = max( max(
							baseHeight.sub( supportHeight ), supportHeight.sub( maxHeight ) ), 0 );
						const scaleError = abs( posePosition.w.sub( expectedScale ) );
						const supportError = max( lateralError, max( heightError, scaleError ) );

						If( lateralError.greaterThan( POSE_LATERAL_EPS )
							.or( heightError.greaterThan( POSE_HEIGHT_EPS ) )
							.or( scaleError.greaterThan( POSE_SCALE_EPS ) ), () => {

							atomicAdd( counters.element( 9 ), uint( 1 ) );
							emitEvent( EV.POSE_SUPPORT, supportError );

						} );

						const quaternionNorm = dot( poseQuaternion, poseQuaternion );
						const bodyUp = rotateByQuaternion( poseQuaternion, vec3( 0, 1, 0 ) );
						const bodyForward = rotateByQuaternion( poseQuaternion, vec3( 0, 0, 1 ) );
						const upDot = dot( bodyUp, expectedSupport );
						const forwardDot = dot( bodyForward, expectedForward );
						const orientationError = max( abs( quaternionNorm.sub( 1 ) ), max(
							max( float( POSE_UP_DOT_MIN ).sub( upDot ), 0 ),
							max( float( POSE_FORWARD_DOT_MIN ).sub( forwardDot ), 0 ) ) );

						If( abs( quaternionNorm.sub( 1 ) ).greaterThan( POSE_QNORM_EPS )
							.or( upDot.lessThan( POSE_UP_DOT_MIN ) )
							.or( forwardDot.lessThan( POSE_FORWARD_DOT_MIN ) ), () => {

							atomicAdd( counters.element( 10 ), uint( 1 ) );
							emitEvent( EV.POSE_ORIENTATION, orientationError );

						} );

					} );

				} );

			} );

			// --- 4/5 · TOUPIE & BLOCAGE : fenêtre glissante, toutes vivantes ---
			// MAIS PAS PENDANT LE REPOS : la sim a un cycle paresseux par DESIGN
			// (simulation.js — jusqu'à ~80 % du temps immobile) ; une fourmi qui
			// dort n'est pas une fourmi bloquée. Le cycle vient de la politique
			// partagée avec la simulation et l'inspecteur ; la fenêtre de mesure
			// est gelée pendant la sieste.
			const hungryR = sim.antVital.element( instanceIndex ).z.lessThan( sim.u.hungryHome );
			const resting = under.and( caste.isQueen.not() ).and( sim.restStateOf(
				instanceIndex,
				state.equal( uint( 1 ) ),
				hungryR,
				caste.isNurse,
			).resting );
			const routeGoalNode = select( goalE.lessThan( 0.5 ), nodeE,
				select( goalE.lessThan( 1.5 ), sim.u.granaryNode,
					select( goalE.lessThan( 2.5 ), sim.u.queenNode,
						select( goalE.lessThan( 3.5 ), sim.u.broodNode, float( 0 ) ) ) ) );
			const travelRequired = under.not().or( sim.antDyn.element( instanceIndex ).x.greaterThan( 0.5 ) )
				.or( abs( nodeE.sub( routeGoalNode ) ).greaterThan( 0.5 ) );

			const awaitingActivation = sim.antData.element( instanceIndex ).w.lessThan( 0 );

			If( alive.and( resting.not() ).and( awaitingActivation.not() ).and( travelRequired ), () => {

				If( sameMode, () => {

					// écart angulaire ramené dans [0, π]
					const dyaw = abs( yaw.sub( prev.z ) ).mod( PI2 );
					const angleDelta = select( dyaw.greaterThan( Math.PI ), PI2.sub( dyaw ), dyaw );
					acc.x.addAssign( select( under, float( 0 ), angleDelta ) );
					acc.y.addAssign( length( pos.sub( prev.xy ) ) );
					acc.z.addAssign( uDt );

				} );

				If( acc.z.greaterThanEqual( float( SPIN_T ) ), () => {

					const spinning = acc.x.greaterThan( float( SPIN_ROT ) )
						.and( acc.y.lessThan( float( SPIN_MOVE ) ) );
					const stuck = acc.y.lessThan( float( STUCK_MOVE ) );

					If( spinning.and( fl.bitAnd( uint( 1 ) ).equal( uint( 0 ) ) ), () => {

						fl.assign( fl.bitOr( uint( 1 ) ) );
						atomicAdd( counters.element( 3 ), uint( 1 ) );
						emitEvent( EV.TOUPIE, acc.x );

					} );
					If( stuck.and( fl.bitAnd( uint( 2 ) ).equal( uint( 0 ) ) ), () => {

						fl.assign( fl.bitOr( uint( 2 ) ) );
						atomicAdd( counters.element( 4 ), uint( 1 ) );
						emitEvent( EV.BLOQUE, acc.y );

					} );
					// rémission : elle a bougé franchement → drapeaux retombés
					If( acc.y.greaterThan( float( SPIN_MOVE ) ), () => {

						fl.assign( fl.bitAnd( uint( 0xFFFFFFFC ) ) );

					} );

					acc.x.assign( 0 );
					acc.y.assign( 0 );
					acc.z.assign( 0 );

				} );

			} ).Else( () => {

				// --- 7 · MORT EN TOUPIE : comptée une fois, à rapprocher de
				// l'énergie relue côté CPU (faim) pour qualifier le bug
				If( state.equal( uint( 2 ) )
					.and( fl.bitAnd( uint( 1 ) ).notEqual( uint( 0 ) ) )
					.and( fl.bitAnd( uint( 4 ) ).equal( uint( 0 ) ) ), () => {

					fl.assign( fl.bitOr( uint( 4 ) ) );
					atomicAdd( counters.element( 7 ), uint( 1 ) );
					emitEvent( EV.MORT_TOUPIE, 0 );

				} );

			} );

			acc.w.assign( fl.toFloat() );
			prevData.element( instanceIndex ).assign(
				vec4( pos.x, pos.y, select( under, sim.antDyn.element( instanceIndex ).w, yaw ),
					// y=0 is a valid underground contact. Keep underground strictly
					// negative; on surface retain physical height plus a positive marker.
					select( under, min( floorNow, float( - 1e-6 ) ),
						max( sim.antDyn.element( instanceIndex ).z, 0 ).add( 1e-6 ) ) ) );
			spinAcc.element( instanceIndex ).assign( acc );

		} );

	} )().compute( MAX_ANTS );

	const kWatchReset = Fn( () => {

		prevData.element( instanceIndex ).assign( vec4( 0, 0, 0, - 999 ) );
		spinAcc.element( instanceIndex ).assign( vec4( 0 ) );

	} )().compute( MAX_ANTS );

	const kCountersReset = Fn( () => {

		atomicStore( counters.element( instanceIndex ), uint( 0 ) );

	} )().compute( 16 );


	const kCursorReset = Fn( () => {

		atomicStore( evCursor.element( 0 ), uint( 0 ) );

	} )().compute( 1 );

	// ------------------------------------------------------------------
	// Orchestrateur CPU
	// ------------------------------------------------------------------
	let simClock = 0;

	function resetWatch( preserveClock = false ) {

		renderer.compute( [ kWatchReset, kCountersReset, kCursorReset ] );
		if ( ! preserveClock ) simClock = 0;
		const deepest = Math.min( 0,
			... ( layout.navigation?.nodes || [] ).map( ( node ) => node.depth ) );
		uDepthMax.value = Math.max( layout.depthMax || MIN_NEST_DEPTH, - deepest );

		uLaneStretch.value = layout.navigation?.maxLaneStretch || 1;
	}

	function primeWatch() {

		// Capture la pose initiale avant le premier pas : une transition forcée au
		// pas 1 reste ainsi observable et soumise à l'oracle cinématique complet.
		renderer.compute( ants.pose.kPose );
		renderer.compute( kWatch );

	}

	// pas manuels surveillés : sim → colonie → veille (les readbacks async
	// respirent périodiquement via readStatsDirect)
	async function steps( seconds, withColony = true ) {

		const total = Math.round( seconds * 60 );

		for ( let i = 0; i < total; i ++ ) {

			sim.step( 1 / 60 );
			if ( withColony ) colony.step( 1 / 60 );
			simClock += 1 / 60;
			uSimTime.value = simClock;
			// Le contrôle de pose doit lire exactement la transformation destinée
			// au rendu pour ce pas, jamais le buffer de la frame précédente.
			renderer.compute( ants.pose.kPose );
			renderer.compute( kWatch );
			if ( i % 240 === 239 ) await sim.readStatsDirect();   // synchro + yield

		}

	}

	async function readWatch() {

		const c = new Uint32Array( await renderer.getArrayBufferAsync( counters.value ) );
		const cur = new Uint32Array( await renderer.getArrayBufferAsync( evCursor.value ) )[ 0 ];
		const ev = new Float32Array( await renderer.getArrayBufferAsync( events.value ) );
		const ex = new Float32Array( await renderer.getArrayBufferAsync( evExtra.value ) );
		const n = Math.min( cur, N_EVENTS );
		const list = [];

		for ( let i = 0; i < n; i ++ ) {

			const gn = Math.round( ex[ i * 4 + 2 ] );
			list.push( { ant: Math.round( ev[ i * 4 ] ), type: Math.round( ev[ i * 4 + 1 ] ),
				typeNom: EV_NOMS[ Math.round( ev[ i * 4 + 1 ] ) ] || '?',
				value: + ev[ i * 4 + 2 ].toFixed( 2 ), t: + ev[ i * 4 + 3 ].toFixed( 1 ),
				x: + ex[ i * 4 ].toFixed( 1 ), y: + ex[ i * 4 + 1 ].toFixed( 1 ),
				goal: gn % 8, node: Math.floor( gn / 8 ), layer: Math.round( ex[ i * 4 + 3 ] ),
				edge: Math.floor( ex[ i * 4 + 3 ] + 1e-5 ),
				progress: + ( ( ex[ i * 4 + 3 ] % 1 ) * 1000 ).toFixed( 4 ) } );

		}

		return { counters: Array.from( c ), events: list, overflow: cur > N_EVENTS };

	}

	function hooks() {

		return {

			activateAnts( k ) {

				const from = params.antCount;
				const target = Math.min( 65536, from + k );
				if ( target <= from ) return;
				sim.spawnHatched( from );
				params.antCount = target;
				sim.u.antCount.value = target;
				ants.setCount( target );
				cones.setCount( target );

			},
		};

	}

	async function tickColony() {

		const st = await sim.readStatsDirect();
		colony.onStats( st, hooks() );
		await colony._dbg.pollBrood();
		return st;

	}

	// ------------------------------------------------------------------
	// CYCLE DE VIE : suivi d'un échantillon de fourmis pendant le scénario
	// ------------------------------------------------------------------
	function makeLifeTracker( sampleN ) {

		const n = Math.min( sampleN, params.antCount );
		const antsT = [];

		for ( let i = 0; i < n; i ++ ) {

			// stratifié : reine + population répartie sur tout l'indice
			const idx = i === 0 ? 0 : Math.floor( ( i - 1 ) * ( params.antCount - 1 ) / Math.max( 1, n - 2 ) );
			antsT.push( { idx, path: 0, states: new Set(), minEnergy: 1,
				dead: - 1, deathEnergy: - 1, lastPos: null, routeTrace: [] } );

		}

		return {

			antsT,

			async sample() {

				const N = params.antCount;
				const st = new Uint32Array( await renderer.getArrayBufferAsync( sim.antState.value, null, 0, N * 4 ) );
				const d = new Float32Array( await renderer.getArrayBufferAsync( sim.antData.value, null, 0, N * 16 ) );
				const v = new Float32Array( await renderer.getArrayBufferAsync( sim.antVital.value, null, 0, N * 16 ) );
				const nav = new Float32Array( await renderer.getArrayBufferAsync( sim.antDyn.value, null, 0, N * 16 ) );

				for ( const t of antsT ) {

					if ( t.idx >= N ) continue;
					const state = st[ t.idx ] & 7;
					const px = d[ t.idx * 4 ], py = d[ t.idx * 4 + 1 ];
					const energy = v[ t.idx * 4 + 2 ];
					const under = ( st[ t.idx ] & 8 ) !== 0;
					const node = ( st[ t.idx ] >>> 7 ) & 127;
					const goal = ( st[ t.idx ] >>> 4 ) & 7;
					const edge = under ? Math.round( nav[ t.idx * 4 ] ) : 0;
					const progress = under ? nav[ t.idx * 4 + 1 ] : 0;
					const depth = under ? nav[ t.idx * 4 + 2 ] : 0;
					const routeDistance = under ? nav[ t.idx * 4 + 3 ] : 0;

					if ( t.lastPos ) t.path += Math.hypot(
						( px - t.lastPos[ 0 ] ) * TEXEL,
						( py - t.lastPos[ 1 ] ) * TEXEL,
						depth - t.lastPos[ 2 ] );
					t.lastPos = [ px, py, depth ];
					t.routeTrace.push( { tick: Math.round( simClock * 60 ), node, goal, edge,
						progress: + progress.toFixed( 5 ), distance: + routeDistance.toFixed( 3 ),
						x: + ( px * TEXEL ).toFixed( 3 ), z: + ( py * TEXEL ).toFixed( 3 ),
						depth: + depth.toFixed( 3 ) } );
					t.states.add( state );
					if ( state < 2 ) t.minEnergy = Math.min( t.minEnergy, energy );
					if ( state === 2 && t.dead < 0 ) { t.dead = simClock; t.deathEnergy = energy; }

				}

			},

			report() {

				// gardes-fous du cycle de vie (bornes, la sim est stochastique)
				const bad = [];
				let healthy = 0;

				for ( const t of antsT ) {

					const issues = [];
					const isQueen = t.idx === 0;
					const lived = t.dead < 0 ? simClock : t.dead;

					// « elle se déplace » — une vivante parcourt un vrai chemin
					// (la reine, sédentaire, en est exempte ; 20 s de grâce)
					if ( ! isQueen && lived > 20 && t.path < 5 ) issues.push( `immobile (${ t.path.toFixed( 1 ) } u)` );
					// « elle fait quelque chose » — hors reine, une fourmi active
					// change d'état au moins une fois en 4 min. Une éclaireuse qui
					// explore 300 s sans trouver est saine : le critère ne mord que
					// si le chemin est dérisoire (robot figé, sinon simple patience)
					if ( ! isQueen && lived > 200 && t.states.size < 2 && t.path < 50 ) issues.push( 'jamais changé d\'état' );
					// « sa mort s'explique » — faim ou venin, jamais « gratuitement »
					if ( t.dead >= 0 && t.deathEnergy > 0.05 ) issues.push( `morte énergie=${ t.deathEnergy.toFixed( 2 ) }` );

					if ( issues.length ) bad.push( { idx: t.idx, issues, path: + t.path.toFixed( 1 ),
						states: [ ...t.states ], dead: + t.dead.toFixed( 1 ), minEnergy: + t.minEnergy.toFixed( 2 ) } );
					else healthy ++;

				}

				return { total: antsT.length, healthy, bad,
					traces: antsT.map( ( ant ) => ( { idx: ant.idx, samples: ant.routeTrace } ) ) };

			},

		};

	}

	// ------------------------------------------------------------------
	// TESTS UNITAIRES du nid (purs, instantanés, sans GPU)
	// ------------------------------------------------------------------
	function unitTests() {

		const out = [];
		const ok = ( name, pass, detail ) => out.push( { name, pass, detail } );

		// déterminisme du registre : même k → même loge, quel que soit l'ordre
		{

			const a = nestUnit( 7, MIN_NEST_DEPTH ), b = nestUnit( 7, MIN_NEST_DEPTH );
			ok( 'nestUnit déterministe',
				a.x === b.x && a.y === b.y && a.depth === b.depth && a.rwx === b.rwx,
				`loge 7 : (${ a.x.toFixed( 1 ) }, ${ a.y.toFixed( 1 ) }, prof ${ a.depth.toFixed( 1 ) })` );

		}
		// append-only : agrandir ne déplace JAMAIS une loge existante
		{

			const n10 = buildNest( 10, MIN_NEST_DEPTH, 6 );
			const n20 = buildNest( 20, MIN_NEST_DEPTH, 6 );
			let moved = 0;

			for ( let k = 0; k < 10; k ++ ) {

				if ( n10.units[ k ].x !== n20.units[ k ].x || n10.units[ k ].depth !== n20.units[ k ].depth ) moved ++;

			}

			ok( 'registre append-only', moved === 0, `${ moved } loge(s) déplacée(s) en grandissant 10→20` );

		}
		// bornes physiques du registre complet. La profondeur d'une loge est
		// −depthMax·zf·(0,94+0,12·vdc) : le jitter la pousse jusqu'à
		// −depthMax·1,06 — EN DESSOUS du depthMax nominal, mais la marge +3 du
		// volume baké (nestvolume.js) la couvre. La garde est donc à 1,06.
		{

			let badDepth = 0, badLayer = 0, badParent = 0;
			const nAll = buildNest( K_MAX, MIN_NEST_DEPTH, 6 );

			for ( const uN of nAll.units ) {

				if ( uN.depth > 0.01 || uN.depth < - MIN_NEST_DEPTH * 1.06 - 0.01 ) badDepth ++;
				if ( uN.layer < 0 || uN.layer > 3 ) badLayer ++;

			}

			for ( let k = 0; k < K_MAX; k ++ ) if ( nAll.parents[ k ] >= k || nAll.parents[ k ] < - 1 ) badParent ++;
			ok( 'bornes du registre (profondeur, nappe, parent)',
				badDepth === 0 && badLayer === 0 && badParent === 0,
				`profondeur hors [-${ ( MIN_NEST_DEPTH * 1.06 ).toFixed( 1 ) }, 0]=${ badDepth }, nappe hors 0..3=${ badLayer }, parents invalides=${ badParent }` );

		}
		// connexité : chaque nœud retombe sur la racine (parent −1 = puits)
		{

			const nAll = buildNest( K_MAX, MIN_NEST_DEPTH, 6 );
			let orphans = 0;

			for ( let k = 1; k < K_MAX; k ++ ) {

				let j = k, hops = 0;
				while ( nAll.parents[ j ] >= 0 && hops <= K_MAX ) { j = nAll.parents[ j ]; hops ++; }
				if ( nAll.parents[ j ] >= 0 ) orphans ++;   // cycle : jamais retombé

			}

			ok( 'graphe du nid connexe', orphans === 0, `${ orphans } nœud(s) en cycle sans racine` );

		}
		// chaque loge active a bien une cavité dans la carte (sur SA nappe)
		{

			const nAll = buildNest( 24, MIN_NEST_DEPTH, 6 );
			let missing = 0;

			for ( let k = 0; k < 24; k ++ ) {

				const uN = nAll.units[ k ];
				if ( nAll.depthAt( Math.round( uN.x ), Math.round( uN.y ), uN.layer ) > - 1e-4 ) missing ++;

			}

			ok( 'loges creusées sur leur nappe', missing === 0,
				`${ missing } centre(s) de loge sans cavité sur leur propre nappe` );

		}

		return out;

	}

	// ------------------------------------------------------------------
	// SCÉNARIOS DE LA CAMPAGNE
	// ------------------------------------------------------------------
	async function captureVolumeGpuProof( caseId ) {

		if ( ! nestVolume ) return {
			id: NEST_VOLUME_GPU_PROBE_ID,
			caseId,
			pass: false,
			fresh: false,
			stale: true,
			error: 'nestVolume unavailable',
		};
		try {

			const bake = nestVolume.rebuild();
			const proof = await nestVolume.probeCleanSurface();
			const bindingMatches = proof.bakeRevision === bake.bakeRevision
				&& proof.layoutRevision === bake.layoutRevision
				&& proof.layoutSignature === bake.layoutSignature;
			const captured = {
				... proof,
				caseId,
				pass: proof.pass === true && bindingMatches,
				fresh: proof.fresh === true && bindingMatches,
				stale: proof.stale === true || ! bindingMatches,
				captureBinding: {
					pass: bindingMatches,
					expectedBakeRevision: bake.bakeRevision,
					expectedLayoutRevision: bake.layoutRevision,
					expectedLayoutSignature: bake.layoutSignature,
				},
			};
			console.log( `[${ NEST_VOLUME_GPU_PROBE_ID }:${ caseId }] ${ captured.pass ? 'PASS' : 'FAIL' }` );
			return captured;

		} catch ( error ) {

			return {
				id: NEST_VOLUME_GPU_PROBE_ID,
				caseId,
				pass: false,
				fresh: false,
				stale: true,
				error: error instanceof Error ? error.message : String( error ),
			};

		}

	}

	async function runScenario( sc ) {

		console.log( `🛡 Scénario « ${ sc.name } » (${ sc.seconds } s sim, ${ sc.ants } fourmis)…` );
		params.antCount = sc.ants;
		sim.u.seed.value = sc.seed ?? 20260726;
		sim.u.antCount.value = sc.ants;
		ants.setCount( sc.ants );
		cones.setCount( sc.ants );
		if ( sc.configure ) sc.configure();
		sim.applyLayout();
		const volumeGpuProofs = [];
		if ( sc.volumeProofCase )
			volumeGpuProofs.push( await captureVolumeGpuProof( sc.volumeProofCase ) );
		await sim.reset();
		await colony.reset();
		if ( sc.setup ) {

			await sc.setup();
			await sim.synchronize();

		}
		resetWatch();
		primeWatch();

		const life = makeLifeTracker( 48 );
		let lastStats = null;
		const watchSegments = [];
		const chunks = Math.max( sc.during ? 2 : 1, Math.round( sc.seconds / 10 ) );

		for ( let c = 0; c < chunks; c ++ ) {

			await steps( sc.seconds / chunks );
			if ( sc.during && c + 1 === Math.ceil( chunks / 2 ) ) {

				watchSegments.push( await readWatch() );
				const mutationApplied = await sc.during();
				if ( sc.volumeProofAfterMutation ) volumeGpuProofs.push(
					mutationApplied === false
						? {
							id: NEST_VOLUME_GPU_PROBE_ID,
							caseId: sc.volumeProofAfterMutation,
							pass: false, fresh: false, stale: true,
							error: 'Expected geometry mutation was not applied',
						}
						: await captureVolumeGpuProof( sc.volumeProofAfterMutation ) );
				// Nouvelle fenêtre de vitesse : le commit lui-même est couvert par la
				// validation immuable du préfixe ; les pas suivants repartent d'une pose connue.
				resetWatch( true );
				await sim.synchronize();

			}
			lastStats = await tickColony();
			await life.sample();

		}

		const watch = await readWatch();
		for ( const segment of watchSegments ) {

			for ( let i = 0; i < watch.counters.length; i ++ )
				watch.counters[ i ] += segment.counters[ i ] || 0;
			watch.events = [ ... segment.events, ... watch.events ];
			watch.overflow ||= segment.overflow;

		}
		const lifeRep = life.report();
		const st = lastStats || {};

		const rep = {

			name: sc.name,
			seconds: sc.seconds,
			ants: params.antCount,
			stats: { morts: st.eaten ?? - 1, livraisons: st.delivered ?? - 1,
				pontes: st.laid ?? - 1, éclosions: st.hatched ?? - 1 },
			anomalies: {
				depassementsCinematiques3D: watch.counters[ 0 ],
				warpXZ: watch.counters[ 1 ],
				horsCorridor: watch.counters[ 2 ],
				toupies: watch.counters[ 3 ],
				bloquées: watch.counters[ 4 ],
				sousLeNid: watch.counters[ 5 ],
				enSurface: watch.counters[ 6 ],
				mortsEnToupie: watch.counters[ 7 ],
				posesNonFinies: watch.counters[ 8 ],
				pivotsHorsSupport: watch.counters[ 9 ],
				orientationsHorsRepere: watch.counters[ 10 ],
				transitionsBoucheDiscontinues: watch.counters[ 11 ],
			},
			transitionsObservees: {
				surfaceVersNid: watch.counters[ 12 ],
				nidVersSurface: watch.counters[ 13 ],
			},
			events: watch.events.slice( 0, 40 ),
			eventsOverflow: watch.overflow,
			cycleDeVie: lifeRep,
			volumeGpuProofs,

		};

		// Un seul écart structurel suffit à faire échouer la campagne. Le scénario
		// de preuve bouche ajoute en plus une exigence positive dans les deux sens.
		const structuralPass = watch.counters.slice( 0, 12 ).every( ( value ) => value === 0 );
		const requiredTransitions = sc.requiredTransitions ?? {};
		const transitionPass = rep.transitionsObservees.surfaceVersNid
			>= ( requiredTransitions.surfaceVersNid ?? 0 )
			&& rep.transitionsObservees.nidVersSurface
			>= ( requiredTransitions.nidVersSurface ?? 0 );
		const volumeGpuPass = volumeGpuProofs.every( isFreshNestVolumeProof )
			&& ( ! sc.volumeProofCase || volumeGpuProofs.some(
				( proof ) => proof.caseId === sc.volumeProofCase ) )
			&& ( ! sc.volumeProofAfterMutation || volumeGpuProofs.some(
				( proof ) => proof.caseId === sc.volumeProofAfterMutation ) );
		const ok = structuralPass && transitionPass && volumeGpuPass;

		if ( sc.proofId ) rep.preuveRuntime = {
			id: sc.proofId,
			pass: ok,
			surfaceVersNid: rep.transitionsObservees.surfaceVersNid,
			nidVersSurface: rep.transitionsObservees.nidVersSurface,
		};
		rep.pass = ok;
		console.log( `${ ok ? '✅' : '❌' } « ${ sc.name } » — cinématique3D=${ rep.anomalies.depassementsCinematiques3D }`
			+ ` horsCorridor=${ rep.anomalies.horsCorridor }, toupies=${ rep.anomalies.toupies }`
			+ ` bloquées=${ rep.anomalies.bloquées } mortsEnToupie=${ rep.anomalies.mortsEnToupie }`
			+ ` poseNaN=${ rep.anomalies.posesNonFinies } support=${ rep.anomalies.pivotsHorsSupport }`
			+ ` orientation=${ rep.anomalies.orientationsHorsRepere }`
			+ ` transition=${ rep.anomalies.transitionsBoucheDiscontinues }`
			+ ` entrée/sortie=${ rep.transitionsObservees.surfaceVersNid }/${ rep.transitionsObservees.nidVersSurface }`
			+ ` cycle=${ rep.cycleDeVie.healthy }/${ rep.cycleDeVie.total } saines` );
		if ( ! ok && rep.events.length ) {

			console.log( `[warden-events] ${ JSON.stringify( rep.events.slice( 0, 8 ) ) }` );
			console.log( `[warden-traces] ${ JSON.stringify( lifeRep.traces.slice( - 8 ) ) }` );

		}

		return rep;

	}

	async function run( opts = {} ) {

		const seconds = opts.seconds || + new URLSearchParams( location.search ).get( 'wdur' ) || 120;
		console.log( `🛡 WARDEN — campagne (${ seconds } s sim par scénario)` );

		const saved = JSON.parse( JSON.stringify( { params: { ...params }, gfx: { ...gfx } } ) );
		const savedPop = params.antCount;
		params.paused = true;
		colony._dbg.setManualTick( true );

		const report = {
			unit: [], scenarios: [], volumeGpuProofs: [], volumeGpuProbe: null,
			startedAt: new Date().toISOString(),
		};

		try {

			report.volumeGpuProofs.push(
				await captureVolumeGpuProof( 'initial-current' ) );

			// --- tests unitaires (instantanés) ---
			report.unit = unitTests();

			for ( const t of report.unit ) {

				console.log( `${ t.pass ? '✅' : '❌' } [unit] ${ t.name } — ${ t.detail }` );

			}

			// --- scénarios d'intégration ---
			const scenarios = [
				{
					name: `preuve bouche déterministe [${ WARDEN_ENTRANCE_PROOF_ID }]`,
					ants: 8,
					seconds: 0.5,
					setup: () => renderer.compute( kEntranceProofSetup ),
					requiredTransitions: { surfaceVersNid: 1, nidVersSurface: 1 },
					proofId: WARDEN_ENTRANCE_PROOF_ID,
				},
				{ name: 'référence', ants: 869, seconds },
				{ name: 'colonie dense', ants: 2048, seconds },
				{ name: 'capacité maximale', ants: MAX_ANTS, seconds: Math.min( seconds, 5 ) },
				{ name: 'profondeur minimale', ants: 869, seconds: Math.min( seconds, 10 ),
					configure: () => { params.nestDepth = MIN_NEST_DEPTH; sim.layout.rebuild(); },
					volumeProofCase: 'depth-min' },
				{ name: 'profondeur extrême', ants: 869, seconds: Math.min( seconds, 10 ),
					configure: () => { params.nestDepth = MAX_NEST_DEPTH; sim.layout.rebuild(); },
					volumeProofCase: 'depth-max' },
				{ name: 'tunnels étroits', ants: 869, seconds,
					configure: () => { params.nestTunnelW = MIN_TUNNEL_WIDTH; sim.layout.rebuild(); },
					volumeProofCase: 'tunnel-min' },
				{ name: 'tunnels larges', ants: 869, seconds,
					configure: () => { params.nestTunnelW = 10; sim.layout.rebuild(); },
					volumeProofCase: 'tunnel-wide' },
				{ name: 'famine', ants: 869, seconds: Math.min( seconds, 150 ),
					configure: () => {

						sim.u.granaryStart.value = 0;
						sim.u.energyLife.value = 45;

					} },
				{ name: 'croissance append-only en trajet', ants: 869, seconds: Math.min( seconds, 20 ),
					configure: () => { params.nestScale = 1; sim.layout.rebuild(); },
					during: async () => {
						await sim.synchronize();
						const grew = sim.layout.growTo( Math.min( K_MAX, sim.layout.K + 4 ) );
						if ( grew ) sim.applyLayout();
						await sim.synchronize();
						return grew;
					},
					volumeProofAfterMutation: 'growth' },
			];

			for ( const sc of scenarios ) {

				const scenarioReport = await runScenario( sc );
				report.scenarios.push( scenarioReport );
				report.volumeGpuProofs.push( ... scenarioReport.volumeGpuProofs );
				// remet les réglages du scénario précédent
				Object.assign( params, saved.params );
				sim.u.energyLife.value = params.energyLife;
				sim.u.granaryStart.value = params.granaryStart;
				sim.layout.rebuild();

			}

		} finally {

			Object.assign( params, saved.params );
			Object.assign( gfx, saved.gfx );
			params.antCount = savedPop;
			sim.u.antCount.value = savedPop;
			ants.setCount( savedPop );
			cones.setCount( savedPop );
			sim.layout.rebuild();
			sim.applyLayout();
			report.volumeGpuProofs.push(
				await captureVolumeGpuProof( 'restored-current' ) );
			await sim.reset();
			await colony.reset();
			sim.refreshDisplay();
			sim.updateFieldNodes();
			colony._dbg.setManualTick( false );
			params.paused = false;

		}

		report.volumeGpuProbe = buildVolumeGpuProofVerdict( report.volumeGpuProofs );
		console.log( `[${ NEST_VOLUME_GPU_PROBE_ID }] matrice volume: `
			+ `${ report.volumeGpuProbe.counts.passed }/${ report.volumeGpuProbe.counts.total } `
			+ `${ report.volumeGpuProbe.pass ? 'PASS' : 'FAIL' }` );

		const surfaceVersNid = report.scenarios.reduce( ( total, scenario ) =>
			total + scenario.transitionsObservees.surfaceVersNid, 0 );
		const nidVersSurface = report.scenarios.reduce( ( total, scenario ) =>
			total + scenario.transitionsObservees.nidVersSurface, 0 );
		report.couvertureTransitions = {
			surfaceVersNid,
			nidVersSurface,
			allerRetourObserve: surfaceVersNid > 0 && nidVersSurface > 0,
		};
		if ( ! report.couvertureTransitions.allerRetourObserve )
			console.warn( `WARDEN — ${ WARDEN_ENTRANCE_PROOF_ID } FAIL : aucune preuve aller-retour complète.` );

		const verdict = buildWardenVerdict(
			report.unit, report.scenarios, report.couvertureTransitions,
			report.volumeGpuProbe );
		report.pass = verdict.pass;
		report.score = verdict.score;
		report.verdicts = verdict.checks;
		const entranceProof = report.scenarios.find(
			( scenario ) => scenario.preuveRuntime?.id === WARDEN_ENTRANCE_PROOF_ID );
		const restoredVolumeProof = report.volumeGpuProofs.find(
			( proof ) => proof.caseId === 'restored-current' );
		report.preuvesRuntime = {
			[ WARDEN_ENTRANCE_PROOF_ID ]: {
				pass: entranceProof?.pass === true,
				surfaceVersNid,
				nidVersSurface,
			},
			[ NEST_VOLUME_GPU_PROBE_ID ]: {
				pass: report.volumeGpuProbe?.pass === true,
				counts: report.volumeGpuProbe?.counts ?? null,
				checks: report.volumeGpuProbe?.checks ?? null,
				bakeRevision: restoredVolumeProof?.bakeRevision ?? null,
				layoutRevision: restoredVolumeProof?.layoutRevision ?? null,
				layoutSignature: restoredVolumeProof?.layoutSignature ?? null,
			},
		};
		console.log( `${ report.pass ? '✅' : '❌' } WARDEN — fin de campagne : ${ report.score }`
			+ ` · ${ WARDEN_ENTRANCE_PROOF_ID }=${ report.couvertureTransitions.allerRetourObserve ? 'PASS' : 'FAIL' }` );
		window.__antwarden = report;
		// Le navigateur de CI s'exécute dans un monde JS isolé ; le dataset est
		// son contrat de lecture, tandis que __antwarden reste l'API de debug.
		if ( typeof document !== 'undefined' )
			document.documentElement.dataset.antWarden = JSON.stringify( report );
		return report;

	}

	return { run };

}
