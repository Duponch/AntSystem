import test from 'node:test';
import assert from 'node:assert/strict';

import {
	ANT_CASTE,
	ANT_GOAL,
	classifyAntObservation,
} from '../src/ant-observer.js';

function observation( overrides = {} ) {

	return {
		id: 42, state: 0, caste: ANT_CASTE.WORKER, isQueen: false,
		under: false, carrying: false, attacking: false,
		goal: ANT_GOAL.NONE, node: 0, atGoal: false,
		resting: false, restRemaining: 0, hungry: false,
		energy: 0.8, venom: 0,
		granaryStock: 8, queenStock: 4, broodStock: 4,
		layTimer: 3, layInterval: 10, layEnergyMin: 0.5,
		stationarySeconds: 0, measuredSpeed: 1.2,
		...overrides,
	};

}

test( 'surface workers expose search, return and attack intentions', () => {

	assert.equal( classifyAntObservation( observation() ).intentCode, 'surface-search' );
	const returning = classifyAntObservation( observation( {
		state: 1, carrying: true,
	} ) );
	assert.equal( returning.intentCode, 'return-with-food' );
	assert.equal( returning.goalLabel, 'Entrée → grenier' );
	assert.equal( classifyAntObservation( observation( {
		hungry: true, energy: 0.2,
	} ) ).intentCode, 'return-to-eat' );
	assert.equal( classifyAntObservation( observation( {
		caste: ANT_CASTE.SOLDIER, attacking: true,
	} ) ).intentCode, 'attack' );

} );

test( 'an underground route reports its actual destination', () => {

	const result = classifyAntObservation( observation( {
		under: true,
		goal: ANT_GOAL.BROOD,
		node: 6,
		corridor: 7,
		progress: 0.35,
	} ) );

	assert.equal( result.intentCode, 'travel-to-brood' );
	assert.equal( result.goalLabel, 'Couvain' );
	assert.equal( result.stopExpected, false );

} );

test( 'scheduled rest is an explicit expected stop with a wake-up time', () => {

	const result = classifyAntObservation( observation( {
		under: true,
		goal: ANT_GOAL.GRANARY,
		resting: true,
		restRemaining: 4.25,
		stationarySeconds: 8,
		measuredSpeed: 0,
	} ) );

	assert.equal( result.intentCode, 'scheduled-rest' );
	assert.equal( result.stopExpected, true );
	assert.equal( result.motionCode, 'expected-stop' );
	assert.match( result.reason, /4[,.]3 s/ );

} );

test( 'a nurse at an empty granary waits intentionally for a delivery', () => {

	const result = classifyAntObservation( observation( {
		caste: ANT_CASTE.NURSE,
		under: true,
		goal: ANT_GOAL.GRANARY,
		node: 2,
		atGoal: true,
		granaryStock: 0,
		stationarySeconds: 15,
		measuredSpeed: 0,
	} ) );

	assert.equal( result.intentCode, 'wait-granary-stock' );
	assert.equal( result.stopExpected, true );
	assert.equal( result.motionCode, 'expected-stop' );

} );

test( 'an unexplained stop on an active route becomes suspicious', () => {

	const result = classifyAntObservation( observation( {
		under: true,
		goal: ANT_GOAL.EXIT,
		corridor: 4,
		progress: 0.52,
		stationarySeconds: 3.2,
		measuredSpeed: 0,
	} ) );

	assert.equal( result.intentCode, 'travel-to-exit' );
	assert.equal( result.stopExpected, false );
	assert.equal( result.motionCode, 'suspicious-stop' );

} );

test( 'the queen exposes feeding and laying cycles', () => {

	const waiting = classifyAntObservation( observation( {
		id: 0,
		caste: ANT_CASTE.QUEEN,
		isQueen: true,
		under: true,
		energy: 0.6,
		queenStock: 0,
	} ) );
	assert.equal( waiting.intentCode, 'queen-await-food' );

	const laying = classifyAntObservation( observation( {
		id: 0,
		caste: ANT_CASTE.QUEEN,
		isQueen: true,
		under: true,
		energy: 0.9,
		queenStock: 3,
		resting: true,
		restRemaining: 7,
		layTimer: 8,
		layInterval: 10,
	} ) );
	assert.equal( laying.intentCode, 'queen-laying-cycle' );
	assert.match( laying.reason, /2[,.]0 s/ );
	assert.equal( laying.goalLabel, 'Ponte' );

} );

test( 'dead ants are never reported as blocked', () => {

	const result = classifyAntObservation( observation( {
		state: 2,
		stationarySeconds: 90,
		measuredSpeed: 0,
	} ) );

	assert.equal( result.intentCode, 'dead' );
	assert.equal( result.motionCode, 'dead' );

} );
