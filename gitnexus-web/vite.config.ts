import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { createRequire } from 'module';

import { resolveDocsUi } from './vite.resolve-docs-ui';

const _require = createRequire(import.meta.url);
const gitnexusPkg = _require('../gitnexus/package.json');
const docsUi = resolveDocsUi();

export default defineConfig({
	plugins: [react(), tailwindcss()],
	define: {
		__REQUIRED_NODE_VERSION__: JSON.stringify(gitnexusPkg.engines.node.replace(/[>=^~\s]/g, '')),
		'import.meta.env.VITE_NEXUS_DEFAULT_REPO': JSON.stringify(
			process.env.VITE_NEXUS_DEFAULT_REPO || 'compiler',
		),
	},
	resolve: {
		dedupe: ['react', 'react-dom'],
		alias: {
			'@': path.resolve(__dirname, './src'),
			...docsUi.aliases,
			'gitnexus-shared': path.resolve(__dirname, '../gitnexus-shared/src/index.ts'),
			'@anthropic-ai/sdk/lib/transform-json-schema': path.resolve(
				__dirname,
				'node_modules/@anthropic-ai/sdk/lib/transform-json-schema.mjs',
			),
			mermaid: path.resolve(__dirname, 'node_modules/mermaid/dist/mermaid.esm.min.mjs'),
		},
	},
	server: {
		fs: { allow: ['..'] },
		proxy: {
			'/api': {
				target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8452',
				changeOrigin: true,
			},
		},
	},
});
