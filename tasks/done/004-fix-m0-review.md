# M0.4 Fix review findings
1) scripts/check-env.ts: parseRequiredNames must ignore blank lines and lines starting with '#', and lines without '='; add vitest cases for a comment line and a line without '='.
2) tsx/esbuild fail on this machine: "@esbuild/darwin-arm64 could not be found". The machine is arm64 but the shell may run x64 node; run `arch -arm64 pnpm install` (reinstall node_modules with `rm -rf node_modules` first) so esbuild's arm64 binary is installed. Do not change package versions unless needed.
3) Add a root script "check-env": "tsx scripts/check-env.ts".
Touch only: scripts/check-env.ts, its test, package.json.
VERIFY: arch -arm64 pnpm install --frozen-lockfile && pnpm test && out=$(arch -arm64 pnpm run check-env 2>&1; true) && echo "$out" | grep -q SUPABASE_URL && ! echo "$out" | grep -qi 'esbuild'
