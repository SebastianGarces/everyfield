#!/bin/sh
# Put the packageManager pnpm into corepack's cache before any `corepack pnpm` call.
# Later calls, including those inside scripts and tests, then need no registry request.
# A registry error such as HTTP 503 gets retried with backoff instead of failing the job.
for wait in 10 20 40 80; do
  corepack install && exit 0
  echo "corepack install failed; retrying in ${wait}s" >&2
  sleep "$wait"
done
exec corepack install
