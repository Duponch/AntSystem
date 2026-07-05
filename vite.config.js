import { defineConfig } from 'vite';

export default defineConfig( {
	build: {
		target: 'esnext', // three/webgpu utilise le top-level await
	},
} );
