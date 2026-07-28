// Prédateurs : araignées rôdeuses — rendu VAT instancié, prêt pour des
// CENTAINES / MILLIERS d'individus.
//
// Les 4 clips (Idle/Walk/Attack/Death) sont bakés dans une seule texture
// (voir loadVATMulti) ; chaque instance porte (clip, phase) × 2 couches + un
// facteur de fondu → transitions douces comme un AnimationMixer, mais le
// skinning ne coûte plus rien. La FSM par araignée reste CPU (triviale même à
// 1024) : guet → déambulation → chasse → frappe, retraite sous les morsures
// des soldates, mort (clip Death) puis réapparition.
//
// Côté fourmis, la menace passe par une grille de SECTEURS 8×8 : chaque fourmi
// ne teste que les 2 araignées les plus proches de son secteur — coût constant
// quel que soit le nombre de prédateurs. Les morsures des soldates
// s'accumulent dans un buffer GPU par araignée, relu ~2×/s.

import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, uniformArray, attribute, vertexIndex, varyingProperty,
	float, int, uint, vec3, ivec2, mat3, cos, sin, floor, mix, select, textureLoad,
	instancedArray, instanceIndex, uvec4, floatBitsToUint, atomicLoad,
} from 'three/tsl';

import { loadVATMulti } from './vat.js';
import { qrot } from './pose.js';
import { GRID, WORLD, NEST, MAX_ANTS, MAX_SPIDERS, params, gfx, gridToWorld, worldToGrid } from './config.js';
import { acquireReadback, tryAcquireReadback, releaseReadback } from './readback.js';

const BODY_LENGTH = 3.2;               // unités monde
const CONTACT_ANIM = 2.6;              // corps→proie estimé sous lequel joue l'anim d'attaque (« au contact »)
const CONSUME_MULT = 2.6;              // la zone de dévoration est plus large que la hitbox du corps
const MAX_HP = 100;
// modes diffusés au noyau (sectorA.z) : 0 rien, 1 morsure, 2 dévoration
const MODE_NONE = 0, MODE_BITE = 1, MODE_EAT = 2, MODE_LAND = 3;
const CLIP = { idle: 0, walk: 1, attack: 2, death: 3, jump: 4 };
// distance parcourue par cycle de marche (unités monde) : c'est une propriété
// de l'ANIMAL, pas de sa vitesse — d'où l'absence totale de patinage quel que
// soit le réglage de vitesse.
const STRIDE = BODY_LENGTH * 0.72;
const SP_GRAV = 26;                    // gravité ressentie par l'araignée (u/s²)
const T = GRID / WORLD;
const SAMPLE = 1024;                   // fourmis échantillonnées pour la détection
const WINDOW = 64;                     // fenêtre de recherche par araignée
const SNAPSHOT_SPIDER_ROWS = 2;
const SNAPSHOT_SPIDER_OFFSET = SAMPLE;
const SNAPSHOT_SIZE = SAMPLE + MAX_SPIDERS * SNAPSHOT_SPIDER_ROWS;
const ANT_POLL_INTERVAL = 0.3;
const DAMAGE_POLL_INTERVAL = 0.2;
const SPIDER_DEFAULT_SEED = 0x51F15EED;

// PRNG entier, stable entre navigateurs. Chaque araignée possède son propre
// flux : ajouter/enlever un autre individu ne décale donc pas ses décisions.
// Le zéro est exclu car xorshift32 y resterait bloqué.
export function spiderRandomSeed( seed, stream = 0 ) {

	let x = ( ( seed >>> 0 ) ^ Math.imul( ( stream + 1 ) >>> 0, 0x9E3779B9 ) ) >>> 0;
	x ^= x >>> 16;
	x = Math.imul( x, 0x7FEB352D ) >>> 0;
	x ^= x >>> 15;
	x = Math.imul( x, 0x846CA68B ) >>> 0;
	x ^= x >>> 16;
	return x === 0 ? 0x6D2B79F5 : x >>> 0;

}

export function spiderRandomNext( state ) {

	let x = state >>> 0;
	if ( x === 0 ) x = 0x6D2B79F5;
	x ^= x << 13;
	x ^= x >>> 17;
	x ^= x << 5;
	return x >>> 0;

}

// Horloge périodique indépendante du découpage de dt. Contrairement à
// `accum = 0`, le modulo conserve exactement le temps restant après une frame
// longue. `due` peut dépasser 1 ; le runtime coalesce ensuite les readbacks car
// une autorité GPU asynchrone ne peut pas reconstruire des snapshots passés.
export function advanceSpiderPollClock( clock, dt ) {

	if ( ! Number.isFinite( dt ) || dt < 0 ) throw new RangeError( 'dt must be a finite non-negative number' );
	if ( dt === 0 ) return 0;
	clock.residual += dt;
	const due = Math.floor( ( clock.residual + 1e-12 ) / clock.interval );
	if ( due > 0 ) clock.residual -= due * clock.interval;
	if ( clock.residual < 0 && clock.residual > - 1e-10 ) clock.residual = 0;
	return due;

}

// secteur plat (éventail) pour le cône de vision debug : rayon 1, pointant +X
// (avant local), dans le plan XZ ; orienté ensuite par le cap de l'araignée.
function buildConeGeo( fovDeg ) {

	const half = fovDeg * 0.5 * Math.PI / 180;
	const seg = 28;
	const pos = [ 0, 0, 0 ];
	const idx = [];
	for ( let i = 0; i <= seg; i ++ ) {

		const a = - half + 2 * half * ( i / seg );
		pos.push( Math.cos( a ), 0, Math.sin( a ) );

	}
	for ( let i = 1; i <= seg; i ++ ) idx.push( 0, i, i + 1 );
	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
	g.setIndex( idx );
	return g;

}

export async function createSpiders( { scene, sim, renderer, props, seed = null } ) {

	const vat = await loadVATMulti( '/Spider.glb', {
		clipNames: [ 'Idle', 'Walk', 'Attack', 'Death', 'Jump' ],
		fps: 16,
		targetLength: BODY_LENGTH,
	} );

	const clipDur = vat.clipInfos.map( ( c ) => c.duration );
	// hauteur du pivot corporel dans le modèle normalisé (pattes en dessous)
	const PIVOT_H = vat.bounds.height * 0.5;
	// Idle/Walk/Attack bouclent (l'attaque se répète tant que l'araignée mord/
	// dévore, au lieu de se figer sur sa dernière frame = « glissade » sans anim) ;
	// Death et Jump tiennent leur dernière frame.
	const isLoop = [ true, true, true, false, false ];

	// ------------------------------------------------------------------
	// Rendu : un seul mesh instancié, attributs dynamiques par araignée
	// ------------------------------------------------------------------
	// L'ORIENTATION est un quaternion complet (lacet + tangage + roulis) calculé
	// côté CPU : à ≤ 1024 individus c'est gratuit, et ça évite trois sin/cos par
	// SOMMET. Sans tangage/roulis, une araignée ne peut ni bondir, ni encaisser,
	// ni basculer en mourant.
	const aPose = new THREE.InstancedBufferAttribute( new Float32Array( MAX_SPIDERS * 4 ), 4 );   // x, y, z, échelle
	const aQuat = new THREE.InstancedBufferAttribute( new Float32Array( MAX_SPIDERS * 4 ), 4 );   // quaternion d'attitude
	const aAnim = new THREE.InstancedBufferAttribute( new Float32Array( MAX_SPIDERS * 4 ), 4 );   // clipA, phaseA, clipB, phaseB
	const aBlend = new THREE.InstancedBufferAttribute( new Float32Array( MAX_SPIDERS ), 1 );       // poids du clip précédent
	aPose.setUsage( THREE.DynamicDrawUsage );
	aQuat.setUsage( THREE.DynamicDrawUsage );
	aAnim.setUsage( THREE.DynamicDrawUsage );
	aBlend.setUsage( THREE.DynamicDrawUsage );

	const geo = new THREE.InstancedBufferGeometry();
	geo.index = vat.geometry.index;
	geo.setAttribute( 'position', vat.geometry.attributes.position );
	geo.setAttribute( 'aPose', aPose );
	geo.setAttribute( 'aQuat', aQuat );
	geo.setAttribute( 'aAnim', aAnim );
	geo.setAttribute( 'aBlend', aBlend );
	geo.instanceCount = 0;

	// table des clips : (offset de ligne, nb de frames)
	// .z = 1 si le clip boucle (Idle/Walk), 0 sinon (Attack/Death tiennent leur dernière frame)
	const uClips = uniformArray( vat.clipInfos.map( ( c, i ) => new THREE.Vector4( c.offset, c.frames, isLoop[ i ] ? 1 : 0, 0 ) ) );
	const uSpiderColor = uniform( new THREE.Color( gfx.spiderColor ) );
	const uSpiderAccent = uniform( new THREE.Color( gfx.spiderAccent ) );

	const material = new THREE.MeshStandardNodeMaterial( { roughness: 0.75, metalness: 0 } );

	const sampleClip = ( clipF, phase ) => {

		const info = uClips.element( clipF.toInt() );
		const rf = phase.clamp( 0, 0.999 ).mul( info.y );
		const f0 = floor( rf );
		const w = rf.sub( f0 );
		const r0 = info.x.add( f0 ).toInt();
		// clip bouclé → frame suivante circulaire ; non bouclé → maintien de la dernière
		const r1 = info.x.add( select( info.z.greaterThan( 0.5 ), f0.add( 1 ).mod( info.y ), f0.add( 1 ).min( info.y.sub( 1 ) ) ) ).toInt();
		const p0 = textureLoad( vat.texture, ivec2( vertexIndex.toInt(), r0 ) ).xyz;
		const p1 = textureLoad( vat.texture, ivec2( vertexIndex.toInt(), r1 ) ).xyz;
		return mix( p0, p1, w );

	};

	material.positionNode = Fn( () => {

		const pose = attribute( 'aPose', 'vec4' );
		const quat = attribute( 'aQuat', 'vec4' );
		const anim = attribute( 'aAnim', 'vec4' );
		const blend = attribute( 'aBlend', 'float' );

		varyingProperty( 'float', 'vSpAccent' ).assign(
			select( vertexIndex.lessThan( uint( vat.counts[ 0 ] ) ), 0, 1 ),
		);

		const local = sampleClip( anim.x, anim.y ).toVar();

		If( blend.greaterThan( 0.002 ), () => {

			local.assign( mix( local, sampleClip( anim.z, anim.w ), blend ) );

		} );

		// pivot au niveau du corps (les pattes pendent en dessous) : c'est autour
		// de lui que l'araignée tangue, roule et bascule en mourant
		const pivot = vec3( 0, PIVOT_H, 0 );

		const world = qrot( quat, local.sub( pivot ).mul( pose.w ) ).add( pose.xyz );

		return world;

	} )();

	material.colorNode = Fn( () => {

		return mix( uSpiderColor, uSpiderAccent, varyingProperty( 'float', 'vSpAccent' ) );

	} )();

	const mesh = new THREE.Mesh( geo, material );
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	scene.add( mesh );

	// ------------------------------------------------------------------
	// HELPERS DE DÉBOGAGE (cochés via l'UI) — matériaux non éclairés (toneMapped
	// false) pour des couleurs franches :
	//  • sphère JAUNE = hitbox du CORPS de l'araignée = ZONE DE MORSURE : une fourmi
	//    n'est envenimée que si SON corps touche cette sphère (jamais au bout d'une
	//    patte) ;
	//  • sphère ORANGE translucide = zone de SAISIE (immobilisation des pattes) ;
	//  • secteur BLEU = cône de vision (portée × champ). Les hitbox des fourmis, elles,
	//    sont dessinées côté ants.js.
	let showDebug = !! gfx.debugSpider;
	const mkMat = ( hex, op ) => {

		const m = new THREE.MeshBasicNodeMaterial( { color: new THREE.Color( hex ), transparent: true, opacity: op } );
		m.toneMapped = false; m.depthWrite = false;
		return m;

	};
	const hitboxMesh = new THREE.InstancedMesh( new THREE.SphereGeometry( 1, 14, 10 ), mkMat( 0xeaff00, 0.30 ), MAX_SPIDERS );
	const grabMesh = new THREE.InstancedMesh( new THREE.SphereGeometry( 1, 12, 8 ), mkMat( 0xff7a1a, 0.10 ), MAX_SPIDERS );
	let coneFov = params.spiderFOV;
	const coneMesh = new THREE.InstancedMesh( buildConeGeo( coneFov ), mkMat( 0x36c5ff, 0.13 ), MAX_SPIDERS );
	coneMesh.material.side = THREE.DoubleSide;
	for ( const m of [ grabMesh, coneMesh, hitboxMesh ] ) {

		m.frustumCulled = false; m.count = 0; m.visible = showDebug; scene.add( m );

	}
	const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion();
	const _vp = new THREE.Vector3(), _vs = new THREE.Vector3(), _yAxis = new THREE.Vector3( 0, 1, 0 );
	// composition d'attitude : lacet ∘ tangage ∘ roulis (mêmes axes que la
	// fourmi — avant = +Z, haut = +Y)
	const _qy = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qr = new THREE.Quaternion();
	const _xAxis = new THREE.Vector3( 1, 0, 0 ), _zAxis = new THREE.Vector3( 0, 0, 1 );

	function writeAttitude( slot, theta, pitch, roll ) {

		_qy.setFromAxisAngle( _yAxis, theta );
		_qp.setFromAxisAngle( _xAxis, pitch );
		_qr.setFromAxisAngle( _zAxis, roll );
		_qy.multiply( _qp ).multiply( _qr );
		aQuat.setXYZW( slot, _qy.x, _qy.y, _qy.z, _qy.w );

	}

	// ------------------------------------------------------------------
	// État CPU par araignée
	// ------------------------------------------------------------------
	const spiders = [];
	let followsSimulationSeed = seed === null || seed === undefined;
	let baseSeed = ( followsSimulationSeed ? sim.u?.seed?.value : seed );
	baseSeed = Number.isFinite( baseSeed ) ? baseSeed >>> 0 : SPIDER_DEFAULT_SEED;

	function randomSpider( sp ) {

		sp.rngState = spiderRandomNext( sp.rngState );
		return sp.rngState / 0x100000000;

	}

	function randomForSerial( stream, serial ) {

		return spiderRandomNext( spiderRandomSeed( baseSeed ^ ( serial >>> 0 ), stream ) ) / 0x100000000;

	}

	function initSpider( i ) {

		const randomState = { rngState: spiderRandomSeed( baseSeed, i ) };
		const random = () => randomSpider( randomState );
		// apparition dans l'ANNEAU de fourragement (là où circulent les fourmis) :
		// le prédateur est tout de suite dans l'action, quelle que soit la taille
		// de la colonie — au lieu d'un point fixe lointain, chaotique à trouver
		const ang = random() * Math.PI * 2;
		const r = WORLD * ( 0.12 + random() * 0.14 );   // ~ anneau 20–42 u (carte 160)
		const spider = {
			id: i,
			state: 'roam',
			t: 0.5 + random() * 2,
			pos: new THREE.Vector2( Math.cos( ang ) * r, Math.sin( ang ) * r ),
			// --- état dynamique : l'araignée a une masse, donc de l'inertie ---
			vel: new THREE.Vector2(),  // vitesse planaire (u/s)
			h: 0,                      // hauteur au-dessus du sol (u)
			vh: 0,                     // vitesse verticale (u/s)
			pitch: 0,                  // tangage courant (rad)
			roll: 0,                   // roulis courant (rad)
			pitchT: 0,                 // tangage visé
			rollT: 0,                  // roulis visé
			gait: random(),       // phase de marche, pilotée par la DISTANCE
			jumpCd: random() * params.spiderJumpCooldown,
			heading: random() * Math.PI * 2,
			target: new THREE.Vector2(),
			detectTimer: random() * 0.4,
			lostT: 0,
			biteMode: MODE_NONE,       // 0 rien / 1 morsure / 2 dévoration (diffusé au noyau)
			feedTimer: 0,              // décompte de dévoration
			alarm: 0,                  // pression d'alarme locale ressentie (0..1, lissée)
			lastKills: 0,              // compteur cumulé de proies tuées (delta → dévoration)
			hp: MAX_HP,
			lastBites: 0,
			biteWindow: 0,
			scaleVar: 0.85 + random() * 0.3,
			clip: CLIP.idle,
			phase: random(),
			prevClip: CLIP.idle,
			prevPhase: 0,
			blend: 0,
			blendRate: 4,
			speedScale: 1,
			rngState: 0,
		};
		spider.rngState = randomState.rngState;
		return spider;

	}

	for ( let i = 0; i < MAX_SPIDERS; i ++ ) spiders.push( initSpider( i ) );

	// cadavres d'araignées PERSISTANTS (ne disparaissent pas comme l'individu qui
	// réapparaît) : { x, z, theta, scale } — pose de mort figée, rendus en plus des
	// vivantes. Plafonnés (FIFO) par gfx.maxSpiderCorpses.
	const spiderCorpses = [];

	// dépose des billes de nourriture au sol (le cadavre de l'araignée nourrit la
	// colonie) : coup de « pinceau nourriture » (mode 0) drainé chaque frame
	function dropFood( wx, wy ) {

		const g = worldToGrid( wx, wy );
		sim.queueBrush( g.x, g.y, 0, 7, Math.max( 1, params.foodAmount ) );

	}

	// remet toutes les araignées à leur état/position de départ (appelé au reset)
	function resetSpiders( nextSeed = followsSimulationSeed ? sim.u?.seed?.value : baseSeed ) {

		if ( Number.isFinite( nextSeed ) ) baseSeed = nextSeed >>> 0;
		for ( let i = 0; i < MAX_SPIDERS; i ++ ) spiders[ i ] = initSpider( i );
		spiderCorpses.length = 0;
		sampleN = 0;
		antPollClock.residual = 0;
		damagePollClock.residual = 0;
		antPollPending = damagePollPending = false;
		readbackEpoch ++;
		antPollSerial = 0;
		pollTelemetry.antDeadlines = pollTelemetry.damageDeadlines = 0;
		pollTelemetry.antCoalesced = pollTelemetry.damageCoalesced = 0;

	}

	function play( sp, name, fade = 0.25, timeScale = 1 ) {

		const idx = CLIP[ name ];
		sp.speedScale = timeScale;
		if ( sp.clip === idx ) return;

		sp.prevClip = sp.clip;
		sp.prevPhase = sp.phase;
		sp.blend = 1;
		sp.blendRate = 1 / Math.max( fade, 0.01 );
		sp.clip = idx;
		sp.phase = 0;

	}

	function advanceAnim( sp, dt, dist ) {

		// LE CYCLE DE MARCHE AVANCE AVEC LA DISTANCE, PAS AVEC LE TEMPS.
		// C'est la seule façon d'éliminer le patinage : quelle que soit la
		// vitesse — accélération, virage serré, blocage contre un obstacle —
		// les pattes touchent le sol au bon endroit. Les autres clips (guet,
		// attaque, mort, bond) restent pilotés par le temps, eux ne se
		// déplacent pas.
		if ( params.physics && sp.clip === CLIP.walk ) {

			sp.phase = ( sp.phase + dist / ( STRIDE / Math.max( 0.2, params.spiderWalkAnim ) ) ) % 1;

		} else {

			sp.phase += ( dt * sp.speedScale ) / clipDur[ sp.clip ];
			sp.phase = isLoop[ sp.clip ] ? sp.phase % 1 : Math.min( sp.phase, 0.999 );

		}

		if ( sp.blend > 0 ) {

			sp.prevPhase += dt / clipDur[ sp.prevClip ];
			sp.prevPhase = isLoop[ sp.prevClip ] ? sp.prevPhase % 1 : Math.min( sp.prevPhase, 0.999 );
			sp.blend = Math.max( 0, sp.blend - dt * sp.blendRate );

		}

	}

	// ------------------------------------------------------------------
	// Intégration physique d'une araignée (masse, inertie, balistique)
	// ------------------------------------------------------------------
	// `wantX/wantY` = vitesse VOULUE par l'animal. En l'air, elle est ignorée :
	// une araignée en vol ne peut pas changer de trajectoire — c'est ce qui rend
	// un bond crédible. Renvoie la distance réellement parcourue (pour la
	// phase de marche).
	const SP_ACCEL = 9;                    // /s : nervosité de l'araignée

	function integrate( sp, dt, wantX, wantY ) {

		const px = sp.pos.x, py = sp.pos.y;

		if ( ! params.physics ) {

			sp.pos.x += wantX * dt;
			sp.pos.y += wantY * dt;
			return Math.hypot( sp.pos.x - px, sp.pos.y - py );

		}

		if ( sp.h > 1e-4 || sp.vh > 0 ) {

			sp.vh -= SP_GRAV * dt;
			sp.h += sp.vh * dt;
			// le corps suit la tangente de sa trajectoire : nez haut à la montée,
			// nez bas à la descente
			sp.pitchT = - sp.vh * 0.035;

			if ( sp.h <= 0 ) {

				// atterrissage : les pattes encaissent, le corps plonge puis se
				// redresse (le tangage visé retombe à zéro tout seul)
				sp.h = 0;
				sp.pitchT += Math.min( 0.5, Math.abs( sp.vh ) * 0.05 );
				// un atterrissage franc propage une onde de choc au sol (kernel)
				if ( Math.abs( sp.vh ) > 3 ) sp.landShock = 1;
				sp.vh = 0;
				sp.vel.multiplyScalar( 0.45 );

			}

		} else {

			sp.h = 0;
			sp.vh = 0;
			const k = Math.min( 1, SP_ACCEL * dt );
			sp.vel.x += ( wantX - sp.vel.x ) * k;
			sp.vel.y += ( wantY - sp.vel.y ) * k;

		}

		sp.pos.x += sp.vel.x * dt;
		sp.pos.y += sp.vel.y * dt;

		// le corps s'incline dans le sens de l'accélération (comme un vrai
		// animal qui démarre ou freine) et se remet à plat par ressort
		const damp = Math.min( 1, 8 * dt );
		sp.pitch += ( sp.pitchT - sp.pitch ) * damp;
		sp.roll += ( sp.rollT - sp.roll ) * damp;
		sp.pitchT *= Math.max( 0, 1 - 3 * dt );
		sp.rollT *= Math.max( 0, 1 - 3 * dt );

		return Math.hypot( sp.pos.x - px, sp.pos.y - py );

	}

	// impulsion : la seule façon d'appliquer un coup à un corps qui a une masse
	function impulse( sp, ix, iy, iv = 0 ) {

		if ( ! params.physics ) return;
		sp.vel.x += ix;
		sp.vel.y += iy;
		if ( iv > 0 ) { sp.vh += iv; sp.h = Math.max( sp.h, 1e-3 ); }

	}

	// Les lectures GPU (getArrayBufferAsync) ne sont PAS sûres en parallèle dans
	// three (les mappings concurrents se corrompent → lectures à zéro). Un seul
	// verrou partagé sérialise TOUS les relevés (échantillon de fourmis + dégâts/
	// alarme/kills) : si un relevé est en cours, les autres passent leur tour.
	// verrou readback GLOBAL (readback.js) : partagé avec readStats (overlay)
	// et le poller du couvain — deux getArrayBufferAsync concurrents se
	// corrompent mutuellement, quel que soit le module d'origine
	let manualPoll = false;   // tests headless : coupe les relevés internes (pilotés à la main)
	const antPollClock = { interval: ANT_POLL_INTERVAL, residual: 0 };
	const damagePollClock = { interval: DAMAGE_POLL_INTERVAL, residual: 0 };
	let antPollPending = false;
	let damagePollPending = false;
	let scheduledReadbackInFlight = false;
	let readbackEpoch = 0;
	let antPollSerial = 0;
	const pollTelemetry = {
		antDeadlines: 0,
		damageDeadlines: 0,
		antCoalesced: 0,
		damageCoalesced: 0,
	};
	// One packed GPU snapshot preserves the exact uint/float bit patterns while
	// reducing a combined authority boundary to a single GPU-to-CPU mapping.
	const authoritySnapshot = instancedArray( SNAPSHOT_SIZE, 'uvec4' );
	const authorityReadback = new THREE.ReadbackBuffer( SNAPSHOT_SIZE * 16 );
	authorityReadback.name = 'spider_authority_snapshot';
	const uSnapshotAntStart = uniform( 0, 'uint' );
	const uSnapshotAntCount = uniform( 0, 'uint' );
	const uSnapshotMask = uniform( 0, 'uint' );
	const kAuthoritySnapshot = Fn( () => {

		const row = instanceIndex;
		const output = authoritySnapshot.element( row );
		If( row.lessThan( uint( SAMPLE ) ), () => {

			If(
				uSnapshotMask.bitAnd( uint( 1 ) ).notEqual( uint( 0 ) )
					.and( row.lessThan( uSnapshotAntCount ) ),
				() => {

					const antIndex = row.add( uSnapshotAntStart );
					const ant = sim.antData.element( antIndex );
					output.assign( uvec4(
						floatBitsToUint( ant.x ),
						floatBitsToUint( ant.y ),
						sim.antState.element( antIndex ),
						uint( 0 ),
					) );

				},
			);

		} ).Else( () => {

			If( uSnapshotMask.bitAnd( uint( 2 ) ).notEqual( uint( 0 ) ), () => {

				const packed = row.sub( uint( SNAPSHOT_SPIDER_OFFSET ) );
				const spiderIndex = packed.shiftRight( uint( 1 ) );
				const killAnt = atomicLoad( sim.spiderKillAnt.element( spiderIndex ) );
				If( packed.bitAnd( uint( 1 ) ).equal( uint( 0 ) ), () => {

					output.assign( uvec4(
						atomicLoad( sim.spiderDamage.element( spiderIndex ) ),
						atomicLoad( sim.spiderAlarm.element( spiderIndex ) ),
						atomicLoad( sim.spiderKills.element( spiderIndex ) ),
						killAnt,
					) );

				} ).Else( () => {

					If( killAnt.lessThan( uint( MAX_ANTS ) ), () => {

						const killPos = sim.antData.element( killAnt );
						output.assign( uvec4(
							floatBitsToUint( killPos.x ), floatBitsToUint( killPos.y ), uint( 0 ), uint( 0 ),
						) );

					} ).Else( () => {

						output.assign( uvec4( uint( 0 ), uint( 0 ), uint( 0 ), uint( 0 ) ) );

					} );

				} );

			} );

		} );

	} )().compute( SNAPSHOT_SIZE );
	// Stable compute group: capture the packed snapshot first, then acknowledge
	// the kill winner on the same GPU command buffer. Later simulation submits
	// can therefore only write after the clear, without an extra queue submit.
	const kAuthoritySnapshotWithKillAck = [
		kAuthoritySnapshot,
		sim.kClearSpiderKillAnt,
	];

	function scheduleReadbacks( dt ) {

		const antDue = advanceSpiderPollClock( antPollClock, dt );
		const damageDue = advanceSpiderPollClock( damagePollClock, dt );
		if ( antDue > 0 ) {

			pollTelemetry.antDeadlines += antDue;
			pollTelemetry.antCoalesced += Math.max( 0, antDue - ( antPollPending ? 0 : 1 ) );
			antPollPending = true;

		}
		if ( damageDue > 0 ) {

			pollTelemetry.damageDeadlines += damageDue;
			pollTelemetry.damageCoalesced += Math.max( 0, damageDue - ( damagePollPending ? 0 : 1 ) );
			damagePollPending = true;

		}

	}

	// Les échéances sont déterministes en temps simulé. Leur lecture reste
	// nécessairement une observation asynchrone de la dernière autorité GPU :
	// si plusieurs échéances arrivent avant que le verrou global se libère, elles
	// sont coalescées en un snapshot récent au lieu de lancer des lectures
	// concurrentes ou de jeter le résidu de l'horloge.
	function serviceScheduledReadback() {

		// Strict/external authority owns every boundary. Never drain a relaxed
		// request left behind by the previous timing mode at an arbitrary tick.
		if ( manualPoll || externalAuthorityScheduling || scheduledReadbackInFlight ) return;
		if ( ! antPollPending && ! damagePollPending ) return;
		const ants = antPollPending;
		const damage = damagePollPending;
		const epoch = readbackEpoch;
		scheduledReadbackInFlight = true;
		const task = pollSnapshot( { ants, damage }, epoch, false );
		Promise.resolve( task ).then( ( succeeded ) => {

			if ( succeeded && epoch === readbackEpoch ) {

				if ( ants ) antPollPending = false;
				if ( damage ) damagePollPending = false;

			}

		} ).finally( () => {

			scheduledReadbackInFlight = false;

		} );

	}

	// --- échantillonnage d'un lot de fourmis (16 Ko ~1×/0,6 s) ---
	const antSample = new Float32Array( SAMPLE * 2 );  // x, z monde
	let sampleN = 0;

	async function pollAnts( epoch = readbackEpoch, waitForLock = false ) {

		return pollSnapshot( { ants: true, damage: false }, epoch, waitForLock );

	}

	// nearest ant sample within a per-spider window (bornée : coût constant)
	const nearest = new THREE.Vector2();

	// CHOIX DE CIBLE — le cœur du problème « toupie ».
	//
	// Prendre bêtement la proie la plus proche fait osciller le prédateur entre
	// deux fourmis situées de part et d'autre de lui : il amorce un demi-tour,
	// change d'avis, repart dans l'autre sens. Vu de l'extérieur, c'est une
	// araignée qui tourne sur elle-même au milieu de la mêlée.
	//
	// On note donc chaque candidate par un COÛT, pas par une distance :
	//   coût = distance
	//        + pénalité d'angle   (une proie dans le dos coûte très cher : il
	//                              faut se retourner, donc perdre du temps et
	//                              se découvrir)
	//        + pénalité de grappe (une proie loin de la cible engagée coûte
	//                              cher : dans un amas serré on change de proie
	//                              librement, entre deux amas presque jamais)
	// et on n'abandonne la cible engagée que si la nouvelle est nettement
	// meilleure (hystérésis `spiderCommit`). Résultat : dans un peloton de
	// soldates l'araignée frappe de proche en proche ; une isolée dans son dos
	// ne la fait plus pivoter.
	//
	// `cur` = cible actuellement engagée (null en phase d'acquisition).
	function findNearest( sp, maxDist, cur ) {

		if ( sampleN === 0 ) return false;

		const start = ( sp.id * 97 ) % sampleN;
		// CÔNE DE VISION : l'araignée ne « voit » que devant elle (comme la fourmi).
		const cosHalf = Math.cos( params.spiderFOV * 0.5 * Math.PI / 180 );
		const fx = Math.cos( sp.heading ), fy = Math.sin( sp.heading );
		const turnBias = params.spiderTurnBias * maxDist;
		const clusterBias = params.spiderClusterBias;

		const costOf = ( px, py ) => {

			const dx = px - sp.pos.x, dy = py - sp.pos.y;
			const dl = Math.hypot( dx, dy );
			if ( dl > maxDist ) return Infinity;
			// cos du cap → angle relatif normalisé 0 (pile devant) … 1 (dans le dos)
			const c = dl > 1e-4 ? ( dx * fx + dy * fy ) / dl : 1;
			if ( dl > 1.5 && c < cosHalf ) return Infinity;              // hors du cône
			let cost = dl + turnBias * ( 1 - c ) * 0.5;
			if ( cur ) cost += clusterBias * Math.hypot( px - cur.x, py - cur.y );
			return cost;

		};

		// coût de la cible déjà engagée : c'est elle qu'il faut battre
		let best = cur ? costOf( cur.x, cur.y ) * ( 1 - params.spiderCommit ) : Infinity;
		if ( ! isFinite( best ) ) best = maxDist * ( 1 + params.spiderTurnBias );
		let found = false;

		for ( let k = 0; k < WINDOW; k ++ ) {

			const j = ( start + k ) % sampleN;
			const cost = costOf( antSample[ j * 2 ], antSample[ j * 2 + 1 ] );
			if ( cost >= best ) continue;

			best = cost;
			nearest.set( antSample[ j * 2 ], antSample[ j * 2 + 1 ] );
			found = true;

		}

		return found;

	}

	// --- morsures des soldates : buffer par araignée, relevé ~2×/s ---
	// nombre de fourmis paniquées « autour » qui sature l'alarme (→ fuite)
	const ALARM_SATURATION = 7;

	async function pollDamage( epoch = readbackEpoch, waitForLock = false ) {

		return pollSnapshot( { ants: false, damage: true }, epoch, waitForLock );

	}

	async function pollSnapshot( { ants = false, damage = false } = {}, epoch = readbackEpoch, waitForLock = true ) {

		if ( ! ants && ! damage ) return false;
		if ( waitForLock ) await acquireReadback();
		else if ( ! tryAcquireReadback() ) return false;
		let succeeded = false;

		try {

			const activeAnts = Math.min( MAX_ANTS, Math.max( 0, params.antCount | 0 ) );
			const n = ants ? Math.min( SAMPLE, activeAnts ) : 0;
			const maxStart = Math.max( 0, activeAnts - n );
			const start = ants && maxStart > 0
				? Math.floor( randomForSerial( 0xA17, antPollSerial ) * ( maxStart + 1 ) )
				: 0;
			uSnapshotAntStart.value = start;
			uSnapshotAntCount.value = n;
			uSnapshotMask.value = ( ants ? 1 : 0 ) | ( damage ? 2 : 0 );

			// Capture then acknowledgement are encoded in-order in one compute
			// command buffer. A later simulation submit can only write after the
			// clear, and damage polling pays a single compute submission.
			renderer.compute( damage
				? kAuthoritySnapshotWithKillAck
				: kAuthoritySnapshot );

			const mapped = await renderer.getArrayBufferAsync( authoritySnapshot.value, authorityReadback );
			if ( epoch !== readbackEpoch ) return false;
			const raw = mapped.buffer;
			const words = new Uint32Array( raw );
			const floats = new Float32Array( raw );

			if ( ants ) {

				let m = 0;
				for ( let i = 0; i < n; i ++ ) {

					const base = i * 4;
					const state = words[ base + 2 ];
					if ( ( state & 7 ) >= 2 || ( state & 8 ) !== 0 ) continue;
					const world = gridToWorld( floats[ base ], floats[ base + 1 ] );
					antSample[ m * 2 ] = world.x;
					antSample[ m * 2 + 1 ] = world.z;
					m ++;

				}
				sampleN = m;
				antPollSerial ++;

			}

			if ( damage ) {

				for ( let i = 0; i < MAX_SPIDERS; i ++ ) {

					const sp = spiders[ i ];
					const base = ( SNAPSHOT_SPIDER_OFFSET + i * SNAPSHOT_SPIDER_ROWS ) * 4;
					const bites = words[ base ];
					const alarm = words[ base + 1 ];
					const kills = words[ base + 2 ];
					const killAnt = words[ base + 3 ];
					sp.biteWindow = ( bites - sp.lastBites ) >>> 0;
					sp.lastBites = bites;
					const alarmNorm = Math.min( 1, alarm / 1024 / ALARM_SATURATION );
					sp.alarm += ( alarmNorm - sp.alarm ) * 0.5;
					sp.newKills = ( kills - sp.lastKills ) >>> 0;
					sp.lastKills = kills;
					if ( sp.newKills > 0 && killAnt < MAX_ANTS ) {

						const world = gridToWorld( floats[ base + 4 ], floats[ base + 5 ] );
						sp.killX = world.x;
						sp.killY = world.z;

					}

				}
			}
			succeeded = true;

		} catch { /* keep the deterministic boundary pending and retry */ } finally {

			if ( authorityReadback._mapped ) authorityReadback.release();
			releaseReadback();

		}
		return succeeded;

	}
	// --- évitements (nid, obstacles, bords) ---
	const nestWorld = gridToWorld( NEST.x, NEST.y );
	const nestV = new THREE.Vector2( nestWorld.x, nestWorld.z );
	const push = new THREE.Vector2();

	function steerClear( sp ) {

		push.set( 0, 0 );

		// évite de s'installer SUR la fourmilière, mais rôde près de son entrée
		// (sinon, sur une petite colonie serrée au nid, elle n'attrape rien)
		const dn = sp.pos.distanceTo( nestV );
		if ( dn < 7 ) push.add( sp.pos.clone().sub( nestV ).normalize().multiplyScalar( ( 7 - dn ) * 0.5 ) );

		const m = WORLD / 2 - 6;
		if ( Math.abs( sp.pos.x ) > m ) push.x -= Math.sign( sp.pos.x ) * ( Math.abs( sp.pos.x ) - m ) * 0.5;
		if ( Math.abs( sp.pos.y ) > m ) push.y -= Math.sign( sp.pos.y ) * ( Math.abs( sp.pos.y ) - m ) * 0.5;

		for ( const e of props.registry ) {

			if ( e.category !== 'obstacles' && e.category !== 'trees' ) continue;

			for ( const p of e.placements ) {

				const r = ( e.category === 'trees' ? 1.4 : p.scale * 0.45 ) + 1.6;
				const dx = sp.pos.x - p.x;
				const dy = sp.pos.y - p.z;
				const d = Math.hypot( dx, dy );
				if ( d < r && d > 0.01 ) push.add( new THREE.Vector2( dx / d, dy / d ).multiplyScalar( ( r - d ) * 0.6 ) );

			}

		}

		if ( push.lengthSq() > 0.0001 ) {

			const desired = Math.atan2( push.y, push.x );
			const delta = Math.atan2( Math.sin( desired - sp.heading ), Math.cos( desired - sp.heading ) );
			sp.heading += delta * 0.15;

		}

	}

	// tourne le cap vers (tx,ty), borné à ±rate ; retourne l'angle RÉELLEMENT
	// tourné (sert à ralentir dans les virages serrés)
	function turnToward( sp, tx, ty, rate ) {

		const desired = Math.atan2( ty - sp.pos.y, tx - sp.pos.x );
		const delta = Math.atan2( Math.sin( desired - sp.heading ), Math.cos( desired - sp.heading ) );
		const applied = THREE.MathUtils.clamp( delta, - rate, rate );
		sp.heading += applied;
		return applied;

	}

	function updateSpider( sp, dt ) {

		const aggro = params.spiderAggro;
		const detect = params.spiderVision;   // portée de vision (cône, voir findNearest)
		sp.t -= dt;
		sp.biteMode = MODE_NONE;
		sp.moved = 0;

		// dégâts : usure, retraite sous la pression, mort
		if ( sp.biteWindow > 0 && sp.state !== 'death' && sp.state !== 'respawn' ) {

			sp.hp -= sp.biteWindow * 0.006;
			const pressed = sp.biteWindow > 110;

			// RECUL SOUS LA MÊLÉE : chaque salve de morsures pousse réellement le
			// prédateur en arrière et le déséquilibre. À plusieurs dizaines de
			// soldates accrochées, l'araignée est physiquement repoussée — ce
			// n'était jusqu'ici qu'un changement d'état.
			const push = Math.min( 1, sp.biteWindow / 90 ) * params.spiderKnockback;
			impulse( sp, - Math.cos( sp.heading ) * push, - Math.sin( sp.heading ) * push );
			sp.pitchT -= push * 0.05;
			sp.rollT += ( randomSpider( sp ) - 0.5 ) * push * 0.08;
			sp.biteWindow = 0;

			if ( sp.hp <= 0 ) {

				sp.state = 'death';
				sp.t = clipDur[ CLIP.death ];
				play( sp, 'death', 0.1, 1 );
				// AGONIE PHYSIQUE : elle se cabre, retombe et bascule sur le flanc.
				// Une araignée morte ne reste pas plantée sur ses huit pattes.
				sp.vh = 2.4;
				sp.h = 1e-3;
				sp.rollT = ( randomSpider( sp ) < 0.5 ? - 1 : 1 ) * ( 1.15 + randomSpider( sp ) * 0.5 );
				sp.pitchT = ( randomSpider( sp ) - 0.5 ) * 0.5;
				dropFood( sp.pos.x, sp.pos.y );   // billes de nourriture lâchées sur le corps
				return;

			}

			// harcelée par les soldates → elle recule (même en pleine morsure)
			if ( pressed ) {

				sp.state = 'retreat';
				sp.t = 3.5;

			}

		}

		// FUITE D'ALARME (biologie : un prédateur solitaire décroche quand la colonie
		// s'affole — trop risqué de se faire encercler). Elle bat en retraite et
		// attend, à distance, que la phéromone d'alarme se dissipe avant de retenter.
		if ( sp.alarm > params.alarmFleeThreshold
			&& sp.state !== 'death' && sp.state !== 'respawn' && sp.state !== 'retreat' ) {

			sp.state = 'retreat';
			sp.t = params.alarmWait;
			sp.feedTimer = 0;

		}

		if ( sp.state === 'death' ) {

			// elle continue de subir la gravité pendant l'animation de mort
			sp.moved = integrate( sp, dt, 0, 0 );

			if ( sp.t <= 0 ) {

				// chute terminée → CADAVRE PERSISTANT, figé dans la pose ET
				// l'ORIENTATION où la physique l'a laissé (sur le flanc, incliné),
				// pas debout comme avant.
				const theta = Math.atan2( Math.cos( sp.heading ), Math.sin( sp.heading ) );
				spiderCorpses.push( {
					x: sp.pos.x, y: sp.pos.y, theta, scale: sp.scaleVar,
					pitch: sp.pitch, roll: sp.roll,
				} );
				while ( spiderCorpses.length > gfx.maxSpiderCorpses ) spiderCorpses.shift();
				sp.state = 'respawn'; sp.t = 20;

			}
			return;

		}

		if ( sp.state === 'respawn' ) {

			if ( sp.t <= 0 ) {

				const a = randomSpider( sp ) * Math.PI * 2;
				sp.pos.set( Math.cos( a ) * ( WORLD / 2 - 10 ), Math.sin( a ) * ( WORLD / 2 - 10 ) );
				sp.vel.set( 0, 0 );
				sp.h = 0; sp.vh = 0;
				sp.pitch = sp.roll = sp.pitchT = sp.rollT = 0;
				sp.hp = MAX_HP;
				sp.state = 'idle';
				sp.t = 2;
				play( sp, 'idle', 0 );

			}

			return;

		}

		if ( sp.state === 'retreat' ) {

			turnToward( sp, sp.pos.x * 3, sp.pos.y * 3, 4.5 * dt );
			steerClear( sp );
			sp.moved = integrate( sp, dt, Math.cos( sp.heading ) * 5.2, Math.sin( sp.heading ) * 5.2 );
			play( sp, 'walk', 0.12, 2.1 * params.spiderWalkAnim );

			// ne repart que si le délai est écoulé ET l'alarme retombée
			if ( sp.t <= 0 && sp.alarm < params.alarmFleeThreshold * 0.5 ) {

				sp.state = 'idle'; sp.t = 3 + randomSpider( sp ) * 3;

			}

		} else if ( sp.state === 'idle' ) {

			sp.newKills = 0;
			sp.moved = integrate( sp, dt, 0, 0 );   // elle s'arrête en glissant, pas net
			play( sp, 'idle' );
			sp.detectTimer -= dt;

			if ( sp.detectTimer <= 0 ) {

				sp.detectTimer = 0.25 + randomSpider( sp ) * 0.3;
				if ( findNearest( sp, detect, null ) ) { sp.state = 'hunt'; sp.target.copy( nearest ); sp.lostT = 0; }

			}

			if ( sp.state === 'idle' && sp.t <= 0 ) { sp.state = 'roam'; sp.t = 6 + randomSpider( sp ) * 8; }

		} else if ( sp.state === 'roam' ) {

			sp.heading += ( randomSpider( sp ) - 0.5 ) * 1.6 * dt;
			// patrouille l'ANNEAU de fourragement (là où les fourmis circulent),
			// au lieu de dériver vers le nid où presque personne ne forage :
			// trop loin → rentre, trop près du nid → ressort
			const dNest = sp.pos.distanceTo( nestV );
			if ( dNest > 38 ) turnToward( sp, nestV.x, nestV.y, 0.6 * dt );
			else if ( dNest < 14 ) turnToward( sp, sp.pos.x * 10, sp.pos.y * 10, 0.6 * dt );
			steerClear( sp );
			sp.moved = integrate( sp, dt, Math.cos( sp.heading ) * 1.3, Math.sin( sp.heading ) * 1.3 );
			play( sp, 'walk', 0.25, 0.8 * params.spiderWalkAnim );

			sp.detectTimer -= dt;

			if ( sp.detectTimer <= 0 ) {

				sp.detectTimer = 0.25 + randomSpider( sp ) * 0.3;
				if ( findNearest( sp, detect, null ) ) { sp.state = 'hunt'; sp.target.copy( nearest ); sp.lostT = 0; }

			}

			if ( sp.state === 'roam' && sp.t <= 0 ) {

				sp.state = 'idle';
				sp.t = 2.5 + randomSpider( sp ) * 4 * ( 1 - aggro * 0.7 );

			}

		} else if ( sp.state === 'hunt' ) {

			// TRAQUE dans le CÔNE DE VISION : approche à vitesse de pointe (RÉDUITE dans
			// les virages — pas la vitesse max en tournant), puis RALENTIT au contact et
			// MORD. La morsure ne compte qu'au CORPS (le noyau teste hitbox corps
			// araignée + hitbox fourmi) — jamais au bout d'une patte. La saisie (large
			// zone) immobilise la proie ; rester dessus = envenimation graduée → mort.
			// CIBLE ENGAGÉE (anti-tremblement/« Parkinson ») : on ne re-choisit la proie
			// que ~4×/s, PAS chaque frame — sinon la « plus proche » saute d'une fourmi
			// à l'autre et l'araignée tremble de gauche à droite. Entre deux, on poursuit
			// la MÊME cible, cap lissé.
			sp.retargetT = ( sp.retargetT || 0 ) - dt;
			sp.lostT = ( sp.lostT || 0 ) + dt;

			// ENGAGEMENT DE VIRAGE. Deuxieme moitie du remede a la toupie : une
			// fois qu'elle a decide de se retourner, l'araignee VA AU BOUT. Sans
			// ca elle amorce un demi-tour, une proie repasse devant elle a
			// mi-parcours, elle repart dans l'autre sens — et ainsi de suite : vue
			// de l'exterieur, elle pivote sur place sans jamais attaquer.
			// Le verrou se leve quand elle fait de nouveau face a sa cible.
			const toTarget = Math.atan2( sp.target.y - sp.pos.y, sp.target.x - sp.pos.x );
			const off = Math.abs( Math.atan2( Math.sin( toTarget - sp.heading ), Math.cos( toTarget - sp.heading ) ) );
			if ( off > 1.75 ) sp.turnLock = 1;          // au-dela de 100 degres : elle s'engage
			if ( off < 0.7 ) sp.turnLock = 0;           // face a la cible : verrou leve

			if ( sp.retargetT <= 0 && ! sp.turnLock ) {

				// on re-evalue a cadence reglable, en PARTANT de la cible engagee :
				// findNearest ne la remplace que si une autre est nettement moins
				// couteuse (angle + grappe + hysteresis). Voir findNearest.
				sp.retargetT = params.spiderRetarget;
				const engaged = sp.lostT < 1.2 ? sp.target : null;
				if ( findNearest( sp, detect * 1.4, engaged ) ) { sp.target.copy( nearest ); sp.lostT = 0; }
				else if ( engaged ) sp.lostT = 0;   // on garde la cible engagee

			}
			const hasTarget = sp.lostT < 1.2;

			// cap visé LISSÉ vers la cible engagée (segments doux, aucun saut par frame)
			sp.aimX = ( sp.aimX == null ) ? sp.target.x : sp.aimX + ( sp.target.x - sp.aimX ) * 0.18;
			sp.aimY = ( sp.aimY == null ) ? sp.target.y : sp.aimY + ( sp.target.y - sp.aimY ) * 0.18;

			const aimX = sp.aimX, aimY = sp.aimY;
			const bodyToPrey = hasTarget ? Math.hypot( sp.target.x - sp.pos.x, sp.target.y - sp.pos.y ) : 1e9;
			// hystérésis : entre en morsure à CONTACT_ANIM, y reste jusqu'à +1 u — évite
			// le clignotement marche↔attaque quand la proie oscille autour du seuil
			const contact = bodyToPrey < ( sp.biting ? CONTACT_ANIM + 1 : CONTACT_ANIM );
			sp.biting = contact;

			sp.jumpCd -= dt;
			const airborne = sp.h > 1e-4;

			// ============================ LE BOND ============================
			// Un salticide ne trotte pas jusqu'à sa proie : il se cale, vise et
			// SAUTE. Ici c'est un vrai tir balistique — on résout la vitesse
			// initiale pour que la parabole retombe exactement sur la cible, puis
			// plus personne ne pilote : la gravité fait le reste. La proie peut
			// esquiver, l'araignée peut manquer. Le clip « Jump » du GLB, jamais
			// utilisé jusqu'ici, sert enfin.
			const jumpMax = params.spiderJumpRange;
			const jumpMin = Math.min( jumpMax * 0.55, CONTACT_ANIM + 1.2 );

			if ( params.physics && jumpMax > jumpMin && ! airborne && ! contact
				&& ! sp.turnLock && sp.jumpCd <= 0 && hasTarget
				&& bodyToPrey > jumpMin && bodyToPrey < jumpMax ) {

				const dx = sp.target.x - sp.pos.x, dy = sp.target.y - sp.pos.y;
				const toAim = Math.atan2( dy, dx );
				// il faut lui faire face : on ne saute pas de travers
				if ( Math.cos( toAim - sp.heading ) > 0.86 ) {

					// hauteur du bond PROPORTIONNELLE a la distance a franchir : un
					// salticide rase le sol sur un petit bond et se cabre sur un
					// grand. Une parabole a hauteur fixe donnait des cloches
					// absurdes sur les courtes distances.
					const apex = params.spiderJumpHeight
						* ( 0.45 + 0.55 * ( bodyToPrey - jumpMin ) / Math.max( jumpMax - jumpMin, 0.1 ) );
					const flight = 2 * Math.sqrt( 2 * Math.max( apex, 0.02 ) / SP_GRAV );
					sp.vel.set( dx / flight, dy / flight );
					sp.vh = SP_GRAV * flight * 0.5;
					sp.h = 1e-3;
					sp.jumpCd = params.spiderJumpCooldown;
					play( sp, 'jump', 0.06, 1 / Math.max( flight, 0.1 ) * clipDur[ CLIP.jump ] );

				}

			}

			if ( sp.h > 1e-4 ) {

				// EN VOL : aucun contrôle, aucun virage. C'est ce qui rend le bond
				// crédible — et faillible.
				sp.moved = integrate( sp, dt, 0, 0 );
				sp.biteMode = MODE_BITE;

			} else {

				const turnRate = ( contact ? 4.5 : 3.4 ) * dt;
				const turned = turnToward( sp, aimX, aimY, turnRate );
				steerClear( sp );
				const turnFrac = Math.min( 1, Math.abs( turned ) / ( turnRate + 1e-5 ) );
				const maxSpeed = contact ? Math.max( 1.3, params.spiderSpeed * 0.22 ) : params.spiderSpeed;

				let moveSpeed;
				if ( contact ) {

					// AU CONTACT : avance DIRECTEMENT vers la proie (jamais tangentiel → pas
					// d'orbite ni de toupie autour d'elle), sans jamais la dépasser
					const dx = aimX - sp.pos.x, dy = aimY - sp.pos.y, dl = Math.hypot( dx, dy ) || 1e-5;
					moveSpeed = Math.min( maxSpeed, dl / dt );
					sp.moved = integrate( sp, dt, dx / dl * moveSpeed, dy / dl * moveSpeed );

				} else {

					// APPROCHE : le long du cap (courbes douces), RÉDUITE dans les virages et
					// tant qu'on ne fait pas face à la cible (anti-toupie : pivote avant d'avancer)
					const toAim = Math.atan2( aimY - sp.pos.y, aimX - sp.pos.x );
					const facing = Math.max( 0, Math.cos( toAim - sp.heading ) );
					moveSpeed = maxSpeed * ( 1 - 0.6 * turnFrac ) * facing;
					sp.moved = integrate( sp, dt,
						Math.cos( sp.heading ) * moveSpeed, Math.sin( sp.heading ) * moveSpeed );

				}

				sp.biteMode = MODE_BITE;   // hitbox de morsure armée (le noyau ne mord qu'AU CORPS)

				// anim : attaque en boucle au contact ; sinon marche (la phase est
				// pilotée par la distance, le timeScale ne sert plus qu'au mode
				// historique)
				if ( contact ) {

					play( sp, 'attack', 0.12, 1.0 );
					// RECUL DU COUP : chaque frappe repousse légèrement l'araignée
					// (elle mord, elle ne pousse pas un mur)
					if ( randomSpider( sp ) < dt / Math.max( params.biteInterval, 0.05 ) ) {

						impulse( sp, - Math.cos( sp.heading ) * 1.4, - Math.sin( sp.heading ) * 1.4 );
						sp.pitchT -= 0.12;

					}

				} else {

					const stride = Math.max( 0.2, moveSpeed / Math.max( 1, params.spiderSpeed ) ) * params.spiderWalkAnim * 1.6;
					play( sp, 'walk', 0.12, stride );

				}

			}

			// DÉCLENCHEUR DE DÉVORATION robuste : soit le noyau signale une mise à mort
			// (relevé GPU async, exact), SOIT — indépendamment de tout relevé — l'araignée
			// est restée AU CONTACT à mordre assez longtemps pour tuer (temps de morsure
			// estimé). Le second cas évite qu'elle reste bloquée en morsure à l'infini si
			// le relevé async traîne (sinon : anim d'attaque en boucle sur place).
			sp.contactBiteT = contact ? ( sp.contactBiteT || 0 ) + dt : 0;
			// marge : laisse d'abord au relevé GPU (exact) le temps d'arriver ; ce
			// repli ne se déclenche que s'il n'est jamais venu, et la proie est alors
			// certainement morte (restée sous le corps bien au-delà du temps de morsure)
			const killTime = params.bitesToKill * params.biteInterval + 0.8;

			if ( sp.newKills > 0 || sp.contactBiteT >= killTime ) {

				if ( sp.newKills <= 0 ) { sp.killX = sp.aimX; sp.killY = sp.aimY; }  // pas de signal noyau → position estimée
				sp.newKills = 0;
				sp.contactBiteT = 0;
				sp.state = 'feed';
				sp.feedTimer = params.eatDuration;
				sp.feedApproach = 0;

			} else if ( sp.lostT > 1.2 ) {

				// plus aucune proie en vue depuis longtemps → on abandonne
				sp.state = 'idle'; sp.t = 1 + randomSpider( sp ) * 2;

			}

		} else if ( sp.state === 'feed' ) {

			sp.newKills = 0;   // le signal de mise à mort ne sert qu'en traque (pas de re-dévoration parasite)

			// DÉVORATION : l'araignée rejoint le lieu de la mise à mort, se met SUR le
			// cadavre, puis le dévore un COURT instant (chrono = eatDuration, décompté
			// UNIQUEMENT une fois sur place — l'approche ne mange pas le temps de repas).
			// Le cadavre disparaît (husk) en fin de repas. Une alarme forte interrompt.
			const tx = ( sp.killX == null ) ? sp.pos.x : sp.killX;
			const ty = ( sp.killY == null ) ? sp.pos.y : sp.killY;
			const dCorpse = Math.hypot( tx - sp.pos.x, ty - sp.pos.y );

			if ( dCorpse > 1.0 ) {

				// APPROCHE le cadavre (chrono de repas figé). ANTI-TOUPIE : on avance
				// DIRECTEMENT vers le cadavre (fixe) → la distance décroît toujours,
				// aucune orbite possible ; le cap pivote juste pour lui faire face.
				sp.feedApproach = ( sp.feedApproach || 0 ) + dt;
				turnToward( sp, tx, ty, 6.0 * dt );
				steerClear( sp );
				const want = Math.min( ( dCorpse - 0.6 ) / Math.max( dt, 1e-4 ), params.spiderSpeed * 0.6 );
				sp.moved = integrate( sp, dt,
					( tx - sp.pos.x ) / dCorpse * want, ( ty - sp.pos.y ) / dCorpse * want );
				play( sp, 'walk', 0.1, params.spiderWalkAnim * 1.4 );

				// cadavre inatteignable (coincé) → on abandonne au bout de quelques s
				if ( sp.feedApproach > 4 ) { sp.state = 'idle'; sp.t = 1 + randomSpider( sp ) * 2; }

			} else {

				// SUR le cadavre : IMMOBILE (cap figé → pas de toupie), anim de dévoration
				// en boucle ; le chrono du repas tourne ; derniers instants → consommation.
				sp.feedApproach = 0;
				sp.feedTimer -= dt;
				sp.moved = integrate( sp, dt, 0, 0 );
				play( sp, 'attack', 0.1, 0.9 );
				if ( sp.feedTimer < 0.5 ) sp.biteMode = MODE_EAT;
				if ( sp.feedTimer <= 0 ) { sp.state = 'idle'; sp.t = 0.6 + randomSpider( sp ) * 1.2; }

			}

		}

	}

	// ------------------------------------------------------------------
	// Grille de secteurs : les 2 araignées les plus proches par secteur
	// ------------------------------------------------------------------
	const SECTOR_TX = GRID / 8;

	function buildSectors( count ) {

		for ( let s = 0; s < 128; s ++ ) sim._sectorA[ s ].set( 0, 0, 0, 0 );

		const reach = params.fleeRadius + 12;   // texels d'influence

		for ( let i = 0; i < count; i ++ ) {

			const sp = spiders[ i ];
			if ( sp.state === 'death' || sp.state === 'respawn' ) continue;

			const g = worldToGrid( sp.pos.x, sp.pos.y );                 // centre du CORPS
			const sx0 = Math.max( 0, Math.floor( ( g.x - reach ) / SECTOR_TX ) );
			const sx1 = Math.min( 7, Math.floor( ( g.x + reach ) / SECTOR_TX ) );
			const sy0 = Math.max( 0, Math.floor( ( g.y - reach ) / SECTOR_TX ) );
			const sy1 = Math.min( 7, Math.floor( ( g.y + reach ) / SECTOR_TX ) );
			// rayon du corps (texels) = hitbox de morsure ; élargi en dévoration pour
			// rattraper le cadavre même si l'araignée s'est un peu décalée
			// zone diffusee selon le mode : morsure = corps, devoration = plus large,
			// ATTERRISSAGE = onde de choc de plusieurs longueurs de corps
			const mult = sp.biteMode === MODE_EAT ? CONSUME_MULT
				: ( sp.biteMode === MODE_LAND ? 4.5 : 1 );
			const biteR = params.bodyRadius * mult * T * sp.scaleVar;

			for ( let sy = sy0; sy <= sy1; sy ++ ) {

				for ( let sx = sx0; sx <= sx1; sx ++ ) {

					const base = ( sy * 8 + sx ) * 2;
					const cx = ( sx + 0.5 ) * SECTOR_TX;
					const cy = ( sy + 0.5 ) * SECTOR_TX;
					const d = ( g.x - cx ) ** 2 + ( g.y - cy ) ** 2;

					// A = (centre x, centre y, mode 0/1/2, rayon du corps)
					// B = (id, dist² au centre du secteur, -, -)
					// garde les 2 araignées les plus proches du centre du secteur
					if ( sim._sectorA[ base ].w === 0 || d < sim._sectorB[ base ].y ) {

						// décale l'occupant 0 vers le slot 1
						sim._sectorA[ base + 1 ].copy( sim._sectorA[ base ] );
						sim._sectorB[ base + 1 ].copy( sim._sectorB[ base ] );
						sim._sectorA[ base ].set( g.x, g.y, sp.biteMode, biteR );
						sim._sectorB[ base ].set( sp.id, d, 0, 0 );

					} else if ( sim._sectorA[ base + 1 ].w === 0 || d < sim._sectorB[ base + 1 ].y ) {

						sim._sectorA[ base + 1 ].set( g.x, g.y, sp.biteMode, biteR );
						sim._sectorB[ base + 1 ].set( sp.id, d, 0, 0 );

					}

				}

			}

		}

	}

	// ------------------------------------------------------------------
	// Pas logique et rendu sont volontairement séparés. Le scheduler global peut
	// exécuter N appels stepSimulation(FIXED_DT), puis un seul renderFrame() :
	// les trajectoires/PRNG suivent alors les ticks et les uploads restent liés
	// au nombre d'images, pas au facteur d'accélération.
	let logicalCount = Math.min( MAX_SPIDERS, params.spiderCount | 0 );
	let externalAuthorityScheduling = false;

	function stepSimulation( simDt ) {

		if ( ! Number.isFinite( simDt ) || simDt < 0 )
			throw new RangeError( 'simDt must be a finite non-negative number' );
		logicalCount = Math.min( MAX_SPIDERS, params.spiderCount | 0 );
		if ( ! externalAuthorityScheduling && logicalCount > 0 && simDt > 0 && ! manualPoll ) scheduleReadbacks( simDt );

		for ( let i = 0; i < logicalCount; i ++ ) {

			const sp = spiders[ i ];
			if ( simDt <= 0 ) continue;
			updateSpider( sp, simDt );
			// L'onde de choc dure un tick logique et prime sur la morsure.
			if ( sp.landShock ) { sp.biteMode = MODE_LAND; sp.landShock = 0; }
			advanceAnim( sp, simDt, sp.moved || 0 );

		}

		buildSectors( logicalCount );
		sim.u.spiderCount.value = logicalCount;
		sim.u.fleeRadius.value = params.fleeRadius;
		return logicalCount;

	}

	async function syncAuthoritative( { ants = false, damage = false } = {} ) {

		if ( logicalCount <= 0 || ( ! ants && ! damage ) ) return false;
		const epoch = readbackEpoch;
		if ( ! await pollSnapshot( { ants, damage }, epoch, true ) )
			throw new Error( 'authoritative spider snapshot readback failed' );
		if ( ants ) antPollPending = false;
		if ( damage ) damagePollPending = false;
		return true;

	}
	function serviceDiagnostics() {

		serviceScheduledReadback();

	}
	function renderFrame() {

		let render = 0;

		for ( let i = 0; i < logicalCount; i ++ ) {

			const sp = spiders[ i ];
			if ( sp.state === 'respawn' ) continue;
			const theta = Math.atan2( Math.cos( sp.heading ), Math.sin( sp.heading ) );
			aPose.setXYZW( render, sp.pos.x, PIVOT_H * sp.scaleVar + sp.h, sp.pos.y, sp.scaleVar );
			writeAttitude( render, theta, sp.pitch, sp.roll );
			aAnim.setXYZW( render, sp.clip, sp.phase, sp.prevClip, sp.prevPhase );
			aBlend.setX( render, sp.blend );

			if ( showDebug ) {

				const br = params.bodyRadius * sp.scaleVar;
				_m4.makeScale( br, br, br ); _m4.setPosition( sp.pos.x, 0.45 + sp.h, sp.pos.y );
				hitboxMesh.setMatrixAt( render, _m4 );
				const gr = params.fleeRadius * 0.85 / T;
				_m4.makeScale( gr, gr * 0.4, gr ); _m4.setPosition( sp.pos.x, 0.2, sp.pos.y );
				grabMesh.setMatrixAt( render, _m4 );
				_q.setFromAxisAngle( _yAxis, - sp.heading );
				_vp.set( sp.pos.x, 0.12, sp.pos.y );
				_vs.set( params.spiderVision, 1, params.spiderVision );
				_m4.compose( _vp, _q, _vs );
				coneMesh.setMatrixAt( render, _m4 );

			}
			render ++;

		}

		const liveRender = render;
		for ( let c = 0; c < spiderCorpses.length && render < MAX_SPIDERS; c ++ ) {

			const cp = spiderCorpses[ c ];
			aPose.setXYZW( render, cp.x, PIVOT_H * cp.scale, cp.y, cp.scale );
			writeAttitude( render, cp.theta, cp.pitch || 0, cp.roll || 0 );
			aAnim.setXYZW( render, CLIP.death, 0.999, CLIP.death, 0.999 );
			aBlend.setX( render, 0 );
			render ++;

		}

		geo.instanceCount = render;
		mesh.visible = render > 0;
		aPose.needsUpdate = true;
		aQuat.needsUpdate = true;
		aAnim.needsUpdate = true;
		aBlend.needsUpdate = true;

		if ( showDebug && params.spiderFOV !== coneFov ) {

			coneFov = params.spiderFOV;
			coneMesh.geometry.dispose();
			coneMesh.geometry = buildConeGeo( coneFov );

		}
		for ( const m of [ grabMesh, coneMesh, hitboxMesh ] ) {

			m.count = showDebug ? liveRender : 0;
			m.visible = showDebug && liveRender > 0;
			if ( showDebug ) m.instanceMatrix.needsUpdate = true;

		}
		return render;

	}

	function update( simDt ) {

		stepSimulation( simDt );
		return renderFrame();

	}

	return {
		mesh,
		uSpiderColor,
		uSpiderAccent,
		reset: resetSpiders,
		stepSimulation,
		syncAuthoritative,
		setExternalAuthorityScheduling( enabled ) {

			const next = !! enabled;
			if ( next && ! externalAuthorityScheduling ) {

				// Invalidate any relaxed result already mapping and drop requests
				// that have not started. Strict mode will acquire a fresh snapshot
				// at its exact integer boundary.
				readbackEpoch ++;
				antPollPending = false;
				damagePollPending = false;
				antPollClock.residual = 0;
				damagePollClock.residual = 0;

			}
			externalAuthorityScheduling = next;
		},
		serviceDiagnostics,
		renderFrame,
		update,
		setSeed( nextSeed, reset = true ) {

			if ( ! Number.isFinite( nextSeed ) ) throw new RangeError( 'seed must be finite' );
			baseSeed = nextSeed >>> 0;
			followsSimulationSeed = false;
			if ( reset ) resetSpiders( baseSeed );
			return baseSeed;

		},
		setDebugVisible( v ) {

			showDebug = !! v;
			for ( const m of [ grabMesh, coneMesh, hitboxMesh ] ) m.visible = showDebug;

		},
		_dbg: {
			spiders,
			spiderCorpses,
			pollAnts,
			pollDamage,
			pollTelemetry,
			pollClocks: { ants: antPollClock, damage: damagePollClock },
			pollPending: () => ( { ants: antPollPending, damage: damagePollPending } ),
			sampleN: () => sampleN,
			seed: () => baseSeed,
			setManualPoll( v ) { manualPoll = !! v; },
		},
	};


}
