import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MAX_BEES, MAX_FLOWERS } from '../src/config.js';
import {
	buildFlowerLayout,
	flowerExclusionsFromProps,
	selectHiveHost,
} from '../src/pollinator-layout.js';

const GLB_MAGIC = 0x46546C67;
const GLB_JSON_CHUNK = 0x4E4F534A;
const GLB_BINARY_CHUNK = 0x004E4942;
const VAT_FPS = 16;
const MAX_VAT_TEXTURE_BYTES = 12 * 1024 * 1024;

async function readSource( relativeUrl ) {

	return readFile( new URL( relativeUrl, import.meta.url ), 'utf8' );

}

async function readGlb( relativeUrl ) {

	const bytes = await readFile( new URL( relativeUrl, import.meta.url ) );
	assert.ok( bytes.length >= 20, `${ relativeUrl } is too short to be a GLB` );
	assert.equal( bytes.readUInt32LE( 0 ), GLB_MAGIC, `${ relativeUrl } has an invalid GLB magic` );
	assert.equal( bytes.readUInt32LE( 4 ), 2, `${ relativeUrl } must use GLB version 2` );
	assert.equal( bytes.readUInt32LE( 8 ), bytes.length, `${ relativeUrl } has a stale declared length` );

	let offset = 12;
	let json = null;
	let binary = null;

	while ( offset < bytes.length ) {

		assert.ok( offset + 8 <= bytes.length, `${ relativeUrl } has a truncated chunk header` );
		const length = bytes.readUInt32LE( offset );
		const type = bytes.readUInt32LE( offset + 4 );
		offset += 8;
		assert.ok( offset + length <= bytes.length, `${ relativeUrl } has a truncated chunk` );

		if ( type === GLB_JSON_CHUNK ) {

			const source = bytes.toString( 'utf8', offset, offset + length ).replace( /[\0\s]+$/u, '' );
			json = JSON.parse( source );

		}
		if ( type === GLB_BINARY_CHUNK ) binary = bytes.subarray( offset, offset + length );
		offset += length;

	}

	assert.equal( offset, bytes.length, `${ relativeUrl } has trailing or misaligned bytes` );
	assert.ok( json, `${ relativeUrl } has no JSON chunk` );
	return { bytes, json, binary };

}

function readColorAccessor( gltf, binary, accessorIndex ) {

	assert.ok( binary, 'GLB has no binary chunk' );
	const accessor = gltf.accessors?.[ accessorIndex ];
	assert.ok( accessor, `missing color accessor ${ accessorIndex }` );
	assert.ok( accessor.type === 'VEC3' || accessor.type === 'VEC4', 'COLOR_0 must be VEC3 or VEC4' );
	assert.equal( accessor.sparse, undefined, 'sparse hive colors are not supported by this guard' );

	const componentCount = accessor.type === 'VEC3' ? 3 : 4;
	const component = {
		5121: { bytes: 1, denominator: 255, read: 'readUInt8' },
		5123: { bytes: 2, denominator: 65535, read: 'readUInt16LE' },
		5126: { bytes: 4, denominator: 1, read: 'readFloatLE' },
	}[ accessor.componentType ];
	assert.ok( component, `unsupported COLOR_0 component type ${ accessor.componentType }` );
	if ( accessor.componentType !== 5126 ) {

		assert.equal( accessor.normalized, true, 'integer COLOR_0 must be normalized' );

	}

	const view = gltf.bufferViews?.[ accessor.bufferView ];
	assert.ok( view, 'COLOR_0 has no buffer view' );
	assert.equal( view.buffer, 0, 'COLOR_0 must reference the embedded GLB buffer' );
	const stride = view.byteStride || component.bytes * componentCount;
	const start = ( view.byteOffset || 0 ) + ( accessor.byteOffset || 0 );
	const end = start + Math.max( 0, accessor.count - 1 ) * stride + component.bytes * componentCount;
	assert.ok( end <= binary.length, 'COLOR_0 exceeds the binary chunk' );

	const colors = [];
	for ( let index = 0; index < accessor.count; index ++ ) {

		const color = [];
		for ( let channel = 0; channel < componentCount; channel ++ ) {

			const offset = start + index * stride + channel * component.bytes;
			color.push( binary[ component.read ]( offset ) / component.denominator );

		}
		colors.push( color );

	}
	return colors;

}

function animationDuration( gltf, animation ) {

	let duration = 0;
	for ( const sampler of animation.samplers || [] ) {

		const accessor = gltf.accessors?.[ sampler.input ];
		assert.ok( accessor?.max?.length, `${ animation.name } has no bounded input accessor` );
		duration = Math.max( duration, accessor.max[ 0 ] );

	}
	return duration;

}

function primitiveVertexCount( gltf ) {

	let count = 0;
	for ( const mesh of gltf.meshes || [] ) {

		for ( const primitive of mesh.primitives || [] ) {

			const accessor = gltf.accessors?.[ primitive.attributes?.POSITION ];
			assert.ok( accessor, `${ mesh.name } has no POSITION accessor` );
			count += accessor.count;

		}

	}
	return count;

}

function primitiveCount( gltf ) {

	return ( gltf.meshes || [] ).reduce( ( sum, mesh ) => sum + ( mesh.primitives || [] ).length, 0 );

}

test( 'POLLINATOR-001 flower layout is deterministic, typed and bounded', () => {

	const options = {
		count: 96,
		world: 160,
		seed: 0x10203040,
		patchCount: 7,
		exclusions: [ { x: 45, z: 10, radius: 6 } ],
	};
	const first = buildFlowerLayout( options );
	const second = buildFlowerLayout( options );
	const variant = buildFlowerLayout( { ...options, seed: options.seed + 1 } );

	assert.equal( first.count, options.count );
	assert.ok( first.positions instanceof Float32Array );
	assert.ok( first.scales instanceof Float32Array );
	assert.ok( first.yaws instanceof Float32Array );
	assert.ok( first.patchIds instanceof Uint16Array );
	assert.equal( first.positions.length, options.count * 3 );
	assert.equal( first.scales.length, options.count );
	assert.equal( first.yaws.length, options.count );
	assert.equal( first.patchIds.length, options.count );
	assert.equal( first.patches.length, options.patchCount );
	assert.deepEqual( first, second );
	assert.notDeepEqual( first.positions, variant.positions );

	const maxCoordinate = options.world * 0.5 - 3;
	const minRadius = Math.max( 14, options.world * 0.14 ) - 3;
	for ( let i = 0; i < first.count; i ++ ) {

		const x = first.positions[ i * 3 ];
		const y = first.positions[ i * 3 + 1 ];
		const z = first.positions[ i * 3 + 2 ];
		assert.ok( Number.isFinite( x ) && Number.isFinite( y ) && Number.isFinite( z ) );
		assert.ok( Math.abs( x ) <= maxCoordinate );
		assert.ok( Math.abs( z ) <= maxCoordinate );
		assert.ok( Math.hypot( x, z ) >= minRadius );
		assert.equal( y, 0 );
		assert.ok( Math.hypot( x - 45, z - 10 ) >= 7.15 );
		assert.ok( first.scales[ i ] >= 0.77 && first.scales[ i ] <= 1.23 );
		assert.ok( first.yaws[ i ] >= 0 && first.yaws[ i ] < Math.PI * 2 );
		assert.ok( first.patchIds[ i ] < options.patchCount );

	}

} );

test( 'POLLINATOR-002 saturated exclusions terminate through a deterministic bounded fallback', async () => {

	const source = await readSource( '../src/pollinator-layout.js' );
	const options = {
		count: MAX_FLOWERS,
		world: 160,
		seed: 0xBEE2026,
		exclusions: [ { x: 0, z: 0, radius: 1_000_000 } ],
	};
	const first = buildFlowerLayout( options );
	const second = buildFlowerLayout( options );

	assert.match( source, /guard\s*\+\+\s*<\s*Math\.max\(\s*64,\s*safeCount\s*\*\s*32\s*\)/u );
	assert.match( source, /for\s*\(\s*let i = written;\s*i < safeCount;\s*i \+\+\s*\)/u );
	assert.equal( first.count, MAX_FLOWERS );
	assert.deepEqual( first, second );

	for ( let i = 0; i < first.count; i ++ ) {

		assert.ok( Number.isFinite( first.positions[ i * 3 ] ) );
		assert.ok( Number.isFinite( first.positions[ i * 3 + 2 ] ) );
		assert.equal( first.scales[ i ], Math.fround( 0.9 ) );

	}
	assert.equal( buildFlowerLayout( { count: -4, world: 0 } ).count, 0 );

} );

test( 'POLLINATOR-003 hive host priority is explicit tag, Tree_02, then largest tree', () => {

	const explicit = { x: 2, z: 3, scale: 4, tag: 'hive-host' };
	const hero = { x: 4, z: 5, scale: 15 };
	const largest = { x: 6, z: 7, scale: 80 };
	const registry = [
		{ category: 'obstacles', model: 'Rock', placements: [ { ...explicit } ] },
		{ category: 'trees', model: 'Tree_01', placements: [ largest, explicit ] },
		{ category: 'trees', model: 'Tree_02', placements: [ hero ] },
	];

	let host = selectHiveHost( registry );
	assert.equal( host.entry.model, 'Tree_01' );
	assert.equal( host.index, 1 );
	assert.equal( host.placement, explicit );

	delete explicit.tag;
	host = selectHiveHost( registry );
	assert.equal( host.entry.model, 'Tree_02' );
	assert.equal( host.placement, hero );

	registry[ 2 ].entry = undefined;
	registry[ 2 ].model = 'Tree_03';
	host = selectHiveHost( registry );
	assert.equal( host.entry.model, 'Tree_01' );
	assert.equal( host.placement, largest );
	assert.equal( selectHiveHost( [] ), null );
	assert.equal( selectHiveHost( [ registry[ 0 ] ] ), null );

} );

test( 'POLLINATOR-008 flower exclusions follow edited category scales', () => {

	const registry = [
		{
			category: 'trees',
			placements: [ { x: 4, z: 8, scale: 20 } ],
		},
		{
			category: 'obstacles',
			placements: [ { x: - 2, z: 3, scale: 5 } ],
		},
	];
	const base = flowerExclusionsFromProps( registry );
	const scaled = flowerExclusionsFromProps( registry, { trees: 2, obstacles: 0.5 } );

	assert.equal( base[ 1 ].radius, 1.5 );
	assert.equal( scaled[ 1 ].radius, 3 );
	assert.equal( base[ 2 ].radius, 2.4 );
	assert.equal( scaled[ 2 ].radius, 1.5 );

} );
test( 'POLLINATOR-004 shipped hive and bee GLBs preserve their runtime contracts', async () => {

	const [ hive, rig, assetSource ] = await Promise.all( [
		readGlb( '../public/Bee.glb' ),
		readGlb( '../public/BeeRigged.glb' ),
		readSource( '../src/pollinator-assets.js' ),
	] );
	const hiveNodes = ( hive.json.nodes || [] ).map( ( node ) => node.name );
	const clipNames = ( rig.json.animations || [] ).map( ( animation ) => animation.name ).sort();
	const hivePrimitive = hive.json.meshes?.[ 0 ]?.primitives?.[ 0 ];
	const colorAccessor = hivePrimitive?.attributes?.COLOR_0;
	assert.notEqual( colorAccessor, undefined, 'hive mesh must expose COLOR_0' );
	assert.notEqual( colorAccessor, hivePrimitive?.attributes?.COLOR_1, 'COLOR_0 must not reference the white fallback channel' );
	const colors = readColorAccessor( hive.json, hive.binary, colorAccessor );
	const uniqueColors = new Set( colors.map( ( color ) => (
		color.slice( 0, 3 ).map( ( value ) => value.toFixed( 4 ) ).join( ',' )
	) ) );
	const means = [ 0, 0, 0 ];
	const minima = [ Infinity, Infinity, Infinity ];
	const maxima = [ - Infinity, - Infinity, - Infinity ];

	for ( const color of colors ) {

		for ( let channel = 0; channel < 3; channel ++ ) {

			means[ channel ] += color[ channel ];
			minima[ channel ] = Math.min( minima[ channel ], color[ channel ] );
			maxima[ channel ] = Math.max( maxima[ channel ], color[ channel ] );

		}

	}
	for ( let channel = 0; channel < 3; channel ++ ) means[ channel ] /= colors.length;

	assert.equal( hiveNodes.filter( ( name ) => name === 'Beehive_AttachPoint' ).length, 1 );
	assert.equal( hiveNodes.filter( ( name ) => name === 'Beehive_FlightPoint' ).length, 1 );
	assert.equal( primitiveCount( hive.json ), 1 );
	assert.equal( colors.length, hive.json.accessors[ hivePrimitive.attributes.POSITION ].count );
	assert.ok( uniqueColors.size >= 4, 'COLOR_0 must preserve the non-uniform hive palette' );
	assert.ok( maxima[ 0 ] - minima[ 0 ] > 0.2, 'COLOR_0 must preserve visible brown value variation' );
	assert.ok( means[ 0 ] > means[ 1 ] * 2, 'COLOR_0 must remain red-dominant like brown wood' );
	assert.ok( means[ 1 ] > means[ 2 ] * 2, 'COLOR_0 must remain warmer than a blue/white channel' );
	assert.ok( means.some( ( value ) => value < 0.8 ), 'COLOR_0 must not reference the uniform white channel' );
	assert.deepEqual( clipNames, [ 'Flight_Bee', 'Forage_Bee' ] );
	assert.ok( ( rig.json.skins || [] ).some( ( skin ) => ( skin.joints || [] ).length > 0 ) );
	assert.ok( ( rig.json.images || [] ).some( ( image ) => image.bufferView !== undefined ) );
	assert.match( assetSource, /loader\.loadAsync\(\s*'\/Bee\.glb'\s*\)/u );
	assert.match( assetSource, /loadVATMulti\(\s*'\/BeeRigged\.glb',\s*\{[\s\S]*?clipNames:\s*\[\s*'Flight_Bee',\s*'Forage_Bee'\s*\][\s\S]*?fps:\s*16/u );

} );

test( 'POLLINATOR-005 bee VAT stays inside the fixed RGBA16F texture budget', async () => {

	const { json } = await readGlb( '../public/BeeRigged.glb' );
	const animations = json.animations || [];
	const frames = animations.map( ( animation ) => (
		Math.max( 2, Math.round( animationDuration( json, animation ) * VAT_FPS ) )
	) );
	const totalVertices = primitiveVertexCount( json );
	const totalRows = frames.reduce( ( sum, count ) => sum + count, 0 );
	const bytes = totalVertices * totalRows * 4 * 2;

	assert.deepEqual( animations.map( ( animation ) => animation.name ), [ 'Flight_Bee', 'Forage_Bee' ] );
	assert.deepEqual( frames, [ 81, 121 ] );
	assert.equal( totalVertices, 7040 );
	assert.equal( totalRows, 202 );
	assert.equal( bytes, 11_376_640 );
	assert.ok( totalVertices <= 8192, 'VAT width exceeds the guaranteed WebGPU texture dimension' );
	assert.ok( totalRows <= 256, 'VAT height exceeds the pollinator row budget' );
	assert.ok( bytes <= MAX_VAT_TEXTURE_BYTES, 'VAT exceeds the 12 MiB RGBA16F budget' );

} );

test( 'POLLINATOR-006 render capacities and draw calls are fixed independently of ants', async () => {

	const [ beeSource, configSource, hive ] = await Promise.all( [
		readSource( '../src/bees.js' ),
		readSource( '../src/config.js' ),
		readGlb( '../public/Bee.glb' ),
	] );
	const flowerDraws = ( beeSource.match( /new THREE\.InstancedMesh\(/gu ) || [] ).length;
	const vatDraws = ( beeSource.match( /new THREE\.Mesh\(/gu ) || [] ).length;
	const totalSurfaceDraws = flowerDraws + vatDraws + primitiveCount( hive.json );

	assert.equal( MAX_BEES, 128 );
	assert.equal( MAX_FLOWERS, 256 );
	assert.match( configSource, /export const MAX_BEES = 128/u );
	assert.match( configSource, /export const MAX_FLOWERS = 256/u );
	assert.match( beeSource, /capacity:\s*MAX_BEES/u );
	assert.match( beeSource, /clamp\(\s*Math\.round\(\s*requested\s*\),\s*0,\s*MAX_BEES\s*\)/u );
	assert.match( beeSource, /clamp\(\s*Math\.round\(\s*gfx\.flowerCount\s*\),\s*0,\s*MAX_FLOWERS\s*\)/u );
	assert.match( beeSource, /geometry\.instanceCount = rendered/u );
	assert.equal( flowerDraws, 1 );
	assert.equal( vatDraws, 1 );
	assert.equal( totalSurfaceDraws, 3 );
	assert.doesNotMatch( beeSource, /\b(?:MAX_ANTS|antCount|ants)\b/u );

} );

test( 'POLLINATOR-007 all pollinator rendering is masked below ground', async () => {

	const [ beeSource, mainSource ] = await Promise.all( [
		readSource( '../src/bees.js' ),
		readSource( '../src/main.js' ),
	] );
	const visibilityAssignments = beeSource.match(
		/group\.visible\s*=\s*!!\s*gfx\.pollinators\s*&&\s*surfaceVisible\s*;/gu,
	) || [];

	assert.ok( visibilityAssignments.length >= 2 );
	assert.match(
		beeSource,
		/function update\(\s*dt,\s*isSurfaceVisible = true\s*\)\s*\{[\s\S]*?surfaceVisible = isSurfaceVisible;[\s\S]*?group\.visible = !! gfx\.pollinators && surfaceVisible;/u,
	);
	assert.match(
		beeSource,
		/function setSurfaceVisible\(\s*visible\s*\)\s*\{[\s\S]*?surfaceVisible = visible;[\s\S]*?group\.visible = !! gfx\.pollinators && surfaceVisible;/u,
	);
	assert.match( mainSource, /bees\.update\(\s*simDt,\s*!\s*dived\s*\)/u );
	assert.match( mainSource, /bees\.setSurfaceVisible\(\s*!\s*dived\s*\)/u );

} );
test( 'POLLINATOR-009 disabled pollinators skip asset loading and can lazy-start', async () => {

	const [ mainSource, facadeSource ] = await Promise.all( [
		readSource( '../src/main.js' ),
		readSource( '../src/pollinators.js' ),
	] );

	assert.match(
		mainSource,
		/gfx\.pollinators\s*\?\s*loadPollinatorAssets\(\)\s*:\s*Promise\.resolve\(\s*null\s*\)/u,
	);
	assert.match( facadeSource, /if\s*\(\s*!\s*gfx\.pollinators\s*\)\s*return Promise\.resolve\(\s*null\s*\)/u );
	assert.match( facadeSource, /if\s*\(\s*loadPromise\s*\)\s*return loadPromise/u );
	assert.match( facadeSource, /loadPromise = loadPollinatorAssets\(\)/u );
	assert.match( facadeSource, /if\s*\(\s*gfx\.pollinators\s*\)\s*void ensureLoaded\(\)/u );

} );

test( 'POLLINATOR-010 Blender flower contact, VAT clips and independent shadows are wired end to end', async () => {

	const [ beeSource, simulationSource, butterflySource, facadeSource, configSource, uiSource ] = await Promise.all( [
		readSource( '../src/bees.js' ),
		readSource( '../src/bee-simulation.js' ),
		readSource( '../src/butterflies.js' ),
		readSource( '../src/pollinators.js' ),
		readSource( '../src/config.js' ),
		readSource( '../src/ui.js' ),
	] );

	assert.match( beeSource, /FLOWER_CONTACT_X = - 0\.0887/u );
	assert.match( beeSource, /FLOWER_CONTACT_Y = 0\.761/u );
	assert.match( beeSource, /FLOWER_CONTACT_Z = - 0\.176/u );
	assert.match( beeSource, /FORAGE_ATTITUDE = new THREE\.Quaternion\(\s*- 0\.4121364, 0\.734995, - 0\.2633494, 0\.4696521/u );
	assert.match( beeSource, /contactX\[ i \] = x\[ i \] \+ \( FLOWER_CONTACT_X \* cosine \+ FLOWER_CONTACT_Z \* sine \) \* scale/u );
	assert.match( beeSource, /state === BEE_STATE\.TOUCHDOWN \|\| state === BEE_STATE\.FORAGE/u );
	assert.match( beeSource, /targetAttitude\.multiplyQuaternions\( flowerYawAttitude, FORAGE_ATTITUDE \)/u );
	assert.match( beeSource, /targetAttitude\.setFromUnitVectors\( modelForward, heading \)/u );
	assert.match( beeSource, /attitude\.slerp\( targetAttitude, 1 - Math\.exp\( - dt \* 8 \) \)/u );
	assert.doesNotMatch( beeSource, /renderPosition\.y\s*\+=/u );

	assert.match( simulationSource, /state === BEE_STATE\.TOUCHDOWN \|\| state === BEE_STATE\.FORAGE/u );
	assert.match( simulationSource, /case BEE_STATE\.TOUCHDOWN:[\s\S]*?_advanceHermite/u );
	assert.match( simulationSource, /case BEE_STATE\.TAKEOFF:[\s\S]*?_beginDepart/u );
	assert.match( simulationSource, /case BEE_STATE\.DEPART:[\s\S]*?_advanceHermite/u );
	assert.match( simulationSource, /forageDurationSeconds \* \( 0\.7 \+ this\._random\( index \) \* 0\.8 \)/u );

	for ( const key of [
		'beeCastShadow', 'beeReceiveShadow',
		'hiveCastShadow', 'hiveReceiveShadow',
		'butterflyCastShadow', 'butterflyReceiveShadow',
	] ) {

		assert.match( configSource, new RegExp( key + ': true' ) );
		assert.match( uiSource, new RegExp( "'" + key + "'" ) );

	}
	assert.match( beeSource, /mesh\.castShadow = !! gfx\.beeCastShadow/u );
	assert.match( beeSource, /mesh\.receiveShadow = !! gfx\.beeReceiveShadow/u );
	assert.match( beeSource, /setHierarchyShadows\( model, gfx\.hiveCastShadow, gfx\.hiveReceiveShadow \)/u );
	assert.match( butterflySource, /mesh\.castShadow = !! gfx\.butterflyCastShadow/u );
	assert.match( butterflySource, /mesh\.receiveShadow = !! gfx\.butterflyReceiveShadow/u );
	for ( const setter of [
		'setBeeCastShadow', 'setBeeReceiveShadow',
		'setHiveCastShadow', 'setHiveReceiveShadow',
		'setButterflyCastShadow', 'setButterflyReceiveShadow',
	] ) assert.match( facadeSource, new RegExp( setter + '\\( value \\)' ) );

	assert.match( configSource, /beeForageDuration: 10/u );
	assert.match( configSource, /beeForageDuration = clampSetting\( gfx\.beeForageDuration, 2, 40 \)/u );
	assert.match( uiSource, /'beeForageDuration', 2, 40, 0\.5/u );

} );