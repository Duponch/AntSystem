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
} from 'three/tsl';

import { loadVATMulti } from './vat.js';
import { GRID, WORLD, NEST, MAX_SPIDERS, params, gfx, gridToWorld, worldToGrid } from './config.js';

const BODY_LENGTH = 3.2;               // unités monde
const CONTACT_ANIM = 2.6;              // corps→proie estimé sous lequel joue l'anim d'attaque (« au contact »)
const CONSUME_MULT = 2.6;              // la zone de dévoration est plus large que la hitbox du corps
const MAX_HP = 100;
// modes diffusés au noyau (sectorA.z) : 0 rien, 1 morsure, 2 dévoration
const MODE_NONE = 0, MODE_BITE = 1, MODE_EAT = 2;
const CLIP = { idle: 0, walk: 1, attack: 2, death: 3 };
const T = GRID / WORLD;
const SAMPLE = 1024;                   // fourmis échantillonnées pour la détection
const WINDOW = 64;                     // fenêtre de recherche par araignée

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

export async function createSpiders( { scene, sim, renderer, props } ) {

	const vat = await loadVATMulti( '/Spider.glb', {
		clipNames: [ 'Idle', 'Walk', 'Attack', 'Death' ],
		fps: 16,
		targetLength: BODY_LENGTH,
	} );

	const clipDur = vat.clipInfos.map( ( c ) => c.duration );
	// Idle/Walk/Attack bouclent (l'attaque se répète tant que l'araignée mord/
	// dévore, au lieu de se figer sur sa dernière frame = « glissade » sans anim) ;
	// Death tient sa dernière frame.
	const isLoop = [ true, true, true, false ];

	// ------------------------------------------------------------------
	// Rendu : un seul mesh instancié, attributs dynamiques par araignée
	// ------------------------------------------------------------------
	const aPose = new THREE.InstancedBufferAttribute( new Float32Array( MAX_SPIDERS * 4 ), 4 );   // x, z, theta, échelle
	const aAnim = new THREE.InstancedBufferAttribute( new Float32Array( MAX_SPIDERS * 4 ), 4 );   // clipA, phaseA, clipB, phaseB
	const aBlend = new THREE.InstancedBufferAttribute( new Float32Array( MAX_SPIDERS ), 1 );       // poids du clip précédent
	aPose.setUsage( THREE.DynamicDrawUsage );
	aAnim.setUsage( THREE.DynamicDrawUsage );
	aBlend.setUsage( THREE.DynamicDrawUsage );

	const geo = new THREE.InstancedBufferGeometry();
	geo.index = vat.geometry.index;
	geo.setAttribute( 'position', vat.geometry.attributes.position );
	geo.setAttribute( 'aPose', aPose );
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
		const anim = attribute( 'aAnim', 'vec4' );
		const blend = attribute( 'aBlend', 'float' );

		varyingProperty( 'float', 'vSpAccent' ).assign(
			select( vertexIndex.lessThan( uint( vat.counts[ 0 ] ) ), 0, 1 ),
		);

		const local = sampleClip( anim.x, anim.y ).toVar();

		If( blend.greaterThan( 0.002 ), () => {

			local.assign( mix( local, sampleClip( anim.z, anim.w ), blend ) );

		} );

		const c = cos( pose.z );
		const s = sin( pose.z );
		const rot = mat3(
			vec3( c, 0, s.negate() ),
			vec3( 0, 1, 0 ),
			vec3( s, 0, c ),
		);

		return rot.mul( local.mul( pose.w ) ).add( vec3( pose.x, 0, pose.y ) );

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

	// ------------------------------------------------------------------
	// État CPU par araignée
	// ------------------------------------------------------------------
	const spiders = [];

	function initSpider( i ) {

		// apparition dans l'ANNEAU de fourragement (là où circulent les fourmis) :
		// le prédateur est tout de suite dans l'action, quelle que soit la taille
		// de la colonie — au lieu d'un point fixe lointain, chaotique à trouver
		const ang = Math.random() * Math.PI * 2;
		const r = WORLD * ( 0.12 + Math.random() * 0.14 );   // ~ anneau 20–42 u (carte 160)
		return {
			id: i,
			state: 'roam',
			t: 0.5 + Math.random() * 2,
			pos: new THREE.Vector2( Math.cos( ang ) * r, Math.sin( ang ) * r ),
			heading: Math.random() * Math.PI * 2,
			target: new THREE.Vector2(),
			detectTimer: Math.random() * 0.4,
			lostT: 0,
			biteMode: MODE_NONE,       // 0 rien / 1 morsure / 2 dévoration (diffusé au noyau)
			feedTimer: 0,              // décompte de dévoration
			alarm: 0,                  // pression d'alarme locale ressentie (0..1, lissée)
			lastKills: 0,              // compteur cumulé de proies tuées (delta → dévoration)
			hp: MAX_HP,
			lastBites: 0,
			biteWindow: 0,
			scaleVar: 0.85 + Math.random() * 0.3,
			clip: CLIP.idle,
			phase: Math.random(),
			prevClip: CLIP.idle,
			prevPhase: 0,
			blend: 0,
			blendRate: 4,
			speedScale: 1,
		};

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
	function resetSpiders() {

		for ( let i = 0; i < MAX_SPIDERS; i ++ ) spiders[ i ] = initSpider( i );
		spiderCorpses.length = 0;
		sampleN = 0;

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

	function advanceAnim( sp, dt ) {

		sp.phase += ( dt * sp.speedScale ) / clipDur[ sp.clip ];
		sp.phase = isLoop[ sp.clip ] ? sp.phase % 1 : Math.min( sp.phase, 0.999 );

		if ( sp.blend > 0 ) {

			sp.prevPhase += dt / clipDur[ sp.prevClip ];
			sp.prevPhase = isLoop[ sp.prevClip ] ? sp.prevPhase % 1 : Math.min( sp.prevPhase, 0.999 );
			sp.blend = Math.max( 0, sp.blend - dt * sp.blendRate );

		}

	}

	// Les lectures GPU (getArrayBufferAsync) ne sont PAS sûres en parallèle dans
	// three (les mappings concurrents se corrompent → lectures à zéro). Un seul
	// verrou partagé sérialise TOUS les relevés (échantillon de fourmis + dégâts/
	// alarme/kills) : si un relevé est en cours, les autres passent leur tour.
	let readbackBusy = false;
	let manualPoll = false;   // tests headless : coupe les relevés internes (pilotés à la main)

	// --- échantillonnage d'un lot de fourmis (16 Ko ~1×/0,6 s) ---
	const antSample = new Float32Array( SAMPLE * 2 );  // x, z monde
	let sampleN = 0;
	let pollAccum = 0;

	async function pollAnts() {

		if ( readbackBusy ) return;
		readbackBusy = true;

		try {

			const n = Math.min( SAMPLE, params.antCount );
			const start = Math.floor( Math.random() * Math.max( 1, params.antCount - n ) );
			const posBuf = await renderer.getArrayBufferAsync( sim.antData.value, null, start * 16, n * 16 );
			const stBuf = await renderer.getArrayBufferAsync( sim.antState.value, null, start * 4, n * 4 );
			const d = new Float32Array( posBuf );
			const st = new Uint32Array( stBuf );

			// on ne garde QUE les fourmis VIVANTES (état 0/1). Les MORTES gardent leur
			// position dans antData : cadavre (état 2) ET surtout DÉVORÉE (état 3,
			// invisible) — sans ce filtre, l'araignée « chasse » une fourmi fantôme
			// (invisible) à l'infini et mord/mange sur place sans fin.
			let m = 0;

			for ( let i = 0; i < n; i ++ ) {

				if ( st[ i ] >= 2 ) continue;
				const w = gridToWorld( d[ i * 4 ], d[ i * 4 + 1 ] );
				antSample[ m * 2 ] = w.x;
				antSample[ m * 2 + 1 ] = w.z;
				m ++;

			}

			sampleN = m;

		} catch { /* device occupé */ } finally {

			readbackBusy = false;

		}

	}

	// nearest ant sample within a per-spider window (bornée : coût constant)
	const nearest = new THREE.Vector2();

	function findNearest( sp, maxDist ) {

		if ( sampleN === 0 ) return false;

		let best = maxDist * maxDist;
		let found = false;
		const start = ( sp.id * 97 ) % sampleN;
		// CÔNE DE VISION : l'araignée ne « voit » que devant elle (comme la fourmi).
		// Ça l'empêche de sauter d'une proie à l'autre de gauche à droite (tremblement)
		// et rend la chasse directionnelle. Une proie collée au corps reste vue.
		const cosHalf = Math.cos( params.spiderFOV * 0.5 * Math.PI / 180 );
		const fx = Math.cos( sp.heading ), fy = Math.sin( sp.heading );

		for ( let k = 0; k < WINDOW; k ++ ) {

			const j = ( start + k ) % sampleN;
			const dx = antSample[ j * 2 ] - sp.pos.x;
			const dy = antSample[ j * 2 + 1 ] - sp.pos.y;
			const d = dx * dx + dy * dy;

			if ( d >= best ) continue;

			const dl = Math.sqrt( d );
			if ( dl > 1.5 && ( dx * fx + dy * fy ) / dl < cosHalf ) continue;   // hors du cône

			best = d;
			nearest.set( antSample[ j * 2 ], antSample[ j * 2 + 1 ] );
			found = true;

		}

		return found;

	}

	// --- morsures des soldates : buffer par araignée, relevé ~2×/s ---
	let dmgAccum = 0;
	// nombre de fourmis paniquées « autour » qui sature l'alarme (→ fuite)
	const ALARM_SATURATION = 7;

	async function pollDamage() {

		if ( readbackBusy ) return;
		readbackBusy = true;

		try {

			// 3 tampons par araignée : morsures des soldates (cumulé), pression
			// d'alarme instantanée, proies tuées (cumulé → delta = « je viens de tuer »).
			// Lectures SÉQUENTIELLES : getArrayBufferAsync n'est pas sûr en parallèle
			// (les mappings concurrents se corrompent → lectures à zéro).
			const d = new Uint32Array( await renderer.getArrayBufferAsync( sim.spiderDamage.value ) );
			const al = new Uint32Array( await renderer.getArrayBufferAsync( sim.spiderAlarm.value ) );
			const kl = new Uint32Array( await renderer.getArrayBufferAsync( sim.spiderKills.value ) );
			const kp = new Float32Array( await renderer.getArrayBufferAsync( sim.spiderKillPos.value ) );

			for ( let i = 0; i < MAX_SPIDERS; i ++ ) {

				const sp = spiders[ i ];

				const delta = Math.max( 0, ( d[ i ] || 0 ) - sp.lastBites );
				sp.lastBites = d[ i ] || 0;
				sp.biteWindow = delta;

				// alarme instantanée (virgule fixe FIXED=1024) → 0..1 lissé
				const alarmNorm = Math.min( 1, ( al[ i ] || 0 ) / 1024 / ALARM_SATURATION );
				sp.alarm += ( alarmNorm - sp.alarm ) * 0.5;

				// proies tuées depuis le dernier relevé → passe à la dévoration, sur le
				// lieu de la mise à mort (position monde du cadavre)
				sp.newKills = Math.max( 0, ( kl[ i ] || 0 ) - sp.lastKills );
				sp.lastKills = kl[ i ] || 0;
				if ( sp.newKills > 0 ) {

					const cw = gridToWorld( kp[ i * 2 ], kp[ i * 2 + 1 ] );
					sp.killX = cw.x; sp.killY = cw.z;

				}

			}

		} catch { /* device occupé */ } finally {

			readbackBusy = false;

		}

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

		// dégâts : usure, retraite sous la pression, mort
		if ( sp.biteWindow > 0 && sp.state !== 'death' && sp.state !== 'respawn' ) {

			sp.hp -= sp.biteWindow * 0.006;
			const pressed = sp.biteWindow > 110;
			sp.biteWindow = 0;

			if ( sp.hp <= 0 ) {

				sp.state = 'death';
				sp.t = clipDur[ CLIP.death ];
				play( sp, 'death', 0.1, 1 );
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

			if ( sp.t <= 0 ) {

				// chute terminée → CADAVRE PERSISTANT (pose de mort figée), et
				// l'individu réapparaît ailleurs (le nombre d'araignées vivantes tient).
				const theta = Math.atan2( Math.cos( sp.heading ), Math.sin( sp.heading ) );
				spiderCorpses.push( { x: sp.pos.x, y: sp.pos.y, theta, scale: sp.scaleVar } );
				while ( spiderCorpses.length > gfx.maxSpiderCorpses ) spiderCorpses.shift();
				sp.state = 'respawn'; sp.t = 20;

			}
			return;

		}

		if ( sp.state === 'respawn' ) {

			if ( sp.t <= 0 ) {

				const a = Math.random() * Math.PI * 2;
				sp.pos.set( Math.cos( a ) * ( WORLD / 2 - 10 ), Math.sin( a ) * ( WORLD / 2 - 10 ) );
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
			sp.pos.x += Math.cos( sp.heading ) * 5.2 * dt;
			sp.pos.y += Math.sin( sp.heading ) * 5.2 * dt;
			play( sp, 'walk', 0.12, 2.1 * params.spiderWalkAnim );

			// ne repart que si le délai est écoulé ET l'alarme retombée
			if ( sp.t <= 0 && sp.alarm < params.alarmFleeThreshold * 0.5 ) {

				sp.state = 'idle'; sp.t = 3 + Math.random() * 3;

			}

		} else if ( sp.state === 'idle' ) {

			sp.newKills = 0;
			play( sp, 'idle' );
			sp.detectTimer -= dt;

			if ( sp.detectTimer <= 0 ) {

				sp.detectTimer = 0.25 + Math.random() * 0.3;
				if ( findNearest( sp, detect ) ) { sp.state = 'hunt'; sp.target.copy( nearest ); }

			}

			if ( sp.state === 'idle' && sp.t <= 0 ) { sp.state = 'roam'; sp.t = 6 + Math.random() * 8; }

		} else if ( sp.state === 'roam' ) {

			sp.heading += ( Math.random() - 0.5 ) * 1.6 * dt;
			// patrouille l'ANNEAU de fourragement (là où les fourmis circulent),
			// au lieu de dériver vers le nid où presque personne ne forage :
			// trop loin → rentre, trop près du nid → ressort
			const dNest = sp.pos.distanceTo( nestV );
			if ( dNest > 38 ) turnToward( sp, nestV.x, nestV.y, 0.6 * dt );
			else if ( dNest < 14 ) turnToward( sp, sp.pos.x * 10, sp.pos.y * 10, 0.6 * dt );
			steerClear( sp );
			sp.pos.x += Math.cos( sp.heading ) * 1.3 * dt;
			sp.pos.y += Math.sin( sp.heading ) * 1.3 * dt;
			play( sp, 'walk', 0.25, 0.8 * params.spiderWalkAnim );

			sp.detectTimer -= dt;

			if ( sp.detectTimer <= 0 ) {

				sp.detectTimer = 0.25 + Math.random() * 0.3;
				if ( findNearest( sp, detect ) ) { sp.state = 'hunt'; sp.target.copy( nearest ); }

			}

			if ( sp.state === 'roam' && sp.t <= 0 ) {

				sp.state = 'idle';
				sp.t = 2.5 + Math.random() * 4 * ( 1 - aggro * 0.7 );

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
			if ( sp.retargetT <= 0 ) {

				sp.retargetT = 0.28;
				if ( findNearest( sp, detect * 1.4 ) ) { sp.target.copy( nearest ); sp.lostT = 0; }

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
				const step = moveSpeed * dt;
				sp.pos.x += dx / dl * step;
				sp.pos.y += dy / dl * step;

			} else {

				// APPROCHE : le long du cap (courbes douces), RÉDUITE dans les virages et
				// tant qu'on ne fait pas face à la cible (anti-toupie : pivote avant d'avancer)
				const toAim = Math.atan2( aimY - sp.pos.y, aimX - sp.pos.x );
				const facing = Math.max( 0, Math.cos( toAim - sp.heading ) );
				moveSpeed = maxSpeed * ( 1 - 0.6 * turnFrac ) * facing;
				sp.pos.x += Math.cos( sp.heading ) * moveSpeed * dt;
				sp.pos.y += Math.sin( sp.heading ) * moveSpeed * dt;

			}

			sp.biteMode = MODE_BITE;   // hitbox de morsure armée (le noyau ne mord qu'AU CORPS)

			// anim : attaque en boucle au contact ; sinon marche (foulée ∝ vitesse × calibrage)
			if ( contact ) {

				play( sp, 'attack', 0.12, 1.0 );

			} else {

				const stride = Math.max( 0.2, moveSpeed / Math.max( 1, params.spiderSpeed ) ) * params.spiderWalkAnim * 1.6;
				play( sp, 'walk', 0.12, stride );

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
				sp.state = 'idle'; sp.t = 1 + Math.random() * 2;

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
				const step = Math.min( dCorpse - 0.6, params.spiderSpeed * 0.6 * dt );
				sp.pos.x += ( tx - sp.pos.x ) / dCorpse * step;
				sp.pos.y += ( ty - sp.pos.y ) / dCorpse * step;
				play( sp, 'walk', 0.1, params.spiderWalkAnim * 1.4 );

				// cadavre inatteignable (coincé) → on abandonne au bout de quelques s
				if ( sp.feedApproach > 4 ) { sp.state = 'idle'; sp.t = 1 + Math.random() * 2; }

			} else {

				// SUR le cadavre : IMMOBILE (cap figé → pas de toupie), anim de dévoration
				// en boucle ; le chrono du repas tourne ; derniers instants → consommation.
				sp.feedApproach = 0;
				sp.feedTimer -= dt;
				play( sp, 'attack', 0.1, 0.9 );
				if ( sp.feedTimer < 0.5 ) sp.biteMode = MODE_EAT;
				if ( sp.feedTimer <= 0 ) { sp.state = 'idle'; sp.t = 0.6 + Math.random() * 1.2; }

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
			const mult = sp.biteMode === MODE_EAT ? CONSUME_MULT : 1;
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
	return {
		mesh,
		uSpiderColor,
		uSpiderAccent,
		reset: resetSpiders,
		setDebugVisible( v ) { showDebug = !! v; for ( const m of [ grabMesh, coneMesh, hitboxMesh ] ) m.visible = showDebug; },
		// hooks de débogage (tests headless : pollAnts/pollDamage sont async et ne
		// résolvent pas dans une boucle synchrone → on les awaite à la main)
		_dbg: { spiders, spiderCorpses, pollAnts, pollDamage, sampleN: () => sampleN, setManualPoll( v ) { manualPoll = !! v; } },
		update( simDt ) {

			const count = Math.min( MAX_SPIDERS, params.spiderCount | 0 );

			if ( count > 0 && ! manualPoll ) {

				pollAccum += simDt;
				if ( pollAccum > 0.3 ) { pollAccum = 0; pollAnts(); }

				// morsures/alarme/mises à mort relevées assez souvent pour que la
				// bascule vers la dévoration soit réactive après une mise à mort
				dmgAccum += simDt;
				if ( dmgAccum > 0.2 ) { dmgAccum = 0; pollDamage(); }

			}

			let render = 0;

			for ( let i = 0; i < count; i ++ ) {

				const sp = spiders[ i ];

				if ( simDt > 0 ) {

					updateSpider( sp, simDt );
					advanceAnim( sp, simDt );

				}

				if ( sp.state === 'respawn' ) continue;

				const theta = Math.atan2( Math.cos( sp.heading ), Math.sin( sp.heading ) );
				aPose.setXYZW( render, sp.pos.x, sp.pos.y, theta, sp.scaleVar );
				aAnim.setXYZW( render, sp.clip, sp.phase, sp.prevClip, sp.prevPhase );
				aBlend.setX( render, sp.blend );

				// helpers debug : hitbox corps (jaune), zone de saisie (orange), cône (bleu)
				if ( showDebug ) {

					const br = params.bodyRadius * sp.scaleVar;
					_m4.makeScale( br, br, br ); _m4.setPosition( sp.pos.x, 0.45, sp.pos.y );
					hitboxMesh.setMatrixAt( render, _m4 );

					const gr = params.fleeRadius * 0.85 / T;   // zone de saisie (monde)
					_m4.makeScale( gr, gr * 0.4, gr ); _m4.setPosition( sp.pos.x, 0.2, sp.pos.y );
					grabMesh.setMatrixAt( render, _m4 );

					// cône : orienté par le cap (avant monde = (cos h, sin h)), échelle = portée
					_q.setFromAxisAngle( _yAxis, - sp.heading );
					_vp.set( sp.pos.x, 0.12, sp.pos.y );
					_vs.set( params.spiderVision, 1, params.spiderVision );
					_m4.compose( _vp, _q, _vs );
					coneMesh.setMatrixAt( render, _m4 );

				}

				render ++;

			}

			const liveRender = render;   // les helpers ne concernent QUE les vivantes

			// CADAVRES persistants (pose de mort figée) rendus après les vivantes
			for ( let c = 0; c < spiderCorpses.length && render < MAX_SPIDERS; c ++ ) {

				const cp = spiderCorpses[ c ];
				aPose.setXYZW( render, cp.x, cp.y, cp.theta, cp.scale );
				aAnim.setXYZW( render, CLIP.death, 0.999, CLIP.death, 0.999 );
				aBlend.setX( render, 0 );
				render ++;

			}

			geo.instanceCount = render;
			mesh.visible = render > 0;
			aPose.needsUpdate = true;
			aAnim.needsUpdate = true;
			aBlend.needsUpdate = true;

			// le cône dépend du FOV : on reconstruit sa géométrie si le réglage change
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

			buildSectors( count );
			sim.u.spiderCount.value = count;
			sim.u.fleeRadius.value = params.fleeRadius;

		},
	};

}
