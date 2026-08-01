import assert from 'node:assert/strict';
import test from 'node:test';

import {
	CHAMELEON_LAB_DISPLAY_DEFAULTS,
	CHAMELEON_LAB_MOVEMENT_DEFAULTS,
	ensureLabDisplaySettings,
	ensureLabMovementSettings,
} from '../src/chameleon-lab/lab-ui.js';

test( 'CHAMELEON-LAB-UI-001 completes legacy state with flat serializable movement defaults', () => {

	const state = { autonomous: false, jumpHeight: 1.1, airControl: 0 };
	assert.equal( ensureLabMovementSettings( state ), state );
	assert.equal( state.jumpHeight, 1.1 );
	assert.equal( state.airControl, 0 );
	assert.equal( state.coyoteTime, 0.12 );
	assert.equal( state.jumpBufferTime, 0.14 );
	assert.equal( state.fallGravityScale, 1.42 );
	assert.equal( state.jumpCutGravityScale, 2.05 );
	assert.deepEqual( JSON.parse( JSON.stringify( state ) ), state );
	assert.equal( Object.isFrozen( CHAMELEON_LAB_MOVEMENT_DEFAULTS ), true );

} );

test( 'CHAMELEON-LAB-UI-002 preserves restored numeric tuning and repairs invalid fields only', () => {

	const state = {
		jumpHeight: 0.94,
		airControl: 1.35,
		coyoteTime: 0,
		jumpBufferTime: 0.22,
		fallGravityScale: Number.NaN,
		jumpCutGravityScale: 3.1,
	};
	ensureLabMovementSettings( state );
	assert.deepEqual( state, {
		jumpHeight: 0.94,
		airControl: 1.35,
		coyoteTime: 0,
		jumpBufferTime: 0.22,
		fallGravityScale: CHAMELEON_LAB_MOVEMENT_DEFAULTS.fallGravityScale,
		jumpCutGravityScale: 3.1,
	} );
	assert.throws( () => ensureLabMovementSettings( null ), /state/u );

} );

test( 'CHAMELEON-LAB-UI-003 completes and preserves the rig overlay display switch', () => {

	const legacy = { debug: true };
	assert.equal( ensureLabDisplaySettings( legacy ), legacy );
	assert.equal( legacy.rigDebug, false );
	const restored = { rigDebug: true };
	ensureLabDisplaySettings( restored );
	assert.equal( restored.rigDebug, true );
	const invalid = { rigDebug: 'yes' };
	ensureLabDisplaySettings( invalid );
	assert.equal( invalid.rigDebug, CHAMELEON_LAB_DISPLAY_DEFAULTS.rigDebug );
	assert.equal( Object.isFrozen( CHAMELEON_LAB_DISPLAY_DEFAULTS ), true );
	assert.throws( () => ensureLabDisplaySettings( null ), /state/u );

} );
