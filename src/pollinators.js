import { gfx } from './config.js';
import { createBees } from './bees.js';
import { loadPollinatorAssets } from './pollinator-assets.js';

/**
 * Stable facade around an optional pollinator renderer.
 *
 * Persisting "Activer" to false skips every GLB request and the VAT bake at
 * startup. Re-enabling starts one shared asynchronous load; UI callbacks remain
 * valid before, during and after that load.
 */
export function createPollinators( { scene, props, assets = null } ) {

	let system = assets ? createBees( { scene, props, assets } ) : null;
	let loadPromise = null;
	let surfaceVisible = true;

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

	return {
		preload: ensureLoaded,
		update( dt, visible = true ) {

			surfaceVisible = visible;
			if ( system ) return system.update( dt, visible );
			if ( gfx.pollinators ) void ensureLoaded();
			return null;

		},
		reset() {

			if ( system ) return system.reset();
			return gfx.pollinators
				? ensureLoaded().then( ( loaded ) => loaded?.reset() )
				: null;

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
		getSimulation: () => system?.getSimulation() || null,
		getTelemetry: () => system?.getTelemetry() || null,
		getFlowerContext: () => system?.getFlowerContext() || null,
		get group() { return system?.group || null; },
		get flowerMesh() { return system?.flowerMesh || null; },
		get beeMesh() { return system?.beeMesh || null; },
		get hive() { return system?.hive || null; },
	};

}