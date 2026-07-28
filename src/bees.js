import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, uniformArray, attribute, vertexIndex, instanceIndex,
	varyingProperty, float, uint, vec3, ivec2, floor, mix, select, textureLoad,
	texture, uv, positionLocal, sin, cos, max, smoothstep,
} from 'three/tsl';

import { qrot } from './pose.js';
import { BEE_CLIP, BEE_STATE, createBeeSimulation } from './bee-simulation.js';
import { MAX_BEES, MAX_FLOWERS, WORLD, gfx } from './config.js';
import {
	buildFlowerLayout,
	flowerExclusionsFromProps,
	selectHiveHost,
} from './pollinator-layout.js';

const TRANSITION_SECONDS = 0.18;
const FLOWER_STOCK = 18;
// Tree meshes are normalized to one unit of height. Keep the hive below the
// foliage so both the entrance and the flight corridor remain readable.
const TREE_SOCKET = new THREE.Vector3( 0.058, 0.275, 0.022 );
// Contact authored in Blender between BeeForageRig and Flower_Forage_Root,
// expressed in the normalized Flower.glb frame. Keeping it explicit makes the
// runtime pose reproduce the reference scene instead of guessing the blossom
// center from an axis-aligned bounding box.
const FLOWER_CONTACT_X = - 0.0887;
const FLOWER_CONTACT_Y = 0.761;
const FLOWER_CONTACT_Z = - 0.176;
const FORAGE_ATTITUDE = new THREE.Quaternion(
	- 0.4121364, 0.734995, - 0.2633494, 0.4696521,
).normalize();
const WORLD_UP = new THREE.Vector3( 0, 1, 0 );

function clamp( value, low, high ) {

	return Math.min( high, Math.max( low, value ) );

}

function setHierarchyShadows( root, castShadow, receiveShadow ) {

	root.traverse( ( object ) => {

		if ( ! object.isMesh ) return;
		object.castShadow = !! castShadow;
		object.receiveShadow = !! receiveShadow;

	} );

}

function prepareHive( source ) {

	const model = source.clone( true );
	const material = new THREE.MeshStandardNodeMaterial( {
		roughness: 0.82,
		metalness: 0,
		vertexColors: true,
	} );
	material.emissiveNode = attribute( 'color', 'vec3' ).mul( 0.18 );

	model.traverse( ( object ) => {

		if ( ! object.isMesh ) return;
		object.material = material;

	} );

	setHierarchyShadows( model, gfx.hiveCastShadow, gfx.hiveReceiveShadow );
	model.updateMatrixWorld( true );
	const attach = model.getObjectByName( 'Beehive_AttachPoint' );
	const flight = model.getObjectByName( 'Beehive_FlightPoint' );
	if ( ! attach || ! flight ) {

		throw new Error( 'Bee.glb doit exposer Beehive_AttachPoint et Beehive_FlightPoint.' );

	}

	const attachPosition = new THREE.Vector3();
	attach.getWorldPosition( attachPosition );
	model.position.sub( attachPosition );
	model.updateMatrixWorld( true );

	return { model, flight, material };

}

function createFlowerRenderer( geometry ) {

	const uTime = uniform( 0 );
	const uWind = uniform( gfx.flowerWind );
	const uPetalColor = uniform( new THREE.Color( gfx.flowerPetalColor ) );
	const uStemColor = uniform( new THREE.Color( gfx.flowerStemColor ) );
	const material = new THREE.MeshStandardNodeMaterial( {
		roughness: 0.82,
		metalness: 0,
		side: THREE.DoubleSide,
	} );

	material.positionNode = Fn( () => {

		const p = positionLocal.toVar();
		const rootWeight = p.y.mul( p.y );
		const phase = uTime.mul( 1.25 )
			.add( instanceIndex.toFloat().mul( 0.731 ) )
			.add( p.y.mul( 2.2 ) );
		const amount = rootWeight.mul( uWind ).mul( 0.085 );
		p.x.addAssign( sin( phase ).mul( amount ) );
		p.z.addAssign( cos( phase.mul( 0.83 ) ).mul( amount ).mul( 0.62 ) );
		return p;

	} )();

	material.colorNode = Fn( () => {

		const source = attribute( 'color', 'vec3' );
		const greenDominance = source.y.sub( max( source.x, source.z ) );
		const stem = smoothstep( 0.04, 0.32, greenDominance );
		const petalColor = source.mul( vec3( uPetalColor ) );
		const stemColor = source.mul( vec3( uStemColor ) );
		return mix( petalColor, stemColor, stem );

	} )();

	const mesh = new THREE.InstancedMesh( geometry, material, MAX_FLOWERS );
	mesh.name = 'PollinatorFlowers';
	mesh.castShadow = false;
	mesh.receiveShadow = true;
	mesh.count = 0;
	return { mesh, material, uTime, uWind, uPetalColor, uStemColor };

}

function findPart( vat, pattern, fallbackIndex ) {

	return vat.parts.find( ( part ) => pattern.test( part.name ) ) || vat.parts[ fallbackIndex ];

}

function createBeeRenderer( vat ) {

	if ( ! vat.colorMap ) throw new Error( 'BeeRigged.glb doit conserver son atlas de couleur.' );

	const pose = new THREE.InstancedBufferAttribute( new Float32Array( MAX_BEES * 4 ), 4 );
	const quaternion = new THREE.InstancedBufferAttribute( new Float32Array( MAX_BEES * 4 ), 4 );
	const animation = new THREE.InstancedBufferAttribute( new Float32Array( MAX_BEES * 4 ), 4 );
	const blend = new THREE.InstancedBufferAttribute( new Float32Array( MAX_BEES ), 1 );

	for ( const buffer of [ pose, quaternion, animation, blend ] ) buffer.setUsage( THREE.DynamicDrawUsage );

	const geometry = new THREE.InstancedBufferGeometry();
	geometry.index = vat.geometry.index;
	geometry.setAttribute( 'position', vat.geometry.getAttribute( 'position' ) );
	geometry.setAttribute( 'uv', vat.geometry.getAttribute( 'uv' ) );
	geometry.setAttribute( 'aPose', pose );
	geometry.setAttribute( 'aQuat', quaternion );
	geometry.setAttribute( 'aAnim', animation );
	geometry.setAttribute( 'aBlend', blend );
	geometry.instanceCount = 0;

	const clipTable = uniformArray(
		vat.clipInfos.map( ( clip ) => new THREE.Vector4( clip.offset, clip.frames, 1, 0 ) ),
	);
	const uBeeTint = uniform( new THREE.Color( gfx.beeTint ) );
	const uWingColor = uniform( new THREE.Color( gfx.beeWingColor ) );
	const eyes = findPart( vat, /eye/i, 1 );
	const proboscis = findPart( vat, /proboscis/i, 2 );
	const wings = findPart( vat, /wing/i, 3 );
	const bodyMap = vat.colorMaps?.[ 0 ] || vat.colorMap;
	const eyeMap = vat.colorMaps?.[ eyes.index ] || bodyMap;
	const wingMap = vat.colorMaps?.[ wings.index ] || bodyMap;
	const pivotHeight = vat.bounds.height * 0.5;

	const sampleClip = ( clipId, phase ) => {

		const info = clipTable.element( clipId.toInt() );
		const rowFloat = phase.fract().mul( info.y );
		const row0 = floor( rowFloat );
		const weight = rowFloat.sub( row0 );
		const first = info.x.add( row0 ).toInt();
		const second = info.x.add( row0.add( 1 ).mod( info.y ) ).toInt();
		const p0 = textureLoad( vat.texture, ivec2( vertexIndex.toInt(), first ) ).xyz;
		const p1 = textureLoad( vat.texture, ivec2( vertexIndex.toInt(), second ) ).xyz;
		return mix( p0, p1, weight );

	};

	const material = new THREE.MeshStandardNodeMaterial( {
		roughness: 0.62,
		metalness: 0,
		side: THREE.DoubleSide,
	} );
	material.flatShading = true;
	material.alphaHash = true;
	material.depthWrite = true;

	material.positionNode = Fn( () => {

		const instancePose = attribute( 'aPose', 'vec4' );
		const instanceQuat = attribute( 'aQuat', 'vec4' );
		const anim = attribute( 'aAnim', 'vec4' );
		const transition = attribute( 'aBlend', 'float' );
		const local = sampleClip( anim.x, anim.y ).toVar();
		If( transition.greaterThan( 0.002 ), () => {

			local.assign( mix( local, sampleClip( anim.z, anim.w ), transition ) );

		} );

		varyingProperty( 'float', 'vBeePart' ).assign(
			select(
				vertexIndex.lessThan( uint( eyes.offset ) ),
				float( 0 ),
				select(
					vertexIndex.lessThan( uint( proboscis.offset ) ),
					float( 1 ),
					select( vertexIndex.lessThan( uint( wings.offset ) ), float( 2 ), float( 3 ) ),
				),
			),
		);

		const pivot = vec3( 0, pivotHeight, 0 );
		return qrot( instanceQuat, local.sub( pivot ).mul( instancePose.w ) )
			.add( instancePose.xyz );

	} )();

	material.colorNode = Fn( () => {

		const bodyAtlas = texture( bodyMap, uv() );
		const eyeAtlas = texture( eyeMap, uv() );
		const wingAtlas = texture( wingMap, uv() );
		const part = varyingProperty( 'float', 'vBeePart' );
		const atlasTinted = bodyAtlas.rgb.mul( vec3( uBeeTint ) );
		const proboscisColor = vec3( 0.075, 0.028, 0.014 );
		const wingColor = mix( wingAtlas.rgb, vec3( uWingColor ), 0.42 );
		return select(
			part.greaterThan( 2.5 ),
			wingColor,
			select(
				part.greaterThan( 1.5 ),
				proboscisColor,
				select( part.greaterThan( 0.5 ), eyeAtlas.rgb, atlasTinted ),
			),
		);

	} )();

	material.opacityNode = Fn( () => {

		const wingAtlas = texture( wingMap, uv() );
		return select(
			varyingProperty( 'float', 'vBeePart' ).greaterThan( 2.5 ),
			max( wingAtlas.a.mul( 0.52 ), 0.16 ),
			float( 1 ),
		);

	} )();

	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = 'HoneyBeeVATInstances';
	mesh.frustumCulled = false;
	mesh.castShadow = !! gfx.beeCastShadow;
	mesh.receiveShadow = !! gfx.beeReceiveShadow;

	return {
		mesh,
		geometry,
		material,
		pose,
		quaternion,
		animation,
		blend,
		uBeeTint,
		uWingColor,
	};

}

export function createBees( { scene, props, assets } ) {

	const group = new THREE.Group();
	group.name = 'Pollinators';

	const flowerRenderer = createFlowerRenderer( assets.flowerGeometry );
	const beeRenderer = createBeeRenderer( assets.beeVat );
	const hiveAsset = prepareHive( assets.hiveScene );
	const hivePivot = new THREE.Group();
	hivePivot.name = 'BeehiveOnTree';
	hivePivot.add( hiveAsset.model );
	group.add( flowerRenderer.mesh, hivePivot, beeRenderer.mesh );
	scene.add( group );

	const dummy = new THREE.Object3D();
	const instanceMatrix = new THREE.Matrix4();
	const worldMatrix = new THREE.Matrix4();
	const hiveAnchor = new THREE.Vector3();
	const hiveFlight = new THREE.Vector3();
	const heading = new THREE.Vector3();
	const renderPosition = new THREE.Vector3();
	const modelForward = new THREE.Vector3( - 1, 0, 0 );
	const attitude = new THREE.Quaternion();
	const targetAttitude = new THREE.Quaternion();
	const flowerYawAttitude = new THREE.Quaternion();
	const flowerContext = {
		count: 0,
		x: new Float32Array(),
		y: new Float32Array(),
		z: new Float32Array(),
		contactX: new Float32Array(),
		contactY: new Float32Array(),
		contactZ: new Float32Array(),
		yaw: new Float32Array(),
		scale: new Float32Array(),
		active: new Uint8Array(),
		patch: new Uint16Array(),
		quality: new Float32Array(),
		nectar: new Float32Array(),
		pollen: new Float32Array(),
	};
	const context = {
		daylight: 1,
		weather: { temperatureC: gfx.beeTemperature, rain: gfx.beeRain, windSpeed: gfx.beeWind },
		hive: { x: 0, y: 1, z: 0 },
		demand: { nectar: 0.62, pollen: 0.38 },
		colony: { queenPresent: true, nutrition: 1, season: 1, layingMultiplier: 1 },
		flowers: flowerContext,
	};
	const currentClip = new Uint8Array( MAX_BEES );
	const blendFromClip = new Uint8Array( MAX_BEES );
	const transitionLeft = new Float32Array( MAX_BEES );
	const blendFromPhase = new Float32Array( MAX_BEES );
	const lastPhase = new Float32Array( MAX_BEES );
	const attitudeX = new Float32Array( MAX_BEES );
	const attitudeY = new Float32Array( MAX_BEES );
	const attitudeZ = new Float32Array( MAX_BEES );
	const attitudeW = new Float32Array( MAX_BEES );
	const attitudeReady = new Uint8Array( MAX_BEES );
	currentClip.fill( BEE_CLIP.HIDDEN );
	blendFromClip.fill( BEE_CLIP.HIDDEN );

	let simulation = createBeeSimulation( {
		capacity: MAX_BEES,
		initialCount: 0,
		seed: 0xBEE2026,
		flightSpeed: gfx.beeSpeed,
		durationScale: 1,
		forageDurationSeconds: gfx.beeForageDuration,
		initialAdultWorkers: 32000,
		initialEggs: 3600,
		initialLarvae: 6500,
		initialPupae: 12500,
	} );
	let flowerLayout = null;
	let lastPropsRevision = - 1;
	let lastTreeScale = NaN;
	let lastFlowerPropsRevision = - 1;
	let lastFlowerTreeScale = NaN;
	let lastFlowerObstacleScale = NaN;
	let flowerStockAccumulator = 0;
	let surfaceVisible = true;
	let hiveAvailable = false;

	function refreshHiveAnchor( force = false ) {

		const revision = props.getRevision ? props.getRevision() : 0;
		if ( ! force && revision === lastPropsRevision && lastTreeScale === gfx.scaleTrees ) return false;
		lastPropsRevision = revision;
		lastTreeScale = gfx.scaleTrees;

		const host = selectHiveHost( props.registry );
		if ( ! host ) {

			hiveAvailable = false;
			hivePivot.visible = false;
			beeRenderer.geometry.instanceCount = 0;
			return false;

		}

		host.entry.mesh.getMatrixAt( host.index, instanceMatrix );
		props.group.updateMatrixWorld( true );
		worldMatrix.multiplyMatrices( props.group.matrixWorld, instanceMatrix );
		hiveAnchor.copy( TREE_SOCKET ).applyMatrix4( worldMatrix );
		hivePivot.position.copy( hiveAnchor );
		hivePivot.rotation.set( 0, Math.atan2( - hiveAnchor.x, - hiveAnchor.z ), 0 );
		hivePivot.scale.setScalar( gfx.hiveScale );
		hivePivot.visible = true;
		hiveAvailable = true;
		hivePivot.updateMatrixWorld( true );
		hiveAsset.flight.getWorldPosition( hiveFlight );
		context.hive.x = hiveFlight.x;
		context.hive.y = hiveFlight.y;
		context.hive.z = hiveFlight.z;
		return true;

	}

	function refreshFlowers() {

		const count = clamp( Math.round( gfx.flowerCount ), 0, MAX_FLOWERS );
		flowerLayout = buildFlowerLayout( {
			count,
			world: WORLD,
			exclusions: flowerExclusionsFromProps( props.registry, {
				trees: gfx.scaleTrees,
				obstacles: gfx.scaleObstacles,
			} ),
		} );

		const x = new Float32Array( count );
		const y = new Float32Array( count );
		const z = new Float32Array( count );
		const contactX = new Float32Array( count );
		const contactY = new Float32Array( count );
		const contactZ = new Float32Array( count );
		const yaw = new Float32Array( count );
		const flowerScale = new Float32Array( count );
		const active = new Uint8Array( count );
		const quality = new Float32Array( count );
		const nectar = new Float32Array( count );
		const pollen = new Float32Array( count );

		for ( let i = 0; i < count; i ++ ) {

			const offset = i * 3;
			const randomScale = 1 + ( flowerLayout.scales[ i ] - 1 ) * gfx.flowerVariation;
			const scale = gfx.flowerSize * randomScale;
			dummy.position.set(
				flowerLayout.positions[ offset ],
				0,
				flowerLayout.positions[ offset + 2 ],
			);
			dummy.rotation.set( 0, flowerLayout.yaws[ i ], 0 );
			dummy.scale.setScalar( scale );
			dummy.updateMatrix();
			flowerRenderer.mesh.setMatrixAt( i, dummy.matrix );

			x[ i ] = dummy.position.x;
			y[ i ] = scale * 0.88;
			z[ i ] = dummy.position.z;
			yaw[ i ] = flowerLayout.yaws[ i ];
			flowerScale[ i ] = scale;
			const cosine = Math.cos( yaw[ i ] );
			const sine = Math.sin( yaw[ i ] );
			contactX[ i ] = x[ i ] + ( FLOWER_CONTACT_X * cosine + FLOWER_CONTACT_Z * sine ) * scale;
			contactY[ i ] = FLOWER_CONTACT_Y * scale;
			contactZ[ i ] = z[ i ] + ( - FLOWER_CONTACT_X * sine + FLOWER_CONTACT_Z * cosine ) * scale;
			active[ i ] = 1;
			quality[ i ] = 0.72 + ( ( i * 73 ) % 29 ) / 100;
			nectar[ i ] = FLOWER_STOCK;
			pollen[ i ] = FLOWER_STOCK;

		}

		flowerRenderer.mesh.count = count;
		flowerRenderer.mesh.instanceMatrix.needsUpdate = true;
		flowerRenderer.mesh.computeBoundingSphere();
		Object.assign( flowerContext, {
			count, x, y, z, contactX, contactY, contactZ, yaw, scale: flowerScale, active,
			patch: flowerLayout.patchIds,
			quality, nectar, pollen,
		} );
		lastFlowerPropsRevision = props.getRevision ? props.getRevision() : 0;
		lastFlowerTreeScale = gfx.scaleTrees;
		lastFlowerObstacleScale = gfx.scaleObstacles;
		return count;

	}

	function refreshFlowerLayoutIfNeeded() {

		const revision = props.getRevision ? props.getRevision() : 0;
		if (
			revision !== lastFlowerPropsRevision ||
			gfx.scaleTrees !== lastFlowerTreeScale ||
			gfx.scaleObstacles !== lastFlowerObstacleScale
		) refreshFlowers();

	}

	function setBeeCount( requested = gfx.beeCount ) {

		const target = clamp( Math.round( requested ), 0, MAX_BEES );
		gfx.beeCount = target;
		if ( target > simulation.count ) {

			simulation.addBees( target - simulation.count, context.hive );

		} else {

			simulation.count = target;

		}
		return target;

	}

	function updateStocks( dt ) {

		flowerStockAccumulator += dt;
		if ( flowerStockAccumulator < 0.5 ) return;
		const elapsed = Math.floor( ( flowerStockAccumulator + 1e-12 ) / 0.5 ) * 0.5;
		flowerStockAccumulator -= elapsed;
		if ( flowerStockAccumulator < 0 && flowerStockAccumulator > - 1e-10 )
			flowerStockAccumulator = 0;
		const refill = elapsed * 0.12;
		for ( let i = 0; i < flowerContext.count; i ++ ) {

			flowerContext.nectar[ i ] = Math.min( FLOWER_STOCK, flowerContext.nectar[ i ] + refill );
			flowerContext.pollen[ i ] = Math.min( FLOWER_STOCK, flowerContext.pollen[ i ] + refill * 0.62 );

		}

	}

	function writeBeeInstances( dt ) {

		const views = simulation.getViews();
		let rendered = 0;

		for ( let bee = 0; bee < simulation.count; bee ++ ) {

			const clip = views.clip[ bee ];
			if ( clip === BEE_CLIP.HIDDEN ) {

				currentClip[ bee ] = BEE_CLIP.HIDDEN;
				blendFromClip[ bee ] = BEE_CLIP.HIDDEN;
				transitionLeft[ bee ] = 0;
				blendFromPhase[ bee ] = 0;
				lastPhase[ bee ] = 0;
				attitudeReady[ bee ] = 0;
				continue;

			}

			if ( currentClip[ bee ] === BEE_CLIP.HIDDEN ) {

				currentClip[ bee ] = clip;
				blendFromClip[ bee ] = clip;
				blendFromPhase[ bee ] = 0;

			} else if ( clip !== currentClip[ bee ] ) {

				blendFromClip[ bee ] = currentClip[ bee ];
				blendFromPhase[ bee ] = lastPhase[ bee ];
				currentClip[ bee ] = clip;
				transitionLeft[ bee ] = TRANSITION_SECONDS;

			}

			renderPosition.set( views.x[ bee ], views.y[ bee ], views.z[ bee ] );
			const state = views.state[ bee ];
			const target = views.targetFlower[ bee ];
			if (
				( state === BEE_STATE.TOUCHDOWN || state === BEE_STATE.FORAGE ) &&
				target >= 0 &&
				target < flowerContext.count
			) {

				flowerYawAttitude.setFromAxisAngle( WORLD_UP, flowerContext.yaw[ target ] );
				targetAttitude.multiplyQuaternions( flowerYawAttitude, FORAGE_ATTITUDE );

			} else {

				heading.set( views.headingX[ bee ], views.headingY[ bee ], views.headingZ[ bee ] );
				if ( heading.lengthSq() < 1e-6 ) heading.copy( modelForward );
				else heading.normalize();
				targetAttitude.setFromUnitVectors( modelForward, heading );

			}

			if ( attitudeReady[ bee ] === 0 ) {

				attitude.copy( targetAttitude );

			} else {

				attitude.set( attitudeX[ bee ], attitudeY[ bee ], attitudeZ[ bee ], attitudeW[ bee ] );
				attitude.slerp( targetAttitude, 1 - Math.exp( - dt * 8 ) );

			}
			attitudeX[ bee ] = attitude.x;
			attitudeY[ bee ] = attitude.y;
			attitudeZ[ bee ] = attitude.z;
			attitudeW[ bee ] = attitude.w;
			attitudeReady[ bee ] = 1;

			const poseOffset = rendered * 4;
			beeRenderer.pose.array[ poseOffset ] = renderPosition.x;
			beeRenderer.pose.array[ poseOffset + 1 ] = renderPosition.y;
			beeRenderer.pose.array[ poseOffset + 2 ] = renderPosition.z;
			beeRenderer.pose.array[ poseOffset + 3 ] = gfx.beeScale;
			beeRenderer.quaternion.array[ poseOffset ] = attitude.x;
			beeRenderer.quaternion.array[ poseOffset + 1 ] = attitude.y;
			beeRenderer.quaternion.array[ poseOffset + 2 ] = attitude.z;
			beeRenderer.quaternion.array[ poseOffset + 3 ] = attitude.w;

			const phase = ( views.animationTime[ bee ] / assets.beeVat.clipInfos[ clip ].duration ) % 1;
			const previous = blendFromClip[ bee ];
			beeRenderer.animation.array[ poseOffset ] = clip;
			beeRenderer.animation.array[ poseOffset + 1 ] = phase;
			beeRenderer.animation.array[ poseOffset + 2 ] = previous;
			beeRenderer.animation.array[ poseOffset + 3 ] = blendFromPhase[ bee ];
			beeRenderer.blend.array[ rendered ] = transitionLeft[ bee ] / TRANSITION_SECONDS;

			transitionLeft[ bee ] = Math.max( 0, transitionLeft[ bee ] - dt );
			if ( transitionLeft[ bee ] > 0 ) {

				blendFromPhase[ bee ] =
					( blendFromPhase[ bee ] + dt / assets.beeVat.clipInfos[ previous ].duration ) % 1;

			} else {

				blendFromClip[ bee ] = clip;
				blendFromPhase[ bee ] = phase;

			}
			lastPhase[ bee ] = phase;
			rendered ++;

		}

		beeRenderer.geometry.instanceCount = rendered;
		beeRenderer.pose.needsUpdate = true;
		beeRenderer.quaternion.needsUpdate = true;
		beeRenderer.animation.needsUpdate = true;
		beeRenderer.blend.needsUpdate = true;
		return rendered;

	}

	function syncSimulationInputs() {

		context.daylight = gfx.beeDaylight;
		context.weather.temperatureC = gfx.beeTemperature;
		context.weather.rain = gfx.beeRain;
		context.weather.windSpeed = gfx.beeWind;
		simulation.flightSpeed = gfx.beeSpeed;
		simulation.forageDurationSeconds = gfx.beeForageDuration;

	}

	// Hot logical path: the fixed-step scheduler may call it many times before
	// one rendered frame. It deliberately performs no GLB traversal, instance
	// upload, matrix rebuild or visibility mutation.
	function stepSimulation( dt ) {

		if ( ! Number.isFinite( dt ) || dt < 0 )
			throw new RangeError( 'dt must be a finite non-negative number' );
		if ( ! gfx.pollinators || dt === 0 || ! hiveAvailable )
			return simulation.getTelemetry();
		syncSimulationInputs();
		updateStocks( dt );
		flowerRenderer.uTime.value += dt;
		simulation.update( dt, context );
		return simulation.getTelemetry();

	}

	// Cold visual path: exactly one upload per browser frame, independently of
	// the requested simulation multiplier.
	function renderFrame( renderDt = 0, isSurfaceVisible = true ) {

		if ( ! Number.isFinite( renderDt ) || renderDt < 0 )
			throw new RangeError( 'renderDt must be a finite non-negative number' );
		surfaceVisible = isSurfaceVisible;
		group.visible = !! gfx.pollinators && surfaceVisible;
		if ( ! gfx.pollinators ) return simulation.getTelemetry();

		refreshHiveAnchor();
		refreshFlowerLayoutIfNeeded();
		flowerRenderer.uWind.value = gfx.flowerWind;
		if ( ! hiveAvailable ) {

			beeRenderer.geometry.instanceCount = 0;
			return simulation.getTelemetry();

		}
		writeBeeInstances( renderDt );
		return simulation.getTelemetry();

	}

	// Backward-compatible single-step facade used by isolated demos/tests.
	function update( dt, isSurfaceVisible = true ) {

		refreshHiveAnchor();
		refreshFlowerLayoutIfNeeded();
		const telemetry = stepSimulation( dt );
		renderFrame( dt, isSurfaceVisible );
		return telemetry;

	}

	function reset() {

		simulation = createBeeSimulation( {
			capacity: MAX_BEES,
			initialCount: 0,
			seed: 0xBEE2026,
			flightSpeed: gfx.beeSpeed,
			durationScale: 1,
			forageDurationSeconds: gfx.beeForageDuration,
			initialAdultWorkers: 32000,
			initialEggs: 3600,
			initialLarvae: 6500,
			initialPupae: 12500,
		} );
		currentClip.fill( BEE_CLIP.HIDDEN );
		blendFromClip.fill( BEE_CLIP.HIDDEN );
		transitionLeft.fill( 0 );
		blendFromPhase.fill( 0 );
		lastPhase.fill( 0 );
		attitudeReady.fill( 0 );
		refreshHiveAnchor( true );
		refreshFlowers();
		setBeeCount();
		writeBeeInstances( 0 );

	}

	function setHiveScale( scale ) {

		gfx.hiveScale = scale;
		hivePivot.scale.setScalar( scale );
		hivePivot.updateMatrixWorld( true );
		hiveAsset.flight.getWorldPosition( hiveFlight );
		Object.assign( context.hive, { x: hiveFlight.x, y: hiveFlight.y, z: hiveFlight.z } );

	}

	function setSurfaceVisible( visible ) {

		surfaceVisible = visible;
		group.visible = !! gfx.pollinators && surfaceVisible;

	}

	function setFlowerPetalColor( value ) {

		gfx.flowerPetalColor = value;
		flowerRenderer.uPetalColor.value.set( value );

	}

	function setFlowerStemColor( value ) {

		gfx.flowerStemColor = value;
		flowerRenderer.uStemColor.value.set( value );

	}

	function setBeeTint( value ) {

		gfx.beeTint = value;
		beeRenderer.uBeeTint.value.set( value );

	}

	function setBeeWingColor( value ) {

		gfx.beeWingColor = value;
		beeRenderer.uWingColor.value.set( value );

	}

	function setBeeCastShadow( value ) {

		gfx.beeCastShadow = !! value;
		beeRenderer.mesh.castShadow = gfx.beeCastShadow;

	}

	function setBeeReceiveShadow( value ) {

		gfx.beeReceiveShadow = !! value;
		beeRenderer.mesh.receiveShadow = gfx.beeReceiveShadow;

	}

	function setHiveCastShadow( value ) {

		gfx.hiveCastShadow = !! value;
		setHierarchyShadows( hiveAsset.model, gfx.hiveCastShadow, gfx.hiveReceiveShadow );

	}

	function setHiveReceiveShadow( value ) {

		gfx.hiveReceiveShadow = !! value;
		setHierarchyShadows( hiveAsset.model, gfx.hiveCastShadow, gfx.hiveReceiveShadow );

	}

	refreshHiveAnchor( true );
	refreshFlowers();
	setBeeCount();
	writeBeeInstances( 0 );

	return {
		group,
		flowerMesh: flowerRenderer.mesh,
		beeMesh: beeRenderer.mesh,
		hive: hivePivot,
		uFlowerWind: flowerRenderer.uWind,
		uFlowerPetalColor: flowerRenderer.uPetalColor,
		uFlowerStemColor: flowerRenderer.uStemColor,
		uBeeTint: beeRenderer.uBeeTint,
		uWingColor: beeRenderer.uWingColor,
		stepSimulation,
		renderFrame,
		update,
		reset,
		setBeeCount,
		refreshFlowers,
		refreshHiveAnchor,
		setHiveScale,
		setSurfaceVisible,
		setFlowerPetalColor,
		setFlowerStemColor,
		setBeeTint,
		setBeeWingColor,
		setBeeCastShadow,
		setBeeReceiveShadow,
		setHiveCastShadow,
		setHiveReceiveShadow,
		getSimulation: () => simulation,
		getTelemetry: () => simulation.getTelemetry(),
		getFlowerContext: () => flowerContext,
	};

}
