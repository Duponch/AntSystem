import { gfx } from './config.js';
import { createBees } from './bees.js';
import { createButterflies } from './butterflies.js';
import { createChameleons } from './chameleons.js';
import { loadButterflyAsset, loadPollinatorAssets } from './pollinator-assets.js';

/**
 * Stable facade around optional pollinator renderers.
 *
 * Persisting "Activer" to false skips every GLB request and VAT bake at
 * startup. Re-enabling starts one shared asynchronous load; UI callbacks remain
 * valid before, during and after that load. Butterflies have their own lazy
 * singleton so disabling them does not disable bees or flowers.
 */
export function createPollinators( {
	scene,
	renderer = null,
	camera = null,
	props,
	environment = null,
	assets = null,
	butterflyVat = null,
} ) {

	let system = assets ? createBees( { scene, props, assets } ) : null;
	let chameleonSystem = null;
	const getChameleonThreat = () => chameleonSystem?.getAvoidanceContext?.()
		|| chameleonSystem?.getAvoidanceView?.() || null;
	let butterflySystem = system && butterflyVat && gfx.butterflies
		? createButterflies( {
			scene,
			vat: butterflyVat,
			getFlowers: () => system?.getFlowerContext() || null,
			getPredatorThreat: getChameleonThreat,
		} )
		: null;
	let loadPromise = null;
	let butterflyLoadPromise = null;
	let chameleonLoadPromise = null;
	let loadGeneration = 0;
	let butterflyLoadGeneration = 0;
	let chameleonLoadGeneration = 0;
	let chameleonSurfaceRefreshTimer = null;
	let chameleonSurfaceRefreshRequest = 0;
	let chameleonSurfaceRefreshPromise = null;
	let chameleonSurfaceRefreshWaiters = [];
	let disposed = false;
	let surfaceVisible = true;
	let chameleonWasEnabled = !! gfx.chameleonEnabled;

	function ensureLoaded() {

		if ( disposed ) return Promise.resolve( null );
		if ( system ) return Promise.resolve( system );
		if ( ! gfx.pollinators ) return Promise.resolve( null );
		if ( loadPromise ) return loadPromise;

		const generation = loadGeneration;
		loadPromise = loadPollinatorAssets()
			.then( ( loadedAssets ) => {

				if ( disposed || generation !== loadGeneration ) return null;
				system = createBees( { scene, props, assets: loadedAssets } );
				system.setSurfaceVisible( surfaceVisible );
				return system;

			} )
			.catch( ( error ) => {

				if ( ! disposed && generation === loadGeneration ) {

					loadPromise = null;
					gfx.pollinators = false;

				}
				console.error( 'Chargement des pollinisateurs impossible.', error );
				return null;

			} );
		return loadPromise;

	}

	function ensureButterflies() {

		if ( disposed ) return Promise.resolve( null );
		if ( butterflySystem ) return Promise.resolve( butterflySystem );
		if ( ! gfx.pollinators || ! gfx.butterflies ) return Promise.resolve( null );
		if ( butterflyLoadPromise ) return butterflyLoadPromise;

		const generation = butterflyLoadGeneration;
		butterflyLoadPromise = Promise.all( [
			ensureLoaded(),
			butterflyVat ? Promise.resolve( butterflyVat ) : loadButterflyAsset(),
		] )
			.then( ( [ loadedSystem, loadedVat ] ) => {

				if ( disposed || generation !== butterflyLoadGeneration ) return null;
				butterflyVat = loadedVat;
				if ( ! loadedSystem || ! loadedVat ) {

					butterflyLoadPromise = null;
					return null;

				}
				if ( ! butterflySystem ) {

					butterflySystem = createButterflies( {
						scene,
						vat: loadedVat,
						getFlowers: () => system?.getFlowerContext() || null,
						getPredatorThreat: getChameleonThreat,
					} );
					butterflySystem.setSurfaceVisible( surfaceVisible );

				}
				return butterflySystem;

			} )
			.catch( ( error ) => {

				if ( ! disposed && generation === butterflyLoadGeneration ) {

					butterflyLoadPromise = null;
					gfx.butterflies = false;

				}
				console.error( 'Chargement des papillons impossible.', error );
				return null;

			} );
		return butterflyLoadPromise;

	}

	function createChameleonInstance() {

		return createChameleons( {
			scene,
			renderer,
			camera,
			props,
			environment,
			getButterflyPredationContext: () => butterflySystem?.getPredationContext() || null,
		} );

	}

	function ensureChameleon() {

		if ( disposed ) return Promise.resolve( null );
		if ( chameleonSystem ) return Promise.resolve( chameleonSystem );
		if ( ! gfx.chameleonEnabled ) return Promise.resolve( null );
		if ( chameleonLoadPromise ) return chameleonLoadPromise;
		const generation = chameleonLoadGeneration;
		const loading = createChameleonInstance()
			.then( ( loaded ) => {

				if ( generation !== chameleonLoadGeneration ) {

					loaded?.dispose?.();
					return chameleonSystem;

				}
				chameleonSystem = loaded;
				chameleonSystem.setSurfaceVisible( surfaceVisible );
				return chameleonSystem;

			} )
			.catch( ( error ) => {

				if ( generation === chameleonLoadGeneration ) {

					chameleonLoadPromise = null;
					gfx.chameleonEnabled = false;

				}
				console.error( 'Chargement du caméléon impossible.', error );
				return null;

			} );
		chameleonLoadPromise = loading;
		return chameleonLoadPromise;

	}

	function settleChameleonSurfaceRefresh( value ) {

		const waiters = chameleonSurfaceRefreshWaiters;
		chameleonSurfaceRefreshWaiters = [];
		for ( const resolve of waiters ) resolve( value );

	}

	async function rebuildChameleonSurfaces() {

		chameleonSurfaceRefreshTimer = null;
		if ( chameleonSurfaceRefreshPromise ) return chameleonSurfaceRefreshPromise;
		chameleonSurfaceRefreshPromise = ( async () => {

			while ( ! disposed && gfx.chameleonEnabled ) {

				const request = chameleonSurfaceRefreshRequest;
				const generation = ++ chameleonLoadGeneration;
				const previous = chameleonSystem;
				let loaded;
				try {

					loaded = await createChameleonInstance();

				} catch ( error ) {

					console.error( 'Reconstruction physique du caméléon impossible.', error );
					// A superseded snapshot is retried instead of publishing stale
					// colliders or resolving a newer caller with the previous world.
					if ( request !== chameleonSurfaceRefreshRequest ) continue;
					settleChameleonSurfaceRefresh( previous );
					return previous;

				}
				const superseded = request !== chameleonSurfaceRefreshRequest;
				const invalid = disposed || ! gfx.chameleonEnabled
					|| generation !== chameleonLoadGeneration;
				if ( superseded || invalid ) {

					loaded?.dispose?.();
					if ( superseded && ! disposed && gfx.chameleonEnabled ) {

						clearTimeout( chameleonSurfaceRefreshTimer );
						chameleonSurfaceRefreshTimer = null;
						continue;

					}
					settleChameleonSurfaceRefresh( chameleonSystem );
					return chameleonSystem;

				}
				const wasSelected = !! previous?.getDebugView?.().selected;
				releaseCapturedButterfly();
				loaded.setSurfaceVisible( surfaceVisible );
				if ( wasSelected ) loaded.select();
				chameleonSystem = loaded;
				chameleonLoadPromise = null;
				previous?.dispose?.();
				settleChameleonSurfaceRefresh( loaded );
				return loaded;

			}
			settleChameleonSurfaceRefresh( chameleonSystem );
			return chameleonSystem;

		} )().finally( () => {

			chameleonSurfaceRefreshPromise = null;

		} );
		return chameleonSurfaceRefreshPromise;

	}

	function refreshChameleonSurfaces( debounceMs = 180 ) {

		if ( disposed ) return Promise.resolve( null );
		chameleonSurfaceRefreshRequest ++;
		clearTimeout( chameleonSurfaceRefreshTimer );
		const completion = new Promise( ( resolve ) => {

			chameleonSurfaceRefreshWaiters.push( resolve );

		} );
		chameleonSurfaceRefreshTimer = setTimeout( () => {

			void rebuildChameleonSurfaces();

		}, Math.max( 0, Number.isFinite( debounceMs ) ? debounceMs : 180 ) );
		return completion;

	}

	function releaseCapturedButterfly() {

		const index = chameleonSystem?.getSimulation().getView().capturedIndex ?? - 1;
		if ( index < 0 ) return false;
		return butterflySystem?.getPredationContext().releaseCapture( index ) || false;

	}

	function syncEnabledTransitions() {

		const chameleonEnabled = !! gfx.chameleonEnabled;
		if ( ! chameleonEnabled && chameleonWasEnabled && chameleonSystem ) {

			releaseCapturedButterfly();
			chameleonSystem.reset();

		}
		chameleonWasEnabled = chameleonEnabled;

	}

	function stepSimulation( dt ) {

		if ( ! Number.isFinite( dt ) || dt < 0 )
			throw new RangeError( 'dt must be a finite non-negative number' );
		let telemetry = null;
		if ( system ) telemetry = system.stepSimulation( dt );
		if ( butterflySystem ) butterflySystem.stepSimulation( dt );
		syncEnabledTransitions();
		if ( chameleonSystem ) chameleonSystem.stepSimulation( dt );
		return telemetry;

	}

	function renderFrame( renderDt = 0, visible = true ) {

		if ( ! Number.isFinite( renderDt ) || renderDt < 0 )
			throw new RangeError( 'renderDt must be a finite non-negative number' );
		surfaceVisible = visible;
		let telemetry = null;
		if ( system ) telemetry = system.renderFrame( renderDt, visible );
		else if ( gfx.pollinators ) void ensureLoaded();

		if ( butterflySystem ) butterflySystem.renderFrame( visible );
		else if ( gfx.pollinators && gfx.butterflies ) void ensureButterflies();

		if ( chameleonSystem ) chameleonSystem.renderFrame( renderDt, visible );
		else if ( gfx.chameleonEnabled ) void ensureChameleon();
		return telemetry;

	}

	function update( dt, visible = true ) {

		const telemetry = stepSimulation( dt );
		renderFrame( dt, visible );
		return telemetry;

	}
	return {
		preload() {

			return Promise.all( [
				ensureLoaded(),
				gfx.butterflies ? ensureButterflies() : Promise.resolve( null ),
				gfx.chameleonEnabled ? ensureChameleon() : Promise.resolve( null ),
			] );

		},
		stepSimulation,
		renderFrame,
		update,
		reset() {

			const beeReset = system
				? system.reset()
				: gfx.pollinators
					? ensureLoaded().then( ( loaded ) => loaded?.reset() )
					: null;
			const butterflyReset = butterflySystem
				? butterflySystem.reset()
				: gfx.pollinators && gfx.butterflies
					? ensureButterflies().then( ( loaded ) => loaded?.reset() )
					: null;
			const chameleonReset = chameleonSystem
				? chameleonSystem.reset()
				: gfx.chameleonEnabled
					? ensureChameleon().then( ( loaded ) => loaded?.reset() )
					: null;
			return Promise.all( [ beeReset, butterflyReset, chameleonReset ] );

		},
		setBeeCount( value ) {

			gfx.beeCount = value;
			return system ? system.setBeeCount( value ) : value;

		},
		refreshFlowers() {

			return system ? system.refreshFlowers() : 0;

		},
		refreshHiveAnchor( force = false ) {

			return system ? system.refreshHiveAnchor( force ) : false;

		},
		refreshChameleonSurfaces,
		setHiveScale( value ) {

			gfx.hiveScale = value;
			if ( system ) system.setHiveScale( value );

		},
		setSurfaceVisible( visible ) {

			surfaceVisible = visible;
			if ( system ) system.setSurfaceVisible( visible );
			if ( butterflySystem ) butterflySystem.setSurfaceVisible( visible );
			if ( chameleonSystem ) chameleonSystem.setSurfaceVisible( visible );

		},
		setFlowerPetalColor( value ) {

			gfx.flowerPetalColor = value;
			if ( system ) system.setFlowerPetalColor( value );

		},
		setFlowerStemColor( value ) {

			gfx.flowerStemColor = value;
			if ( system ) system.setFlowerStemColor( value );

		},
		setBeeTint( value ) {

			gfx.beeTint = value;
			if ( system ) system.setBeeTint( value );

		},
		setBeeWingColor( value ) {

			gfx.beeWingColor = value;
			if ( system ) system.setBeeWingColor( value );

		},
		setBeeCastShadow( value ) {

			gfx.beeCastShadow = !! value;
			if ( system ) system.setBeeCastShadow( value );

		},
		setBeeReceiveShadow( value ) {

			gfx.beeReceiveShadow = !! value;
			if ( system ) system.setBeeReceiveShadow( value );

		},
		setHiveCastShadow( value ) {

			gfx.hiveCastShadow = !! value;
			if ( system ) system.setHiveCastShadow( value );

		},
		setHiveReceiveShadow( value ) {

			gfx.hiveReceiveShadow = !! value;
			if ( system ) system.setHiveReceiveShadow( value );

		},
		setButterflyCount( value ) {

			gfx.butterflyCount = value;
			if ( butterflySystem ) return butterflySystem.setCount( value );
			if ( gfx.pollinators && gfx.butterflies ) void ensureButterflies();
			return value;

		},
		setButterflyTint( value ) {

			gfx.butterflyTint = value;
			if ( butterflySystem ) butterflySystem.setTint( value );

		},
		setButterflyCastShadow( value ) {

			gfx.butterflyCastShadow = !! value;
			if ( butterflySystem ) butterflySystem.setCastShadow( value );

		},
		setButterflyReceiveShadow( value ) {

			gfx.butterflyReceiveShadow = !! value;
			if ( butterflySystem ) butterflySystem.setReceiveShadow( value );

		},
		selectButterfly( index ) {

			return butterflySystem ? butterflySystem.select( index ) : - 1;

		},
		clearButterflySelection() {

			if ( butterflySystem ) butterflySystem.clearSelection();

		},
		getButterflyDebugSnapshot() {

			return butterflySystem?.getDebugSnapshot() || null;

		},
		setChameleonEnabled( value ) {

			gfx.chameleonEnabled = !! value;
			chameleonWasEnabled = gfx.chameleonEnabled;
			if ( ! gfx.chameleonEnabled ) {

				chameleonLoadGeneration ++;
				chameleonLoadPromise = null;
				chameleonSurfaceRefreshRequest ++;
				clearTimeout( chameleonSurfaceRefreshTimer );
				chameleonSurfaceRefreshTimer = null;
				settleChameleonSurfaceRefresh( null );
				releaseCapturedButterfly();
				chameleonSystem?.clearSelection();
				chameleonSystem?.reset();
				chameleonSystem?.setSurfaceVisible( surfaceVisible );

			} else if ( gfx.chameleonEnabled ) {

				void ensureChameleon();

			}

		},
		setChameleonCastShadow( value ) {

			gfx.chameleonCastShadow = !! value;
			if ( chameleonSystem ) chameleonSystem.setCastShadow( value );

		},
		setChameleonReceiveShadow( value ) {

			gfx.chameleonReceiveShadow = !! value;
			if ( chameleonSystem ) chameleonSystem.setReceiveShadow( value );

		},
		selectChameleon( selected = true ) {

			if ( ! chameleonSystem ) return null;
			return selected ? chameleonSystem.select() : chameleonSystem.clearSelection();

		},
		clearChameleonSelection() {

			return chameleonSystem?.clearSelection() || null;

		},
		getChameleonDebugView() {

			return chameleonSystem?.getDebugView() || null;

		},
		getChameleonAvoidanceContext() {

			return chameleonSystem?.getAvoidanceContext() || null;

		},
		getSimulation: () => system?.getSimulation() || null,
		getTelemetry: () => system?.getTelemetry() || null,
		getFlowerContext: () => system?.getFlowerContext() || null,
		getButterflySimulation: () => butterflySystem?.getSimulation() || null,
		getButterflyTelemetry: () => butterflySystem?.getTelemetry() || null,
		getChameleonSimulation: () => chameleonSystem?.getSimulation() || null,
		getChameleonTelemetry: () => chameleonSystem?.getTelemetry() || null,
		get group() { return system?.group || null; },
		get flowerMesh() { return system?.flowerMesh || null; },
		get beeMesh() { return system?.beeMesh || null; },
		get hive() { return system?.hive || null; },
		get butterflyMesh() { return butterflySystem?.mesh || null; },
		get chameleon() { return chameleonSystem?.model || null; },
		get chameleonPickable() { return chameleonSystem?.pickable || null; },
		dispose() {

			if ( disposed ) return;
			disposed = true;
			loadGeneration ++;
			butterflyLoadGeneration ++;
			chameleonLoadGeneration ++;
			chameleonSurfaceRefreshRequest ++;
			clearTimeout( chameleonSurfaceRefreshTimer );
			chameleonSurfaceRefreshTimer = null;
			settleChameleonSurfaceRefresh( null );
			releaseCapturedButterfly();
			chameleonSystem?.clearSelection?.();
			chameleonSystem?.dispose?.();
			butterflySystem?.dispose?.();
			system?.dispose?.();
			chameleonSystem = null;
			butterflySystem = null;
			system = null;
			chameleonLoadPromise = null;
			chameleonSurfaceRefreshPromise = null;

		},
	};

}
