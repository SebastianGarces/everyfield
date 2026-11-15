#!/bin/sh
# Put pnpm on PATH through corepack, at the packageManager version in package.json, before any pnpm call.
# `corepack install -g` also makes that version corepack's default, so pnpm run outside the repo (temp
# workspaces in tests have no packageManager) gets the same version instead of the latest release.
# Later calls, including those inside scripts and tests, then need no registry request.
# When corepack's home came back from a cache (.github/actions/setup), the install runs with the network off, so it
# makes no registry request. Otherwise a registry error such as HTTP 503 gets retried with backoff instead of failing
# the job.
set -u
corepack enable
pm=$(node -p 'require("./package.json").packageManager')
if COREPACK_ENABLE_NETWORK=0 corepack install -g "$pm" 2>/dev/null; then
  echo "$pm from the corepack cache, no registry request"
else
  echo "$pm is not in the corepack cache; fetching it from the registry"
  for wait in 10 20 40 80 last; do
    corepack install -g "$pm" && break
    [ "$wait" = last ] && exit 1
    echo "corepack install failed; retrying in ${wait}s" >&2
    sleep "$wait"
  done
fi
echo "pnpm $(pnpm --version) in the repo, $(cd / && pnpm --version) outside it"
