import {
	APP_ENTRY_CHAMELEON_LAB,
	selectAppEntry,
} from './app-entry.js';

const entry = selectAppEntry( window.location.search );

if ( entry === APP_ENTRY_CHAMELEON_LAB ) {

	await import( './chameleon-lab/main.js' );

} else {

	await import( './main.js' );

}
