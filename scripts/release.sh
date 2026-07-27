#!/usr/bin/env bash
# Release ritual (floating-major-tag mechanism): test → bump+tag vX.Y.Z →
# force-move v1 → push. Consumers (npm git-dep + GitHub Action) follow v1 and
# pick the release up without edits — the accepted supply-chain trade-off.
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${1:?usage: release.sh patch|minor|major}"
[ -z "$(git status --porcelain)" ] || { echo "X dirty working tree — commit or stash first" >&2; exit 1; }

npm run typecheck
npm test
npm version "$BUMP"
git tag -f v1
git push
git push --tags --force

node scripts/consumers-check.mjs || true
echo "Consumers re-resolve v1 on their next npm install; workflows pick it up immediately."
