import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

const docsUiCandidates = [
	path.resolve(webRoot, '../../../packages/beskid-docs-ui/src'),
	path.resolve(webRoot, '../../packages/beskid-docs-ui/src'),
];

export function resolveDocsUi() {
	const src = docsUiCandidates.find((candidate) =>
		fs.existsSync(path.join(candidate, 'styles/theme.material.css')),
	);
	const stubs = path.resolve(webRoot, 'src/stubs');
	return {
		src,
		aliases: {
			...(src ? { '@beskid/docs-ui': src } : {}),
			'#beskid-hub-entry': src
				? path.join(src, 'client/beskid-hub-entry.ts')
				: path.join(stubs, 'beskid-hub-entry-stub.ts'),
			'#beskid-theme-css': src
				? path.join(src, 'styles/theme.material.css')
				: path.join(webRoot, 'src/styles/beskid-fallback-theme.css'),
			'#beskid-hub-css': src ? path.join(src, 'styles/hub.css') : path.join(stubs, 'beskid-hub-stub.css'),
		},
	};
}
