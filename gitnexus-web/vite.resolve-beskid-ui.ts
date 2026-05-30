import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function tryResolvePackageRoot(specifier: string): string | null {
	const segments = specifier.split('/');
	const candidate = path.join(webRoot, 'node_modules', ...segments);
	if (fs.existsSync(path.join(candidate, 'package.json'))) {
		return candidate;
	}
	try {
		const entry = require.resolve(specifier);
		let dir = path.dirname(entry);
		while (dir !== path.dirname(dir)) {
			if (fs.existsSync(path.join(dir, 'package.json'))) {
				return dir;
			}
			dir = path.dirname(dir);
		}
	} catch {
		// not resolvable
	}
	return null;
}

export function resolveBeskidUi() {
	const uiRoot = tryResolvePackageRoot('@beskid/beskid-ui');
	const src = uiRoot ? path.join(uiRoot, 'src') : null;
	const stubs = path.resolve(webRoot, 'src/stubs');
	const themeCss = src
		? path.join(src, 'styles/theme.material.css')
		: path.join(webRoot, 'src/styles/beskid-fallback-theme.css');

	return {
		src,
		aliases: {
			...(src ? { '@beskid/beskid-ui': src } : {}),
			'#beskid-hub-entry': src
				? path.join(src, 'client/beskid-hub-entry.ts')
				: path.join(stubs, 'beskid-hub-entry-stub.ts'),
			'#beskid-theme-css': themeCss,
			'#beskid-hub-css': src
				? path.join(src, 'styles/hub.css')
				: path.join(stubs, 'beskid-hub-stub.css'),
		},
	};
}

export function resolveUiReactSrc(): string | null {
	const root = tryResolvePackageRoot('@beskid/ui-react');
	return root ? path.join(root, 'src') : null;
}

/** Tracker-style shadcn aliases into installed @beskid/ui-react/src. */
export function resolveUiReactAliases(): Record<string, string> {
	const src = resolveUiReactSrc();
	if (!src) return {};
	return {
		'#/components/ui': path.join(src, 'components/ui'),
		'#/lib/utils.ts': path.join(src, 'lib/utils.ts'),
		'#/lib/utils': path.join(src, 'lib/utils.ts'),
		'#/hooks/use-mobile.ts': path.join(src, 'hooks/use-mobile.ts'),
	};
}

export function resolveBeskidUiSrc(): string | null {
	const root = tryResolvePackageRoot('@beskid/beskid-ui');
	return root ? path.join(root, 'src') : null;
}

/** Fail fast when a declared dependency is missing from node_modules. */
export function assertBeskidPackagesInstalled(): void {
	for (const pkg of ['@beskid/beskid-ui', '@beskid/ui-react'] as const) {
		if (!tryResolvePackageRoot(pkg)) {
			throw new Error(
				`${pkg} is not installed. Run bun install (GitHub Packages: set NODE_AUTH_TOKEN).`,
			);
		}
	}
}
