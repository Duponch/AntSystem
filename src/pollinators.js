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
export function createPollinators( { scene, props, assets = null, butterflyVat = null } ) {

	let system = assets ? createBees( { scene, props, assets } ) : null;
	let butterflySystem = system && butterflyVat && gfx.butterflies
		? createButterflies( {
			scene,
			vat: butterflyVat,
			getFlowers: () => system?.getFlowerContext() || null,
		} )
		: null;
	let loadPromise = null;
	let butterflyLoadPromise = null;
	let chameleonSystem = null;
	let chameleonLoadPromise = null;
	let surfaceVisible = true;
	let chameleonWasEnabled = !! gfx.chameleonEnabled;

	function ensureLoaded() {

		if ( system ) return Promise.resolve( system );
		if ( ! gfx.pollinators ) return Promise.resolve( null );
		if ( loadPromise ) return loadPromise;

		loadPromise = loadPollinatorAssets()
			.then( ( loadedAssets ) => {

				system = createBees( { scene, props, assets: loadedAssets } );
				system.setSurfaceVisible( surfaceVisible );
				return system;

			} )
			.catch( ( error ) => {

				loadPromise = null;
				gfx.pollinators = false;
				console.error( 'Chargement des pollinisateurs impossible.', error );
				return null;

			} );
		return loadPromise;

	}

	function ensureButterflies() {

		if ( butterflySystem ) return Promise.resolve( butterflySystem );
		if ( ! gfx.pollinators || ! gfx.butterflies ) return Promise.resolve( null );
		if ( butterflyLoadPromise ) return butterflyLoadPromise;

		butterflyLoadPromise = Promise.all( [
			ensureLoaded(),
			butterflyVat ? Promise.resolve( butterflyVat ) : loadButterflyAsset(),
		] )
			.then( ( [ loadedSystem, loadedVat ] ) => {

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
					} );
					butterflySystem.setSurfaceVisible( surfaceVisible );

				}
				return butterflySystem;

			} )
			.catch( ( error ) => {

				butterflyLoadPromise = null;
				gfx.butterflies = false;
				console.error( 'Chargement des papillons impossible.', error );
				return null;

			} );
		return butterflyLoadPromise;

	}

	function ensureChameleon() {

		if ( chameleonSystem ) return Promise.resolve( chameleonSystem );
		if ( ! gfx.chameleonEnabled ) return Promise.resolve( null );
		if ( chameleonLoadPromise ) return chameleonLoadPromise;
		chameleonLoadPromise = createChameleons( {
			scene,
			props,
			getButterflyPredationContext: () => butterflySystem?.getPredationContext() || null,
		} )
			.then( ( loaded ) => {

				chameleonSystem = loaded;
				chameleonSystem.setSurfaceVisible( surfaceVisible );
				return chameleonSystem;

			} )
			.catch( ( error ) => {

				chameleonLoadPromise = null;
				gfx.chameleonEnabled = false;
				console.error( 'Chargement du caméléon impossible.', error );
				return null;

			} );
		return chameleonLoadPromise;

	}

	function releaseCapturedButterfly() {

		const index = chameleonSystem?.getSimulation().getView().capturedIndex ?? - 1;
		if ( index < 0 ) return false;
		return butterflySystem?.getPredationContext().releaseCapture( index ) || false;

	}

	return {
		preload() {

			return Promise.all( [
				ensureLoaded(),
				gfx.butterflies ? ensureButterflies() : Promise.resolve( null ),
				gfx.chameleonEnabled ? ensureChameleon() : Promise.resolve( null ),
			] );

		},
		update( dt, visible = true ) {

			surfaceVisible = visible;
			let telemetry = null;
			if ( system ) telemetry = system.update( dt, visible );
			else if ( gfx.pollinators ) void ensureLoaded();

			if ( butterflySystem ) butterflySystem.update( dt, visible );
			else if ( gfx.pollinators && gfx.butterflies ) void ensureButterflies();

			const chameleonEnabled = !! gfx.chameleonEnabled;
			if ( ! chameleonEnabled && chameleonWasEnabled && chameleonSystem ) {

				releaseCapturedButterfly();
				chameleonSystem.reset();

			}
			chameleonWasEnabled = chameleonEnabled;
			if ( chameleonSystem ) chameleonSystem.update( dt );
			else if ( chameleonEnabled ) void ensureChameleon();
			if ( butterflySystem ) butterflySystem.flushPredationRender();
			return telemetry;

		},
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
		setChameleonEnabled( value ) {

			gfx.chameleonEnabled = !! value;
			chameleonWasEnabled = gfx.chameleonEnabled;
			if ( ! gfx.chameleonEnabled && chameleonSystem ) {

				releaseCapturedButterfly();
				chameleonSystem.reset();
				chameleonSystem.setSurfaceVisible( surfaceVisible );

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
	};

}
