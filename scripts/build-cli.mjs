// Bundles the CLI into one file: dist-cli/dispatch-run.mjs
import { build } from 'esbuild'
import { chmodSync } from 'node:fs'

await build({
  entryPoints: ['src/cli/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist-cli/dispatch-run.mjs',
  // Some dependencies (yaml) are CommonJS and call require(); give the ES module bundle one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
})
chmodSync('dist-cli/dispatch-run.mjs', 0o755)
