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
const KILL_RADIUS_WORLD = 2.6;         // portée de morsure (le bond rapproche)
const ATTACK_RANGE = 3.0;              // distance de déclenchement du bond
const MAX_HP = 100;
const CLIP = { idle: 0, walk: 1, attack: 2, death: 3 };
const T = GRID / WORLD;
const SAMPLE = 1024;                   // fourmis échantillonnées pour la détection
const WINDOW = 64;                     // fenêtre de recherche par araignée

export async function createSpiders( { scene, sim, renderer, props } ) {

	const vat = await loadVATMulti( '/Spider.glb', {
		clipNames: [ 'Idle', 'Walk', 'Attack', 'Death' ],
		fps: 16,
		targetLength: BODY_LENGTH,
	} );

	const clipDur = vat.clipInfos.map( ( c ) => c.duration );
	const isLoop = [ true, true, false, false ];

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
	// État CPU par araignée
	// ------------------------------------------------------------------
	const spiders = [];

	for ( let i = 0; i < MAX_SPIDERS; i ++ ) {

		const a0 = i * 2.399963; // angle d'or : dispersion homogène

		spiders.push( {
			id: i,
			state: 'idle',
			t: 1 + Math.random() * 3,
			pos: new THREE.Vector2(
				Math.cos( a0 ) * ( WORLD * 0.18 + ( i % 11 ) * WORLD * 0.028 ),
				Math.sin( a0 ) * ( WORLD * 0.18 + ( i % 7 ) * WORLD * 0.036 ),
			),
			heading: Math.random() * Math.PI * 2,
			target: new THREE.Vector2(),
			detectTimer: Math.random() * 0.4,
			killActive: 0,
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
		} );

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

	// --- échantillonnage d'un lot de fourmis (16 Ko ~1×/0,6 s) ---
	const antSample = new Float32Array( SAMPLE * 2 );  // x, z monde
	let sampleN = 0;
	let pollAccum = 0;
	let polling = false;

	async function pollAnts() {

		if ( polling ) return;
		polling = true;

		try {

			const n = Math.min( SAMPLE, params.antCount );
			const start = Math.floor( Math.random() * Math.max( 1, params.antCount - n ) );
			const posBuf = await renderer.getArrayBufferAsync( sim.antData.value, null, start * 16, n * 16 );
			const stBuf = await renderer.getArrayBufferAsync( sim.antState.value, null, start * 4, n * 4 );
			const d = new Float32Array( posBuf );
			const st = new Uint32Array( stBuf );

			// on ne garde QUE les fourmis vivantes : un cadavre (état 2) conserve sa
			// position dans antData, sinon l'araignée le chasserait sans fin
			let m = 0;

			for ( let i = 0; i < n; i ++ ) {

				if ( st[ i ] === 2 ) continue;
				const w = gridToWorld( d[ i * 4 ], d[ i * 4 + 1 ] );
				antSample[ m * 2 ] = w.x;
				antSample[ m * 2 + 1 ] = w.z;
				m ++;

			}

			sampleN = m;

		} catch { /* device occupé */ } finally {

			polling = false;

		}

	}

	// nearest ant sample within a per-spider window (bornée : coût constant)
	const nearest = new THREE.Vector2();

	function findNearest( sp, maxDist ) {

		if ( sampleN === 0 ) return false;

		let best = maxDist * maxDist;
		let found = false;
		const start = ( sp.id * 97 ) % sampleN;

		for ( let k = 0; k < WINDOW; k ++ ) {

			const j = ( start + k ) % sampleN;
			const dx = antSample[ j * 2 ] - sp.pos.x;
			const dy = antSample[ j * 2 + 1 ] - sp.pos.y;
			const d = dx * dx + dy * dy;

			if ( d < best ) {

				best = d;
				nearest.set( antSample[ j * 2 ], antSample[ j * 2 + 1 ] );
				found = true;

			}

		}

		return found;

	}

	// --- morsures des soldates : buffer par araignée, relevé ~2×/s ---
	let dmgAccum = 0;
	let dmgPolling = false;

	async function pollDamage() {

		if ( dmgPolling ) return;
		dmgPolling = true;

		try {

			const buf = await renderer.getArrayBufferAsync( sim.spiderDamage.value );
			const d = new Uint32Array( buf );

			for ( let i = 0; i < MAX_SPIDERS; i ++ ) {

				const delta = Math.max( 0, ( d[ i ] || 0 ) - spiders[ i ].lastBites );
				spiders[ i ].lastBites = d[ i ] || 0;
				spiders[ i ].biteWindow = delta;

			}

		} catch { /* device occupé */ } finally {

			dmgPolling = false;

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

	function turnToward( sp, tx, ty, rate ) {

		const desired = Math.atan2( ty - sp.pos.y, tx - sp.pos.x );
		const delta = Math.atan2( Math.sin( desired - sp.heading ), Math.cos( desired - sp.heading ) );
		sp.heading += THREE.MathUtils.clamp( delta, - rate, rate );

	}

	function updateSpider( sp, dt ) {

		const aggro = params.spiderAggro;
		const detect = 16 + 26 * aggro;
		sp.t -= dt;
		sp.killActive = 0;

		// dégâts : usure, retraite sous la pression, mort
		if ( sp.biteWindow > 0 && sp.state !== 'death' && sp.state !== 'respawn' ) {

			sp.hp -= sp.biteWindow * 0.006;
			const pressed = sp.biteWindow > 110;
			sp.biteWindow = 0;

			if ( sp.hp <= 0 ) {

				sp.state = 'death';
				sp.t = clipDur[ CLIP.death ] + 1.6;
				play( sp, 'death', 0.1, 1 );
				return;

			}

			if ( pressed && sp.state !== 'attack' ) {

				sp.state = 'retreat';
				sp.t = 3.5;

			}

		}

		if ( sp.state === 'death' ) {

			if ( sp.t <= 0 ) { sp.state = 'respawn'; sp.t = 20; }
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
			play( sp, 'walk', 0.12, 2.1 );

			if ( sp.t <= 0 ) { sp.state = 'idle'; sp.t = 3 + Math.random() * 3; }

		} else if ( sp.state === 'idle' ) {

			play( sp, 'idle' );
			sp.detectTimer -= dt;

			if ( sp.detectTimer <= 0 ) {

				sp.detectTimer = 0.25 + Math.random() * 0.3;
				if ( findNearest( sp, detect ) ) { sp.state = 'hunt'; sp.target.copy( nearest ); }

			}

			if ( sp.state === 'idle' && sp.t <= 0 ) { sp.state = 'roam'; sp.t = 6 + Math.random() * 8; }

		} else if ( sp.state === 'roam' ) {

			sp.heading += ( Math.random() - 0.5 ) * 1.6 * dt;
			// dérive vers la colonie quand on en est loin : un prédateur isolé
			// errerait sinon loin d'une petite colonie sans jamais la croiser
			if ( sp.pos.distanceTo( nestV ) > 22 ) turnToward( sp, nestV.x, nestV.y, 0.5 * dt );
			steerClear( sp );
			sp.pos.x += Math.cos( sp.heading ) * 1.3 * dt;
			sp.pos.y += Math.sin( sp.heading ) * 1.3 * dt;
			play( sp, 'walk', 0.25, 0.8 );

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

			// suivi VIVANT : on ré-accroche la fourmi la plus proche à chaque frame
			// (la cible fuit — une cible figée ferait frapper dans le vide)
			if ( findNearest( sp, detect * 1.6 ) ) {

				sp.target.copy( nearest );
				sp.lostT = 0;

			} else {

				sp.lostT = ( sp.lostT || 0 ) + dt;

			}

			turnToward( sp, sp.target.x, sp.target.y, 4.0 * dt );
			steerClear( sp );

			// plus rapide qu'une ouvrière en fuite (moveSpeed × 1.45) → elle la rattrape
			const workerFlee = ( params.moveSpeed / T ) * 1.45;
			const speed = Math.max( 4.5 + aggro * 2.5, workerFlee * 1.35 );
			sp.pos.x += Math.cos( sp.heading ) * speed * dt;
			sp.pos.y += Math.sin( sp.heading ) * speed * dt;
			play( sp, 'walk', 0.12, 1.8 );

			if ( sp.pos.distanceTo( sp.target ) < ATTACK_RANGE ) {

				sp.state = 'attack';
				sp.t = clipDur[ CLIP.attack ];
				play( sp, 'attack', 0.06, 1.15 );

			} else if ( ( sp.lostT || 0 ) > 1.2 ) {

				// proie perdue de vue trop longtemps → on abandonne
				sp.state = 'idle'; sp.t = 1 + Math.random() * 2;

			}

		} else if ( sp.state === 'attack' ) {

			// BOND guidé : l'araignée ré-accroche la proie VIVANTE la plus proche
			// à chaque frame et braque le bond dessus — sinon, en visant la
			// position échantillonnée (périmée), elle plonge là où la fourmi
			// n'est plus. La morsure (killActive) tue toute fourmi à portée.
			if ( findNearest( sp, 10 ) ) sp.target.copy( nearest );
			turnToward( sp, sp.target.x, sp.target.y, 6.5 * dt );

			const lunging = sp.phase > 0.1 && sp.phase < 0.62;
			sp.killActive = ( sp.phase > 0.12 && sp.phase < 0.66 ) ? 1 : 0;

			if ( lunging ) {

				const workerFlee = ( params.moveSpeed / T ) * 1.45;
				const lunge = Math.max( 9, workerFlee * 2.8 );
				sp.pos.x += Math.cos( sp.heading ) * lunge * dt;
				sp.pos.y += Math.sin( sp.heading ) * lunge * dt;

			}

			if ( sp.t <= 0 ) { sp.state = 'idle'; sp.t = 0.5 + ( 1 - aggro ) * 1.6; }

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

			const g = worldToGrid( sp.pos.x, sp.pos.y );
			const sx0 = Math.max( 0, Math.floor( ( g.x - reach ) / SECTOR_TX ) );
			const sx1 = Math.min( 7, Math.floor( ( g.x + reach ) / SECTOR_TX ) );
			const sy0 = Math.max( 0, Math.floor( ( g.y - reach ) / SECTOR_TX ) );
			const sy1 = Math.min( 7, Math.floor( ( g.y + reach ) / SECTOR_TX ) );
			const killR = KILL_RADIUS_WORLD * T * sp.scaleVar;

			for ( let sy = sy0; sy <= sy1; sy ++ ) {

				for ( let sx = sx0; sx <= sx1; sx ++ ) {

					const base = ( sy * 8 + sx ) * 2;
					const cx = ( sx + 0.5 ) * SECTOR_TX;
					const cy = ( sy + 0.5 ) * SECTOR_TX;
					const d = ( g.x - cx ) ** 2 + ( g.y - cy ) ** 2;

					// garde les 2 plus proches du centre du secteur
					if ( sim._sectorA[ base ].w === 0 || d < sim._sectorB[ base ].y ) {

						// décale l'occupant 0 vers le slot 1
						sim._sectorA[ base + 1 ].copy( sim._sectorA[ base ] );
						sim._sectorB[ base + 1 ].copy( sim._sectorB[ base ] );
						sim._sectorA[ base ].set( g.x, g.y, sp.killActive, killR );
						sim._sectorB[ base ].set( sp.id, d, 0, 0 );

					} else if ( sim._sectorA[ base + 1 ].w === 0 || d < sim._sectorB[ base + 1 ].y ) {

						sim._sectorA[ base + 1 ].set( g.x, g.y, sp.killActive, killR );
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
		update( simDt ) {

			const count = Math.min( MAX_SPIDERS, params.spiderCount | 0 );

			if ( count > 0 ) {

				pollAccum += simDt;
				if ( pollAccum > 0.3 ) { pollAccum = 0; pollAnts(); }

				dmgAccum += simDt;
				if ( dmgAccum > 0.45 ) { dmgAccum = 0; pollDamage(); }

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
				render ++;

			}

			geo.instanceCount = render;
			mesh.visible = render > 0;
			aPose.needsUpdate = true;
			aAnim.needsUpdate = true;
			aBlend.needsUpdate = true;

			buildSectors( count );
			sim.u.spiderCount.value = count;
			sim.u.fleeRadius.value = params.fleeRadius;

		},
	};

}
