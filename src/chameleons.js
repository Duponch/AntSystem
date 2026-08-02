import { createChameleonPhysicalSystem } from './chameleon-physical-system.js';

/**
 * Compatibility facade kept for the pollinator coordinator.
 *
 * The former production-specific kinematic body, raycast probes, synthetic
 * support track and duplicate camouflage renderer have deliberately been
 * removed. The laboratory-proven hybrid body now owns locomotion, contacts,
 * rig, tail, route following and surface camouflage in the real scene.
 */
export async function createChameleons( options ) {

	return createChameleonPhysicalSystem( options );

}

export { createChameleonPhysicalSystem };
