#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const DOC_ROOT = path.join( ROOT, 'doc' );
const MANIFEST = path.join( DOC_ROOT, 'manifest.json' );
const SELF = 'scripts/docs-sync.mjs';

const CONTRACTS = Object.freeze( {
	'COL-ECO': {
		document: 'doc/fonctionnel/colonie.md',
		guides: [
			'doc/guide/colonie.md',
			'doc/guide/cycle-vie-ressources.md',
			'doc/guide/attentes-menaces-limites.md',
		],
		sources: [
			'src/ants.js',
			'src/bees.js',
			'src/butterflies.js',
			'src/chameleons.js',
			'src/main.js',
			'src/pollinators.js',
			'src/config.js',
			'src/colony.js',
			'src/colony-layout.js',
			'src/guide.js',
			'src/guide.css',
			'src/ragdoll.js',
			'src/simulation.js',
			'src/readback.js',
			'src/simulation-clock.js',
			'src/simulation-authority.js',
			'src/ui.js',
			'src/spiders.js',
		],
		tests: [
			'test/colony-layout.test.js',
			'test/readback.test.js',
			'test/simulation-clock.test.js',
			'test/spider-time.test.js',
			'test/spider-kill-election.test.js',
			'test/time-scale-runtime.test.js',
			'test/simulation-authority.test.js',
			'test/time-scale-ecosystem.test.js',
		],
		runtimeTests: [ 'src/tests.js' ],
		evidence: [
			'T2 ponte (reine nourrie)',
			'T3 éclosions → croissance',
			'T5 aller-retour bouche + livraison au grenier',
			'T6 famine sans nourriture',
			'SPIDER-AUTHORITY-002',
			'T9 échantillon araignées',
			'TIME-SCALE-RUNTIME-006',
			'COLONY-TROUGH-001',
			'COLONY-TROUGH-002',
			'COLONY-BROOD-001',
		],
	},
	'TIME-SCALE': {
		document: 'doc/technique/architecture.md',
		guides: [ 'doc/guide/colonie.md' ],
		sources: [
			'src/ants.js',
			'src/bees.js',
			'src/butterflies.js',
			'src/chameleons.js',
			'src/colony.js',
			'src/main.js',
			'src/pollinators.js',
			'src/ragdoll.js',
			'src/readback.js',
			'src/simulation-clock.js',
			'src/simulation.js',
			'src/spiders.js',
			'src/simulation-authority.js',
			'src/ui.js',
		],
		tests: [
			'test/config-timing-session.test.js',
			'test/gpu-dispatch-budget.test.js',
			'test/hybrid-time-policy.test.js',
			'test/readback.test.js',
			'test/simulation-clock.test.js',
			'test/simulation-synchronization.test.js',
			'test/spider-authority-readback.test.js',
			'test/spider-kill-election.test.js',
			'test/simulation-authority.test.js',
			'test/spider-time.test.js',
			'test/time-scale-ecosystem.test.js',
			'test/time-scale-runtime.test.js',
		],
		runtimeTests: [],
		evidence: [
			'HYBRID-TIME-001',
			'HYBRID-TIME-004',
			'HYBRID-TIME-006',
			'HYBRID-TIME-RUNTIME-001',
			'CONFIG-TIMING-001',
			'GPU-DISPATCH-001',
			'GPU-DISPATCH-002',
			'GPU-DISPATCH-003',
			'SIM-SYNC-001',
			'SIM-STATS-001',
			'TIME-SCALE-RUNTIME-005',
			'SPIDER-AUTHORITY-002',
			'SIM-CLOCK-003',
			'SIM-CLOCK-005',
			'SIM-CLOCK-006',
			'SPIDER-TIME-003',
			'TIME-SCALE-ECO-002',
			'TIME-SCALE-RUNTIME-001',
			'TIME-SCALE-RUNTIME-003',
			'TIME-SCALE-RUNTIME-006',
			'awaited requests are served in strict FIFO order',
		],
	},
	'COL-START': {
		document: 'doc/fonctionnel/demarrage-naturel.md',
		guides: [ 'doc/guide/demarrage-naturel.md' ],
		sources: [ 'src/colony-startup.js', 'src/colony.js', 'src/simulation.js' ],
		tests: [ 'test/colony-startup.test.js' ],
		runtimeTests: [ 'src/tests.js' ],
		evidence: [
			'COL-START-001',
			'COL-START-002',
			'COL-START-003',
			'COL-START-004',
			'T1 démarrage naturel',
			'T10 toggle colonie ON→OFF→ON atomique',
		],
	},
	'NAV-SURFACE': {
		document: 'doc/technique/navigation-contact-3d.md',
		guides: [ 'doc/guide/navigation-3d.md' ],
		sources: [
			'src/ants.js',
			'src/colony.js',
			'src/config.js',
			'src/main.js',
			'src/nest-mutation-ui.js',
			'src/navigation/corridor-network.js',
			'src/navigation/corridor-sampling-tsl.js',
			'src/navigation/corridor-surface-parallel.js',
			'src/navigation/corridor-surface-partition.js',
			'src/navigation/corridor-surface.worker.js',
			'src/navigation/nest-mutation-transaction.js',
			'src/navigation/nest-volume-probe.js',
			'src/navigation/support-geometry.js',
			'src/nest.js',
			'src/nestvolume.js',
			'src/pose.js',
			'src/simulation.js',
			'src/ui.js',
			'src/underground.js',
		],
		tests: [
			'test/corridor-network.surface-contact.test.js',
			'test/colony-runtime-oracles.test.js',
			'test/chamber-surface.test.js',
			'test/corridor-network.complexity.test.js',
			'test/corridor-network.continuity.test.js',
			'test/corridor-network.invariants.test.js',
			'test/corridor-network.lane-stretch.test.js',
			'test/corridor-network.regression.test.js',
			'test/corridor-network.routes.test.js',
			'test/corridor-network.sample-boundary.test.js',
			'test/corridor-network.vertical-shaft.test.js',
			'test/corridor-surface-parallel.test.js',
			'test/helpers/corridor-fixtures.js',
			'test/nest-layout-async.integration.test.js',
			'test/nest-mutation-transaction.test.js',
			'test/nest-mutation-ui.test.js',
			'test/nest-volume-probe.test.js',
			'test/warden-verdict.test.js',
			'test/support-geometry.spatial-hash.test.js',
			'test/nest.organic-layout.test.js',
			'test/nest.organic-registry.test.js',
			'test/nest.natural-topology.test.js',
			'test/nest.depth-resolution.test.js',
		],
		runtimeTests: [ 'src/tests.js', 'src/warden.js' ],
		evidence: [
			'NAV-SURFACE-001',
			'NAV-SURFACE-002',
			'NAV-SURFACE-003',
			'NAV-SURFACE-004',
			'NAV-SURFACE-005',
			'NAV-SURFACE-006',
			'NAV-SURFACE-007',
			'NAV-SURFACE-008',
			'NAV-SURFACE-PERF-001',
			'NAV-SURFACE-PAR-001',
			'NAV-SURFACE-PAR-002',
			'NAV-SURFACE-PAR-003',
			'NAV-SURFACE-PAR-004',
			'NAV-NEST-TXN-001',
			'NAV-NEST-TXN-002',
			'NAV-NEST-TXN-003',
			'NAV-NEST-TXN-004',
			'NAV-NEST-PAUSE-001',
			'NAV-NEST-PAUSE-002',
			'NEST-LAYOUT-001',
			'NEST-LAYOUT-002',
			'NEST-LAYOUT-003',
			'NEST-LAYOUT-004',
			'NEST-NATURAL-001',
			'NEST-NATURAL-002',
			'NEST-NATURAL-003',
			'NEST-NATURAL-004',
			'NEST-NATURAL-005',
			'NEST-NATURAL-006',
			'NEST-ORGANIC-001',
			'NEST-ORGANIC-002',
			'NEST-ORGANIC-003',
			'NEST-ORGANIC-004',
			'NEST-ORGANIC-005',
			'NAV-VOLUME-001',
			'NAV-VOLUME-002',
			'NAV-VOLUME-GPU-001',
			'NAV-VOLUME-GPU-002',
			'NAV-VOLUME-GPU-003',
			'NAV-VOLUME-GPU-004',
			'NAV-VOLUME-GPU-005',
			'NAV-VOLUME-GPU-006',
			'NAV-VOLUME-GPU-007',
			'COL-CONFINEMENT-001',
			'COL-CONFINEMENT-002',
			'COL-CONFINEMENT-003',
			'posesNonFinies',
			'pivotsHorsSupport',
			'orientationsHorsRepere',
		],
	},
	'NAV-ENTRANCE': {
		document: 'doc/technique/navigation-contact-3d.md',
		guides: [ 'doc/guide/navigation-3d.md' ],
		sources: [
			'src/environment.js',
			'src/graphics/grass.js',
			'src/navigation/corridor-network.js',
			'src/navigation/entrance-geometry.js',
			'src/nest.js',
			'src/nestvolume.js',
			'src/simulation.js',
		],
		tests: [
			'test/corridor-network.surface-contact.test.js',
			'test/entrance-geometry.test.js',
			'test/warden-verdict.test.js',
		],
		runtimeTests: [ 'src/warden.js' ],
		evidence: [
			'NAV-ENTRANCE-001',
			'NAV-ENTRANCE-002',
			'NAV-ENTRANCE-003',
			'NAV-ENTRANCE-004',
			'NAV-ENTRANCE-005',
			'NAV-ENTRANCE-006',
			'NAV-ENTRANCE-007',
			'NAV-ENTRANCE-008',
			'NAV-ENTRANCE-009',
			'NAV-ENTRANCE-010',
			'NAV-ENTRANCE-RUNTIME-001',
		],
	},
	'BEE-SIM': {
		document: 'doc/technique/pollinisateurs.md',
		guides: [ 'doc/guide/pollinisateurs.md' ],
		sources: [
			'src/bee-simulation.js',
			'src/bees.js',
			'src/config.js',
			'src/graphics/props.js',
			'src/main.js',
			'src/pollinator-assets.js',
			'src/pollinator-layout.js',
			'src/pollinators.js',
			'src/ui.js',
			'src/vat.js',
		],
		tests: [
			'test/bee-simulation.test.js',
			'test/pollinator-integration.test.js',
		],
		runtimeTests: [],
		evidence: [
			'BEE-SIM-001',
			'BEE-SIM-002',
			'BEE-SIM-003',
			'BEE-SIM-004',
			'BEE-SIM-005',
			'BEE-SIM-006',
			'BEE-SIM-007',
			'BEE-SIM-008',
			'BEE-SIM-009',
			'BEE-SIM-010',
			'BEE-SIM-011',
			'BEE-SIM-012',
			'BEE-SIM-013',
			'BEE-SIM-014',
			'BEE-SIM-015',
			'BEE-SIM-016',
			'BEE-SIM-017',
			'POLLINATOR-001',
			'POLLINATOR-002',
			'POLLINATOR-003',
			'POLLINATOR-004',
			'POLLINATOR-005',
			'POLLINATOR-006',
			'POLLINATOR-007',
			'POLLINATOR-008',
			'POLLINATOR-009',
			'POLLINATOR-010',
		],
	},
	'BUTTERFLY-SIM': {
		document: 'doc/technique/papillons.md',
		guides: [ 'doc/guide/papillons.md' ],
		sources: [
			'src/butterfly-simulation.js',
			'src/butterflies.js',
			'src/config.js',
			'src/main.js',
			'src/pollinator-assets.js',
			'src/pollinators.js',
			'src/ui.js',
			'src/vat.js',
		],
		tests: [
			'test/butterfly-simulation.test.js',
			'test/butterfly-integration.test.js',
			'test/butterfly-predator-avoidance.test.js',
		],
		runtimeTests: [],
		evidence: [
			'BUTTERFLY-SIM-001',
			'BUTTERFLY-SIM-002',
			'BUTTERFLY-SIM-003',
			'BUTTERFLY-SIM-004',
			'BUTTERFLY-SIM-005',
			'BUTTERFLY-SIM-006',
			'BUTTERFLY-SIM-007',
			'BUTTERFLY-SIM-008',
			'BUTTERFLY-SIM-009',
			'BUTTERFLY-SIM-010',
			'BUTTERFLY-SIM-011',
			'BUTTERFLY-SIM-012',
			'BUTTERFLY-SIM-013',
			'BUTTERFLY-SIM-014',
			'BUTTERFLY-FEAR-001',
			'BUTTERFLY-FEAR-002',
			'BUTTERFLY-FEAR-003',
			'BUTTERFLY-FEAR-004',
			'BUTTERFLY-FEAR-005',
			'BUTTERFLY-FEAR-006',
		],
	},
	'CHAMELEON-SIM': {
		document: 'doc/technique/cameleons.md',
		guides: [ 'doc/guide/cameleons.md', 'doc/guide/laboratoire-cameleon.md' ],
		sources: [
			'index.html',
			'blender/chameleon_physics_rig.blend',
			'public/assets/ChameleonPhysical.glb',
			'scripts/rebuild-chameleon-hybrid-asset.py',
			'src/app-entry.js',
			'src/bootstrap.js',
			'src/chameleon-lab/environment.js',
			'src/chameleon-lab/grab-controller.js',
			'src/chameleon-lab/hybrid-chameleon.js',
			'src/chameleon-lab/hybrid-controller-model.js',
			'src/chameleon-lab/lab.css',
			'src/chameleon-lab/lab-ui.js',
			'src/chameleon-lab/main.js',
			'src/chameleon-lab/physics-world.js',
			'src/chameleon-lab/surface-contact-model.js',
			'src/chameleon-lab/third-person-controller.js',
			'src/chameleon-simulation.js',
			'src/chameleon-body-contact.js',
			'src/chameleon-procedural-gait.js',
			'src/chameleon-rig.js',
			'src/chameleon-surface-collider.js',
			'src/chameleon-surface-graph.js',
			'src/chameleon-surface-patches.js',
			'src/chameleon-tail-contact.js',
			'src/chameleon-track.js',
			'src/chameleon-assets.js',
			'src/chameleon-camouflage.js',
			'src/chameleons.js',
			'src/butterfly-simulation.js',
			'src/butterflies.js',
			'src/config.js',
			'src/pollinators.js',
			'src/ui.js',
			'src/wildlife-inspector.js',
		],
		tests: [
			'test/chameleon-lab-active-ragdoll.test.js',
			'test/chameleon-lab-controller.test.js',
			'test/chameleon-lab-physics-world.test.js',
			'test/chameleon-lab-route.test.js',
			'test/chameleon-physical-asset.test.js',
			'test/chameleon-simulation.test.js',
			'test/chameleon-track.test.js',
			'test/chameleon-integration.test.js',
			'test/chameleon-predation.test.js',
			'test/chameleon-final-integration.test.js',
			'test/chameleon-facing.test.js',
			'test/chameleon-surface-graph.test.js',
			'test/chameleon-surface-collider.test.js',
			'test/chameleon-surface-patches.test.js',
			'test/chameleon-procedural-gait.test.js',
			'test/chameleon-rig.test.js',
			'test/chameleon-body-tail-contact.test.js',
			'test/chameleon-physical-locomotion.test.js',
			'test/chameleon-camouflage.test.js',
			'test/wildlife-inspector.test.js',
		],
		runtimeTests: [],
		evidence: [
			'CHAMELEON-LAB-RAGDOLL-001',
			'CHAMELEON-LAB-RAGDOLL-002',
			'CHAMELEON-LAB-RAGDOLL-003',
			'CHAMELEON-LAB-RAGDOLL-004',
			'CHAMELEON-LAB-RAGDOLL-005',
			'CHAMELEON-LAB-RAGDOLL-006',
			'CHAMELEON-LAB-RAGDOLL-007',
			'CHAMELEON-LAB-CONTROLLER-001',
			'CHAMELEON-LAB-CONTROLLER-002',
			'CHAMELEON-LAB-CONTROLLER-003',
			'CHAMELEON-LAB-CONTROLLER-004',
			'CHAMELEON-LAB-CONTROLLER-005',
			'CHAMELEON-LAB-CONTROLLER-006',
			'CHAMELEON-LAB-CONTROLLER-007',
			'CHAMELEON-LAB-CONTROLLER-008',
			'CHAMELEON-LAB-PHYSICS-001',
			'CHAMELEON-LAB-PHYSICS-002',
			'CHAMELEON-LAB-PHYSICS-003',
			'CHAMELEON-LAB-PHYSICS-004',
			'CHAMELEON-LAB-PHYSICS-005',
			'CHAMELEON-LAB-PHYSICS-006',
			'CHAMELEON-LAB-ROUTE-001',
			'CHAMELEON-LAB-ROUTE-002',
			'CHAMELEON-LAB-ROUTE-003',
			'CHAMELEON-LAB-ROUTE-004',
			'CHAMELEON-PHYSICAL-ASSET-001',
			'CHAMELEON-PHYSICAL-ASSET-002',
			'CHAMELEON-SIM-001',
			'CHAMELEON-SIM-002',
			'CHAMELEON-SIM-003',
			'CHAMELEON-SIM-004',
			'CHAMELEON-SIM-005',
			'CHAMELEON-SIM-006',
			'CHAMELEON-SIM-007',
			'CHAMELEON-SIM-008',
			'CHAMELEON-SIM-009',
			'CHAMELEON-SIM-010',
			'CHAMELEON-SIM-011',
			'CHAMELEON-SIM-012',
			'CHAMELEON-SIM-013',
			'CHAMELEON-SIM-014',
			'CHAMELEON-SIM-015',
			'CHAMELEON-SIM-016',
			'CHAMELEON-SIM-017',
			'CHAMELEON-SIM-018',
			'CHAMELEON-SIM-019',
			'CHAMELEON-SIM-020',
			'CHAMELEON-SIM-021',
			'CHAMELEON-SIM-022',
			'CHAMELEON-SIM-023',
			'CHAMELEON-SIM-024',
			'CHAMELEON-SIM-025',
			'CHAMELEON-SIM-026',
			'CHAMELEON-SIM-027',
			'CHAMELEON-SIM-028',
			'CHAMELEON-SIM-029',
			'CHAMELEON-SIM-030',
			'CHAMELEON-SIM-031',
			'CHAMELEON-SIM-032',
			'CHAMELEON-SIM-033',
			'CHAMELEON-SIM-034',
			'CHAMELEON-SIM-035',
			'CHAMELEON-SIM-036',
			'CHAMELEON-SIM-037',
			'CHAMELEON-SURFACE-001',
			'CHAMELEON-SURFACE-002',
			'CHAMELEON-SURFACE-003',
			'CHAMELEON-SURFACE-004',
			'CHAMELEON-SURFACE-004B',
			'CHAMELEON-SURFACE-005',
			'CHAMELEON-SURFACE-005B',
			'CHAMELEON-SURFACE-006',
			'CHAMELEON-SURFACE-007',
			'CHAMELEON-SURFACE-008',
			'CHAMELEON-SURFACE-009',
			'CHAMELEON-SURFACE-010',
			'CHAMELEON-SURFACE-011',
			'CHAMELEON-SURFACE-012',
			'CHAMELEON-COLLIDER-001',
			'CHAMELEON-COLLIDER-002',
			'CHAMELEON-COLLIDER-003',
			'CHAMELEON-COLLIDER-004',
			'CHAMELEON-COLLIDER-004B',
			'CHAMELEON-COLLIDER-005',
			'CHAMELEON-COLLIDER-006',
			'CHAMELEON-COLLIDER-007',
			'CHAMELEON-COLLIDER-008',
			'CHAMELEON-COLLIDER-009',
			'CHAMELEON-COLLIDER-010',
			'CHAMELEON-COLLIDER-011',
			'CHAMELEON-COLLIDER-012',
			'CHAMELEON-GAIT-001',
			'CHAMELEON-GAIT-002',
			'CHAMELEON-GAIT-003',
			'CHAMELEON-GAIT-004',
			'CHAMELEON-GAIT-005',
			'CHAMELEON-GAIT-006',
			'CHAMELEON-GAIT-007',
			'CHAMELEON-RIG-001',
			'CHAMELEON-RIG-002',
			'CHAMELEON-RIG-003',
			'CHAMELEON-RIG-004',
			'CHAMELEON-RIG-005',
			'CHAMELEON-RIG-006',
			'CHAMELEON-RIG-007',
			'CHAMELEON-RIG-008',
			'CHAMELEON-RIG-009',
			'CHAMELEON-RIG-010',
			'CHAMELEON-RIG-011',
			'CHAMELEON-RIG-012',
			'CHAMELEON-RIG-013',
			'CHAMELEON-RIG-014',
			'CHAMELEON-RIG-015',
			'CHAMELEON-RIG-016',
			'CHAMELEON-RIG-017',
			'CHAMELEON-RIG-018',
			'CHAMELEON-BODY-CONTACT-001',
			'CHAMELEON-BODY-CONTACT-002',
			'CHAMELEON-BODY-CONTACT-003',
			'CHAMELEON-BODY-CONTACT-004',
			'CHAMELEON-BODY-CONTACT-005',
			'CHAMELEON-BODY-CONTACT-006',
			'CHAMELEON-BODY-CONTACT-007',
			'CHAMELEON-BODY-CONTACT-008',
			'CHAMELEON-BODY-CONTACT-009',
			'CHAMELEON-TAIL-CONTACT-001',
			'CHAMELEON-TAIL-CONTACT-002',
			'CHAMELEON-TAIL-CONTACT-003',
			'CHAMELEON-TAIL-CONTACT-004',
			'CHAMELEON-TAIL-CONTACT-005',
			'CHAMELEON-TAIL-CONTACT-006',
			'CHAMELEON-PHYSICS-000A',
			'CHAMELEON-PHYSICS-000B',
			'CHAMELEON-PHYSICS-000C',
			'CHAMELEON-PHYSICS-000D',
			'CHAMELEON-PHYSICS-000E',
			'CHAMELEON-PHYSICS-001',
			'CHAMELEON-PHYSICS-002',
			'CHAMELEON-PHYSICS-003',
			'WILDLIFE-INSPECTOR-001',
			'WILDLIFE-INSPECTOR-002',
			'WILDLIFE-INSPECTOR-003',
		],
	},
	'UNDERGROUND-VISUAL': {
		document: 'doc/technique/rendu-souterrain-stylise.md',
		guides: [ 'doc/guide/vue-souterraine.md' ],
		sources: [
			'src/config.js',
			'src/environment.js',
			'src/main.js',
			'src/ants.js',
			'src/underground.js',
			'src/underground-assets.js',
			'src/underground-visual.js',
			'src/ui.js',
		],
		tests: [
			'test/underground-visual.test.js',
			'test/underground-geology-v2.test.js',
			'test/underground-transition-source.test.js',
		],
		runtimeTests: [],
		evidence: [
			'UNDERGROUND-VISUAL-001',
			'UNDERGROUND-VISUAL-002',
			'UNDERGROUND-VISUAL-003',
			'UNDERGROUND-VISUAL-004',
			'UNDERGROUND-VISUAL-005',
			'UNDERGROUND-VISUAL-006',
			'UNDERGROUND-VISUAL-008',
			'UNDERGROUND-VISUAL-009',
			'UNDERGROUND-VISUAL-010',
			'UNDERGROUND-VISUAL-011',
			'UNDERGROUND-VISUAL-PERF-001',
		],
	},
	OBS: {
		document: 'doc/fonctionnel/intentions-et-arrets.md',
		guides: [ 'doc/guide/inspecteur.md', 'doc/guide/attentes-menaces-limites.md' ],
		sources: [ 'src/ant-observer.js', 'src/antfollow.js' ],
		tests: [ 'test/ant-observer.intent.test.js', 'test/ant-observer.motion.test.js' ],
		runtimeTests: [],
		evidence: [ 'OBS-START-001', 'OBS-PAUSE-001', 'OBS-DIST-001' ],
	},
} );

const REQUIRED_GUIDES = Object.freeze( [
	{ path: 'doc/guide/colonie.md', order: 10 },
	{ path: 'doc/guide/demarrage-naturel.md', order: 20 },
	{ path: 'doc/guide/cycle-vie-ressources.md', order: 30 },
	{ path: 'doc/guide/attentes-menaces-limites.md', order: 40 },
	{ path: 'doc/guide/navigation-3d.md', order: 50 },
	{ path: 'doc/guide/vue-souterraine.md', order: 55 },
	{ path: 'doc/guide/pollinisateurs.md', order: 58 },
	{ path: 'doc/guide/papillons.md', order: 59 },
	{ path: 'doc/guide/inspecteur.md', order: 60 },
	{ path: 'doc/guide/cameleons.md', order: 61 },
	{ path: 'doc/guide/laboratoire-cameleon.md', order: 62 },
] );

const REQUIRED_DOCS = Object.freeze( [
	'doc/index.md',
	'doc/fonctionnel/colonie.md',
	'doc/fonctionnel/demarrage-naturel.md',
	'doc/fonctionnel/intentions-et-arrets.md',
	'doc/technique/architecture.md',
	'doc/technique/navigation-contact-3d.md',
	'doc/technique/performance.md',
	'doc/technique/papillons.md',
	'doc/technique/cameleons.md',
	'doc/technique/laboratoire-cameleon-physique.md',
	'doc/technique/pollinisateurs.md',
	'doc/technique/rendu-souterrain-stylise.md',
	'doc/qualite/strategie-tests.md',
	'doc/qualite/matrice-contrats.md',
	... REQUIRED_GUIDES.map( ( guide ) => guide.path ),
] );

const REQUIRED_SCRIPTS = Object.freeze( {
	'docs:sync': 'node scripts/docs-sync.mjs --write',
	'docs:check': 'node scripts/docs-sync.mjs --check',
	check: 'npm run docs:check && npm test && npm run build',
} );

const full = ( relative ) => path.join( ROOT, ... relative.split( '/' ) );
const posix = ( value ) => value.split( path.sep ).join( '/' );
const normalize = ( value ) => value.replace( /^\uFEFF/, '' ).replace( /\r\n?/g, '\n' );
const read = ( relative ) => normalize( readFileSync( full( relative ), 'utf8' ) );
const BINARY_EXTENSIONS = new Set( [ '.blend', '.glb' ] );
const digest = ( relative ) => {

	const content = BINARY_EXTENSIONS.has( path.extname( relative ).toLowerCase() )
		? readFileSync( full( relative ) )
		: read( relative );
	return `sha256:${ createHash( 'sha256' ).update( content ).digest( 'hex' ) }`;

};
const contractTestFiles = ( contract ) => [
	... contract.tests,
	... ( contract.runtimeTests ?? [] ),
];

function frontMatter( relative ) {

	const match = read( relative ).match( /^---\n([\s\S]*?)\n---(?:\n|$)/ );
	if ( ! match ) return null;
	const metadata = {};
	for ( const line of match[ 1 ].split( '\n' ) ) {

		const separator = line.indexOf( ':' );
		if ( separator < 1 ) continue;
		metadata[ line.slice( 0, separator ).trim() ] = line.slice( separator + 1 ).trim();

	}
	return metadata;

}

function markdownFiles( directory ) {

	const files = [];
	for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {

		const candidate = path.join( directory, entry.name );
		if ( entry.isDirectory() ) files.push( ... markdownFiles( candidate ) );
		else if ( entry.isFile() && entry.name.endsWith( '.md' ) )
			files.push( posix( path.relative( ROOT, candidate ) ) );

	}
	return files.sort();

}

function validateLinks( files, errors ) {

	const pattern = /!?\[[^\]]*]\(([^)]+)\)/g;
	for ( const relative of files ) {

		let match;
		const text = read( relative );
		while ( ( match = pattern.exec( text ) ) ) {

			let target = match[ 1 ].trim();
			if ( target.startsWith( '<' ) && target.endsWith( '>' ) ) target = target.slice( 1, - 1 );
			target = target.split( /\s+["']/ )[ 0 ];
			if ( /^(?:[a-z]+:|#)/i.test( target ) ) continue;
			const clean = target.split( '#' )[ 0 ].split( '?' )[ 0 ];
			if ( ! clean ) continue;

			let decoded;
			try { decoded = decodeURIComponent( clean ); }
			catch { errors.push( `${ relative }: lien non décodable « ${ target } »` ); continue; }

			const destination = path.resolve( path.dirname( full( relative ) ), decoded );
			const inside = destination === ROOT || destination.startsWith( `${ ROOT }${ path.sep }` );
			if ( ! inside || ( destination !== MANIFEST && ! existsSync( destination ) ) )
				errors.push( `${ relative }: cible locale absente « ${ target } »` );

		}

	}

}

function validate() {

	const errors = [];
	for ( const relative of REQUIRED_DOCS )
		if ( ! existsSync( full( relative ) ) ) errors.push( `document requis absent « ${ relative } »` );
	if ( errors.length ) return { errors, files: [] };

	const guideOrders = new Map();
	for ( const guide of REQUIRED_GUIDES ) {

		const metadata = frontMatter( guide.path );
		if ( ! metadata ) {

			errors.push( `${ guide.path }: frontmatter requis absent` );
			continue;

		}
		if ( ! metadata.title ) errors.push( `${ guide.path }: champ title absent` );
		if ( ! metadata.summary ) errors.push( `${ guide.path }: champ summary absent` );
		const order = Number( metadata.order );
		if ( order !== guide.order )
			errors.push( `${ guide.path }: ordre ${ metadata.order ?? 'absent' }, attendu ${ guide.order }` );
		if ( guideOrders.has( order ) )
			errors.push( `${ guide.path }: ordre dupliqué avec ${ guideOrders.get( order ) }` );
		else guideOrders.set( order, guide.path );

		const references = ( metadata.contracts ?? '' )
			.split( ',' ).map( ( value ) => value.trim() ).filter( Boolean );
		if ( references.length === 0 ) errors.push( `${ guide.path }: champ contracts absent` );
		for ( const reference of references )
			if ( ! Object.hasOwn( CONTRACTS, reference ) )
				errors.push( `${ guide.path }: contrat inconnu « ${ reference } »` );

	}

	for ( const [ id, contract ] of Object.entries( CONTRACTS ) ) {

		const heading = new RegExp( `^#{1,6}\\s+${ id }(?:\\s|$)`, 'm' );
		if ( ! heading.test( read( contract.document ) ) )
			errors.push( `${ contract.document }: titre canonique ${ id } absent` );
		for ( const guide of contract.guides ) {

			const references = ( frontMatter( guide )?.contracts ?? '' )
				.split( ',' ).map( ( value ) => value.trim() );
			if ( ! references.includes( id ) )
				errors.push( `${ guide }: référence au contrat ${ id } absente du frontmatter` );

		}

		const watched = [ ... contract.sources, ... contractTestFiles( contract ) ];
		for ( const relative of watched )
			if ( ! existsSync( full( relative ) ) ) errors.push( `${ id }: fichier absent « ${ relative } »` );
		if ( watched.some( ( relative ) => ! existsSync( full( relative ) ) ) ) continue;

		const corpus = contractTestFiles( contract ).map( read ).join( '\n' );
		for ( const evidence of contract.evidence )
			if ( ! corpus.includes( evidence ) ) errors.push( `${ id }: preuve ${ evidence } absente` );

	}

	const ownedSources = new Set( Object.values( CONTRACTS ).flatMap( ( contract ) => contract.sources ) );
	const navigationSources = readdirSync( full( 'src/navigation' ), { withFileTypes: true } )
		.filter( ( entry ) => entry.isFile() && entry.name.endsWith( '.js' ) )
		.map( ( entry ) => `src/navigation/${ entry.name }` );
	const simulationSources = [
		'src/bee-simulation.js',
		'src/chameleon-simulation.js',
		'src/chameleon-surface-graph.js',
		'src/chameleon-track.js',
		'src/chameleon-assets.js',
		'src/chameleons.js',
		'src/bees.js',
		'src/butterfly-simulation.js',
		'src/butterflies.js',
		'src/config.js',
		'src/colony.js',
		'src/colony-layout.js',
		'src/colony-startup.js',
		'src/environment.js',
		'src/main.js',
		'src/nest-mutation-ui.js',
		'src/nest.js',
		'src/nestvolume.js',
		'src/pose.js',
		'src/pollinator-assets.js',
		'src/pollinator-layout.js',
		'src/simulation.js',
		'src/spiders.js',
		'src/ui.js',
		... navigationSources,
	];
	for ( const relative of simulationSources )
		if ( ! ownedSources.has( relative ) )
			errors.push( `source de simulation sans contrat documentaire « ${ relative } »` );

	const packageJson = JSON.parse( read( 'package.json' ) );
	for ( const [ name, command ] of Object.entries( REQUIRED_SCRIPTS ) )
		if ( packageJson.scripts?.[ name ] !== command )
			errors.push( `package.json: script « ${ name } » invalide` );

	const files = markdownFiles( DOC_ROOT );
	validateLinks( files, errors );
	return { errors, files };

}

function makeManifest( files ) {

	const documents = Object.fromEntries( files.map( ( relative ) => [ relative, digest( relative ) ] ) );
	const watchedFiles = [ ... new Set( Object.values( CONTRACTS ).flatMap(
		( contract ) => [ ... contract.sources, ... contractTestFiles( contract ) ],
	) ) ].sort();
	const watched = Object.fromEntries( watchedFiles.map( ( relative ) => [ relative, digest( relative ) ] ) );

	return {
		schemaVersion: 2,
		algorithm: 'sha256',
		generator: { path: SELF, hash: digest( SELF ) },
		contracts: CONTRACTS,
		hashes: { documents, watched },
	};

}

function fail( messages ) {

	for ( const message of messages ) console.error( `docs-sync: ${ message }` );
	process.exitCode = 1;

}

const mode = process.argv[ 2 ] ?? '--write';
if ( mode !== '--write' && mode !== '--check' ) {

	fail( [ `option inconnue « ${ mode } » ; utiliser --write ou --check` ] );

} else {

	const { errors, files } = validate();
	if ( errors.length ) fail( errors );
	else {

		const expected = `${ JSON.stringify( makeManifest( files ), null, 2 ) }\n`;
		if ( mode === '--write' ) {

			writeFileSync( MANIFEST, expected, 'utf8' );
			console.log( `docs-sync: manifeste mis à jour (${ files.length } documents).` );

		} else if ( ! existsSync( MANIFEST ) ) {

			fail( [ 'doc/manifest.json absent ; relire les contrats puis lancer npm run docs:sync' ] );

		} else if ( readFileSync( MANIFEST, 'utf8' ).replace( /\r\n?/g, '\n' ) !== expected ) {

			fail( [
				'dérive détectée dans la documentation ou un contrat surveillé.',
				'Relire les changements, mettre la documentation à jour, puis lancer npm run docs:sync.',
			] );

		} else console.log( `docs-sync: manifeste valide (${ files.length } documents).` );

	}

}
