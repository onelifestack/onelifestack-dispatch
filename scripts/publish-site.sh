#!/usr/bin/env bash
# Builds the web app, the CLI and the site, and publishes site/dist to the public GitHub Pages repo
# og-crafts/dispatch-site (main branch). The web app ends up under /app/.
# NOT run automatically: the owner creates the repo and approves the first publish (see site/README.md).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"
{ [ -d node_modules ] || npm ci --silent; }
npm run build --silent        # web app in dist/ (relative base, so it works under /app/)
npm run build:cli --silent    # dist-cli/dispatch-run.mjs, offered on /cli/
python3 site/build.py --strict   # copies dist/ to site/dist/app/ and runs every check
work=site/.publish
if [ ! -d "$work/.git" ]; then git clone -q https://github.com/og-crafts/dispatch-site.git "$work"; fi
git -C "$work" pull -q --ff-only || true
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a site/dist/. "$work"/
cd "$work"
git add -A
if git diff --cached --quiet; then echo "site already up to date"; exit 0; fi
git -c user.name="Omprakash Gautam" -c user.email="356532942+og-crafterr@users.noreply.github.com" \
  commit -q -m "Publish site from dispatch $(git -C ../.. rev-parse --short HEAD)"
git push -q origin HEAD:main
echo "published"
