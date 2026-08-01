import assert from 'node:assert/strict';
import test from 'node:test';

import { PlatformerJumpModel } from '../src/chameleon-lab/platformer-jump-model.js';
import { LabInputController } from '../src/chameleon-lab/third-person-controller.js';

class FakeEventTarget {

	constructor() {

		this.listeners = new Map();

	}

	addEventListener( type, listener ) {

		let listeners = this.listeners.get( type );
		if ( ! listeners ) {

			listeners = new Set();
			this.listeners.set( type, listeners );

		}
		listeners.add( listener );

	}

	removeEventListener( type, listener ) {

		const listeners = this.listeners.get( type );
		listeners?.delete( listener );
		if ( listeners?.size === 0 ) this.listeners.delete( type );

	}

	emit( type, overrides = {} ) {

		const event = {
			code: '',
			repeat: false,
			target: null,
			defaultPrevented: false,
			preventDefault() {

				this.defaultPrevented = true;

			},
			...overrides,
		};
		for ( const listener of this.listeners.get( type ) ?? [] ) listener( event );
		return event;

	}

}

function createInput() {

	const target = new FakeEventTarget();
	return { target, input: new LabInputController( target ) };

}

test( 'CHAMELEON-LAB-INPUT-001 exposes one pressed edge, a held level and one released edge', () => {

	const { target, input } = createInput();
	const keyDown = target.emit( 'keydown', { code: 'Space' } );
	assert.equal( keyDown.defaultPrevented, true );
	const state = input.consumeJumpState();
	assert.deepEqual( state, {
		jumpPressed: true,
		jumpHeld: true,
		jumpReleased: false,
	} );
	assert.equal( input.consume( 'jumpQueued' ), false,
		'the modern and legacy APIs must not consume the same edge twice' );
	assert.deepEqual( input.consumeJumpState(), {
		jumpPressed: false,
		jumpHeld: true,
		jumpReleased: false,
	} );
	target.emit( 'keyup', { code: 'Space' } );
	assert.deepEqual( input.consumeJumpState(), {
		jumpPressed: false,
		jumpHeld: false,
		jumpReleased: true,
	} );
	assert.deepEqual( input.consumeJumpState(), {
		jumpPressed: false,
		jumpHeld: false,
		jumpReleased: false,
	} );
	input.dispose();
	assert.equal( target.listeners.size, 0 );

} );

test( 'CHAMELEON-LAB-INPUT-002 keyboard auto-repeat and duplicate keydown never retrigger a jump', () => {

	const { target, input } = createInput();
	target.emit( 'keydown', { code: 'Space' } );
	assert.equal( input.consumeJumpState().jumpPressed, true );
	for ( let repeat = 0; repeat < 100; repeat ++ ) {

		target.emit( 'keydown', { code: 'Space', repeat: true } );
		const state = input.consumeJumpState();
		assert.equal( state.jumpPressed, false );
		assert.equal( state.jumpHeld, true );
		assert.equal( state.jumpReleased, false );

	}
	// Some platforms can produce a duplicate non-repeat keydown. The physical
	// down-state guard must reject that just like a native repeat event.
	target.emit( 'keydown', { code: 'Space', repeat: false } );
	assert.equal( input.consumeJumpState().jumpPressed, false );
	target.emit( 'keyup', { code: 'Space' } );
	assert.equal( input.consumeJumpState().jumpReleased, true );
	target.emit( 'keyup', { code: 'Space' } );
	assert.equal( input.consumeJumpState().jumpReleased, false );
	input.dispose();

} );

test( 'CHAMELEON-LAB-INPUT-003 a complete tap between fixed steps preserves both edges', () => {

	const { target, input } = createInput();
	target.emit( 'keydown', { code: 'Space' } );
	target.emit( 'keyup', { code: 'Space' } );
	const state = input.consumeJumpState();
	assert.equal( state.jumpPressed, true );
	assert.equal( state.jumpHeld, false );
	assert.equal( state.jumpReleased, true );

	const jump = new PlatformerJumpModel();
	const view = jump.update( 1 / 120, {
		supported: true,
		supportNormal: { x: 0, y: 1, z: 0 },
		velocity: { x: 0, y: 0, z: 0 },
		gravity: { x: 0, y: -9.81, z: 0 },
		mass: 1,
		...state,
	} );
	assert.equal( view.jumped, true );
	assert.ok( view.impulse.y > 0 );
	input.dispose();

} );

test( 'CHAMELEON-LAB-INPUT-004 blur safely converts a held jump into one release edge', () => {

	const { target, input } = createInput();
	target.emit( 'keydown', { code: 'Space' } );
	input.consumeJumpState();
	target.emit( 'blur' );
	assert.equal( input.keys.size, 0 );
	assert.deepEqual( input.consumeJumpState(), {
		jumpPressed: false,
		jumpHeld: false,
		jumpReleased: true,
	} );
	target.emit( 'blur' );
	assert.equal( input.consumeJumpState().jumpReleased, false );
	input.dispose();

} );

test( 'CHAMELEON-LAB-INPUT-005 reuses its state record and preserves the legacy queue API', () => {

	const { target, input } = createInput();
	const state = input.consumeJumpState();
	const external = {};
	assert.equal( input.consumeJumpState(), state );
	target.emit( 'keydown', { code: 'Space' } );
	assert.equal( input.jumpQueued, true );
	assert.equal( input.consume( 'jumpQueued' ), true );
	assert.equal( input.consume( 'jumpQueued' ), false );
	assert.equal( input.consumeJumpState( external ), external );
	assert.deepEqual( external, {
		jumpPressed: false,
		jumpHeld: true,
		jumpReleased: false,
	} );
	assert.equal( input.consumeJumpState(), state );
	assert.deepEqual( state, {
		jumpPressed: false,
		jumpHeld: true,
		jumpReleased: false,
	} );
	input.dispose();

} );

test( 'CHAMELEON-LAB-INPUT-006 editable controls never steal Space or synthesize edges', () => {

	const { target, input } = createInput();
	const event = target.emit( 'keydown', {
		code: 'Space',
		target: { tagName: 'INPUT', isContentEditable: false },
	} );
	assert.equal( event.defaultPrevented, false );
	assert.deepEqual( input.consumeJumpState(), {
		jumpPressed: false,
		jumpHeld: false,
		jumpReleased: false,
	} );
	assert.equal( input.keys.has( 'Space' ), false );
	input.dispose();

} );
