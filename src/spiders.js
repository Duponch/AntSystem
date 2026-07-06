// Prédateurs : araignées rôdeuses.
//
// 1 à 3 individus — à ce volume, un SkinnedMesh classique par araignée avec
// AnimationMixer (Idle/Walk/Attack du GLB) est l'outil le plus performant
// (~0,1 ms), le VAT n'aurait de sens qu'à des centaines d'instances.
//
// Machine à états par araignée : GUET → DÉAMBULATION (évite nid, obstacles,
// bords) → CHASSE (une fourmi repérée par échantillonnage GPU : 16 octets/s)
// → FRAPPE (animation Attack, fenêtre de mort brève). Le côté fourmis (fuite,
// panique, mort/respawn au nid) vit dans le kernel GPU de la simulation.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

import { GRID, WORLD, NEST, params, gridToWorld, worldToGrid } from './config.js';

const MAX_SPIDERS = 3;
const BODY_LENGTH = 3.2;              // unités monde
const KILL_RADIUS_WORLD = 1.6;

export async function createSpiders( { scene, sim, renderer, props } ) {

	const gltf = await new GLTFLoader().loadAsync( '/Spider.glb' );
	gltf.scene.updateMatrixWorld( true );

	// normalisation : longueur du corps ≈ BODY_LENGTH, pattes au sol
	const box = new THREE.Box3().setFromObject( gltf.scene );
	const size = new THREE.Vector3();
	box.getSize( size );
	const s = BODY_LENGTH / Math.max( size.x, size.z );

	const clips = {
		idle: gltf.animations.find( ( a ) => a.name.includes( 'Idle' ) ),
		walk: gltf.animations.find( ( a ) => a.name.includes( 'Walk' ) ),
		attack: gltf.animations.find( ( a ) => a.name.includes( 'Attack' ) ),
		death: gltf.animations.find( ( a ) => a.name.includes( 'Death' ) ),
	};

	const MAX_HP = 100;

	// ------------------------------------------------------------------
	const spiders = [];
	const group = new THREE.Group();
	scene.add( group );

	for ( let i = 0; i < MAX_SPIDERS; i ++ ) {

		const root = cloneSkeleton( gltf.scene );
		root.scale.setScalar( s * ( 0.9 + 0.2 * ( i / MAX_SPIDERS ) ) );
		root.position.y = - box.min.y * s;
		root.traverse( ( o ) => {

			if ( o.isMesh || o.isSkinnedMesh ) {

				o.castShadow = true;
				o.receiveShadow = true;
				o.frustumCulled = false;   // squelette animé : bornes CPU fausses

			}

		} );

		const mixer = new THREE.AnimationMixer( root );
		const actions = {
			idle: mixer.clipAction( clips.idle ),
			walk: mixer.clipAction( clips.walk ),
			attack: mixer.clipAction( clips.attack ),
			death: mixer.clipAction( clips.death ),
		};
		actions.attack.setLoop( THREE.LoopOnce );
		actions.attack.clampWhenFinished = true;
		actions.death.setLoop( THREE.LoopOnce );
		actions.death.clampWhenFinished = true;

		const a0 = ( i / MAX_SPIDERS ) * Math.PI * 2 + 0.9;

		spiders.push( {
			root, mixer, actions,
			current: null,
			state: 'idle',
			t: Math.random() * 2,
			pos: new THREE.Vector2( Math.cos( a0 ) * 55, Math.sin( a0 ) * 55 ),
			heading: Math.random() * Math.PI * 2,
			target: new THREE.Vector2(),
			killActive: 0,
			hp: MAX_HP,
			lastBites: 0,
			biteWindow: 0,
		} );

		group.add( root );

	}

	function play( sp, name, fade = 0.25, timeScale = 1 ) {

		const next = sp.actions[ name ];
		if ( sp.current === next ) {

			next.timeScale = timeScale;
			return;

		}

		next.reset().setEffectiveTimeScale( timeScale ).fadeIn( fade ).play();
		if ( sp.current ) sp.current.fadeOut( fade );
		sp.current = next;

	}

	// --- échantillonnage d'une fourmi (16 octets, ~1/s) pour la détection ---
	const lastAnt = new THREE.Vector2( 1e9, 1e9 );
	let pollAccum = 0;
	let polling = false;

	async function pollAnt() {

		if ( polling ) return;
		polling = true;

		try {

			const idx = Math.floor( Math.random() * params.antCount );
			const buf = await renderer.getArrayBufferAsync( sim.antData.value, null, idx * 16, 16 );
			const d = new Float32Array( buf );
			const w = gridToWorld( d[ 0 ], d[ 1 ] );
			lastAnt.set( w.x, w.z );

		} catch { /* device occupé */ } finally {

			polling = false;

		}

	}

	// --- morsures des soldates : compteurs stats[3..6], relevés ~2×/s ---
	let dmgAccum = 0;
	let dmgPolling = false;

	async function pollDamage() {

		if ( dmgPolling ) return;
		dmgPolling = true;

		try {

			const buf = await renderer.getArrayBufferAsync( sim.stats.value );
			const d = new Uint32Array( buf );

			for ( let i = 0; i < MAX_SPIDERS; i ++ ) {

				const bites = d[ 3 + i ] || 0;
				const delta = Math.max( 0, bites - spiders[ i ].lastBites );  // reset → 0
				spiders[ i ].lastBites = bites;
				spiders[ i ].biteWindow = delta;

			}

		} catch { /* device occupé */ } finally {

			dmgPolling = false;

		}

	}

	// --- évitements (nid, obstacles, bords) : direction corrigée ---
	const nestWorld = gridToWorld( NEST.x, NEST.y );
	const push = new THREE.Vector2();

	function steerClear( sp ) {

		push.set( 0, 0 );

		// nid : l'araignée n'ose pas approcher la fourmilière
		const dn = sp.pos.distanceTo( new THREE.Vector2( nestWorld.x, nestWorld.z ) );
		if ( dn < 12 ) push.add( sp.pos.clone().sub( { x: nestWorld.x, y: nestWorld.z } ).normalize().multiplyScalar( ( 12 - dn ) * 0.4 ) );

		// bords de la carte
		const m = WORLD / 2 - 6;
		if ( Math.abs( sp.pos.x ) > m ) push.x -= Math.sign( sp.pos.x ) * ( Math.abs( sp.pos.x ) - m ) * 0.5;
		if ( Math.abs( sp.pos.y ) > m ) push.y -= Math.sign( sp.pos.y ) * ( Math.abs( sp.pos.y ) - m ) * 0.5;

		// obstacles du décor
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

	// ------------------------------------------------------------------
	function updateSpider( sp, dt ) {

		const aggro = params.spiderAggro;
		const detect = 16 + 26 * aggro;
		sp.t -= dt;
		sp.killActive = 0;

		// dégâts des soldates : usure, retraite sous la pression, mort
		if ( sp.biteWindow > 0 && sp.state !== 'death' && sp.state !== 'respawn' ) {

			sp.hp -= sp.biteWindow * 0.006;
			const pressed = sp.biteWindow > 110;
			sp.biteWindow = 0;

			if ( sp.hp <= 0 ) {

				sp.state = 'death';
				sp.t = ( clips.death ? clips.death.duration : 1.5 ) + 1.6;
				play( sp, 'death', 0.1, 1 );
				return;

			}

			if ( pressed && sp.state !== 'attack' ) {

				// trop de morsures : elle décroche et détale loin du nid
				sp.state = 'retreat';
				sp.t = 3.5;

			}

		}

		if ( sp.state === 'death' ) {

			if ( sp.t <= 0 ) {

				sp.state = 'respawn';
				sp.t = 20;
				sp.root.visible = false;

			}

			sp.mixer.update( dt );
			return;

		}

		if ( sp.state === 'respawn' ) {

			if ( sp.t <= 0 ) {

				const a = Math.random() * Math.PI * 2;
				sp.pos.set( Math.cos( a ) * ( WORLD / 2 - 10 ), Math.sin( a ) * ( WORLD / 2 - 10 ) );
				sp.hp = MAX_HP;
				sp.state = 'idle';
				sp.t = 2;
				sp.root.visible = true;
				play( sp, 'idle', 0 );

			}

			return;

		}

		if ( sp.state === 'retreat' ) {

			// cap opposé au nid, à toute vitesse
			turnToward( sp, sp.pos.x * 3, sp.pos.y * 3, 4.5 * dt );
			steerClear( sp );
			sp.pos.x += Math.cos( sp.heading ) * 5.2 * dt;
			sp.pos.y += Math.sin( sp.heading ) * 5.2 * dt;
			play( sp, 'walk', 0.12, 2.1 );

			if ( sp.t <= 0 ) {

				sp.state = 'idle';
				sp.t = 3 + Math.random() * 3;

			}

		} else if ( sp.state === 'idle' ) {

			play( sp, 'idle' );

			if ( sp.t <= 0 ) {

				sp.state = 'roam';
				sp.t = 6 + Math.random() * 8;

			}

		} else if ( sp.state === 'roam' ) {

			// déambulation : cap qui dérive lentement
			sp.heading += ( Math.random() - 0.5 ) * 1.6 * dt;
			steerClear( sp );

			const speed = 1.3;
			sp.pos.x += Math.cos( sp.heading ) * speed * dt;
			sp.pos.y += Math.sin( sp.heading ) * speed * dt;
			play( sp, 'walk', 0.25, 0.8 );

			// une fourmi repérée à portée → chasse
			if ( sp.pos.distanceTo( lastAnt ) < detect ) {

				sp.state = 'hunt';
				sp.target.copy( lastAnt );

			} else if ( sp.t <= 0 ) {

				sp.state = 'idle';
				sp.t = 2.5 + Math.random() * 4 * ( 1 - aggro * 0.7 );

			}

		} else if ( sp.state === 'hunt' ) {

			turnToward( sp, sp.target.x, sp.target.y, 3.2 * dt );
			steerClear( sp );

			const speed = 3.4 + aggro * 1.6;
			sp.pos.x += Math.cos( sp.heading ) * speed * dt;
			sp.pos.y += Math.sin( sp.heading ) * speed * dt;
			play( sp, 'walk', 0.15, 1.7 );

			if ( sp.pos.distanceTo( sp.target ) < 2.0 ) {

				sp.state = 'attack';
				sp.t = clips.attack ? clips.attack.duration : 1.0;
				play( sp, 'attack', 0.08, 1 );

			}

		} else if ( sp.state === 'attack' ) {

			// fenêtre de mort au cœur de l'animation
			const total = clips.attack ? clips.attack.duration : 1.0;
			const elapsed = total - sp.t;
			sp.killActive = ( elapsed > total * 0.25 && elapsed < total * 0.7 ) ? 1 : 0;

			if ( sp.t <= 0 ) {

				sp.state = 'idle';
				sp.t = 1.2 + ( 1 - aggro ) * 2.5;

			}

		}

		// pose du mesh (le modèle regarde +Z)
		sp.root.position.x = sp.pos.x;
		sp.root.position.z = sp.pos.y;
		sp.root.rotation.y = Math.atan2( Math.cos( sp.heading ), Math.sin( sp.heading ) );
		sp.mixer.update( dt );

	}

	// ------------------------------------------------------------------
	return {
		group,
		update( simDt ) {

			const count = Math.min( MAX_SPIDERS, params.spiderCount );

			pollAccum += simDt;

			if ( pollAccum > 1.1 - params.spiderAggro * 0.6 && count > 0 ) {

				pollAccum = 0;
				pollAnt();

			}

			dmgAccum += simDt;

			if ( dmgAccum > 0.45 && count > 0 ) {

				dmgAccum = 0;
				pollDamage();

			}

			for ( let i = 0; i < MAX_SPIDERS; i ++ ) {

				const sp = spiders[ i ];
				const active = i < count;
				sp.root.visible = active;

				if ( active && simDt > 0 ) updateSpider( sp, simDt );

				// uniforms GPU : position grille + frappe + rayon de mort
				const g = active ? worldToGrid( sp.pos.x, sp.pos.y ) : { x: - 1e5, y: - 1e5 };
				sim._spiderVecs[ i ].set( g.x, g.y, sp.killActive, KILL_RADIUS_WORLD * ( GRID / WORLD ) );

			}

			sim.u.spiderCount.value = count;

		},
	};

}
