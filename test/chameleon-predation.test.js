import assert from 'node:assert/strict';
import test from 'node:test';

import {
	BUTTERFLY_BEHAVIOR,
	BUTTERFLY_STAGE,
	ButterflySimulation,
} from '../src/butterfly-simulation.js';

function createContext() {

	return {
		daylight: 1,
		weather: {
			temperatureC: 24,
			rain: 0,
			windSpeed: 0,
		},
		habitat: { x: 2, y: 0.25, z: - 3 },
		flowers: {
			count: 1,
			x: new Float32Array( [ 12 ] ),
			y: new Float32Array( [ 1 ] ),
			z: new Float32Array( [ 4 ] ),
			active: new Uint8Array( [ 1 ] ),
			nectar: new Float32Array( [ 10 ] ),
		},
	};

}

function createAdult() {

	const simulation = new ButterflySimulation( {
		capacity: 3,
		initialCount: 1,
		initialStage: BUTTERFLY_STAGE.ADULT,
		seed: 0xc4a3e1,
		lifeSpeed: 1,
		adultDuration: 90,
		adultDurationSpread: 0,
		staggerInitialLifecycle: false,
	} );
	simulation.behavior[ 0 ] = BUTTERFLY_BEHAVIOR.FLY;
	simulation.behaviorTime[ 0 ] = 20;
	simulation.targetFlower[ 0 ] = 0;
	return simulation;

}

test( 'CHAMELEON-SIM-021 capture exposes a stable SoA flag and freezes lifecycle and motion', () => {

	const simulation = createAdult();
	const context = createContext();
	const views = simulation.getViews();

	assert.ok( simulation.captured instanceof Uint8Array );
	assert.equal( views.captured, simulation.captured );
	assert.equal( simulation.tryCapture( 0 ), true );
	assert.equal( simulation.tryCapture( 0 ), false, 'a captured butterfly cannot be captured twice' );
	assert.equal( simulation.captured[ 0 ], 1 );

	const before = {
		x: simulation.x[ 0 ],
		y: simulation.y[ 0 ],
		z: simulation.z[ 0 ],
		age: simulation.age[ 0 ],
		stageTime: simulation.stageTime[ 0 ],
		behaviorTime: simulation.behaviorTime[ 0 ],
		animationTime: simulation.animationTime[ 0 ],
		generation: simulation.generation[ 0 ],
	};

	simulation.update( 0.75, context );

	assert.equal( simulation.x[ 0 ], before.x );
	assert.equal( simulation.y[ 0 ], before.y );
	assert.equal( simulation.z[ 0 ], before.z );
	assert.equal( simulation.age[ 0 ], before.age );
	assert.equal( simulation.stageTime[ 0 ], before.stageTime );
	assert.equal( simulation.behaviorTime[ 0 ], before.behaviorTime );
	assert.equal( simulation.generation[ 0 ], before.generation );
	assert.ok(
		simulation.animationTime[ 0 ] > before.animationTime,
		'the wing animation must stay alive while the tongue carries the butterfly',
	);

} );

test( 'CHAMELEON-SIM-022 capture position follows the tongue and release resumes simulation', () => {

	const simulation = createAdult();
	const context = createContext();

	assert.equal( simulation.tryCapture( 0 ), true );
	assert.equal( simulation.setCapturedPosition( 0, 8, 3.5, - 7 ), true );
	assert.equal( simulation.x[ 0 ], 8 );
	assert.equal( simulation.y[ 0 ], 3.5 );
	assert.equal( simulation.z[ 0 ], - 7 );

	simulation.update( 0.25, context );
	assert.deepEqual(
		[ simulation.x[ 0 ], simulation.y[ 0 ], simulation.z[ 0 ] ],
		[ 8, 3.5, - 7 ],
		'the butterfly must remain attached until the predator explicitly moves it',
	);

	const frozenAge = simulation.age[ 0 ];
	assert.equal( simulation.releaseCapture( 0 ), true );
	assert.equal( simulation.releaseCapture( 0 ), false );
	assert.equal( simulation.captured[ 0 ], 0 );
	simulation.update( 0.25, context );
	assert.ok( simulation.age[ 0 ] > frozenAge, 'released butterfly resumes its lifecycle' );

} );

test( 'CHAMELEON-SIM-023 consumption restarts the prey at EGG and records predation', () => {

	const simulation = createAdult();
	const context = createContext();
	const telemetry = simulation.getTelemetry();
	const generation = simulation.generation[ 0 ];
	const cyclesCompleted = telemetry.cyclesCompleted;
	const predated = telemetry.predated;

	assert.equal( predated, 0 );
	assert.equal( simulation.tryCapture( 0 ), true );
	assert.equal( simulation.consumeCaptured( 0, context.habitat ), true );

	assert.equal( simulation.captured[ 0 ], 0 );
	assert.equal( simulation.stage[ 0 ], BUTTERFLY_STAGE.EGG );
	assert.equal( simulation.visible[ 0 ], 0 );
	assert.equal( simulation.generation[ 0 ], generation + 1 );
	assert.equal( telemetry.cyclesCompleted, cyclesCompleted + 1 );
	assert.equal( telemetry.predated, predated + 1 );
	assert.equal( telemetry.stageCounts[ BUTTERFLY_STAGE.EGG ], 1 );
	assert.equal( telemetry.visibleAdults, 0 );

} );

test( 'CHAMELEON-SIM-024 invalid, immature and uncaptured prey are rejected safely', () => {

	const simulation = new ButterflySimulation( {
		capacity: 2,
		initialCount: 1,
		initialStage: BUTTERFLY_STAGE.EGG,
		seed: 55,
		staggerInitialLifecycle: false,
	} );
	const initialStage = simulation.stage[ 0 ];
	const initialGeneration = simulation.generation[ 0 ];

	for ( const index of [ - 1, 1, Number.NaN, 0.5 ] ) {

		assert.equal( simulation.tryCapture( index ), false );
		assert.equal( simulation.setCapturedPosition( index, 1, 2, 3 ), false );
		assert.equal( simulation.releaseCapture( index ), false );
		assert.equal( simulation.consumeCaptured( index ), false );

	}
	assert.equal( simulation.tryCapture( 0 ), false, 'an egg cannot be captured' );
	assert.equal( simulation.setCapturedPosition( 0, 1, 2, 3 ), false );
	assert.equal( simulation.releaseCapture( 0 ), false );
	assert.equal( simulation.consumeCaptured( 0 ), false );
	assert.equal( simulation.stage[ 0 ], initialStage );
	assert.equal( simulation.generation[ 0 ], initialGeneration );
	assert.equal( simulation.getTelemetry().predated, 0 );

} );
