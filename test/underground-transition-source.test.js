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
const assetSource = readSource( 'underground-assets.js' );

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
	assert.match( mainSource, /await createUnderground/ );

} );

test( 'UNDERGROUND-TRANSITION-003 surface shells toggle atomically with dive', () => {

	for ( const object of [ 'ground', 'soil', 'entrance' ] )
		assert.match( mainSource, new RegExp( 'env\\.' + object + '\\.visible = ! dived;' ) );
	assert.match( mainSource, /cones\.setVisible\( ! dived && gfx\.debugCones \)/ );
	assert.match( mainSource, /scene\.fog = dived \? null : sky\.fog;/ );
	assert.match( mainSource, /colony\.setVisible\( params\.colony && dived \);/ );

} );

test( 'UNDERGROUND-TRANSITION-004 ant rendering rejects the opposite camera layer', () => {

	assert.match( antsSource, /const sameCameraLayer = \( under \) =>/ );
	const layerGuards = antsSource.match( /sameCameraLayer\( P\.under \)/g ) || [];
	assert.ok( layerGuards.length >= 5 );
	assert.doesNotMatch( antsSource, /P\.under\.or\( uDive\.lessThan\( 0\.5 \) \)/ );

} );

test( 'UNDERGROUND-TRANSITION-005 UI exposes the organic palette and buried-object controls', () => {

	for ( const key of [
		'undergroundColorHumus',
		'undergroundColorTopsoil',
		'undergroundColorClay',
		'undergroundColorOchre',
		'undergroundColorBedrock',
		'undergroundChaos',
		'undergroundPatchSize',
		'undergroundBlend',
		'undergroundGrain',
	] ) {

		assert.match( configSource, new RegExp( key + ':' ) );
		assert.match( uiSource, new RegExp( "'" + key + "'" ) );

	}
	for ( const prefix of [ 'Rock', 'Bone', 'FishBone' ] )
		for ( const suffix of [ 'Frequency', 'Size', 'Variation', 'Color' ] )
			assert.match( configSource, new RegExp( `underground${prefix}${suffix}:` ) );
	assert.match( uiSource, /addBuriedControls\( 'Rock', 'Rochers' \)/ );
	assert.match( uiSource, /addBuriedControls\( 'Bone', 'Os' \)/ );
	assert.match( uiSource, /addBuriedControls\( 'FishBone', 'Arêtes de poisson' \)/ );
	assert.doesNotMatch( configSource + uiSource, /undergroundDust/ );

} );

test( 'UNDERGROUND-TRANSITION-006 persisted numeric controls migrate into safe bounds', async () => {

	const previousStorage = globalThis.localStorage;
	globalThis.localStorage = {
		getItem: () => JSON.stringify( { gfx: {
			undergroundRadius: 14,
			undergroundChaos: - 3,
			undergroundPatchSize: 99,
			undergroundBlend: 0,
			undergroundRockFrequency: 4,
			undergroundBoneSize: 9,
			undergroundFishBoneVariation: - 2,
			undergroundArtifactExposure: 2,
			undergroundArtifactBurial: 0.68,
			undergroundDust: 1,
		} } ),
		setItem() {},
		removeItem() {},
	};
	try {

		const { gfx: migrated } = await import( '../src/config.js?underground-v2-migration-test' );
		assert.deepEqual( {
			radius: migrated.undergroundRadius,
			chaos: migrated.undergroundChaos,
			patchSize: migrated.undergroundPatchSize,
			blend: migrated.undergroundBlend,
			rockFrequency: migrated.undergroundRockFrequency,
			boneSize: migrated.undergroundBoneSize,
			fishVariation: migrated.undergroundFishBoneVariation,
			exposure: migrated.undergroundArtifactExposure,
		}, {
			radius: 10,
			chaos: 0.45,
			patchSize: 18,
			blend: 0.1,
			rockFrequency: 1,
			boneSize: 2.5,
			fishVariation: 0,
			exposure: 1.2,
		} );
		assert.equal( 'undergroundDust' in migrated, false );
		assert.equal( 'undergroundArtifactBurial' in migrated, false );

	} finally {

		if ( previousStorage === undefined ) delete globalThis.localStorage;
		else globalThis.localStorage = previousStorage;

	}

} );

test( 'UNDERGROUND-RENDER-001 excavation unions with the nest and owns its depth', () => {

	assert.match( undergroundSource, /return min\( sampleSDF\( p \), excavation \);/ );
	assert.match( undergroundSource, /material\.depthNode = Fn/ );
	assert.match( undergroundSource, /material\.fog = false;/ );
	assert.match( undergroundSource, /for \( let refinement = 0; refinement < 3; refinement \+\+ \)/ );
	assert.match( undergroundSource, /const wallAA = max\( fwidth\( r\.w \)\.mul\( 1\.75 \), 0\.018 \);/ );
	assert.match( undergroundSource, /const capDistance = max\( radius\.mul\( 2\.2 \), 14 \);/ );
	assert.match( undergroundSource, /min\( tExit\.sub\( 0\.01 \), tEnter\.add\( capDistance \) \)/ );

} );

test( 'UNDERGROUND-RENDER-002 geology pools stay world-fixed, periodic and dust-free', () => {

	assert.match( undergroundSource, /Object\.entries\( UNDERGROUND_ARTIFACT_CATALOG \)/ );
	assert.match( undergroundSource, /artifactMeshes\[ key \] = new THREE\.InstancedMesh/ );
	assert.match( undergroundSource, /visualLayout\.artifacts\[ key \]/ );
	assert.match( undergroundSource, /lastDecorPosition\.distanceToSquared/ );
	assert.match( undergroundSource, /wrapPeriodicCoordinate/ );
	assert.match( undergroundSource, /decorObject\.position\.set\( sourceX, sourceY, sourceZ \)/ );
	assert.doesNotMatch( undergroundSource, /presentedDistance|radialScale/ );
	assert.doesNotMatch( undergroundSource, /new THREE\.(?:Points|PointsMaterial)\(/ );
	assert.doesNotMatch( undergroundSource, /antCount|u\.antCount/ );

} );

test( 'UNDERGROUND-RENDER-003 roots remain connected to the exposed ceiling', () => {

	assert.match( undergroundSource, /plantOffset \+= 9 \* 7/ );
	assert.match( undergroundSource, /for \( let segment = 0; segment < 9; segment \+\+ \)/ );
	assert.match( undergroundSource, /if \( ! hangsFromCeiling \) continue;/ );

} );

test( 'UNDERGROUND-RENDER-004 every buried GLB is clipped by the clean physical SDF', () => {

	assert.match( undergroundSource,
		/const matterVisibility = sampleSDFClean\( positionWorld \)\.greaterThanEqual\( 0 \);/ );
	assert.match( undergroundSource, /clodMaterial\.maskNode = matterVisibility;/ );
	assert.match( undergroundSource, /material\.maskNode = matterVisibility;/ );
	assert.match( undergroundSource,
		/isEmbeddedInExcavationShell\([\s\S]*undergroundArtifactExposure/ );
	assert.doesNotMatch( undergroundSource, /opacityNode = matterVisibility|alphaTest = 0\.5/ );

} );

test( 'UNDERGROUND-RENDER-005 GLB geometries load once outside the update loop', () => {

	assert.match( assetSource, /const geometryPromises = new Map\(\)/ );
	assert.match( assetSource, /Promise\.all/ );
	assert.match( assetSource, /loader\.loadAsync\( url \)/ );
	assert.match( assetSource, /geometry\.applyMatrix4/ );
	assert.match( assetSource, /geometry\.scale\( 1 \/ maxDimension/ );
	const updateSource = undergroundSource.slice( undergroundSource.indexOf( 'function update( dt )' ) );
	assert.doesNotMatch( updateSource, /loadAsync|GLTFLoader|new THREE\.BufferGeometry/ );

} );