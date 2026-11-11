#!/bin/sh
# Put pnpm on PATH through corepack, at the packageManager version in package.json, before any pnpm call.
# `corepack install -g` also makes that version corepack's default, so pnpm run outside the repo (temp
# workspaces in tests have no packageManager) gets the same version instead of the latest release.
# Later calls, including those inside scripts and tests, then need no registry request.
# A registry error such as HTTP 503 gets retried with backoff instead of failing the job.
set -u
corepack enable
pm=$(node -p 'require("./package.json").packageManager')
for wait in 10 20 40 80 last; do
  corepack install -g "$pm" && break
  [ "$wait" = last ] && exit 1
  echo "corepack install failed; retrying in ${wait}s" >&2
  sleep "$wait"
done
echo "pnpm $(pnpm --version) in the repo, $(cd / && pnpm --version) outside it"
