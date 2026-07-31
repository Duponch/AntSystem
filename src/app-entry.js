export const APP_ENTRY_MAIN = 'main';
export const APP_ENTRY_CHAMELEON_LAB = 'chameleon-lab';

export function selectAppEntry( search = '' ) {

	const params = new URLSearchParams( search );
	if ( ! params.has( 'test' ) ) return APP_ENTRY_MAIN;
	const test = params.get( 'test' );
	return test === '' || test === 'chameleon'
		? APP_ENTRY_CHAMELEON_LAB
		: APP_ENTRY_MAIN;

}
