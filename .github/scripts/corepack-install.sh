#!/bin/sh
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
