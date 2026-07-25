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
	fract, floor, mix, hash, select, min, max, abs, length, normalize, cross, smoothstep, uv,
	textureLoad, atomicAdd, atomicStore, atomicLoad, clamp,
} from 'three/tsl';

import { loadAntCasteVAT, buildLodGeometry } from './vat.js';
import { createPose, qrot } from './pose.js';
import { GRID, WORLD, MAX_ANTS, params, gfx } from './config.js';

const LOD_DIST = [ 16, 42 ];          // limites LOD0→1 et LOD1→2 (unités monde)
const CULL_MARGIN = 1.6;              // rayon de sécurité autour d'une fourmi

export async function createAnts( sim ) {

	const vat = await loadAntCasteVAT(
		'/AntWorkerRigged.glb', '/AntSoldierRigged.glb',
		{ fps: 30, targetLength: 0.95 },
	);
	sim.u.soldierAttackDuration.value = vat.clips.soldierAttack.duration;

	// passe de pose : la source unique de vérité du rendu
	const pose = createPose( sim, vat );
	const antPose = pose.antPose;
	const uPivot = pose.u.pivotY;
	const uSoldierPivot = pose.u.soldierPivotY;
	const uPhysOn = sim.u.physOn;

	// Constantes de l'atlas unique. Les selections ci-dessous sont des noeuds
	// TSL : elles ne creent ni texture ni draw supplementaire.
	const workerModel = vat.models.worker;
	const soldierModel = vat.models.soldier;
	const workerWalk = vat.clips.workerWalk;
	const soldierWalk = vat.clips.soldierWalk;
	const soldierAttack = vat.clips.soldierAttack;
	const workerWalkOffset = int( workerWalk.offset );
	const soldierWalkOffset = int( soldierWalk.offset );
	const soldierAttackOffset = int( soldierAttack.offset );
	const workerWalkFrames = int( workerWalk.frames );
	const soldierWalkFrames = int( soldierWalk.frames );
	const soldierAttackFrames = int( soldierAttack.frames );
	const workerWalkFramesF = float( workerWalk.frames );
	const soldierWalkFramesF = float( soldierWalk.frames );
	const soldierAttackFramesF = float( soldierAttack.frames );
	const workerDeathRow = int( workerModel.deathRow );
	const soldierDeathRow = int( soldierModel.deathRow );
	const workerHeight = float( workerModel.bounds.height );
	const soldierHeight = float( soldierModel.bounds.height );
	const workerHeadZ = float( workerModel.bounds.headZ );
	const soldierHeadZ = float( soldierModel.bounds.headZ );

	const modelFor = ( P ) => {

		// caste est un float transporte par antPose ; la marge evite de dependre
		// d'une egalite flottante. La reine reste explicitement une ouvriere.
		const soldier = abs( P.caste.sub( 1 ) ).lessThan( 0.5 ).and( P.isQueen.not() );
		return {
			soldier,
			pivot: select( soldier, uSoldierPivot, uPivot ),
			height: select( soldier, soldierHeight, workerHeight ),
			headZ: select( soldier, soldierHeadZ, workerHeadZ ),
			walkOffset: select( soldier, soldierWalkOffset, workerWalkOffset ),
			walkFrames: select( soldier, soldierWalkFrames, workerWalkFrames ),
			walkFramesF: select( soldier, soldierWalkFramesF, workerWalkFramesF ),
			deathRow: select( soldier, soldierDeathRow, workerDeathRow ),
		};

	};

	const clipFor = ( P ) => {

		const model = modelFor( P );
		const attack = model.soldier.and( P.attacking );
		return {
			...model,
			attack,
			offset: select( attack, soldierAttackOffset, model.walkOffset ),
			frames: select( attack, soldierAttackFrames, model.walkFrames ),
			framesF: select( attack, soldierAttackFramesF, model.walkFramesF ),
		};

	};

	// Retourne les deux lignes contigues d'un clip, avec wrap LOCAL a ce clip.
	const clipFrameRows = ( clip, cycle ) => {

		const ff = fract( cycle ).mul( clip.framesF );
		const local0 = floor( ff ).toInt();
		return {
			ff,
			row0: clip.offset.add( local0 ),
			row1: clip.offset.add( local0.add( 1 ).mod( clip.frames ) ),
		};

	};

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
	// plongée (0/1 binaire) : caméra DANS le bloc de terre → les souterraines
	// deviennent visibles, et les fourmis de SURFACE passent en fantomatique
	// (opacityNode) — elles restent présentes mais ne font plus écran
	const uDive = uniform( 0 );
	// scanner (0/1 binaire) : les souterraines sont AUSSI dessinées en émissif
	// plat à travers tout (passe jumelle scanBodies + lueur de la reine),
	// dans une couleur réglable depuis l'UI
	const uScanAnts = uniform( 0 );
	const uScanAntColor = uniform( new THREE.Color( gfx.scanAntColor ) );
	let phaseAcc = 0;


	// ------------------------------------------------------------------
	// Kernels : remise à zéro des compteurs puis classement/compaction
	// ------------------------------------------------------------------
	const kReset = Fn( () => {

		atomicStore( indirectNode.element( instanceIndex.mul( 5 ).add( 1 ) ), uint( 0 ) );

	} )().compute( 3 );

	const kClassify = Fn( () => {

		If( instanceIndex.toFloat().lessThan( sim.u.antCount ), () => {

			const P = pose.read( instanceIndex );
			// caméra hors du bloc de terre → les souterraines sont invisibles
			// sous le sol opaque, on les SAUTE au classement (ni VAT ni ombres) ;
			// la reine (index 0, colonie active) a son mesh dédié ; une fourmi
			// RAGDOLLÉE est dessinée par son propre pipeline (sinon elle
			// apparaîtrait deux fois)
			const hidden = P.under.and( uDive.lessThan( 0.01 ) );
			const model = modelFor( P );

			If( P.isQueen.not().and( hidden.not() ).and( P.ragdolled.not() ), () => {

				// centre de la sphère de culling : on retire le pivot pour rester
				// sur le même point qu'avant le passage par antPose (sinon les
				// bascules de LOD se décalent d'une caste à l'autre)
				const world = vec3(
					P.world.x,
					P.world.y.sub( model.pivot.mul( P.scale ) ).add( 0.3 ),
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
	// scanPass : jumelle ÉMISSIVE pour la vue scanner — non éclairée, sans test
	// de profondeur, seules les souterraines survivent (les autres s'effondrent
	// en sommets dégénérés) → elles restent visibles à travers la terre.
	function makeBodyMaterial( lodBase, animMode, scanPass = false ) {

		const material = scanPass
			? new THREE.MeshBasicNodeMaterial()
			: new THREE.MeshStandardNodeMaterial( { roughness: 0.6, metalness: 0.0 } );

		if ( scanPass ) {

			material.depthTest = false;
			material.depthWrite = false;
			material.toneMapped = false;         // couleur franche, pas de lavage ACES

		}
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
			varyingProperty( 'float', 'vUnder' ).assign( select( P.under, 1, 0 ) );

			const clip = clipFor( P );
			let animated;

			if ( animMode === 2 ) {

				animated = textureLoad( vat.texture, ivec2( vatIdx, clip.walkOffset ) ).xyz;

			} else {

				// PHASE DE DÉMARCHE : en mode physique elle est propre à chaque
				// fourmi et pilotée par la DISTANCE qu'elle a réellement parcourue
				// (fin du patinage) ; en mode historique c'est l'horloge globale.
				const walkCycle = select( uPhysOn.greaterThan( 0.5 ),
					P.gait, uPhase.add( hash( antId.add( uint( 1013 ) ) ) ) );
				const cycle = select( clip.attack, P.gait, walkCycle );
				const frame = clipFrameRows( clip, cycle );

				if ( animMode === 1 ) {

					animated = textureLoad( vat.texture, ivec2( vatIdx, frame.row0 ) ).xyz;

				} else {

					const p0 = textureLoad( vat.texture, ivec2( vatIdx, frame.row0 ) ).xyz;
					const p1 = textureLoad( vat.texture, ivec2( vatIdx, frame.row1 ) ).xyz;
					animated = mix( p0, p1, fract( frame.ff ) );

				}

			}

			// envenimation : la marche se fige progressivement (paralysie)
			animated = mix( animated,
				textureLoad( vat.texture, ivec2( vatIdx, clip.walkOffset ) ).xyz, P.venom );

			const local = animated.toVar();

			If( P.dead, () => {

				// CADAVRE : pose de mort bakée — pattes recroquevillées sous le
				// corps, tête et gastre retombés. En mode historique on garde la
				// vieille pose de repos plaquée (le témoin de comparaison).
				const rowDead = textureLoad( vat.texture, ivec2( vatIdx, clip.deathRow ) ).xyz;
				const rowRest = textureLoad( vat.texture, ivec2( vatIdx, clip.walkOffset ) ).xyz;
				local.assign( select( uPhysOn.greaterThan( 0.5 ), rowDead, rowRest ) );

			} );

			// dévorée : sommet dégénéré, invisible
			const vis = select( P.gone, float( 0 ), float( 1 ) ).toVar();

			if ( scanPass ) {

				// passe scanner : seules les SOUTERRAINES existent ici
				vis.assign( select( P.under, vis, float( 0 ) ) );

			}

			// le corps tourne autour de son PIVOT anatomique (articulation « root »),
			// pas autour de ses pieds : sans ça une fourmi qui bascule s'enfonce
			return qrot( P.q,
				local.sub( vec3( 0, clip.pivot, 0 ) ).mul( P.scale ).mul( vis ) )
				.add( P.world );

		} )();

		if ( scanPass ) {

			// émissif plat, couleur réglable — comme la fourmi suivie, mais pour
			// TOUTES les souterraines (vu scanner : lisible à travers la terre)
			material.colorNode = Fn( () => vec3( uScanAntColor ).mul( 1.15 ) )();
			material.transparent = true;

			return material;

		}

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

		// PLONGÉE : les fourmis de SURFACE deviennent semi-transparentes
		// (on plonge sous elles, elles ne doivent plus faire écran) tandis que
		// les souterraines restent pleines — elles sont le sujet de la vue.
		// opacity constante par instance → pas de tri à faire, depthWrite resté
		// actif : les corps s'occluent encore correctement entre eux.
		material.opacityNode = Fn( () => {

			return mix( float( 1 ), float( 0.25 ),
				varyingProperty( 'float', 'vUnder' ).oneMinus().mul( uDive ) );

		} )();
		material.transparent = true;

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
	// PASSE SCANNER : jumelles émissives des corps — MÊME géométrie et MÊMES
	// listes d'instances (aucun classement supplémentaire), mais non éclairées,
	// sans test de profondeur, et seules les souterraines y survivent → elles
	// restent visibles À TRAVERS la terre, comme la fourmi suivie, dans la
	// couleur scanner réglée à l'UI. Coût nul quand visible = false.
	// ------------------------------------------------------------------
	const scanBodies = [];

	for ( let k = 0; k < 3; k ++ ) {

		const igeo = new THREE.InstancedBufferGeometry();
		igeo.index = lodGeos[ k ].index;
		igeo.attributes = lodGeos[ k ].attributes;
		igeo.instanceCount = 1;                       // le vrai compte vit sur GPU
		igeo.setIndirect( indirectAttr, k * 20 );     // offset en octets

		const mesh = new THREE.Mesh( igeo, makeBodyMaterial( k * MAX_ANTS, k, true ) );
		mesh.frustumCulled = false;
		mesh.renderOrder = 11;                        // sous la fourmi suivie (12)
		mesh.visible = false;
		group.add( mesh );
		scanBodies.push( mesh );

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
		const frame = clipFrameRows( {
			offset: workerWalkOffset, frames: workerWalkFrames, framesF: workerWalkFramesF,
		}, cycle );
		const p0 = textureLoad( vat.texture, ivec2( vatIdx, frame.row0 ) ).xyz;
		const p1 = textureLoad( vat.texture, ivec2( vatIdx, frame.row1 ) ).xyz;
		const animated = mix( p0, p1, fract( frame.ff ) );

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

	// scanner : la reine luit de la couleur scanner (main.js lève en même temps
	// son test de profondeur → visible à travers tout, comme la fourmi suivie)
	queenMat.emissiveNode = Fn( () => vec3( uScanAntColor ).mul( uScanAnts ) )();

	const queen = new THREE.Mesh( vat.geometry, queenMat );
	queen.frustumCulled = false;
	queen.castShadow = true;
	queen.visible = !! params.colony;
	group.add( queen );

	// ------------------------------------------------------------------
	// SURBRILLANCE DE LA FOURMI SUIVIE (antfollow.js) : une copie UNE SEULE
	// instance de la VAT, réanimée avec exactement la même logique que les
	// corps (cycle, venin, pose de mort), mais en jaune émissive plat, sans
	// test de profondeur et dessinée en tout dernier → la fourmi sélectionnée
	// reste visible À TRAVERS TOUT (terre, hologramme, autres fourmis).
	// Une mesh de ~2000 tris : coût négligeable, nul quand visible=false.
	// ------------------------------------------------------------------
	const uFollowIdx = uniform( - 1 );      // index de la fourmi suivie (−1 = aucune)

	const followMat = new THREE.MeshBasicNodeMaterial();
	// TRANSPARENT : obligatoire — les corps des fourmis sont eux-mêmes dans la
	// passe transparente (semi-transparence de surface du mode scanner), et
	// l'opaque rend toujours AVANT : sans ce drapeau la surbrillance serait
	// recouverte par les corps qu'elle doit coiffer.
	followMat.transparent = true;
	followMat.depthTest = false;
	followMat.depthWrite = false;
	followMat.toneMapped = false;           // jaune franc, pas de lavage ACES

	followMat.positionNode = Fn( () => {

		const antId = max( uFollowIdx, 0 ).toUint();
		const P = pose.read( antId );
		const clip = clipFor( P );

		const vatIdx = attribute( 'vatIndex', 'float' ).toInt();
		// la reine a sa propre cadence (voir queenMat) ; les autres le cycle commun
		const walkCycle = select( uPhysOn.greaterThan( 0.5 ),
			P.gait, uPhase.add( hash( antId.add( uint( 1013 ) ) ) ) );
		const cycleW = select( clip.attack, P.gait, walkCycle );
		const cycleQ = select( uPhysOn.greaterThan( 0.5 ),
			P.gait, uPhase.div( uQueenScale ).mul( 0.55 ) );
		const cycle = select( P.isQueen, cycleQ, cycleW );
		const frame = clipFrameRows( clip, cycle );
		const p0 = textureLoad( vat.texture, ivec2( vatIdx, frame.row0 ) ).xyz;
		const p1 = textureLoad( vat.texture, ivec2( vatIdx, frame.row1 ) ).xyz;
		const animated = mix( p0, p1, fract( frame.ff ) )
			.toVar();

		// mêmes déformations que les corps : paralysie de venin, pose de mort
		animated.assign( mix( animated,
			textureLoad( vat.texture, ivec2( vatIdx, clip.walkOffset ) ).xyz, P.venom ) );

		const local = animated.toVar();

		If( P.dead, () => {

			const rowDead = textureLoad( vat.texture, ivec2( vatIdx, clip.deathRow ) ).xyz;
			const rowRest = textureLoad( vat.texture, ivec2( vatIdx, clip.walkOffset ) ).xyz;
			local.assign( select( uPhysOn.greaterThan( 0.5 ), rowDead, rowRest ) );

		} );

		// dégénérée si dévorée (le temps qu'antfollow lâche la sélection)
		const vis = select( P.gone, float( 0 ), float( 1 ) );

		// LA REINE est un cas à part : échelle royale, gaster étiré, pivot à
		// SON gabarit (sinon la surbrillance la dessine en ouvrière naine au
		// milieu de son vrai corps). Mêmes formules que queenMat.
		const stretch = clamp( positionLocal.z.negate().mul( 2 ), 0, 1 );
		const localQ = local.sub( vec3( 0, uPivot, 0 ) ).mul( uQueenScale )
			.mul( vec3( 1.05, 1.05, float( 1 ).add( stretch.mul( 0.5 ) ) ) );
		const localW = local.sub( vec3( 0, clip.pivot, 0 ) ).mul( P.scale );
		const world = vec3(
			P.world.x,
			P.world.y.sub( clip.pivot.mul( P.scale ) ).add(
				select( P.isQueen, uPivot.mul( uQueenScale ), clip.pivot.mul( P.scale ) ),
			),
			P.world.z,
		);

		return qrot( P.q, select( P.isQueen, localQ, localW ).mul( vis ) ).add( world );

	} )();

	// jaune émissive PLAT : c'est la silhouette qui compte, pas le volume ;
	// un éclairage détaillé la rendrait moins lisible dans l'hologramme
	followMat.colorNode = vec3( 1.0, 0.82, 0.29 );

	const followMesh = new THREE.Mesh( vat.geometry, followMat );
	followMesh.frustumCulled = false;
	followMesh.renderOrder = 12;            // après l'hologramme (10)
	followMesh.visible = false;
	group.add( followMesh );

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
	const mouthOffset = ( P ) => {

		const model = modelFor( P );
		return vec3(
			float( 0 ), model.height.mul( 0.62 ).sub( model.pivot ), model.headZ.mul( 0.9 ),
		).mul( P.scale );

	};

	grainMat.positionNode = Fn( () => {

		const P = pose.read( instanceIndex );
		// grain caché avec sa porteuse : souterraine + caméra hors du bloc
		const hidden = P.under.and( uDive.lessThan( 0.01 ) );
		const show = select( P.carrying.and( hidden.not() ), float( 1 ), float( 0 ) );
		const offset = qrot( P.q, mouthOffset( P ) );

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
		const hidden = P.under.and( uDive.lessThan( 0.01 ) );
		const show = select( P.carrying.and( hidden.not() ), float( 1 ), float( 0 ) );
		const center = qrot( P.q, mouthOffset( P ) ).add( P.world );

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
		const model = modelFor( P );
		const center = qrot( P.q,
			vec3( 0, model.height.mul( 0.45 ).sub( model.pivot ), 0 ).mul( P.scale ) ).add( P.world );
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
		uDive,
		uScanAnts,
		uScanAntColor,
		scanBodies,
		uFollowIdx,
		followMesh,
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
