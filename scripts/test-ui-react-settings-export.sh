#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="${root}/gitnexus-web/node_modules/@beskid/ui-react"
settings_entry="${package_root}/src/components/settings/index.ts"

if [[ ! -f "${settings_entry}" ]]; then
	printf 'Missing public @beskid/ui-react/settings implementation: %s\n' "${settings_entry}" >&2
	exit 1
fi

if ! node -e '
const fs = require("node:fs");
const packageJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (packageJson.exports?.["./settings"] !== "./src/components/settings/index.ts") process.exit(1);
' "${package_root}/package.json"; then
	printf 'Installed @beskid/ui-react package does not expose ./settings.\n' >&2
	exit 1
fi
