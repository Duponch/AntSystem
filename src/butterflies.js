import * as THREE from 'three/webgpu';
import {
	Fn, uniform, attribute, vertexIndex, ivec2, floor, mix, textureLoad,
	texture, uv, vec3,
} from 'three/tsl';

import { qrot } from './pose.js';
import {
	BUTTERFLY_BEHAVIOR,
	BUTTERFLY_STAGE,
	createButterflySimulation,
} from './butterfly-simulation.js';
import { MAX_BUTTERFLIES, gfx } from './config.js';

function clamp( value, low, high ) {

	return Math.min( high, Math.max( low, value ) );

}

const EMPTY_FLOWER_CONTEXT = Object.freeze( { count: 0 } );

function createButterflyRenderer( vat ) {

	if ( ! vat.colorMap ) throw new Error( 'Butterfly.glb doit conserver son atlas de couleur.' );
	if ( vat.clipInfos.length !== 1 ) throw new Error( 'Butterfly.glb doit exposer un unique clip VAT.' );

	const pose = new THREE.InstancedBufferAttribute( new Float32Array( MAX_BUTTERFLIES * 4 ), 4 );
	const quaternion = new THREE.InstancedBufferAttribute( new Float32Array( MAX_BUTTERFLIES * 4 ), 4 );
	const phase = new THREE.InstancedBufferAttribute( new Float32Array( MAX_BUTTERFLIES ), 1 );
	for ( const buffer of [ pose, quaternion, phase ] ) buffer.setUsage( THREE.DynamicDrawUsage );

	const geometry = new THREE.InstancedBufferGeometry();
	geometry.index = vat.geometry.index;
	geometry.setAttribute( 'position', vat.geometry.getAttribute( 'position' ) );
	geometry.setAttribute( 'uv', vat.geometry.getAttribute( 'uv' ) );
	geometry.setAttribute( 'aPose', pose );
	geometry.setAttribute( 'aQuat', quaternion );
	geometry.setAttribute( 'aPhase', phase );
	geometry.instanceCount = 0;

	const clip = vat.clipInfos[ 0 ];
	const pivotHeight = vat.bounds.height * 0.5;
	const uTint = uniform( new THREE.Color( gfx.butterflyTint ) );
	const material = new THREE.MeshStandardNodeMaterial( {
		roughness: 0.72,
		metalness: 0,
		side: THREE.DoubleSide,
	} );
	material.flatShading = true;
	material.depthWrite = true;

	material.positionNode = Fn( () => {

		const instancePose = attribute( 'aPose', 'vec4' );
		const instanceQuat = attribute( 'aQuat', 'vec4' );
		const animationPhase = attribute( 'aPhase', 'float' );
		const rowFloat = animationPhase.fract().mul( clip.frames );
		const row0 = floor( rowFloat );
		const weight = rowFloat.sub( row0 );
		const first = row0.add( clip.offset ).toInt();
		const second = row0.add( 1 ).mod( clip.frames ).add( clip.offset ).toInt();
		const p0 = textureLoad( vat.texture, ivec2( vertexIndex.toInt(), first ) ).xyz;
		const p1 = textureLoad( vat.texture, ivec2( vertexIndex.toInt(), second ) ).xyz;
		const local = mix( p0, p1, weight );
		const pivot = vec3( 0, pivotHeight, 0 );
		return qrot( instanceQuat, local.sub( pivot ).mul( instancePose.w ) )
			.add( instancePose.xyz );

	} )();

	material.colorNode = Fn( () => {

		return texture( vat.colorMap, uv() ).rgb.mul( vec3( uTint ) );

	} )();

	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = 'ButterflyVATInstances';
	mesh.frustumCulled = false;
	mesh.castShadow = !! gfx.butterflyCastShadow;
	mesh.receiveShadow = !! gfx.butterflyReceiveShadow;
	return { mesh, geometry, material, pose, quaternion, phase, uTint, clip };

}

export function createButterflies( { scene, vat, getFlowers } ) {

	const group = new THREE.Group();
	group.name = 'Butterflies';
	const renderer = createButterflyRenderer( vat );
	group.add( renderer.mesh );
	scene.add( group );

	const habitat = { x: 0, y: 0, z: 0 };
	const context = {
		daylight: gfx.beeDaylight,
		weather: {
			temperatureC: gfx.beeTemperature,
			rain: gfx.beeRain,
			windSpeed: gfx.beeWind,
		},
		habitat,
		flowers: null,
	};
	function createLifecycleSimulation() {

		const count = clamp( Math.round( gfx.butterflyCount ), 0, MAX_BUTTERFLIES );
		const next = createButterflySimulation( {
			capacity: MAX_BUTTERFLIES,
			initialCount: 0,
			seed: 0xB0772026,
			flightSpeed: gfx.butterflySpeed,
			lifeSpeed: gfx.butterflyLifeSpeed,
		} );
		// The configured population represents lifecycle lineages. Starting them
		// in four deterministic cohorts prevents every adult disappearing at once.
		const adults = Math.ceil( count * 0.6 );
		const eggs = Math.floor( count * 0.15 );
		const larvae = Math.floor( count * 0.15 );
		const pupae = count - adults - eggs - larvae;
		if ( adults > 0 ) next.addButterflies( adults, habitat, BUTTERFLY_STAGE.ADULT );
		if ( eggs > 0 ) next.addButterflies( eggs, habitat, BUTTERFLY_STAGE.EGG );
		if ( larvae > 0 ) next.addButterflies( larvae, habitat, BUTTERFLY_STAGE.LARVA );
		if ( pupae > 0 ) next.addButterflies( pupae, habitat, BUTTERFLY_STAGE.PUPA );
		return next;

	}

	let simulation = createLifecycleSimulation();
	let surfaceVisible = true;
	let predationDirty = false;
	const predationContext = {
		count: simulation.count,
		capacity: MAX_BUTTERFLIES,
		x: null,
		y: null,
		z: null,
		visible: null,
		captured: null,
		headingX: null,
		headingY: null,
		headingZ: null,
		tryCapture( index ) {

			const accepted = simulation.tryCapture( index );
			if ( accepted ) predationDirty = true;
			return accepted;

		},
		setCapturedPosition( index, x, y, z ) {

			const accepted = simulation.setCapturedPosition( index, x, y, z );
			if ( accepted ) {

				predationDirty = true;

			}
			return accepted;

		},
		releaseCapture( index ) {

			const accepted = simulation.releaseCapture( index );
			if ( accepted ) predationDirty = true;
			return accepted;

		},
		consume( index ) {

			const accepted = simulation.consumeCaptured( index, habitat );
			if ( accepted ) predationDirty = true;
			return accepted;

		},
	};

	function syncPredationContext() {

		const views = simulation.getViews();
		predationContext.count = simulation.count;
		predationContext.x = views.x;
		predationContext.y = views.y;
		predationContext.z = views.z;
		predationContext.visible = views.visible;
		predationContext.captured = views.captured;
		predationContext.headingX = views.headingX;
		predationContext.headingY = views.headingY;
		predationContext.headingZ = views.headingZ;

	}

	const renderPosition = new THREE.Vector3();
	const heading = new THREE.Vector3();
	const modelForward = new THREE.Vector3( 0, 0, 1 );
	const attitude = new THREE.Quaternion();

	function writeInstances() {

		const views = simulation.getViews();
		let rendered = 0;

		for ( let butterfly = 0; butterfly < simulation.count; butterfly ++ ) {

			if ( views.visible[ butterfly ] !== 1 ) continue;
			renderPosition.set( views.x[ butterfly ], views.y[ butterfly ], views.z[ butterfly ] );
			if (
				views.captured[ butterfly ] !== 1
				&& views.behavior[ butterfly ] === BUTTERFLY_BEHAVIOR.FLY
			) {

				const sway = Math.sin( simulation.time * 3.7 + butterfly * 2.173 ) * 0.22;
				renderPosition.x -= views.headingZ[ butterfly ] * sway;
				renderPosition.z += views.headingX[ butterfly ] * sway;
				renderPosition.y += Math.sin( simulation.time * 5.1 + butterfly * 0.83 ) * 0.12;

			} else if ( views.captured[ butterfly ] !== 1 ) {

				renderPosition.y += Math.sin( simulation.time * 1.9 + butterfly ) * 0.025;

			}

			heading.set(
				views.headingX[ butterfly ],
				views.headingY[ butterfly ],
				views.headingZ[ butterfly ],
			);
			if ( heading.lengthSq() < 1e-6 ) heading.copy( modelForward );
			else heading.normalize();
			attitude.setFromUnitVectors( modelForward, heading );

			const offset = rendered * 4;
			renderer.pose.array[ offset ] = renderPosition.x;
			renderer.pose.array[ offset + 1 ] = renderPosition.y;
			renderer.pose.array[ offset + 2 ] = renderPosition.z;
			renderer.pose.array[ offset + 3 ] = gfx.butterflyScale;
			renderer.quaternion.array[ offset ] = attitude.x;
			renderer.quaternion.array[ offset + 1 ] = attitude.y;
			renderer.quaternion.array[ offset + 2 ] = attitude.z;
			renderer.quaternion.array[ offset + 3 ] = attitude.w;
			renderer.phase.array[ rendered ] =
				( views.animationTime[ butterfly ] / renderer.clip.duration ) % 1;
			rendered ++;

		}

		renderer.geometry.instanceCount = rendered;
		renderer.pose.needsUpdate = true;
		renderer.quaternion.needsUpdate = true;
		renderer.phase.needsUpdate = true;
		predationContext.count = simulation.count;
		predationDirty = false;
		return rendered;

	}

	function syncSimulationInputs() {

		context.daylight = gfx.beeDaylight;
		context.weather.temperatureC = gfx.beeTemperature;
		context.weather.rain = gfx.beeRain;
		context.weather.windSpeed = gfx.beeWind;
		context.flowers = getFlowers() || EMPTY_FLOWER_CONTEXT;
		simulation.flightSpeed = gfx.butterflySpeed;
		simulation.lifeSpeed = gfx.butterflyLifeSpeed;

	}

	function stepSimulation( dt ) {

		if ( ! Number.isFinite( dt ) || dt < 0 )
			throw new RangeError( 'dt must be a finite non-negative number' );
		if ( ! gfx.pollinators || ! gfx.butterflies || dt === 0 )
			return simulation.getTelemetry();
		syncSimulationInputs();
		simulation.update( dt, context );
		syncPredationContext();
		predationDirty = true;
		return simulation.getTelemetry();

	}

	function renderFrame( visible = true ) {

		surfaceVisible = visible;
		group.visible = !! gfx.pollinators && !! gfx.butterflies && surfaceVisible;
		if ( ! gfx.pollinators || ! gfx.butterflies ) return simulation.getTelemetry();
		writeInstances();
		return simulation.getTelemetry();

	}

	function update( dt, visible = true ) {

		const telemetry = stepSimulation( dt );
		renderFrame( visible );
		return telemetry;

	}


	function reset() {

		simulation = createLifecycleSimulation();
		syncPredationContext();
		writeInstances();

	}

	function setCount( value ) {

		const count = clamp( Math.round( value ), 0, MAX_BUTTERFLIES );
		gfx.butterflyCount = count;
		simulation.setCount( count, habitat );
		syncPredationContext();
		writeInstances();
		return count;

	}

	function flushPredationRender() {

		if ( predationDirty ) writeInstances();
		return renderer.geometry.instanceCount;

	}

	function setSurfaceVisible( visible ) {

		surfaceVisible = visible;
		group.visible = !! gfx.pollinators && !! gfx.butterflies && surfaceVisible;

	}

	function setTint( value ) {

		gfx.butterflyTint = value;
		renderer.uTint.value.set( value );

	}

	function setCastShadow( value ) {

		gfx.butterflyCastShadow = !! value;
		renderer.mesh.castShadow = gfx.butterflyCastShadow;

	}

	function setReceiveShadow( value ) {

		gfx.butterflyReceiveShadow = !! value;
		renderer.mesh.receiveShadow = gfx.butterflyReceiveShadow;

	}

	syncPredationContext();
	writeInstances();
	setSurfaceVisible( true );

	return {
		group,
		mesh: renderer.mesh,
		update,
		stepSimulation,
		renderFrame,
		reset,
		setCount,
		setSurfaceVisible,
		setTint,
		setCastShadow,
		setReceiveShadow,
		flushPredationRender,
		getPredationContext: () =>
			gfx.pollinators && gfx.butterflies ? predationContext : null,
		getSimulation: () => simulation,
		getTelemetry: () => simulation.getTelemetry(),
	};

}