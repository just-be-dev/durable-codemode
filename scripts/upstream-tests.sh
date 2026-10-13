#!/bin/sh
# Run upstream @opencode/codemode's own test suite against the patched copy in vendor/codemode.
#   sh scripts/upstream-tests.sh [path/to/opencode/packages/codemode]
set -e
upstream="${1:-../opencode/packages/codemode}"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cp -R vendor/codemode "$dir/src"
cp -R "$upstream/test" "$dir/test"
ln -s "$PWD/node_modules" "$dir/node_modules"
cd "$dir" && bun test
