import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

const docsUiCandidates = [
	path.resolve(webRoot, '../../../node_modules/@beskid/docs-ui/src'),
	path.resolve(webRoot, '../../../node_modules/@cyber-nomad-collective/docs-ui/src'),
	path.resolve(webRoot, '../../node_modules/@beskid/docs-ui/src'),
	path.resolve(webRoot, '../../node_modules/@cyber-nomad-collective/docs-ui/src'),
];

const webStylesCandidates = [
	path.resolve(webRoot, '../../../packages/beskid-web-styles/src'),
	path.resolve(webRoot, '../../packages/beskid-web-styles/src'),
];

export function resolveDocsUi() {
	const src = docsUiCandidates.find((candidate) =>
		fs.existsSync(path.join(candidate, 'styles/theme.material.css')),
	);
	const webStyles = webStylesCandidates.find((candidate) =>
		fs.existsSync(path.join(candidate, 'tokens.css')),
	);
	const stubs = path.resolve(webRoot, 'src/stubs');
	const themeCss = webStyles
		? path.join(webStyles, 'tokens.css')
		: src
			? path.join(src, 'styles/theme.material.css')
			: path.join(webRoot, 'src/styles/beskid-fallback-theme.css');
	return {
		src,
		webStyles,
		aliases: {
			...(src ? { '@beskid/docs-ui': src } : {}),
			...(webStyles ? { '@beskid/web-styles': webStyles } : {}),
			'#beskid-hub-entry': src
				? path.join(src, 'client/beskid-hub-entry.ts')
				: path.join(stubs, 'beskid-hub-entry-stub.ts'),
			'#beskid-theme-css': themeCss,
			'#beskid-hub-css': webStyles
				? path.join(webStyles, 'hub.css')
				: src
					? path.join(src, 'styles/hub.css')
					: path.join(stubs, 'beskid-hub-stub.css'),
		},
	};
}
