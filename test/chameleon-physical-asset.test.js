import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

const COMPONENTS = Object.freeze( {
	5120: { bytes: 1, read: ( buffer, offset ) => buffer.readInt8( offset ) },
	5121: { bytes: 1, read: ( buffer, offset ) => buffer.readUInt8( offset ) },
	5122: { bytes: 2, read: ( buffer, offset ) => buffer.readInt16LE( offset ) },
	5123: { bytes: 2, read: ( buffer, offset ) => buffer.readUInt16LE( offset ) },
	5125: { bytes: 4, read: ( buffer, offset ) => buffer.readUInt32LE( offset ) },
	5126: { bytes: 4, read: ( buffer, offset ) => buffer.readFloatLE( offset ) },
} );

const TYPE_COMPONENTS = Object.freeze( {
	SCALAR: 1,
	VEC2: 2,
	VEC3: 3,
	VEC4: 4,
	MAT2: 4,
	MAT3: 9,
	MAT4: 16,
} );

const assetUrl = new URL( '../public/assets/ChameleonPhysical.glb', import.meta.url );
const assetBytes = readFileSync( assetUrl );

function parseGlb( bytes ) {

	assert.ok( bytes.length >= 20, 'GLB header and first chunk header must be present' );
	assert.equal( bytes.readUInt32LE( 0 ), GLB_MAGIC, 'asset must start with the glTF magic' );
	assert.equal( bytes.readUInt32LE( 4 ), 2, 'asset must use GLB/glTF version 2' );
	assert.equal( bytes.readUInt32LE( 8 ), bytes.length, 'GLB declared length must match the file' );

	const chunks = [];
	let offset = 12;
	while ( offset < bytes.length ) {

		assert.ok( offset + 8 <= bytes.length, 'truncated GLB chunk header' );
		const byteLength = bytes.readUInt32LE( offset );
		const type = bytes.readUInt32LE( offset + 4 );
		const start = offset + 8;
		const end = start + byteLength;
		assert.equal( byteLength % 4, 0, 'GLB chunks must include four-byte padding' );
		assert.ok( end <= bytes.length, 'GLB chunk extends beyond the declared file length' );
		chunks.push( { type, bytes: bytes.subarray( start, end ) } );
		offset = end;

	}

	assert.equal( offset, bytes.length, 'GLB chunks must consume the complete file' );
	assert.equal( chunks.length, 2, 'physics asset must remain a self-contained JSON + BIN GLB' );
	assert.equal( chunks[ 0 ].type, GLB_JSON_CHUNK, 'the first GLB chunk must be JSON' );
	assert.equal( chunks[ 1 ].type, GLB_BIN_CHUNK, 'the second GLB chunk must be binary' );

	const jsonText = chunks[ 0 ].bytes.toString( 'utf8' ).replace( /[\u0000\u0020]+$/u, '' );
	const gltf = JSON.parse( jsonText );
	const binary = chunks[ 1 ].bytes;
	assert.equal( gltf.asset?.version, '2.0' );
	assert.equal( gltf.buffers?.length, 1, 'the asset must have one embedded binary buffer' );
	assert.equal( gltf.buffers[ 0 ].uri, undefined, 'the GLB buffer may not depend on an external URI' );
	assert.ok( gltf.buffers[ 0 ].byteLength <= binary.length );
	assert.ok(
		binary.length - gltf.buffers[ 0 ].byteLength <= 3,
		'the binary chunk may only exceed the declared buffer by alignment padding',
	);

	return { gltf, binary };

}

function createAccessorReader( gltf, binary, accessorIndex ) {

	const accessor = gltf.accessors?.[ accessorIndex ];
	assert.ok( accessor, `missing accessor ${ accessorIndex }` );
	assert.equal( accessor.sparse, undefined, `accessor ${ accessorIndex } may not be sparse` );
	assert.ok( Number.isInteger( accessor.count ) && accessor.count > 0 );

	const component = COMPONENTS[ accessor.componentType ];
	const components = TYPE_COMPONENTS[ accessor.type ];
	assert.ok( component, `unsupported component type ${ accessor.componentType }` );
	assert.ok( components, `unsupported accessor type ${ accessor.type }` );

	const view = gltf.bufferViews?.[ accessor.bufferView ];
	assert.ok( view, `missing buffer view ${ accessor.bufferView }` );
	assert.equal( view.buffer, 0, 'all accessors must use the embedded GLB buffer' );

	const elementBytes = component.bytes * components;
	const stride = view.byteStride ?? elementBytes;
	assert.ok( stride >= elementBytes, 'buffer view stride is smaller than one accessor element' );
	assert.equal( stride % component.bytes, 0, 'buffer view stride must align to its component type' );

	const viewStart = view.byteOffset ?? 0;
	const start = viewStart + ( accessor.byteOffset ?? 0 );
	const end = start + ( accessor.count - 1 ) * stride + elementBytes;
	assert.ok( start >= viewStart );
	assert.ok( end <= viewStart + view.byteLength, `accessor ${ accessorIndex } exceeds its buffer view` );
	assert.ok( end <= gltf.buffers[ 0 ].byteLength, `accessor ${ accessorIndex } exceeds its buffer` );
	assert.ok( end <= binary.length, `accessor ${ accessorIndex } exceeds the binary chunk` );

	return {
		accessor,
		components,
		read( element, lane ) {

			assert.ok( element >= 0 && element < accessor.count );
			assert.ok( lane >= 0 && lane < components );
			return component.read( binary, start + element * stride + lane * component.bytes );

		},
	};

}

function normalizedWeight( accessor, value ) {

	if ( accessor.componentType === 5126 ) return value;
	assert.equal( accessor.normalized, true, 'integer weights must be normalized' );
	if ( accessor.componentType === 5121 ) return value / 255;
	if ( accessor.componentType === 5123 ) return value / 65535;
	assert.fail( `unsupported weight component type ${ accessor.componentType }` );

}

function assertChain( gltf, nodeByName, names ) {

	for ( let index = 0; index < names.length - 1; index ++ ) {

		const parentIndex = nodeByName.get( names[ index ] );
		const childIndex = nodeByName.get( names[ index + 1 ] );
		assert.ok( gltf.nodes[ parentIndex ].children?.includes( childIndex ),
			`${ names[ index + 1 ] } must descend directly from ${ names[ index ] }` );

	}

}

test( 'CHAMELEON-PHYSICAL-ASSET-001 GLB is self-contained, bounded and structurally valid', () => {

	assert.ok( assetBytes.length >= 250 * 1024, 'asset is unexpectedly empty or incomplete' );
	assert.ok( assetBytes.length <= 12 * 1024 * 1024, 'rig asset exceeds its performance budget' );

	const { gltf, binary } = parseGlb( assetBytes );
	assert.equal( gltf.meshes?.length, 2, 'body and neutral tail must remain separate meshes' );
	assert.equal( gltf.skins?.length, 1, 'both meshes must share exactly one skin' );

	const skinnedMeshNodes = gltf.nodes
		.map( ( node, index ) => ( { ...node, index } ) )
		.filter( ( node ) => node.mesh !== undefined );
	assert.equal( skinnedMeshNodes.length, 2 );
	assert.deepEqual(
		new Set( skinnedMeshNodes.map( ( node ) => node.name ) ),
		new Set( [ 'Chameleon_Physics_Body', 'Chameleon_Physics_Tail' ] ),
	);
	for ( const node of skinnedMeshNodes ) {

		assert.equal( node.skin, 0, `${ node.name } must reference the shared rig skin` );
		assert.equal( node.extras?.physics_ready, true );

	}

	const primitives = gltf.meshes.flatMap( ( mesh ) => mesh.primitives ?? [] );
	assert.equal( primitives.length, 2, 'asset must contain exactly two skinned primitives' );

	const globalMin = [ Infinity, Infinity, Infinity ];
	const globalMax = [ - Infinity, - Infinity, - Infinity ];
	let triangleCount = 0;
	for ( const primitive of primitives ) {

		assert.equal( primitive.mode ?? 4, 4, 'physics meshes must use triangle primitives' );
		assert.notEqual( primitive.indices, undefined, 'triangle primitive must be indexed' );
		for ( const semantic of [ 'POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0' ] ) {

			assert.notEqual( primitive.attributes?.[ semantic ], undefined, `missing ${ semantic }` );

		}
		assert.equal( primitive.attributes.JOINTS_1, undefined, 'more than four joint influences are forbidden' );
		assert.equal( primitive.attributes.WEIGHTS_1, undefined, 'more than four weight influences are forbidden' );

		const positions = createAccessorReader( gltf, binary, primitive.attributes.POSITION );
		const normals = createAccessorReader( gltf, binary, primitive.attributes.NORMAL );
		const indices = createAccessorReader( gltf, binary, primitive.indices );
		assert.equal( positions.accessor.type, 'VEC3' );
		assert.equal( positions.accessor.componentType, 5126 );
		assert.equal( normals.accessor.type, 'VEC3' );
		assert.equal( normals.accessor.componentType, 5126 );
		assert.equal( normals.accessor.count, positions.accessor.count );
		assert.equal( indices.accessor.type, 'SCALAR' );
		assert.ok( [ 5121, 5123, 5125 ].includes( indices.accessor.componentType ) );
		assert.equal( indices.accessor.count % 3, 0 );
		triangleCount += indices.accessor.count / 3;

		const actualMin = [ Infinity, Infinity, Infinity ];
		const actualMax = [ - Infinity, - Infinity, - Infinity ];
		for ( let vertex = 0; vertex < positions.accessor.count; vertex ++ ) {

			for ( let lane = 0; lane < 3; lane ++ ) {

				const value = positions.read( vertex, lane );
				assert.ok( Number.isFinite( value ), 'vertex positions must be finite' );
				actualMin[ lane ] = Math.min( actualMin[ lane ], value );
				actualMax[ lane ] = Math.max( actualMax[ lane ], value );

			}

		}
		for ( let lane = 0; lane < 3; lane ++ ) {

			assert.ok( Math.abs( actualMin[ lane ] - positions.accessor.min[ lane ] ) < 1e-5 );
			assert.ok( Math.abs( actualMax[ lane ] - positions.accessor.max[ lane ] ) < 1e-5 );
			globalMin[ lane ] = Math.min( globalMin[ lane ], actualMin[ lane ] );
			globalMax[ lane ] = Math.max( globalMax[ lane ], actualMax[ lane ] );

		}
		for ( let index = 0; index < indices.accessor.count; index ++ ) {

			const vertex = indices.read( index, 0 );
			assert.ok( Number.isInteger( vertex ) && vertex < positions.accessor.count,
				'mesh index must reference an existing vertex' );

		}

	}

	assert.ok( triangleCount >= 20_000 && triangleCount <= 80_000,
		'mesh detail falls outside the intended visual/performance envelope' );
	const span = globalMax.map( ( maximum, lane ) => maximum - globalMin[ lane ] );
	assert.ok( globalMin[ 0 ] < - 0.4 && globalMax[ 0 ] > 1,
		'head-to-neutral-tail extent is missing or incorrectly oriented' );
	assert.ok( span[ 0 ] >= 1.5 && span[ 0 ] <= 3 );
	assert.ok( span[ 1 ] >= 0.5 && span[ 1 ] <= 2 );
	assert.ok( span[ 2 ] >= 0.5 && span[ 2 ] <= 2 );
	assert.ok( globalMin.every( ( value ) => value > - 5 ) );
	assert.ok( globalMax.every( ( value ) => value < 5 ) );

} );

test( 'CHAMELEON-PHYSICAL-ASSET-002 skin weights and anatomical hierarchy satisfy the active-ragdoll contract', () => {

	const { gltf, binary } = parseGlb( assetBytes );
	const skin = gltf.skins[ 0 ];
	assert.ok( skin.joints.length >= 40, 'the physics rig needs at least 40 visual/deform joints' );
	assert.equal( new Set( skin.joints ).size, skin.joints.length, 'skin joints must be unique' );
	assert.ok( skin.joints.every( ( index ) => Number.isInteger( index ) && gltf.nodes[ index ] ) );

	const inverseBindMatrices = createAccessorReader( gltf, binary, skin.inverseBindMatrices );
	assert.equal( inverseBindMatrices.accessor.type, 'MAT4' );
	assert.equal( inverseBindMatrices.accessor.componentType, 5126 );
	assert.equal( inverseBindMatrices.accessor.count, skin.joints.length );
	for ( let joint = 0; joint < inverseBindMatrices.accessor.count; joint ++ ) {

		for ( let lane = 0; lane < 16; lane ++ ) {

			assert.ok( Number.isFinite( inverseBindMatrices.read( joint, lane ) ) );

		}

	}

	const nodeByName = new Map( gltf.nodes.map( ( node, index ) => [ node.name, index ] ) );
	const requiredBones = [
		'root', 'pelvis', 'spine_01', 'spine_02', 'neck', 'head', 'jaw',
		'front_girdle.L', 'front_upper.L', 'front_lower.L', 'front_palm.L',
		'front_girdle.R', 'front_upper.R', 'front_lower.R', 'front_palm.R',
		'hind_girdle.L', 'hind_upper.L', 'hind_lower.L', 'hind_palm.L',
		'hind_girdle.R', 'hind_upper.R', 'hind_lower.R', 'hind_palm.R',
		...Array.from( { length: 12 }, ( _, index ) => `tail_${ String( index + 1 ).padStart( 2, '0' ) }` ),
	];
	const skinJointSet = new Set( skin.joints );
	for ( const name of requiredBones ) {

		assert.ok( nodeByName.has( name ), `required bone ${ name } is missing` );
		assert.ok( skinJointSet.has( nodeByName.get( name ) ), `${ name } is not part of the skin` );

	}

	assertChain( gltf, nodeByName, [ 'root', 'pelvis', 'spine_01', 'spine_02', 'neck', 'head', 'jaw' ] );
	for ( const side of [ 'L', 'R' ] ) {

		for ( const limb of [ 'front', 'hind' ] ) {

			assertChain( gltf, nodeByName, [
				`${ limb }_girdle.${ side }`,
				`${ limb }_upper.${ side }`,
				`${ limb }_lower.${ side }`,
				`${ limb }_palm.${ side }`,
			] );
			const palm = gltf.nodes[ nodeByName.get( `${ limb }_palm.${ side }` ) ];
			assert.ok( palm.children.includes( nodeByName.get( `${ limb }_digits_inner.${ side }` ) ) );
			assert.ok( palm.children.includes( nodeByName.get( `${ limb }_digits_outer.${ side }` ) ) );

		}

	}
	assertChain(
		gltf,
		nodeByName,
		Array.from( { length: 12 }, ( _, index ) => `tail_${ String( index + 1 ).padStart( 2, '0' ) }` ),
	);

	const usedWithPositiveWeight = new Set();
	let multiInfluenceVertices = 0;
	for ( const primitive of gltf.meshes.flatMap( ( mesh ) => mesh.primitives ) ) {

		const joints = createAccessorReader( gltf, binary, primitive.attributes.JOINTS_0 );
		const weights = createAccessorReader( gltf, binary, primitive.attributes.WEIGHTS_0 );
		assert.equal( joints.accessor.type, 'VEC4' );
		assert.ok( [ 5121, 5123 ].includes( joints.accessor.componentType ) );
		assert.equal( weights.accessor.type, 'VEC4' );
		assert.ok( [ 5121, 5123, 5126 ].includes( weights.accessor.componentType ) );
		assert.equal( joints.accessor.count, weights.accessor.count );

		for ( let vertex = 0; vertex < joints.accessor.count; vertex ++ ) {

			let sum = 0;
			let positiveInfluences = 0;
			for ( let lane = 0; lane < 4; lane ++ ) {

				const joint = joints.read( vertex, lane );
				const weight = normalizedWeight( weights.accessor, weights.read( vertex, lane ) );
				assert.ok( Number.isInteger( joint ) && joint >= 0 && joint < skin.joints.length );
				assert.ok( Number.isFinite( weight ) && weight >= 0 && weight <= 1 + 1e-6 );
				sum += weight;
				if ( weight > 1e-6 ) {

					positiveInfluences ++;
					usedWithPositiveWeight.add( joint );

				}

			}
			assert.ok( positiveInfluences >= 1 && positiveInfluences <= 4 );
			assert.ok( Math.abs( sum - 1 ) < 2e-4, `vertex ${ vertex } weights sum to ${ sum }` );
			if ( positiveInfluences > 1 ) multiInfluenceVertices ++;

		}

	}
	assert.ok( multiInfluenceVertices > 100, 'rig must contain smoothly blended vertices' );
	const rootSkinIndex = skin.joints.indexOf( nodeByName.get( 'root' ) );
	const expectedWeightedJoints = new Set( skin.joints.map( ( _, index ) => index ) );
	expectedWeightedJoints.delete( rootSkinIndex );
	assert.deepEqual(
		usedWithPositiveWeight,
		expectedWeightedJoints,
		'every deform joint, and only deform joints, must carry positive skin weight',
	);

	const rigNodeIndex = nodeByName.get( 'Chameleon_Physics_Armature' );
	assert.notEqual( rigNodeIndex, undefined, 'rig root node is missing' );
	const rigNode = gltf.nodes[ rigNodeIndex ];
	assert.match( rigNode.extras?.rig_version ?? '', /^\d+\.\d+\.\d+$/u );
	assert.match( rigNode.extras?.coordinate_contract ?? '', /head=-X.*tail=\+X.*glTF Y-up/u );
	assert.equal( rigNode.extras?.visual_bones, skin.joints.length );
	assert.ok( rigNode.extras?.physics_proxy_bodies >= 20 );
	assert.ok( rigNode.children.includes( nodeByName.get( 'root' ) ) );
	assert.ok( rigNode.children.includes( nodeByName.get( 'Chameleon_Physics_Body' ) ) );
	assert.ok( rigNode.children.includes( nodeByName.get( 'Chameleon_Physics_Tail' ) ) );

} );
