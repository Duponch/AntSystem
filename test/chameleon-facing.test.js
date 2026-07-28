import assert from 'node:assert/strict';
import test from 'node:test';

import {
	CHAMELEON_STATE,
	ChameleonSimulation,
} from '../src/chameleon-simulation.js';

function angularDistance( a, b ) {

	let delta = b - a;
	while ( delta > Math.PI ) delta -= Math.PI * 2;
	while ( delta < - Math.PI ) delta += Math.PI * 2;
	return Math.abs( delta );

}

function headingDotToPrey( simulation, prey ) {

	const dx = prey.x[ 0 ] - simulation.x;
	const dz = prey.z[ 0 ] - simulation.z;
	const targetLength = Math.hypot( dx, dz );
	const headingLength = Math.hypot( simulation.headingX, simulation.headingZ );
	return (
		simulation.headingX * dx + simulation.headingZ * dz
	) / ( headingLength * targetLength );

}

test( 'CHAMELEON-SIM-028 lateral prey produces a smooth turn and a strongly aligned release', () => {

	const turnSpeed = 6;
	const dt = 0.01;
	const simulation = new ChameleonSimulation( {
		preyCapacity: 1,
		scanFrequency: 10,
		attackDistance: 2,
		detectionDistance: 2.8,
		maxTongueLength: 2.2,
		patrolSpeed: 0.62,
		trackingSpeed: 0.95,
		turnSpeed,
		restScanDuration: 0,
		aimDuration: 0.55,
		predictionTime: 0,
		maxIntegrationStep: dt,
	} );
	simulation.setTrack( 0, 0, 0, 4, 0, 0 );

	const prey = {
		count: 1,
		capacity: 1,
		x: new Float32Array( [ 0.05 ] ),
		y: new Float32Array( [ 0.13 ] ),
		z: new Float32Array( [ 1.35 ] ),
		active: new Uint8Array( [ 1 ] ),
		visible: new Uint8Array( [ 1 ] ),
		captured: new Uint8Array( [ 0 ] ),
	};

	let previousAngle = Math.atan2( simulation.headingZ, simulation.headingX );
	let previousDot = - Infinity;
	let aimSamples = 0;
	let enteredAim = false;
	let releaseDot = - 1;
	const maximumAngularStep = turnSpeed * dt * 1.08 + 1e-6;

	for ( let step = 0; step < 400; step ++ ) {

		const previousHeadingX = simulation.headingX;
		const previousHeadingZ = simulation.headingZ;
		simulation.update( dt, prey );
		const angle = Math.atan2( simulation.headingZ, simulation.headingX );

		if ( simulation.state === CHAMELEON_STATE.AIM_AND_BRACE ) {

			const dot = headingDotToPrey( simulation, prey );
			if ( ! enteredAim ) {

				enteredAim = true;
				const dx = prey.x[ 0 ] - simulation.x;
				const dz = prey.z[ 0 ] - simulation.z;
				const targetLength = Math.hypot( dx, dz );
				const previousLength = Math.hypot( previousHeadingX, previousHeadingZ );
				const preAimDot = (
					previousHeadingX * dx + previousHeadingZ * dz
				) / ( previousLength * targetLength );

				assert.ok( preAimDot < 0.25, 'fixture must begin as a genuinely lateral target' );
				assert.ok( dot > preAimDot, 'the first aim step must turn toward the prey' );

			}
			assert.ok(
				angularDistance( previousAngle, angle ) <= maximumAngularStep,
				'aim heading changed faster than the configured turn rate',
			);
			assert.ok( dot + 1e-7 >= previousDot, 'alignment must improve monotonically during aim' );
			previousDot = dot;
			aimSamples ++;

		} else if ( enteredAim && simulation.state === CHAMELEON_STATE.STRIKE_EXTEND ) {

			assert.ok(
				angularDistance( previousAngle, angle ) <= maximumAngularStep,
				'release introduced an angular snap',
			);
			releaseDot = headingDotToPrey( simulation, prey );
			break;

		}

		previousAngle = angle;

	}

	assert.equal( enteredAim, true );
	assert.ok( aimSamples >= 40, 'aim must remain a visible progressive turn, not a one-frame snap' );
	assert.ok( releaseDot > 0.9, `release alignment is too weak (${ releaseDot })` );

} );
