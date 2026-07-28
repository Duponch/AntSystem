import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
	CHAMELEON_MAX_SCAN_HZ,
	CHAMELEON_MIN_SCAN_HZ,
	CHAMELEON_STATE,
	CHAMELEON_STATE_NAMES,
	ChameleonSimulation,
	createChameleonSimulation,
} from '../src/chameleon-simulation.js';

function createPrey( positions, {
	active = true,
	withHeading = false,
} = {} ) {

	const count = positions.length;
	const x = new Float32Array( count );
	const y = new Float32Array( count );
	const z = new Float32Array( count );
	const activeMask = new Uint8Array( count );
	const visible = new Uint8Array( count );
	const captured = new Uint8Array( count );
	const headingX = new Float32Array( count );
	const headingY = new Float32Array( count );
	const headingZ = new Float32Array( count );
	const speed = new Float32Array( count );
	for ( let i = 0; i < count; i ++ ) {

		x[ i ] = positions[ i ][ 0 ];
		y[ i ] = positions[ i ][ 1 ];
		z[ i ] = positions[ i ][ 2 ];
		activeMask[ i ] = active ? 1 : 0;
		visible[ i ] = active ? 1 : 0;
		if ( withHeading ) {

			headingX[ i ] = 1;
			speed[ i ] = 2;

		}

	}

	const events = {
		captureAttempts: 0,
		positionWrites: 0,
		consumeAttempts: 0,
		consumedIndex: - 1,
		consumeX: 0,
		consumeY: 0,
		consumeZ: 0,
	};
	const prey = {
		count,
		capacity: count,
		x,
		y,
		z,
		active: activeMask,
		visible,
		captured,
		headingX,
		headingY,
		headingZ,
		speed,
		tryCapture( index ) {

			events.captureAttempts ++;
			if ( captured[ index ] || ! activeMask[ index ] ) return false;
			captured[ index ] = 1;
			return true;

		},
		setCapturedPosition( index, nextX, nextY, nextZ ) {

			events.positionWrites ++;
			x[ index ] = nextX;
			y[ index ] = nextY;
			z[ index ] = nextZ;

		},
		consume( index ) {

			events.consumeAttempts ++;
			events.consumedIndex = index;
			events.consumeX = x[ index ];
			events.consumeY = y[ index ];
			events.consumeZ = z[ index ];
			activeMask[ index ] = 0;
			visible[ index ] = 0;
			captured[ index ] = 0;
			return true;

		},
	};
	return { prey, events };

}

function createFastSimulation( overrides = {} ) {

	const simulation = new ChameleonSimulation( {
		preyCapacity: 16,
		scanFrequency: 9,
		attackDistance: 2,
		detectionDistance: 2.8,
		maxTongueLength: 2.2,
		patrolSpeed: 1,
		trackingSpeed: 1.5,
		restScanDuration: 0.02,
		aimDuration: 0.04,
		predictionTime: 0,
		extendDuration: 0.055,
		missRetractDuration: 0.06,
		contactDuration: 0.015,
		retractDuration: 0.09,
		biteDuration: 0.04,
		cooldownDuration: 0.05,
		preyRadius: 0.12,
		tongueRadius: 0.04,
		mouthConsumeRadius: 0.035,
		maxIntegrationStep: 0.0025,
		...overrides,
	} );
	simulation.setTrack( 0, 0, 0, 4, 0, 0 );
	return simulation;

}

function run( simulation, prey, duration, dt = 0.005, observer = null ) {

	const steps = Math.ceil( duration / dt );
	for ( let i = 0; i < steps; i ++ ) {

		simulation.update( dt, prey );
		if ( observer ) observer( simulation, i );

	}

}

test( 'CHAMELEON-SIM-001 exposes stable state names, view and telemetry identities', () => {

	const simulation = createChameleonSimulation();
	const view = simulation.getView();
	const telemetry = simulation.getTelemetry();

	assert.equal( CHAMELEON_STATE_NAMES.length, 9 );
	assert.deepEqual( Object.keys( CHAMELEON_STATE ), CHAMELEON_STATE_NAMES );
	assert.equal( view.stateName, 'REST_SCAN' );
	assert.equal( view.tongueVisible, 0 );
	assert.equal( view.targetIndex, - 1 );

	run( simulation, { count: 0 }, 1, 0.01 );
	assert.equal( simulation.getView(), view );
	assert.equal( simulation.getViews(), view );
	assert.equal( simulation.getTelemetry(), telemetry );
	assert.equal( telemetry.updateCalls, 100 );
	assert.ok( telemetry.integrationSteps >= telemetry.updateCalls );

} );

test( 'CHAMELEON-SIM-002 identical inputs produce identical trajectories and telemetry', () => {

	const options = {
		preyCapacity: 4,
		attackDistance: 2,
		detectionDistance: 3,
		predictionTime: 0,
		restScanDuration: 0.01,
		aimDuration: 0.05,
		cooldownDuration: 0.1,
	};
	const a = new ChameleonSimulation( options );
	const b = new ChameleonSimulation( options );
	a.setTrackSamples(
		new Float32Array( [ 0, 1, 2, 4 ] ),
		new Float32Array( [ 0, 0.1, 0.15, 0 ] ),
		new Float32Array( [ 0, 0.2, - 0.1, 0 ] ),
	);
	b.setTrackSamples(
		new Float32Array( [ 0, 1, 2, 4 ] ),
		new Float32Array( [ 0, 0.1, 0.15, 0 ] ),
		new Float32Array( [ 0, 0.2, - 0.1, 0 ] ),
	);
	const contextA = createPrey( [ [ 1.25, 0.2, 0.1 ], [ 3.5, 2, 0 ] ] );
	const contextB = createPrey( [ [ 1.25, 0.2, 0.1 ], [ 3.5, 2, 0 ] ] );

	for ( let i = 0; i < 500; i ++ ) {

		a.update( 0.004, contextA.prey );
		b.update( 0.004, contextB.prey );
		assert.deepEqual( a.getView(), b.getView() );

	}
	assert.deepEqual( a.getTelemetry(), b.getTelemetry() );
	assert.deepEqual( contextA.prey.x, contextB.prey.x );
	assert.deepEqual( contextA.prey.y, contextB.prey.y );
	assert.deepEqual( contextA.prey.z, contextB.prey.z );
	assert.deepEqual( contextA.events, contextB.events );

} );

test( 'CHAMELEON-SIM-003 patrol remains on the pre-sampled log track and reverses at its bounds', () => {

	const simulation = new ChameleonSimulation( {
		patrolSpeed: 2,
		restScanDuration: 0,
		maxIntegrationStep: 0.005,
	} );
	const x = new Float32Array( [ - 2, - 1, 0.5, 2 ] );
	const y = new Float32Array( [ 0.2, 0.45, 0.3, 0.5 ] );
	const z = new Float32Array( [ 1, 1.5, 1.2, 0.8 ] );
	simulation.setTrackSamples( x, y, z );

	let minimumTrackPosition = Infinity;
	let maximumTrackPosition = - Infinity;
	for ( let i = 0; i < 1400; i ++ ) {

		simulation.update( 0.01, { count: 0 } );
		const view = simulation.getView();
		minimumTrackPosition = Math.min( minimumTrackPosition, view.trackPosition );
		maximumTrackPosition = Math.max( maximumTrackPosition, view.trackPosition );
		assert.ok( view.trackPosition >= - 1e-7 );
		assert.ok( view.trackPosition <= view.trackLength + 1e-7 );
		assert.ok( view.x >= - 2.00001 && view.x <= 2.00001 );
		assert.ok( view.y >= 0.19999 && view.y <= 0.50001 );
		assert.ok( view.z >= 0.79999 && view.z <= 1.50001 );

	}
	assert.ok( minimumTrackPosition < 0.02 );
	assert.ok( maximumTrackPosition > simulation.trackLength - 0.02 );
	assert.ok( simulation.getTelemetry().trackReversals >= 2 );
	assert.ok( simulation.getTelemetry().maxStepDistance <= 2 * 0.005 + 1e-5 );

} );

test( 'CHAMELEON-SIM-004 never releases an attack while prey remains outside attackDistance', () => {

	const simulation = createFastSimulation( {
		attackDistance: 1,
		detectionDistance: 6,
	} );
	const { prey } = createPrey( [ [ 2, 3, 0 ] ] );

	run( simulation, prey, 3 );

	assert.equal( simulation.getTelemetry().attacksReleased, 0 );
	assert.equal( simulation.getTelemetry().contacts, 0 );
	assert.ok(
		simulation.state === CHAMELEON_STATE.TRACK_PREY
		|| simulation.state === CHAMELEON_STATE.PATROL_LOG,
	);

} );

test( 'CHAMELEON-SIM-005 successful hunt visits the complete ordered attack sequence', () => {

	const simulation = createFastSimulation();
	const { prey, events } = createPrey( [ [ 1.25, 0.13, 0 ] ] );
	const observed = new Uint8Array( CHAMELEON_STATE_NAMES.length );
	let previousState = simulation.state;
	let previousOrdinal = - 1;
	const attackOrder = new Int8Array( CHAMELEON_STATE_NAMES.length );
	attackOrder.fill( - 1 );
	attackOrder[ CHAMELEON_STATE.AIM_AND_BRACE ] = 0;
	attackOrder[ CHAMELEON_STATE.STRIKE_EXTEND ] = 1;
	attackOrder[ CHAMELEON_STATE.CONTACT ] = 2;
	attackOrder[ CHAMELEON_STATE.RETRACT_WITH_PREY ] = 3;
	attackOrder[ CHAMELEON_STATE.BITE_AND_SWALLOW ] = 4;
	attackOrder[ CHAMELEON_STATE.COOLDOWN ] = 5;

	run( simulation, prey, 1.2, 0.002, ( current ) => {

		observed[ current.state ] = 1;
		if ( current.state !== previousState ) {

			const ordinal = attackOrder[ current.state ];
			if ( ordinal >= 0 ) {

				assert.ok( ordinal >= previousOrdinal, 'attack states must not run backwards' );
				previousOrdinal = ordinal;

			}
			previousState = current.state;

		}

	} );

	for ( const state of [
		CHAMELEON_STATE.TRACK_PREY,
		CHAMELEON_STATE.AIM_AND_BRACE,
		CHAMELEON_STATE.STRIKE_EXTEND,
		CHAMELEON_STATE.CONTACT,
		CHAMELEON_STATE.RETRACT_WITH_PREY,
		CHAMELEON_STATE.BITE_AND_SWALLOW,
		CHAMELEON_STATE.COOLDOWN,
	] ) assert.equal( observed[ state ], 1, `${ CHAMELEON_STATE_NAMES[ state ] } was not observed` );
	assert.equal( events.captureAttempts, 1 );
	assert.equal( events.consumeAttempts, 1 );
	assert.equal( events.consumedIndex, 0 );
	assert.equal( simulation.getTelemetry().contacts, 1 );
	assert.equal( simulation.getTelemetry().consumed, 1 );

} );

test( 'CHAMELEON-SIM-006 aim follows prey, then release freezes a short predicted strike point', () => {

	const simulation = createFastSimulation( {
		aimDuration: 0.05,
		predictionTime: 0.04,
		predictionSpeed: 2,
	} );
	const { prey } = createPrey( [ [ 1.05, 0.13, 0 ] ], { withHeading: true } );

	while ( simulation.state !== CHAMELEON_STATE.AIM_AND_BRACE ) simulation.update( 0.002, prey );
	prey.x[ 0 ] = 1.2;
	simulation.update( 0.01, prey );
	assert.ok( Math.abs( simulation.getView().aimX - 1.2 ) < 1e-6 );

	while ( simulation.state !== CHAMELEON_STATE.STRIKE_EXTEND ) simulation.update( 0.002, prey );
	const frozenX = simulation.strikeX;
	const frozenY = simulation.strikeY;
	const frozenZ = simulation.strikeZ;
	assert.ok( frozenX > prey.x[ 0 ], 'heading should add a short forward prediction' );

	prey.x[ 0 ] = 1.8;
	prey.y[ 0 ] = 1.5;
	prey.z[ 0 ] = 0.8;
	run( simulation, prey, 0.04, 0.002 );
	assert.equal( simulation.strikeX, frozenX );
	assert.equal( simulation.strikeY, frozenY );
	assert.equal( simulation.strikeZ, frozenZ );

} );

test( 'CHAMELEON-SIM-007 contact requires a real swept tip-sphere intersection', () => {

	const hitSimulation = createFastSimulation( { predictionTime: 0 } );
	const hitContext = createPrey( [ [ 1.3, 0.13, 0 ] ] );
	run( hitSimulation, hitContext.prey, 0.5, 0.002 );
	assert.equal( hitSimulation.getTelemetry().contacts, 1 );
	assert.equal( hitContext.events.captureAttempts, 1 );

	const missSimulation = createFastSimulation( { predictionTime: 0 } );
	const missContext = createPrey( [ [ 1.3, 0.13, 0 ] ] );
	while ( missSimulation.state !== CHAMELEON_STATE.STRIKE_EXTEND ) {

		missSimulation.update( 0.002, missContext.prey );

	}
	missContext.prey.y[ 0 ] = 8;
	missContext.prey.z[ 0 ] = 6;
	run( missSimulation, missContext.prey, 0.3, 0.002 );
	assert.equal( missSimulation.getTelemetry().contacts, 0 );
	assert.equal( missSimulation.getTelemetry().misses, 1 );
	assert.equal( missContext.events.captureAttempts, 0 );
	assert.equal( missContext.events.consumeAttempts, 0 );

} );

test( 'CHAMELEON-SIM-008 capture preserves its contact offset and retracts prey continuously to the mouth', () => {

	const simulation = createFastSimulation( {
		retractDuration: 0.14,
		mouthConsumeRadius: 0.012,
	} );
	const { prey, events } = createPrey( [ [ 1.25, 0.13, 0.025 ] ] );
	let captured = false;
	let offsetX = 0;
	let offsetY = 0;
	let offsetZ = 0;
	let lastX = prey.x[ 0 ];
	let lastY = prey.y[ 0 ];
	let lastZ = prey.z[ 0 ];
	let maximumCapturedStep = 0;
	let previousBodyX = simulation.x;
	let previousBodyY = simulation.y;
	let previousBodyZ = simulation.z;

	for ( let i = 0; i < 800 && events.consumeAttempts === 0; i ++ ) {

		simulation.update( 0.002, prey );
		const bodyStep = Math.hypot(
			simulation.x - previousBodyX,
			simulation.y - previousBodyY,
			simulation.z - previousBodyZ,
		);
		assert.ok( bodyStep <= simulation.trackingSpeed * 0.002 + 1e-5 );
		previousBodyX = simulation.x;
		previousBodyY = simulation.y;
		previousBodyZ = simulation.z;

		if ( simulation.capturedIndex === 0 ) {

			const currentOffsetX = prey.x[ 0 ] - simulation.tongueTipX;
			const currentOffsetY = prey.y[ 0 ] - simulation.tongueTipY;
			const currentOffsetZ = prey.z[ 0 ] - simulation.tongueTipZ;
			if ( ! captured ) {

				captured = true;
				offsetX = currentOffsetX;
				offsetY = currentOffsetY;
				offsetZ = currentOffsetZ;
				lastX = prey.x[ 0 ];
				lastY = prey.y[ 0 ];
				lastZ = prey.z[ 0 ];

			} else {

				assert.ok( Math.abs( currentOffsetX - offsetX ) < 2e-6 );
				assert.ok( Math.abs( currentOffsetY - offsetY ) < 2e-6 );
				assert.ok( Math.abs( currentOffsetZ - offsetZ ) < 2e-6 );
				const preyStep = Math.hypot(
					prey.x[ 0 ] - lastX,
					prey.y[ 0 ] - lastY,
					prey.z[ 0 ] - lastZ,
				);
				maximumCapturedStep = Math.max( maximumCapturedStep, preyStep );
				lastX = prey.x[ 0 ];
				lastY = prey.y[ 0 ];
				lastZ = prey.z[ 0 ];

			}

		}

	}

	assert.equal( captured, true );
	assert.ok( maximumCapturedStep > 0 );
	assert.ok(
		maximumCapturedStep <= simulation.maxTongueLength * 1.6 * 0.002 / simulation.retractDuration + 0.002,
		'captured prey displacement must be bounded by the continuous retraction curve',
	);
	assert.equal( events.consumeAttempts, 1 );
	const mouthDistanceAtConsume = Math.hypot(
		events.consumeX - simulation.mouthX,
		events.consumeY - simulation.mouthY,
		events.consumeZ - simulation.mouthZ,
	);
	assert.ok( mouthDistanceAtConsume <= simulation.mouthConsumeRadius + 0.002 );

} );

test( 'CHAMELEON-SIM-009 a rejected capture is never attached or consumed', () => {

	const simulation = createFastSimulation();
	const { prey, events } = createPrey( [ [ 1.25, 0.13, 0 ] ] );
	prey.tryCapture = () => {

		events.captureAttempts ++;
		prey.captured[ 0 ] = 1;
		return false;

	};

	run( simulation, prey, 0.5, 0.002 );

	assert.equal( events.captureAttempts, 1 );
	assert.equal( events.positionWrites, 0 );
	assert.equal( events.consumeAttempts, 0 );
	assert.equal( simulation.getTelemetry().captureRejected, 1 );
	assert.equal( simulation.getTelemetry().captures, 0 );

} );

test( 'CHAMELEON-SIM-013 target scans stay at 8-10 Hz and checks are strictly capacity-bounded', () => {

	const simulation = new ChameleonSimulation( {
		preyCapacity: 7,
		scanFrequency: 99,
		restScanDuration: 0,
		maxIntegrationStep: 0.01,
	} );
	const positions = Array.from( { length: 100 }, ( _, index ) => [ index, 50, 0 ] );
	const { prey } = createPrey( positions, { active: false } );
	prey.capacity = 100;

	run( simulation, prey, 10, 0.01 );

	const telemetry = simulation.getTelemetry();
	assert.equal( simulation.scanFrequency, CHAMELEON_MAX_SCAN_HZ );
	assert.ok( telemetry.scans >= 99 && telemetry.scans <= 102 );
	assert.equal( telemetry.targetChecks, telemetry.scans * simulation.preyCapacity );

	const slow = new ChameleonSimulation( { scanFrequency: 1 } );
	assert.equal( slow.scanFrequency, CHAMELEON_MIN_SCAN_HZ );

} );

test( 'CHAMELEON-SIM-014 track buffers and public records remain stable across the hot path', async () => {

	const simulation = createFastSimulation();
	const { prey } = createPrey( [ [ 20, 20, 20 ] ] );
	const view = simulation.getView();
	const telemetry = simulation.getTelemetry();
	const trackX = simulation._trackX;
	const trackY = simulation._trackY;
	const trackZ = simulation._trackZ;
	const trackCumulative = simulation._trackCumulative;

	run( simulation, prey, 4, 0.002 );

	assert.equal( simulation.getView(), view );
	assert.equal( simulation.getTelemetry(), telemetry );
	assert.equal( simulation._trackX, trackX );
	assert.equal( simulation._trackY, trackY );
	assert.equal( simulation._trackZ, trackZ );
	assert.equal( simulation._trackCumulative, trackCumulative );

	const source = await readFile(
		new URL( '../src/chameleon-simulation.js', import.meta.url ),
		'utf8',
	);
	const hotPathStart = source.indexOf( '\n\t_integrate( dt, prey ) {' );
	const hotPathEnd = source.indexOf( '\n\t_syncPublicState()', hotPathStart );
	const hotPath = source.slice( hotPathStart, hotPathEnd );
	assert.doesNotMatch( hotPath, /\bnew\s+(?:Array|Object|Map|Set|Float32Array|Uint8Array)\b/ );
	assert.doesNotMatch( hotPath, /\.(?:map|filter|reduce|slice|sort|forEach)\s*\(/ );

} );
