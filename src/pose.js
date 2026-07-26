// POSE : une passe compute qui calcule, une fois par fourmi et par frame, la
// TRANSFORMATION COMPLÈTE de son corps (position monde du pivot, attitude
// quaternion, phase de démarche, teintes, drapeaux) et la publie dans un seul
// buffer contigu, `antPose`.
//
// Pourquoi une passe dédiée plutôt que du calcul dans le vertex shader :
//   • le vertex shader tournait ~21 millions de fois par frame au pire cas
//     (65 536 fourmis × leur LOD, ×2 avec la passe d'ombres) et refaisait à
//     CHAQUE sommet six hash() de caste, un cos/sin, la construction d'une
//     matrice et une lecture de la carte de profondeur. Ici c'est fait 65 536
//     fois, point ;
//   • et surtout : l'attitude du corps n'est plus un simple lacet. Tangage,
//     roulis, hauteur, culbute de cadavre — un vertex shader ne peut pas les
//     dériver seul sans relire quatre buffers par sommet.
//
// Le mode physique ne change QUE le contenu de cette passe, jamais sa
// structure : `physOn = 0` réécrit exactement la pose d'origine (lacet seul,
// posée au sol), ce qui donne un témoin de comparaison honnête.

import {
	Fn, If, instanceIndex, uniform, instancedArray,
	float, uint, vec2, vec3, vec4, ivec2,
	cos, sin, abs, exp, floor, min, select, clamp, cross, textureLoad, PI2,
} from 'three/tsl';

import { WORLD, TEXEL, MAX_ANTS, gfx } from './config.js';

// ---------------------------------------------------------------------------
// Algèbre des quaternions (le vertex shader n'utilise que `qrot`)
// ---------------------------------------------------------------------------

// rotation d'un vecteur par un quaternion unitaire, sans passer par une matrice
export const qrot = ( q, v ) =>
	v.add( cross( q.xyz, cross( q.xyz, v ).add( v.mul( q.w ) ) ).mul( 2 ) );

const qMul = ( a, b ) => vec4(
	a.w.mul( b.x ).add( a.x.mul( b.w ) ).add( a.y.mul( b.z ) ).sub( a.z.mul( b.y ) ),
	a.w.mul( b.y ).sub( a.x.mul( b.z ) ).add( a.y.mul( b.w ) ).add( a.z.mul( b.x ) ),
	a.w.mul( b.z ).add( a.x.mul( b.y ) ).sub( a.y.mul( b.x ) ).add( a.z.mul( b.w ) ),
	a.w.mul( b.w ).sub( a.x.mul( b.x ) ).sub( a.y.mul( b.y ) ).sub( a.z.mul( b.z ) ),
);

// Conventions d'axes du modèle (vérifiées sur AntRigged.glb) :
//   avant = +Z · haut = +Y · côté = +X
// donc LACET autour de Y, TANGAGE autour de X, ROULIS autour de Z.
// Un roulis de π donne (x, y) → (−x, −y) : exactement le retournement « sur le
// dos » que l'ancien rendu plaquait à la main.
const qYaw = ( a ) => { const h = a.mul( 0.5 ); return vec4( 0, sin( h ), 0, cos( h ) ); };
const qPitch = ( a ) => { const h = a.mul( 0.5 ); return vec4( sin( h ), 0, 0, cos( h ) ); };
const qRoll = ( a ) => { const h = a.mul( 0.5 ); return vec4( 0, 0, sin( h ), cos( h ) ); };

// drapeaux publiés dans antPose[3i+2].w :
// kind + 4·souterraine + 8·reine + 16·porteuse + 32·attaque
export const POSE_ALIVE = 0, POSE_CORPSE = 1, POSE_GONE = 2, POSE_RAGDOLL = 3;

export function createPose( sim, vat ) {

	const layout = sim.layout;
	const depthSize = layout.depthTexture.image.width;
	const workerModel = vat.models?.worker ?? vat;
	const soldierModel = vat.models?.soldier ?? workerModel;
	const workerRestY = workerModel.restY ?? vat.restY;
	const soldierRestY = soldierModel.restY ?? workerRestY;
	const workerBounds = workerModel.bounds ?? vat.bounds;
	const soldierBounds = soldierModel.bounds ?? workerBounds;
	// Alias historique : les consommateurs qui ne distinguent pas les castes
	// continuent d'utiliser les mesures de l'ouvrière.
	const PIVOT_Y = workerModel.pivotY ?? vat.pivotY;
	const SOLDIER_PIVOT_Y = soldierModel.pivotY ?? PIVOT_Y;

	// [3i+0] = ( x, y, z monde du PIVOT corporel , gabarit de caste )
	// [3i+1] = quaternion d'attitude ( lacet ∘ tangage ∘ roulis )
	// [3i+2] = ( phase de démarche , venin 0..1 , id de caste , drapeaux )
	const antPose = instancedArray( MAX_ANTS * 3, 'vec4' );
	// slot de ragdoll possédé par chaque fourmi (+1 ; 0 = aucun). Vit ici et non
	// dans ragdoll.js pour que kPose puisse marquer la fourmi comme « rendue par
	// le ragdoll » — sinon elle serait dessinée deux fois.
	const antRagSlot = instancedArray( MAX_ANTS, 'uint' );

	const u = {
		time: uniform( 0 ),
		bobAmp: uniform( gfx.bobAmp ),
		swayAmp: uniform( gfx.swayAmp ),
		pitchAmp: uniform( gfx.pitchAmp ),
		// Mesures bakées par caste. Les alias sans préfixe restent ceux de
		// l'ouvrière pour la reine et la compatibilité avec le rendu existant.
		restY0: uniform( workerRestY[ 0 ] ),
		restY1: uniform( workerRestY[ 1 ] ),
		restY2: uniform( workerRestY[ 2 ] ),
		restY3: uniform( workerRestY[ 3 ] ),
		soldierRestY0: uniform( soldierRestY[ 0 ] ),
		soldierRestY1: uniform( soldierRestY[ 1 ] ),
		soldierRestY2: uniform( soldierRestY[ 2 ] ),
		soldierRestY3: uniform( soldierRestY[ 3 ] ),
		pivotY: uniform( PIVOT_Y ),
		soldierPivotY: uniform( SOLDIER_PIVOT_Y ),
		workerHeight: uniform( workerBounds.height ),
		soldierHeight: uniform( soldierBounds.height ),
	};

	// Plancher souterrain au point (texels grille), SUR LA NAPPE DE LA FOURMI.
	// La carte porte quatre planchers superposes par colonne : c'est ce qui
	// permet a une chambre d'etre reellement au-dessus d'une autre. Si la nappe
	// demandee est vide ici (cas de bord), on retombe sur la cavite la plus
	// haute plutot que de renvoyer 0, qui projetterait la fourmi en surface.
	const floorDepth = ( gp, layer ) => {

		const lc = clamp(
			ivec2( gp.sub( vec2( layout.origin.x, layout.origin.y ) ) ),
			ivec2( 0 ), ivec2( depthSize - 1 ),
		);
		const t = textureLoad( layout.depthTexture, lc ).toVar();
		const own = select( layer.equal( uint( 0 ) ), t.x,
			select( layer.equal( uint( 1 ) ), t.y,
				select( layer.equal( uint( 2 ) ), t.z, t.w ) ) ).toVar();

		If( own.greaterThan( - 1e-4 ), () => {

			own.assign( min( min( t.x, t.y ), min( t.z, t.w ) ) );

		} );

		return own;

	};

	const kPose = Fn( () => {

		If( instanceIndex.toFloat().lessThan( sim.u.antCount ), () => {

			const a = sim.antData.element( instanceIndex );
			const st = sim.antState.element( instanceIndex );
			const vt = sim.antVital.element( instanceIndex );
			const dyn = sim.antDyn.element( instanceIndex );

			const state = st.bitAnd( uint( 7 ) );
			const under = st.bitAnd( uint( 8 ) ).notEqual( uint( 0 ) );
			const attacking = st.shiftRight( uint( 24 ) ).bitAnd( uint( 1 ) )
				.notEqual( uint( 0 ) );
			const dead = state.equal( uint( 2 ) );
			const gone = state.equal( uint( 3 ) );
			const dw = st.shiftRight( uint( 16 ) ).bitAnd( uint( 255 ) );
			// nappe : a quel etage superpose la fourmi se trouve (voir nest.js)
			const layer = st.shiftRight( uint( 14 ) ).bitAnd( uint( 3 ) );

			const { isQueen, isNurse, isSoldier, isScout } = sim.casteOf( instanceIndex );
			const scale = select( isSoldier, float( 1.45 ),
				select( isNurse, float( 0.85 ),
					select( isScout, float( 0.92 ), float( 1 ) ) ) ).toVar();
			const pivotY = select( isSoldier, u.soldierPivotY, u.pivotY );
			const modelHeight = select( isSoldier, u.soldierHeight, u.workerHeight );

			// Sous terre, antDyn.z est la profondeur continue de la courbe 3D.
			const solY = select( under, dyn.z.add( 0.04 ), float( 0 ) ).toVar();

			const yaw = float( Math.PI / 2 ).sub( a.z );
			const pitch = float( 0 ).toVar();
			const roll = float( 0 ).toVar();
			const lift = float( 0 ).toVar();       // hauteur ajoutée au pivot

			If( sim.u.physOn.greaterThan( 0.5 ), () => {

				lift.assign( dyn.z );              // hauteur balistique réelle

				If( under, () => {

					lift.assign( 0 );


				} );
				If( dead, () => {

					// ================= CULBUTE DU CADAVRE =================
					// L'orientation converge en forme fermée vers son quadrant de
					// repos (mot de mort figé à l'instant de la mort) pendant que
					// la POSITION, elle, est intégrée pour de vrai par le noyau.
					// Passé ~2 s l'exponentielle vaut 1e-3 : la pose devient une
					// constante exacte — c'est un « sleeping » gratuit, sans
					// drapeau ni branchement.
					const t = vt.w;
					const restQ = dw.bitAnd( uint( 3 ) ).toFloat();
					const spinN = dw.shiftRight( uint( 2 ) ).bitAnd( uint( 3 ) ).toFloat();
					const pitchQ = dw.shiftRight( uint( 4 ) ).bitAnd( uint( 7 ) ).toFloat();
					const dirS = select( dw.shiftRight( uint( 7 ) ).bitAnd( uint( 1 ) ).equal( uint( 1 ) ),
						float( 1 ), float( - 1 ) );

					const k = float( 1 ).sub( exp( t.negate().div( 0.32 ) ) );
					roll.assign( restQ.mul( Math.PI / 2 ).add( dirS.mul( spinN ).mul( PI2 ) ).mul( k ) );
					pitch.assign( pitchQ.sub( 3.5 ).mul( 0.16 ).mul( k ) );

					// la hauteur de repos dépend de la face sur laquelle elle finit :
					// à plat sur le dos une fourmi ne repose pas à la même hauteur que
					// debout. Valeurs BAKÉES depuis la pose de mort réelle.
					const workerRest = select( restQ.lessThan( 0.5 ), u.restY0,
						select( restQ.lessThan( 1.5 ), u.restY1,
							select( restQ.lessThan( 2.5 ), u.restY2, u.restY3 ) ) );
					const soldierRest = select( restQ.lessThan( 0.5 ), u.soldierRestY0,
						select( restQ.lessThan( 1.5 ), u.soldierRestY1,
							select( restQ.lessThan( 2.5 ), u.soldierRestY2, u.soldierRestY3 ) ) );
					const restY = select( isSoldier, soldierRest, workerRest );
					lift.addAssign( restY.sub( pivotY ).mul( scale ).mul( k ) );

				} ).Else( () => {

					// ============ MICRO-DYNAMIQUE DE LA MARCHE ============
					// Une fourmi en marche tripode roule d'un côté puis de l'autre
					// à la fréquence de la foulée, rebondit à 2× cette fréquence et
					// tangue en quadrature. C'est ce qui distingue un corps qui
					// MARCHE d'un corps qui glisse en bloc au-dessus du sol.
					const ph = vt.w.mul( PI2 );
					const walkMotion = select( attacking, float( 0.25 ), float( 1 ) );
					lift.addAssign( u.bobAmp.mul( abs( sin( ph ) ) ).mul( scale ).mul( walkMotion ) );
					roll.assign( u.swayAmp.mul( sin( ph ) ).mul( walkMotion ) );
					pitch.assign( u.pitchAmp.mul( sin( ph.add( 1.5707963 ) ) ).mul( walkMotion ) );

					// envenimée : elle titube (le venin est un neurotoxique)
					const venomT = vt.x.clamp( 0, 1 );
					roll.addAssign( venomT.mul( 0.45 ).mul(
						sin( u.time.mul( 7.3 ).add( instanceIndex.toFloat().mul( 2.399963 ) ) ) ) );

					// ============ ENCAISSEMENT D'UN COUP ============
					// biteClock est remis à zéro à chaque frappe : on s'en sert
					// comme horloge de réaction. Oscillation amortie du buste —
					// la fourmi est SECOUÉE, elle ne se contente pas de reculer.
					const shock = exp( vt.y.negate().div( 0.22 ) );
					roll.addAssign( shock.mul( 0.55 ).mul( sin( vt.y.mul( 41 ) ) ) );
					pitch.addAssign( shock.mul( 0.4 ).mul( sin( vt.y.mul( 33 ) ) ) );

					// en vol : le corps pique du nez proportionnellement à sa chute
					pitch.addAssign( clamp( dyn.w.mul( - 0.06 ), - 0.5, 0.5 )
						.mul( select( dyn.z.greaterThan( 0.002 ), 1, 0 ) ) );

				} );

			} ).Else( () => {

				// mode historique : le cadavre est PLAQUÉ sur le dos (roulis π),
				// sans transition ni hauteur de repos correcte
				roll.assign( select( dead, float( Math.PI ), float( 0 ) ) );
				// l'ancien rendu retournait le cadavre autour de ses PIEDS (origine
				// du modèle) et non autour du pivot corporel : il faut donc défalquer
				// DEUX fois le pivot pour retrouver la hauteur historique exacte
				lift.assign( select( dead,
					modelHeight.sub( pivotY.mul( 2 ) ).mul( scale ), float( 0 ) ) );

			} );

			const q = qMul( qMul( qYaw( yaw ), qPitch( pitch ) ), qRoll( roll ) );

			const world = vec3(
				a.x.mul( TEXEL ).sub( WORLD / 2 ),
				solY.add( pivotY.mul( scale ) ).add( lift ),
				a.y.mul( TEXEL ).sub( WORLD / 2 ),
			);

			const ragdolled = antRagSlot.element( instanceIndex ).notEqual( uint( 0 ) );
			const kind = select( ragdolled.and( dead ), float( POSE_RAGDOLL ),
				select( gone, float( POSE_GONE ),
					select( dead, float( POSE_CORPSE ), float( POSE_ALIVE ) ) ) );
			const flags = kind
				.add( select( under, float( 4 ), float( 0 ) ) )
				.add( select( isQueen, float( 8 ), float( 0 ) ) )
				.add( select( state.equal( uint( 1 ) ), float( 16 ), float( 0 ) ) )
				.add( select( attacking, float( 32 ), float( 0 ) ) );

			const casteId = select( isSoldier, float( 1 ),
				select( isNurse, float( 2 ), select( isScout, float( 3 ), float( 0 ) ) ) );

			const b = instanceIndex.mul( uint( 3 ) );
			antPose.element( b ).assign( vec4( world, scale ) );
			antPose.element( b.add( uint( 1 ) ) ).assign( q );
			antPose.element( b.add( uint( 2 ) ) ).assign(
				vec4( vt.w, vt.x.clamp( 0, 1 ), casteId, flags ) );

		} );

	} )().compute( MAX_ANTS );

	let clock = 0;

	return {
		antPose,
		antRagSlot,
		kPose,
		u,
		PIVOT_Y,
		// lecture pratique côté rendu : une fourmi = 3 vec4 contigus
		read( antId ) {

			const b = antId.mul( uint( 3 ) );
			const p = antPose.element( b );
			const q = antPose.element( b.add( uint( 1 ) ) );
			const m = antPose.element( b.add( uint( 2 ) ) );
			// drapeaux dépliés en arithmétique flottante pure : pas une seule
			// conversion entière au vertex
			//   w = kind + 4·souterraine + 8·reine + 16·porteuse + 32·attaque
			const f1 = floor( m.w.div( 4 ) ).toVar();
			const kind = m.w.sub( f1.mul( 4 ) ).toVar();
			const f2 = floor( f1.div( 2 ) ).toVar();
			const f3 = floor( f2.div( 2 ) ).toVar();
			const f4 = floor( f3.div( 2 ) ).toVar();

			return {
				world: p.xyz,
				scale: p.w,
				q,
				gait: m.x,
				venom: m.y,
				caste: m.z,
				kind,
				ragdolled: kind.greaterThan( 2.5 ),
				under: f1.sub( f2.mul( 2 ) ).greaterThan( 0.5 ),
				isQueen: f2.sub( f3.mul( 2 ) ).greaterThan( 0.5 ),
				carrying: f3.sub( f4.mul( 2 ) ).greaterThan( 0.5 ),
				attacking: f4.greaterThan( 0.5 ),
				dead: kind.greaterThan( 0.5 ).and( kind.lessThan( 1.5 ) ),
				gone: kind.greaterThan( 1.5 ).and( kind.lessThan( 2.5 ) ),
			};

		},
		tick( dt ) {

			clock += dt;
			u.time.value = clock;
			u.bobAmp.value = gfx.bobAmp;
			u.swayAmp.value = gfx.swayAmp;
			u.pitchAmp.value = gfx.pitchAmp;

		},
	};

}
