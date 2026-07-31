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
const EXPECTED_SOURCE_VERTICES = 25_002;
const EXPECTED_SOURCE_TRIANGLES = 50_000;
const EXPECTED_ORIGINAL_TAIL_VERTICES = 7_206;
const EXPECTED_SOURCE_MIN = Object.freeze( [ -0.5564488172531128, -0.5407788157463074, -0.39481300115585327 ] );
const EXPECTED_SOURCE_MAX = Object.freeze( [ 0.4548959732055664, 0.39516758918762207, 0.39570799469947815 ] );
const TAIL_BONE_NAMES = Object.freeze(
	Array.from( { length: 12 }, ( _, index ) => `tail_${ String( index + 1 ).padStart( 2, '0' ) }` ),
);
const EXPECTED_REST_MESH_SHA256 = '1732a987975806e9e34a48e529347dfca2291e02b8b9c967b3a7ae18f6f2287c';
const EXPECTED_TAIL_REST_SHA256 = '6b493bfe12b33cc1e7caba9884b4681ad9317f24ab4da3d14c12b8599a820bd1';

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

function multiplyMatrices( left, right ) {

	const result = new Array( 16 ).fill( 0 );
	for ( let column = 0; column < 4; column ++ ) {

		for ( let row = 0; row < 4; row ++ ) {

			for ( let lane = 0; lane < 4; lane ++ ) {

				result[ column * 4 + row ] += left[ lane * 4 + row ] * right[ column * 4 + lane ];

			}

		}

	}
	return result;

}

function nodeLocalMatrix( node ) {

	if ( node.matrix ) return [ ...node.matrix ];
	const [ x, y, z, w ] = node.rotation ?? [ 0, 0, 0, 1 ];
	const [ scaleX, scaleY, scaleZ ] = node.scale ?? [ 1, 1, 1 ];
	const [ translationX, translationY, translationZ ] = node.translation ?? [ 0, 0, 0 ];
	const x2 = x + x;
	const y2 = y + y;
	const z2 = z + z;
	const xx = x * x2;
	const xy = x * y2;
	const xz = x * z2;
	const yy = y * y2;
	const yz = y * z2;
	const zz = z * z2;
	const wx = w * x2;
	const wy = w * y2;
	const wz = w * z2;
	return [
		( 1 - ( yy + zz ) ) * scaleX, ( xy + wz ) * scaleX, ( xz - wy ) * scaleX, 0,
		( xy - wz ) * scaleY, ( 1 - ( xx + zz ) ) * scaleY, ( yz + wx ) * scaleY, 0,
		( xz + wy ) * scaleZ, ( yz - wx ) * scaleZ, ( 1 - ( xx + yy ) ) * scaleZ, 0,
		translationX, translationY, translationZ, 1,
	];

}

function createWorldMatrixReader( gltf ) {

	const parentByNode = new Map();
	for ( let parent = 0; parent < gltf.nodes.length; parent ++ ) {

		for ( const child of gltf.nodes[ parent ].children ?? [] ) parentByNode.set( child, parent );

	}
	const cache = new Map();
	return function worldMatrix( nodeIndex ) {

		if ( cache.has( nodeIndex ) ) return cache.get( nodeIndex );
		const local = nodeLocalMatrix( gltf.nodes[ nodeIndex ] );
		const parent = parentByNode.get( nodeIndex );
		const world = parent === undefined ? local : multiplyMatrices( worldMatrix( parent ), local );
		cache.set( nodeIndex, world );
		return world;

	};

}

function transformPoint( matrix, point ) {

	const [ x, y, z ] = point;
	return [
		matrix[ 0 ] * x + matrix[ 4 ] * y + matrix[ 8 ] * z + matrix[ 12 ],
		matrix[ 1 ] * x + matrix[ 5 ] * y + matrix[ 9 ] * z + matrix[ 13 ],
		matrix[ 2 ] * x + matrix[ 6 ] * y + matrix[ 10 ] * z + matrix[ 14 ],
	];

}

function distance( first, second ) {

	return Math.hypot(
		first[ 0 ] - second[ 0 ],
		first[ 1 ] - second[ 1 ],
		first[ 2 ] - second[ 2 ],
	);

}

function pointLineDistance( point, start, end ) {

	const line = end.map( ( value, lane ) => value - start[ lane ] );
	const relative = point.map( ( value, lane ) => value - start[ lane ] );
	const squaredLength = line.reduce( ( total, value ) => total + value * value, 0 );
	const parameter = relative.reduce( ( total, value, lane ) => total + value * line[ lane ], 0 ) / squaredLength;
	const projection = start.map( ( value, lane ) => value + parameter * line[ lane ] );
	return distance( point, projection );

}

test( 'CHAMELEON-PHYSICAL-ASSET-001 GLB is self-contained, bounded and structurally valid', () => {

	assert.ok( assetBytes.length >= 250 * 1024, 'asset is unexpectedly empty or incomplete' );
	assert.ok( assetBytes.length <= 12 * 1024 * 1024, 'rig asset exceeds its performance budget' );

	const { gltf, binary } = parseGlb( assetBytes );
	assert.equal( gltf.meshes?.length, 1, 'the exact original geometry must remain one closed render mesh' );
	assert.equal( gltf.skins?.length, 1, 'the exact original mesh must use one shared skin' );

	const skinnedMeshNodes = gltf.nodes
		.map( ( node, index ) => ( { ...node, index } ) )
		.filter( ( node ) => node.mesh !== undefined );
	assert.equal( skinnedMeshNodes.length, 1 );
	const meshNode = skinnedMeshNodes[ 0 ];
	assert.equal( meshNode.name, 'Chameleon_Physics_Body' );
	assert.equal( meshNode.skin, 0, 'the original mesh must reference the rig skin' );
	assert.equal( meshNode.extras?.physics_ready, true );
	assert.equal( meshNode.extras?.mesh_contract_version, '3.1.0' );
	assert.equal( meshNode.extras?.source_object, 'Chameleon_Imported_Source' );
	assert.equal( meshNode.extras?.exact_source_geometry, true );
	assert.equal( meshNode.extras?.source_vertex_count, EXPECTED_SOURCE_VERTICES );
	assert.equal( meshNode.extras?.source_polygon_count, EXPECTED_SOURCE_TRIANGLES );
	assert.equal( meshNode.extras?.rest_mesh_position_topology_sha256, EXPECTED_REST_MESH_SHA256 );
	assert.equal( meshNode.extras?.original_tail_vertices, EXPECTED_ORIGINAL_TAIL_VERTICES );
	assert.equal( meshNode.extras?.original_tail_rest_position_sha256, EXPECTED_TAIL_REST_SHA256 );
	assert.equal( meshNode.extras?.tail_deformation_mode, 'surface-geodesic-bspline-12' );
	assert.equal( meshNode.extras?.tail_weighting, 'surface-geodesic-cubic-bspline' );
	assert.equal( meshNode.extras?.tail_weighted_vertices, EXPECTED_ORIGINAL_TAIL_VERTICES );
	assert.equal( meshNode.extras?.tail_weight_bones, TAIL_BONE_NAMES.length );
	assert.equal( meshNode.extras?.tail_weight_max_influences, 4 );
	assert.equal( meshNode.extras?.tail_centerline_samples, TAIL_BONE_NAMES.length + 1 );
	assert.equal( meshNode.extras?.tail_interface_vertices, 107 );
	assert.ok( meshNode.extras?.tail_surface_geodesic_length > 1.16 );
	assert.ok( meshNode.extras?.tail_surface_geodesic_length < 1.18 );
	assert.ok( meshNode.extras?.tail_rest_arc_length > 1.13 );
	assert.ok( meshNode.extras?.tail_rest_arc_length < 1.15 );
	assert.equal( meshNode.extras?.tail_rest_coordinate_space, 'blender-rig-local-z-up' );
	assert.deepEqual( meshNode.extras?.tail_roll_reference, [ 0, 1, 0 ] );
	assert.equal( meshNode.extras?.tail_rest_centerline?.length, ( TAIL_BONE_NAMES.length + 1 ) * 3 );
	assert.equal( meshNode.extras?.tail_rest_segment_lengths?.length, TAIL_BONE_NAMES.length );
	assert.ok( meshNode.extras.tail_rest_segment_lengths.every( ( length ) => length >= 0.015 && length <= 0.35 ) );
	assert.ok( Math.abs(
		meshNode.extras.tail_rest_segment_lengths.reduce( ( sum, length ) => sum + length, 0 )
		- meshNode.extras.tail_rest_arc_length
	) < 1e-8 );
	assert.equal( meshNode.extras?.tail_physics_dofs, 0 );
	assert.equal( meshNode.extras?.origin_normalized, true );
	assert.deepEqual( meshNode.extras?.origin_shift, [ 0, 0, 6.119999885559082 ] );

	const primitives = gltf.meshes.flatMap( ( mesh ) => mesh.primitives ?? [] );
	assert.equal( primitives.length, 1, 'asset must contain exactly one skinned primitive' );

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
		assert.ok( positions.accessor.count >= EXPECTED_SOURCE_VERTICES,
			'hard-normal splits may duplicate source vertices but may not discard them' );
		assert.ok( positions.accessor.count <= EXPECTED_SOURCE_TRIANGLES * 3,
			'the exported primitive exceeds one vertex per triangle corner' );
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

	assert.equal( triangleCount, EXPECTED_SOURCE_TRIANGLES,
		'the preserved source must retain its exact 50k-triangle topology' );
	for ( let lane = 0; lane < 3; lane ++ ) {

		assert.ok( Math.abs( globalMin[ lane ] - EXPECTED_SOURCE_MIN[ lane ] ) < 1e-5,
			`original source minimum changed on axis ${ lane }` );
		assert.ok( Math.abs( globalMax[ lane ] - EXPECTED_SOURCE_MAX[ lane ] ) < 1e-5,
			`original source maximum changed on axis ${ lane }` );

	}
	const span = globalMax.map( ( maximum, lane ) => maximum - globalMin[ lane ] );
	assert.ok( span.every( ( value ) => value >= 0.75 && value <= 1.1 ),
		'the compact original silhouette, including its curled tail, must remain intact' );

} );

test( 'CHAMELEON-PHYSICAL-ASSET-002 skin weights and anatomical hierarchy satisfy the hybrid-controller contract', () => {

	const { gltf, binary } = parseGlb( assetBytes );
	const meshNode = gltf.nodes.find( ( node ) => node.mesh !== undefined );
	assert.ok( meshNode, 'skinned mesh node is missing' );
	const skin = gltf.skins[ 0 ];
	assert.equal( skin.joints.length, 43, 'the visual rig must retain its complete 43-joint hierarchy' );
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
		...TAIL_BONE_NAMES,
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
	assertChain( gltf, nodeByName, TAIL_BONE_NAMES );

	const skinJointNames = skin.joints.map( ( nodeIndex ) => gltf.nodes[ nodeIndex ].name );
	const tailBoneNameSet = new Set( TAIL_BONE_NAMES );
	const tailWeightUse = new Map( TAIL_BONE_NAMES.map( ( name ) => [ name, 0 ] ) );
	const usedBoneNames = new Set();
	let multiInfluenceVertices = 0;
	let tailInfluencedVertices = 0;
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
			let hasTailInfluence = false;
			for ( let lane = 0; lane < 4; lane ++ ) {

				const joint = joints.read( vertex, lane );
				const weight = normalizedWeight( weights.accessor, weights.read( vertex, lane ) );
				assert.ok( Number.isInteger( joint ) && joint >= 0 && joint < skin.joints.length );
				assert.ok( Number.isFinite( weight ) && weight >= 0 && weight <= 1 + 1e-6 );
				sum += weight;
				if ( weight > 1e-6 ) {

					positiveInfluences ++;
					const boneName = skinJointNames[ joint ];
					usedBoneNames.add( boneName );
					if ( tailBoneNameSet.has( boneName ) ) {

						hasTailInfluence = true;
						tailWeightUse.set( boneName, tailWeightUse.get( boneName ) + 1 );

					}

				}

			}
			assert.ok( positiveInfluences >= 1 && positiveInfluences <= 4 );
			assert.ok( Math.abs( sum - 1 ) < 2e-4, `vertex ${ vertex } weights sum to ${ sum }` );
			if ( positiveInfluences > 1 ) multiInfluenceVertices ++;
			if ( hasTailInfluence ) tailInfluencedVertices ++;

		}

	}
	assert.ok( multiInfluenceVertices > 100, 'body and tail skinning must retain smooth blends' );
	assert.ok( tailInfluencedVertices >= EXPECTED_ORIGINAL_TAIL_VERTICES,
		'the complete original tail must be bound to its curved visual chain' );
	for ( const [ name, uses ] of tailWeightUse ) {

		assert.ok( uses > 0, `${ name } must influence the preserved original tail` );

	}
	assert.deepEqual(
		usedBoneNames,
		new Set( skinJointNames.filter( ( name ) => name !== 'root' ) ),
		'all deformation bones except the non-deforming root must carry skin weights',
	);
	const rigNodeIndex = nodeByName.get( 'Chameleon_Physics_Armature' );
	assert.notEqual( rigNodeIndex, undefined, 'rig root node is missing' );
	const rigNode = gltf.nodes[ rigNodeIndex ];
	assert.equal( rigNode.extras?.rig_version, '3.1.0' );
	assert.match( rigNode.extras?.coordinate_contract ?? '', /head=-X.*tail-root=\+X.*original-curled.*glTF Y-up/u );
	assert.equal( rigNode.extras?.visual_bones, 43 );
	assert.equal( rigNode.extras?.visual_deformation_bones, 42 );
	assert.equal( rigNode.extras?.physics_proxy_bodies, 1 );
	assert.equal( rigNode.extras?.physics_proxy_bone, 'pelvis' );
	assert.equal( rigNode.extras?.runtime_controller, 'hybrid-root-ik' );
	assert.equal( rigNode.extras?.render_mesh_count, 1 );
	assert.equal( rigNode.extras?.exact_source_geometry, true );
	assert.equal( rigNode.extras?.rest_mesh_position_topology_sha256, EXPECTED_REST_MESH_SHA256 );
	assert.equal( rigNode.extras?.original_tail_vertices, EXPECTED_ORIGINAL_TAIL_VERTICES );
	assert.equal( rigNode.extras?.original_tail_rest_position_sha256, EXPECTED_TAIL_REST_SHA256 );
	assert.equal( rigNode.extras?.tail_deformation_mode, 'surface-geodesic-bspline-12' );
	assert.equal( rigNode.extras?.tail_weighting, 'surface-geodesic-cubic-bspline' );
	assert.equal( rigNode.extras?.tail_rest_bone_axis, 'local +Y' );
	assert.equal( rigNode.extras?.tail_physics_dofs, 0 );
	assert.deepEqual( rigNode.extras?.tail_rest_centerline, meshNode.extras.tail_rest_centerline );
	assert.deepEqual( rigNode.extras?.tail_rest_segment_lengths, meshNode.extras.tail_rest_segment_lengths );
	assert.ok( rigNode.children.includes( nodeByName.get( 'root' ) ) );
	assert.ok( rigNode.children.includes( nodeByName.get( 'Chameleon_Physics_Body' ) ) );

	const physicsBodyBones = skinJointNames.filter(
		( name ) => gltf.nodes[ nodeByName.get( name ) ].extras?.physics_body === true,
	);
	assert.deepEqual( physicsBodyBones, [ 'pelvis' ], 'only the pelvis may describe the single physics proxy' );
	for ( const name of skinJointNames ) {

		const extras = gltf.nodes[ nodeByName.get( name ) ].extras;
		assert.equal( extras?.rest_axis, 'local +Y', `${ name } must publish its rest axis` );
		assert.equal( extras?.rest_head_local?.length, 3, `${ name } must publish a rest head` );
		assert.equal( extras?.rest_tail_local?.length, 3, `${ name } must publish a rest tail` );
		assert.ok( extras.rest_head_local.every( Number.isFinite ) );
		assert.ok( extras.rest_tail_local.every( Number.isFinite ) );
		assert.ok( Number.isFinite( extras?.rest_length ) && extras.rest_length > 0.015 );

	}
	for ( let index = 0; index < TAIL_BONE_NAMES.length; index ++ ) {

		const extras = gltf.nodes[ nodeByName.get( TAIL_BONE_NAMES[ index ] ) ].extras;
		assert.equal( extras.physics_body, false );
		assert.equal( extras.physics_role, 'visual-deformation' );
		assert.equal( extras.joint, 'fixed-visual' );
		assert.equal( extras.tail_rest_index, index );
		assert.equal( extras.tail_deformation_only, true );

	}

	const centerlineBlender = Array.from(
		{ length: TAIL_BONE_NAMES.length + 1 },
		( _, index ) => meshNode.extras.tail_rest_centerline.slice( index * 3, index * 3 + 3 ),
	);
	const centerlineGltf = centerlineBlender.map( ( [ x, y, z ] ) => [ x, z, - y ] );
	const maximumCurlDeviation = Math.max(
		...centerlineGltf.slice( 1, -1 ).map(
			( point ) => pointLineDistance( point, centerlineGltf[ 0 ], centerlineGltf.at( - 1 ) ),
		),
	);
	assert.ok( maximumCurlDeviation > 0.2,
		'the twelve-bone rest chain must follow the original spiral instead of a straight substitute' );

	const worldMatrix = createWorldMatrixReader( gltf );
	for ( let index = 0; index < TAIL_BONE_NAMES.length; index ++ ) {

		const name = TAIL_BONE_NAMES[ index ];
		const node = gltf.nodes[ nodeByName.get( name ) ];
		const matrix = worldMatrix( nodeByName.get( name ) );
		const actualHead = transformPoint( matrix, [ 0, 0, 0 ] );
		const actualTail = transformPoint( matrix, [ 0, node.extras.rest_length, 0 ] );
		assert.ok( distance( actualHead, centerlineGltf[ index ] ) < 2e-5,
			`${ name } world head must coincide with centerline sample ${ index }` );
		assert.ok( distance( actualTail, centerlineGltf[ index + 1 ] ) < 2e-5,
			`${ name } world tail must coincide with centerline sample ${ index + 1 }` );
		assert.ok( distance( node.extras.rest_head_local, centerlineBlender[ index ] ) < 1e-6 );
		assert.ok( distance( node.extras.rest_tail_local, centerlineBlender[ index + 1 ] ) < 1e-6 );
		assert.ok( Math.abs( node.extras.rest_length - meshNode.extras.tail_rest_segment_lengths[ index ] ) < 1e-6 );

	}

	const positionReaders = gltf.meshes.flatMap( ( mesh ) => mesh.primitives ).map(
		( primitive ) => createAccessorReader( gltf, binary, primitive.attributes.POSITION ),
	);
	for ( let pointIndex = 0; pointIndex < centerlineGltf.length; pointIndex ++ ) {

		const point = centerlineGltf[ pointIndex ];
		let nearestSurface = Infinity;
		for ( const positions of positionReaders ) {

			for ( let vertex = 0; vertex < positions.accessor.count; vertex ++ ) {

				nearestSurface = Math.min( nearestSurface, distance( point, [
					positions.read( vertex, 0 ),
					positions.read( vertex, 1 ),
					positions.read( vertex, 2 ),
				] ) );

			}

		}
		assert.ok( nearestSurface < 0.09,
			`centerline sample ${ pointIndex } is ${ nearestSurface } away from the original tail surface` );

	}

	assert.equal( nodeByName.has( 'Chameleon_Physics_Tail' ), false,
		'the procedural straight tail must not leak into the hybrid export' );

} );
