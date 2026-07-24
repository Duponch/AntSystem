// RAGDOLL XPBD SUR GPU — pool borné, dispatch INDIRECT.
//
// Ce qu'il apporte par rapport à la culbute en forme fermée de kPose : les
// MEMBRES vivent. Une fourmi qui meurt ne prend pas une pose bakée, elle
// s'effondre patte par patte ; un cadavre drape sur le relief ; une araignée
// qui marche dessus le déforme ; les pattes retombent avec leur propre inertie.
//
// TROIS DÉCISIONS QUI FONT TOUT LE COÛT :
//
// 1. RAGDOLL EN ESPACE-POSE. Les 15 particules vivent en coordonnées LOCALES
//    autour du pivot de la fourmi, pas dans le monde. La TRAJECTOIRE reste
//    possédée par le noyau de simulation (antData) — le ragdoll n'exprime que
//    l'attitude des membres. Conséquences : aucune dérive numérique en float32
//    (les coordonnées restent dans [-1, 1]), et surtout aucune désynchro-
//    nisation : l'araignée qui vient dévorer le cadavre le trouve toujours là
//    où la simulation dit qu'il est.
//
// 2. POOL + DISPATCH INDIRECT. Le pool est un anneau de `rdBudget` slots. Un
//    compute compacte les ragdolls RÉVEILLÉS dans une liste et écrit lui-même
//    le nombre de workgroups à lancer : un cadavre endormi ne coûte pas même un
//    thread démarré, et le CPU n'apprend jamais combien il y en a.
//
// 3. SOMMEIL. Un ragdoll dont les particules ne bougent plus est retiré de la
//    liste active ; ses matrices d'os ne sont plus recalculées et il continue de
//    s'afficher pour zéro coût de simulation. C'est ce qui permet d'avoir des
//    centaines de cadavres articulés à l'écran.
//
// SKINNING : le rig de la fourmi est RIGIDE (une seule influence par sommet,
// vérifié au parse du GLB). Un ragdoll n'a donc besoin que d'UNE transformation
// par sommet — un quaternion + une origine — au lieu des quatre matrices d'un
// skinning classique.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, instanceIndex, uniform, uniformArray, instancedArray, storage,
	attribute, varyingProperty,
	float, int, uint, vec3, vec4, positionLocal,
	abs, min, max, clamp, floor, select, normalize, cross, dot, length, mix, hash,
	atomicAdd, atomicStore, atomicLoad, textureLoad,
} from 'three/tsl';

import { qrot } from './pose.js';
import { MAX_ANTS, TEXEL, WORLD, params, gfx } from './config.js';

// --- topologie du ragdoll -------------------------------------------------
// 15 particules : le tronc (3) + un genou et un tarse par patte (12).
const P_THORAX = 0, P_HEAD = 1, P_GASTER = 2;
const LEGS = [ 'FL', 'FR', 'ML', 'MR', 'RL', 'RR' ];
const N_PART = 15;
const SUBSTEPS = 8;              // constante de compilation : la boucle se déroule
const FIXED_H = 1 / 60;

export function createRagdoll( { sim, vat, pose, renderer, camera } ) {

	const rig = vat.rig;
	const MAX_RD = Math.max( 1, Math.min( 512, gfx.rdBudget | 0 ) || 192 );
	const nameIdx = ( n ) => rig.boneNames.indexOf( n );

	const restOf = ( bi ) => new THREE.Vector3(
		rig.boneRest[ bi * 3 ], rig.boneRest[ bi * 3 + 1 ], rig.boneRest[ bi * 3 + 2 ] );
	const axisOf = ( bi ) => new THREE.Vector3(
		rig.boneAxis[ bi * 3 ], rig.boneAxis[ bi * 3 + 1 ], rig.boneAxis[ bi * 3 + 2 ] );

	// --- particules, en espace VAT normalisé RELATIF AU PIVOT ---------------
	const pivot = new THREE.Vector3( 0, vat.pivotY, 0 );
	const bind = [];                       // THREE.Vector3 × 15
	const invMass = new Float32Array( N_PART );

	bind[ P_THORAX ] = restOf( nameIdx( 'root' ) ).sub( pivot );
	bind[ P_HEAD ] = restOf( nameIdx( 'head' ) ).sub( pivot );
	bind[ P_GASTER ] = restOf( nameIdx( 'abdomen' ) ).sub( pivot );
	invMass[ P_THORAX ] = 0.5; invMass[ P_HEAD ] = 1.2; invMass[ P_GASTER ] = 0.8;

	const femurIdx = [], tibiaIdx = [];

	LEGS.forEach( ( L, k ) => {

		const fb = nameIdx( `leg${L[ 0 ]}${L[ 1 ]}F` );
		const tb = nameIdx( `leg${L[ 0 ]}${L[ 1 ]}T` );
		femurIdx.push( fb ); tibiaIdx.push( tb );
		const knee = restOf( tb ).sub( pivot );
		// le TARSE n'est matérialisé par aucun os : c'est le bout de chair le
		// plus éloigné le long de l'axe du tibia (mesuré au bake)
		const tip = knee.clone().addScaledVector( axisOf( tb ), rig.boneLen[ tb ] );
		bind[ 3 + k * 2 ] = knee;
		bind[ 4 + k * 2 ] = tip;
		invMass[ 3 + k * 2 ] = 2.5;
		invMass[ 4 + k * 2 ] = 4.0;

	} );

	// --- contraintes de distance -------------------------------------------
	// α̃ = compliance : 0 = rigide, plus grand = plus mou. Les valeurs viennent
	// de l'anatomie : le tronc est rigide, les articulations des pattes cèdent
	// un peu, les butées de flexion beaucoup.
	// RAYON DE CONTACT par particule. Une particule est un point, mais la chair
	// qu'elle porte a une épaisseur : sans ça le gastre s'enfonce d'un tiers de
	// corps dans le sol (mesuré). Le tronc est épais, les tarses sont des pointes.
	const RADIUS = new Float32Array( N_PART );
	RADIUS[ P_THORAX ] = vat.bounds.height * 0.30;
	RADIUS[ P_HEAD ] = vat.bounds.height * 0.26;
	RADIUS[ P_GASTER ] = vat.bounds.height * 0.32;
	for ( let k = 0; k < 6; k ++ ) {

		RADIUS[ 3 + k * 2 ] = vat.bounds.height * 0.08;   // genou
		RADIUS[ 4 + k * 2 ] = vat.bounds.height * 0.03;   // tarse

	}

	const CONSTR = [];
	const addC = ( a, b, alpha ) => CONSTR.push( { a, b, rest: bind[ a ].distanceTo( bind[ b ] ), alpha } );

	addC( P_THORAX, P_HEAD, 0.0 );
	addC( P_THORAX, P_GASTER, 0.0 );
	addC( P_HEAD, P_GASTER, 0.25 );            // raideur du tronc

	LEGS.forEach( ( L, k ) => {

		const knee = 3 + k * 2, tarsus = 4 + k * 2;
		// point d'attache anatomique de la patte sur le tronc : les avant sur la
		// tête, les médianes sur le thorax, les arrière sur le gastre
		const anchor = k < 2 ? P_HEAD : ( k < 4 ? P_THORAX : P_GASTER );
		addC( P_THORAX, knee, 0.04 );          // fémur
		addC( knee, tarsus, 0.04 );            // tibia
		addC( anchor, tarsus, 0.80 );          // butée de flexion du genou
		addC( anchor, knee, 0.40 );            // la patte ne traverse pas le corps

	} );

	// genoux voisins : les pattes ne se croisent pas
	addC( 3, 7, 1.2 ); addC( 7, 11, 1.2 ); addC( 5, 9, 1.2 ); addC( 9, 13, 1.2 );

	// --- os → segment physique ---------------------------------------------
	// Chaque os du GLB reçoit sa rotation d'un segment (deux particules). Les
	// antennes suivent la tête, le reste suit son propre segment.
	const BONE_SEG = [];       // { from, to } indices de particules

	rig.boneNames.forEach( ( name, bi ) => {

		let from = P_THORAX, to = P_HEAD;

		if ( name === 'root' ) { from = P_GASTER; to = P_HEAD; }
		else if ( name === 'head' || name === 'antL' || name === 'antR' ) { from = P_THORAX; to = P_HEAD; }
		else if ( name === 'abdomen' ) { from = P_THORAX; to = P_GASTER; }
		else {

			const f = femurIdx.indexOf( bi );
			const t = tibiaIdx.indexOf( bi );
			if ( f >= 0 ) { from = P_THORAX; to = 3 + f * 2; }
			else if ( t >= 0 ) { from = 3 + t * 2; to = 4 + t * 2; }

		}

		BONE_SEG.push( { from, to } );

	} );

	const N_BONE = rig.boneNames.length;

	// tables constantes envoyées au GPU
	const uBind = uniformArray( bind.map( ( b, i ) => new THREE.Vector4( b.x, b.y, b.z, invMass[ i ] ) ) );
	// par os : origine de bind (relative au pivot) + axe de bind du segment
	const uBoneRest = uniformArray( rig.boneNames.map( ( _, bi ) => {

		const o = restOf( bi ).sub( pivot );
		return new THREE.Vector4( o.x, o.y, o.z, 0 );

	} ) );
	const uSegBind = uniformArray( BONE_SEG.map( ( s ) => {

		const d = bind[ s.to ].clone().sub( bind[ s.from ] ).normalize();
		return new THREE.Vector4( d.x, d.y, d.z, 0 );

	} ) );

	// --- buffers ------------------------------------------------------------
	const rdPos = instancedArray( MAX_RD * N_PART, 'vec4' );    // xyz local, w libre
	const rdPrev = instancedArray( MAX_RD * N_PART, 'vec4' );   // Verlet : la vitesse est implicite
	// 2 vec4 par slot : [0] position monde du pivot + échelle, [1] hauteur du
	// SOL en coordonnées locales (elle bouge : le cadavre peut être en l'air,
	// ou sous terre sur le plancher d'une galerie)
	const rdAnchor = instancedArray( MAX_RD * 2, 'vec4' );
	const rdState = instancedArray( MAX_RD, 'uint' );           // bits 0-15 antId, 16 occupé, 17 dormant, 18-25 repos
	const rdBone = instancedArray( MAX_RD * N_BONE * 2, 'vec4' ); // quaternion + origine par os
	const rdActive = instancedArray( MAX_RD, 'uint' );          // liste compactée des réveillés
	const rdDraw = instancedArray( MAX_RD, 'uint' );            // liste compactée des affichés
	const rdAlloc = instancedArray( 4, 'uint' ).toAtomic();     // [0] curseur anneau [1] actifs [2] affichés
	const antRagSlot = pose.antRagSlot;                         // slot+1, 0 = pas de ragdoll

	// arguments de dispatch INDIRECT : le GPU décide combien de workgroups lancer
	const argsArray = new Uint32Array( [ 0, 1, 1 ] );
	const rdArgsAttr = new THREE.IndirectStorageBufferAttribute( argsArray, 1 );
	const rdArgs = storage( rdArgsAttr, 'uint', 3 ).toAtomic();

	const u = {
		gravity: uniform( params.gravity ),
		dist: uniform( gfx.rdDist ),
		camPos: uniform( new THREE.Vector3() ),
		budget: uniform( MAX_RD ),
		spawnWin: uniform( 0.12 ),          // s : fenêtre de détection « vient de mourir »
		pivotY: uniform( vat.pivotY ),
	};

	const WG = 32;
	const OCCUPIED = 1 << 16, ASLEEP = 1 << 17;

	// ------------------------------------------------------------------
	// Quaternions : arc le plus court d'un vecteur unitaire à un autre.
	// Le cas dégénéré (vecteurs opposés) DOIT être traité : un cadavre peut
	// parfaitement finir retourné à 180° de sa pose de bind, et un NaN de
	// ragdoll est contagieux (l'instance entière part à l'infini).
	// ------------------------------------------------------------------
	const shortestArc = ( a, b ) => {

		const c = cross( a, b ).toVar();
		const s = float( 1 ).add( dot( a, b ) ).toVar();
		const q = vec4( c, s ).toVar();

		If( s.lessThan( 1e-5 ), () => {

			// 180° : n'importe quel axe perpendiculaire fait l'affaire
			const alt = select( abs( a.x ).lessThan( 0.9 ), vec3( 1, 0, 0 ), vec3( 0, 1, 0 ) );
			q.assign( vec4( normalize( cross( a, alt ) ), 0 ) );

		} );

		return normalize( q );

	};

	const qMul = ( a, b ) => vec4(
		a.w.mul( b.x ).add( a.x.mul( b.w ) ).add( a.y.mul( b.z ) ).sub( a.z.mul( b.y ) ),
		a.w.mul( b.y ).sub( a.x.mul( b.z ) ).add( a.y.mul( b.w ) ).add( a.z.mul( b.x ) ),
		a.w.mul( b.z ).add( a.x.mul( b.y ) ).sub( a.y.mul( b.x ) ).add( a.z.mul( b.w ) ),
		a.w.mul( b.w ).sub( a.x.mul( b.x ) ).sub( a.y.mul( b.y ) ).sub( a.z.mul( b.z ) ),
	);

	// ------------------------------------------------------------------
	// kRdSpawn : une fourmi FRAÎCHEMENT morte et assez proche de la caméra
	// prend un slot dans l'anneau. Un thread par fourmi.
	// ------------------------------------------------------------------
	const kRdSpawn = Fn( () => {

		If( instanceIndex.toFloat().lessThan( sim.u.antCount ), () => {

			const st = sim.antState.element( instanceIndex );
			const state = st.bitAnd( uint( 7 ) );
			const tDeath = sim.antVital.element( instanceIndex ).w;
			const slotHeld = antRagSlot.element( instanceIndex );

			const b = instanceIndex.mul( uint( 3 ) );
			const P = pose.antPose.element( b );
			const Q = pose.antPose.element( b.add( uint( 1 ) ) );

			const dCam = length( P.xyz.sub( u.camPos ) );

			const eligible = sim.u.physOn.greaterThan( 0.5 )
				.and( state.equal( uint( 2 ) ) )
				.and( tDeath.lessThan( u.spawnWin ) )
				.and( slotHeld.equal( uint( 0 ) ) )
				.and( dCam.lessThan( u.dist ) );

			If( eligible, () => {

				const slot = atomicAdd( rdAlloc.element( uint( 0 ) ), uint( 1 ) ).mod( u.budget.toUint() ).toVar();

				// le slot peut être encore occupé (anneau) : on dépossède
				// l'ancienne propriétaire, qui repassera en culbute analytique
				const prev = rdState.element( slot ).toVar();

				If( prev.bitAnd( uint( OCCUPIED ) ).notEqual( uint( 0 ) ), () => {

					antRagSlot.element( prev.bitAnd( uint( 0xFFFF ) ) ).assign( uint( 0 ) );

				} );

				rdState.element( slot ).assign( instanceIndex.bitAnd( uint( 0xFFFF ) ).bitOr( uint( OCCUPIED ) ) );
				rdAnchor.element( slot.mul( uint( 2 ) ) ).assign( vec4( P.xyz, P.w ) );
				antRagSlot.element( instanceIndex ).assign( slot.add( uint( 1 ) ) );

				// pose initiale : la pose de bind, orientée comme la fourmi l'était
				// à l'instant de sa mort, et une vitesse de départ tirée de sa
				// vitesse réelle (encodée en décalant la position précédente)
				const dyn = sim.antDyn.element( instanceIndex );
				const vLocal = vec3( dyn.x.mul( TEXEL ), dyn.w, dyn.y.mul( TEXEL ) )
					.div( max( P.w, 0.01 ) ).mul( FIXED_H / SUBSTEPS );
				const base = slot.mul( uint( N_PART ) );

				Loop( { start: uint( 0 ), end: uint( N_PART ), type: 'uint', condition: '<' }, ( { i } ) => {

					const bp = uBind.element( i.toInt() );
					const p = qrot( Q, bp.xyz );
					rdPos.element( base.add( i ) ).assign( vec4( p, bp.w ) );
					// jitter minuscule : deux pattes exactement symétriques
					// resteraient éternellement symétriques (pose figée)
					const j = hash( instanceIndex.mul( uint( 31 ) ).add( i ) ).sub( 0.5 ).mul( 0.004 );
					rdPrev.element( base.add( i ) ).assign( vec4( p.sub( vLocal ).add( vec3( j ) ), bp.w ) );

				} );

			} );

		} );

	} )().compute( MAX_ANTS );

	// ------------------------------------------------------------------
	const kRdReset = Fn( () => {

		atomicStore( rdAlloc.element( uint( 1 ) ), uint( 0 ) );
		atomicStore( rdAlloc.element( uint( 2 ) ), uint( 0 ) );
		atomicStore( rdArgs.element( uint( 0 ) ), uint( 0 ) );

	} )().compute( 1 );

	// kRdCull : qui doit être SIMULÉ, qui doit être AFFICHÉ.
	// Un ragdoll endormi reste affiché mais ne coûte plus rien à simuler.
	const kRdCull = Fn( () => {

		const st = rdState.element( instanceIndex ).toVar();

		If( st.bitAnd( uint( OCCUPIED ) ).notEqual( uint( 0 ) ), () => {

			const owner = st.bitAnd( uint( 0xFFFF ) );
			// RÈGLE DE PROPRIÉTÉ : un slot n'est valide que si sa fourmi le
			// revendique encore. Sans ça, le recyclage de l'anneau ferait afficher
			// à une fourmi le squelette d'une autre.
			const valid = antRagSlot.element( owner ).equal( instanceIndex.add( uint( 1 ) ) );

			If( valid.not(), () => {

				rdState.element( instanceIndex ).assign( uint( 0 ) );

			} ).Else( () => {

				// L'ANCRE SUIT LA FOURMI : sa trajectoire reste possédée par le
				// noyau de simulation, donc le cadavre visible est TOUJOURS là où
				// la simulation le croit (l'araignée qui vient dévorer ne mâche
				// jamais du vide).
				const ob = owner.mul( uint( 3 ) );
				const P = pose.antPose.element( ob );
				const hLocal = sim.antDyn.element( owner ).z.div( max( P.w, 0.01 ) );
				rdAnchor.element( instanceIndex.mul( uint( 2 ) ) ).assign( vec4( P.xyz, P.w ) );
				rdAnchor.element( instanceIndex.mul( uint( 2 ) ).add( uint( 1 ) ) )
					.assign( vec4( u.pivotY.add( hLocal ).negate(), 0, 0, 0 ) );
				const visible = length( P.xyz.sub( u.camPos ) ).lessThan( u.dist.mul( 1.6 ) );

				If( visible, () => {

					const d = atomicAdd( rdAlloc.element( uint( 2 ) ), uint( 1 ) );
					rdDraw.element( d ).assign( instanceIndex );

					If( st.bitAnd( uint( ASLEEP ) ).equal( uint( 0 ) ), () => {

						const s = atomicAdd( rdAlloc.element( uint( 1 ) ), uint( 1 ) );
						rdActive.element( s ).assign( instanceIndex );

					} );

				} );

			} );

		} );

	} )().compute( MAX_RD );

	// nombre de workgroups à lancer, écrit PAR LE GPU
	const kRdArgs = Fn( () => {

		const n = atomicLoad( rdAlloc.element( uint( 1 ) ) );
		atomicStore( rdArgs.element( uint( 0 ) ), n.add( uint( WG - 1 ) ).div( uint( WG ) ) );

	} )().compute( 1 );

	// ------------------------------------------------------------------
	// kRdSolve : XPBD, un thread par ragdoll. Les 15 particules vivent en
	// REGISTRES pendant les 8 sous-pas — aucun aller-retour en mémoire globale
	// entre les itérations, ce qui est tout l'intérêt.
	//
	// Sous-pas plutôt qu'itérations (Small Steps in Physics Simulation,
	// Macklin 2019) : à budget de projections égal, 8 sous-pas d'1 itération
	// convergent bien mieux que 1 pas de 8 itérations, et la raideur ne dépend
	// plus du nombre d'itérations.
	// ------------------------------------------------------------------
	const h = FIXED_H / SUBSTEPS;
	const DAMP = 1 - 4 * h;             // le sous-pas détruit l'amortissement numérique : on le réinjecte
	const V_MAX = 0.02;                 // borne CFL : jamais plus d'1/4 de la plus courte contrainte par sous-pas

	const kRdSolve = Fn( () => {

		// pas de garde de bornes automatique en dispatch indirect
		If( instanceIndex.lessThan( atomicLoad( rdAlloc.element( uint( 1 ) ) ) ), () => {

			const slot = rdActive.element( instanceIndex ).toVar();
			const base = slot.mul( uint( N_PART ) );
			const anchor = rdAnchor.element( slot.mul( uint( 2 ) ) );
			const scale = max( anchor.w, 0.01 );

			// plan de contact, en coordonnées locales : le sol vu depuis le pivot
			const groundY = rdAnchor.element( slot.mul( uint( 2 ) ).add( uint( 1 ) ) ).x.toVar();

			// chargement en registres
			const p = [], q = [], w = [];

			for ( let i = 0; i < N_PART; i ++ ) {

				const e = rdPos.element( base.add( uint( i ) ) );
				p.push( e.xyz.toVar() );
				w.push( e.w.toVar() );
				q.push( rdPrev.element( base.add( uint( i ) ) ).xyz.toVar() );

			}

			const gStep = u.gravity.div( scale ).mul( h * h );
			const moved = float( 0 ).toVar();

			for ( let s = 0; s < SUBSTEPS; s ++ ) {

				// --- prédiction (Verlet amorti + clamp CFL) ---
				for ( let i = 0; i < N_PART; i ++ ) {

					const v = p[ i ].sub( q[ i ] ).mul( DAMP ).toVar();
					const vl = length( v ).max( 1e-7 );
					v.mulAssign( min( float( 1 ), float( V_MAX ).div( vl ) ) );
					q[ i ].assign( p[ i ] );
					p[ i ].addAssign( v.sub( vec3( 0, gStep, 0 ) ) );

				}

				// --- projection des contraintes (déroulée : indices constants) ---
				for ( const c of CONSTR ) {

					const pa = p[ c.a ], pb = p[ c.b ];
					const wa = w[ c.a ], wb = w[ c.b ];
					const d = pa.sub( pb ).toVar();
					const l = length( d ).max( 1e-6 );
					// une seule itération par sous-pas ⇒ λ = 0 ⇒ le numérateur
					// se réduit à −C ; la compliance α̃ va au dénominateur
					const denom = wa.add( wb ).add( c.alpha ).max( 1e-6 );
					const corr = d.div( l ).mul( l.sub( c.rest ).negate().div( denom ) ).toVar();
					pa.addAssign( corr.mul( wa ) );
					pb.subAssign( corr.mul( wb ) );

				}

				// --- ancrage du tronc sur la trajectoire possédée par le noyau ---
				// (le ragdoll exprime l'ATTITUDE, pas le déplacement : c'est ce qui
				// garantit que le cadavre reste là où la simulation le croit)
				p[ P_THORAX ].assign( mix( p[ P_THORAX ], uBind.element( int( P_THORAX ) ).xyz, 0.35 ) );

				// --- contact avec le sol + friction de Coulomb ---
				for ( let i = 0; i < N_PART; i ++ ) {

					const floorI = groundY.add( RADIUS[ i ] );

					If( p[ i ].y.lessThan( floorI ), () => {

						// la composante tangentielle est freinée, pas annulée :
						// une patte glisse un peu avant d'accrocher (Coulomb)
						p[ i ].assign( vec3(
							mix( p[ i ].x, q[ i ].x, 0.75 ), floorI, mix( p[ i ].z, q[ i ].z, 0.75 ) ) );

					} );

				}

			}

			// --- mesure du mouvement résiduel → mise en sommeil ---
			for ( let i = 0; i < N_PART; i ++ ) {

				moved.assign( max( moved, length( p[ i ].sub( q[ i ] ) ) ) );

			}

			const st = rdState.element( slot ).toVar();
			const restCnt = st.shiftRight( uint( 18 ) ).bitAnd( uint( 255 ) ).toVar();
			restCnt.assign( select( moved.lessThan( 2e-4 ), min( restCnt.add( uint( 1 ) ), uint( 255 ) ), uint( 0 ) ) );

			const sleeping = restCnt.greaterThan( uint( 30 ) );
			rdState.element( slot ).assign(
				st.bitAnd( uint( 0x0001FFFF ) )
					.bitOr( restCnt.shiftLeft( uint( 18 ) ) )
					.bitOr( select( sleeping, uint( ASLEEP ), uint( 0 ) ) ),
			);

			// --- écriture ---
			for ( let i = 0; i < N_PART; i ++ ) {

				rdPos.element( base.add( uint( i ) ) ).assign( vec4( p[ i ], w[ i ] ) );
				rdPrev.element( base.add( uint( i ) ) ).assign( vec4( q[ i ], w[ i ] ) );

			}

			// --- repères d'os, calculés ICI : les particules sont déjà en
			// registres, une passe séparée les relirait pour rien ---
			// Le corps donne une rotation COMPLÈTE (deux vecteurs indépendants :
			// l'axe tête-gastre et l'axe des genoux médians) ; chaque os y ajoute
			// l'arc qui aligne son propre segment. Un os dont le segment n'a pas
			// bougé hérite exactement de l'orientation du corps — roulis compris.
			const fBind = normalize( uSegBind.element( int( 0 ) ).xyz );
			const fCur = normalize( p[ P_HEAD ].sub( p[ P_GASTER ] ) ).toVar();
			const q1 = shortestArc( fBind, fCur ).toVar();

			const lBindV = bind[ 9 ].clone().sub( bind[ 7 ] ).normalize();
			const lBind = vec3( lBindV.x, lBindV.y, lBindV.z );
			const lCur = normalize( p[ 9 ].sub( p[ 7 ] ) ).toVar();
			const l1 = qrot( q1, lBind ).toVar();
			// on ne garde que la composante perpendiculaire à l'axe du corps :
			// la torsion résiduelle autour de cet axe est exactement le roulis
			const perp = ( v ) => normalize( v.sub( fCur.mul( dot( v, fCur ) ) ).add( vec3( 1e-7 ) ) );
			const qBody = qMul( shortestArc( perp( l1 ), perp( lCur ) ), q1 ).toVar();

			for ( let b = 0; b < N_BONE; b ++ ) {

				const seg = BONE_SEG[ b ];
				const aBind = uSegBind.element( int( b ) ).xyz;
				const aCur = normalize( p[ seg.to ].sub( p[ seg.from ] ).add( vec3( 1e-7 ) ) );
				const qb = qMul( shortestArc( qrot( qBody, aBind ), aCur ), qBody );
				// origine de l'os = son point d'attache physique, transporté
				const o = p[ seg.from ].add(
					qrot( qb, uBoneRest.element( int( b ) ).xyz.sub( uBind.element( int( seg.from ) ).xyz ) ) );
				const bb = slot.mul( uint( N_BONE * 2 ) ).add( uint( b * 2 ) );
				rdBone.element( bb ).assign( qb );
				rdBone.element( bb.add( uint( 1 ) ) ).assign( vec4( o, 0 ) );

			}

		} );

	} )().computeKernel( [ WG ] );

	// ------------------------------------------------------------------
	// Rendu : géométrie SÉPARÉE (clone du LOD plein détail) portant l'index
	// d'os. Elle n'est jamais lue par les 65 536 fourmis normales.
	// ------------------------------------------------------------------
	const rdGeoSrc = vat.geometry;
	const boneAttr = new Float32Array( vat.totalVerts );
	for ( let i = 0; i < vat.totalVerts; i ++ ) boneAttr[ i ] = rig.boneOf[ i ];

	const igeo = new THREE.InstancedBufferGeometry();
	igeo.index = rdGeoSrc.index;
	igeo.setAttribute( 'position', rdGeoSrc.attributes.position );
	igeo.setAttribute( 'vatIndex', rdGeoSrc.attributes.vatIndex );
	igeo.setAttribute( 'boneIndex', new THREE.BufferAttribute( boneAttr, 1 ) );
	igeo.instanceCount = 0;

	const uBodyColor = uniform( new THREE.Color( gfx.antColor ) );
	const uAccent = uniform( new THREE.Color( gfx.antAccentColor ) );

	const material = new THREE.MeshStandardNodeMaterial( { roughness: 0.6, metalness: 0 } );

	material.positionNode = Fn( () => {

		const slot = rdDraw.element( instanceIndex ).toVar();
		const anchor = rdAnchor.element( slot.mul( uint( 2 ) ) );
		const bi = attribute( 'boneIndex', 'float' ).toInt();

		varyingProperty( 'float', 'vRdAccent' ).assign(
			select( attribute( 'vatIndex', 'float' ).toInt().lessThan( int( vat.counts[ 0 ] ) ), 0, 1 ) );

		const bb = slot.mul( uint( N_BONE * 2 ) ).add( bi.toUint().mul( uint( 2 ) ) );
		const qb = rdBone.element( bb );
		const ob = rdBone.element( bb.add( uint( 1 ) ) ).xyz;

		// skinning rigide : UNE transformation par sommet, pas quatre
		const rest = uBoneRest.element( bi ).xyz;
		const localVAT = positionLocal.sub( vec3( 0, u.pivotY, 0 ) );
		const local = qrot( qb, localVAT.sub( rest ) ).add( ob );

		return local.mul( anchor.w ).add( anchor.xyz );

	} )();

	material.colorNode = Fn( () => {

		// un cadavre est assombri, comme dans le pipeline normal
		return mix( vec3( uBodyColor ), vec3( uAccent ), varyingProperty( 'float', 'vRdAccent' ) ).mul( 0.5 );

	} )();

	const mesh = new THREE.Mesh( igeo, material );
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;

	// DRAW INDIRECT dédié : le nombre de ragdolls affichés est écrit par le GPU,
	// le CPU ne le connaît jamais et ne réalloue rien.
	const drawArgs = new Uint32Array( 5 );
	drawArgs[ 0 ] = rdGeoSrc.index.count;
	const drawAttr = new THREE.IndirectStorageBufferAttribute( drawArgs, 1 );
	const drawNode = storage( drawAttr, 'uint', 5 ).toAtomic();
	igeo.setIndirect( drawAttr, 0 );
	igeo.instanceCount = 1;

	const kRdDrawArgs = Fn( () => {

		atomicStore( drawNode.element( uint( 1 ) ), atomicLoad( rdAlloc.element( uint( 2 ) ) ) );

	} )().compute( 1 );

	// ------------------------------------------------------------------
	const PASSES_A = [ kRdSpawn, kRdReset, kRdCull, kRdArgs ];
	const PASSES_B = [ kRdDrawArgs ];
	let enabled = params.physics && gfx.rdBudget > 0;

	return {
		mesh,
		antRagSlot,
		MAX_RD,
		// crochets de débogage : un ragdoll qui part en NaN est CONTAGIEUX
		// (l'instance entière explose en étoile) — il faut pouvoir l'inspecter
		_dbg: { rdPos, rdPrev, rdState, rdBone, rdAlloc, rdDraw, rdAnchor, N_PART, N_BONE, CONSTR },
		uBodyColor,
		uAccent,
		setEnabled( v ) { enabled = !! v; },
		tick() {

			enabled = params.physics && gfx.rdBudget > 0;
			mesh.visible = enabled;

			if ( ! enabled ) return;

			u.gravity.value = params.gravity;
			u.dist.value = gfx.rdDist;
			u.camPos.value.copy( camera.position );

			renderer.compute( PASSES_A );
			// DISPATCH INDIRECT : le nombre de workgroups vient du GPU lui-même.
			// Zéro ragdoll réveillé = zéro workgroup lancé.
			renderer.compute( kRdSolve, rdArgsAttr );
			renderer.compute( PASSES_B );

		},
	};

}
