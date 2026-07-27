import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = ( name ) => readFileSync(
	new URL( '../src/' + name, import.meta.url ), 'utf8',
);

const environmentSource = readSource( 'environment.js' );
const mainSource = readSource( 'main.js' );
const antsSource = readSource( 'ants.js' );
const configSource = readSource( 'config.js' );
const uiSource = readSource( 'ui.js' );
const undergroundSource = readSource( 'underground.js' );

test( 'UNDERGROUND-TRANSITION-001 environment exposes every soil shell', () => {

	assert.match( environmentSource, /return\s*{\s*ground,\s*soil,/ );
	assert.match( environmentSource, /soil,\s*uTrail,\s*entranceMat,\s*entrance,/ );

} );

test( 'UNDERGROUND-TRANSITION-002 camera motion resolves before dive detection', () => {

	const cinematic = mainSource.indexOf( 'cinematic.update( rawDt )' );
	const controls = mainSource.indexOf( 'controls.update()' );
	const underground = mainSource.indexOf( 'underground.update( rawDt )' );
	assert.ok( cinematic >= 0 && cinematic < underground );
	assert.ok( controls >= 0 && controls < underground );

} );

test( 'UNDERGROUND-TRANSITION-003 surface shells toggle atomically with dive', () => {

	for ( const object of [ 'ground', 'soil', 'entrance' ] ) {

		assert.match( mainSource, new RegExp( 'env\\.' + object + '\\.visible = ! dived;' ) );

	}
	assert.match( mainSource, /cones\.setVisible\( ! dived && gfx\.debugCones \)/ );
	assert.match( mainSource, /sky\.moonLight\.visible = ! dived;/ );
	assert.match( mainSource, /sky\.ambient\.visible = ! dived;/ );
	assert.match( mainSource, /scene\.fog = dived \? null : sky\.fog;/ );
	assert.match( mainSource, /colony\.setVisible\( params\.colony && dived \);/ );
	assert.match( mainSource, /ants\.queen\.visible = params\.colony && dived;/ );

} );

test( 'UNDERGROUND-TRANSITION-004 ant rendering rejects the opposite camera layer', () => {

	assert.doesNotMatch( antsSource, /mix\( float\( 1 \), float\( 0\.25 \)/ );
	assert.match( antsSource, /const sameCameraLayer = \( under \) =>/ );
	const layerGuards = antsSource.match( /sameCameraLayer\( P\.under \)/g ) || [];
	assert.ok( layerGuards.length >= 5, 'bodies, selection, grain and halo must share the layer guard' );
	assert.doesNotMatch( antsSource, /P\.under\.or\( uDive\.lessThan\( 0\.5 \) \)/ );

} );
test( 'UNDERGROUND-TRANSITION-005 visual controls expose bounded live settings', () => {

	for ( const [ key, value ] of [
		[ 'undergroundRadius', '9' ],
		[ 'undergroundRelief', '1' ],
		[ 'undergroundContrast', '1' ],
		[ 'undergroundDust', '0.72' ],
	] ) {

		assert.match( configSource, new RegExp( key + ':\\s*' + value ) );
		assert.match( uiSource, new RegExp( "fCut\\.add\\( gfx, '" + key + "'" ) );

	}
	assert.match( uiSource, /'undergroundRadius', 6, 10, 0\.1/ );
	assert.match( uiSource, /'undergroundRelief', 0, 1\.8, 0\.05/ );
	assert.match( uiSource, /'undergroundContrast', 0\.6, 1\.4, 0\.05/ );
	assert.match( uiSource, /'undergroundDust', 0, 1, 0\.01/ );

} );

test( 'UNDERGROUND-TRANSITION-006 migrates persisted excavation controls into safe bounds', async () => {

	const previousStorage = globalThis.localStorage;
	globalThis.localStorage = {
		getItem: () => JSON.stringify( { gfx: {
			undergroundRadius: 14,
			undergroundRelief: - 3,
			undergroundContrast: 9,
			undergroundDust: 2,
		} } ),
		setItem() {},
		removeItem() {},
	};
	try {

		const { gfx: migrated } = await import( '../src/config.js?underground-migration-test' );
		assert.deepEqual( {
			radius: migrated.undergroundRadius,
			relief: migrated.undergroundRelief,
			contrast: migrated.undergroundContrast,
			dust: migrated.undergroundDust,
		}, { radius: 10, relief: 0, contrast: 1.4, dust: 1 } );

	} finally {

		if ( previousStorage === undefined ) delete globalThis.localStorage;
		else globalThis.localStorage = previousStorage;

	}

} );
test( 'UNDERGROUND-RENDER-001 excavation unions with the nest and owns its depth', () => {

	assert.match( undergroundSource, /return min\( sampleSDF\( p \), excavation \);/ );
	assert.match( undergroundSource, /material\.depthNode = Fn/ );
	assert.match( undergroundSource, /material\.fog = false;/ );
	assert.doesNotMatch( undergroundSource, /soilBox|SphereGeometry/ );

} );

test( 'UNDERGROUND-RENDER-002 geology pools stay fixed and camera-local', () => {

	assert.equal( ( undergroundSource.match( /new THREE\.InstancedMesh\(/g ) || [] ).length, 3 );
	assert.equal( ( undergroundSource.match( /new THREE\.Points\(/g ) || [] ).length, 1 );
	assert.match( undergroundSource, /lastDecorPosition\.distanceToSquared/ );
	assert.match( undergroundSource, /const reliefChanged = Math\.abs\(/ );
	assert.match( undergroundSource, /visualLayout = generateUndergroundVisualLayout/ );
	assert.match( undergroundSource, /wrapPeriodicCoordinate/ );
	assert.match( undergroundSource, /UNDERGROUND_VISUAL_BUDGET\.clods/ );
	assert.doesNotMatch( undergroundSource, /antCount|u\.antCount/ );

} );
test( 'UNDERGROUND-RENDER-003 roots remain connected to the exposed ceiling', () => {

	assert.match( undergroundSource, /plantOffset \+= 9 \* 7/ );
	assert.match( undergroundSource, /for \( let segment = 0; segment < 9; segment \+\+ \)/ );
	assert.doesNotMatch( undergroundSource, /Math\.floor\( index \/ 9 \)/ );
	assert.match( undergroundSource, /if \( ! hangsFromCeiling \) continue;/ );
	assert.match( undergroundSource, /cameraPositionCPU\.y \+ radius > - 0\.35/ );

} );
test( 'UNDERGROUND-RENDER-004 visible rocks stay embedded in the excavation shell', () => {

	assert.match( undergroundSource, /const instanceRadius = Math\.max\(/ );
	assert.match( undergroundSource, /if \( ! isEmbeddedInExcavationShell\(/ );
	assert.match( undergroundSource, /const rockMaterial = new THREE\.MeshLambertNodeMaterial/ );
	assert.match( undergroundSource, /const matterVisibility = sampleSDFClean\( positionWorld \)\.greaterThanEqual\( 0 \);/ );
	assert.match( undergroundSource, /clodMaterial\.maskNode = matterVisibility;/ );
	assert.match( undergroundSource, /rockMaterial\.maskNode = matterVisibility;/ );
	assert.doesNotMatch( undergroundSource, /Material\.opacityNode = matterVisibility|\.alphaTest = 0\.5/ );
	assert.match( undergroundSource, /mesh\.setColorAt\( count, decorColor \);/ );

} );