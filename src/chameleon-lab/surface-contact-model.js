export const WORLD_COLLISION_LAYER = 0x0001;
export const CHAMELEON_COLLISION_LAYER = 0x0002;

export function chameleonCollisionGroups() {

	return ( CHAMELEON_COLLISION_LAYER << 16 )
		| WORLD_COLLISION_LAYER
		| CHAMELEON_COLLISION_LAYER;

}

export function isExternalGripRayHit( timeOfImpact, normal, direction ) {

	if ( ! Number.isFinite( timeOfImpact ) || timeOfImpact <= 1e-4 ) return false;
	if ( ! normal || ! direction ) return false;
	const alignment = normal.x * direction.x
		+ normal.y * direction.y
		+ normal.z * direction.z;
	return Number.isFinite( alignment ) && alignment < -0.05;

}
