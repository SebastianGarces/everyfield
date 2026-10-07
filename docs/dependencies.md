# Dependency plan

Verified against official primary sources on **2026-10-03**. The parent completed the broad stack research; this task directly reopened the eight core release sources and Next's TypeScript compatibility documentation. Pin exact supported releases when implementation starts and rerun the compatibility/security gate. A version in v2's manifest is evidence of the old build, not the latest safe v3 choice.

| Required / candidate dependency | Dated stable baseline | Rationale and compatibility gate | Official source |
|---|---|---|---|
| Next.js | 16.3.8 | Latest verified active release includes September security fixes; use App Router; tenant-sensitive caching must be scoped and tested | [Security release](https://nextjs.org/blog/september-2026-security-release) |
| TypeScript | 7.0.2 | Stable native CLI; compiler API/plugin support differs; Next local CLI integration setting is experimental, so test MDX/ESLint/build/editor compatibility; do not silently use a nightly | [TS7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [Next TypeScript config](https://nextjs.org/docs/app/api-reference/config/typescript) |
| Better Auth | 1.7.7 | Maintained auth boundary; release includes a critical Magic Link fix, relevant even if that flow is not enabled; verify database adapter and exact cookie/session integration | [Release](https://github.com/better-auth/better-auth/releases/tag/v1.7.7) |
| Tailwind CSS | 4.3.3 | Requested stack; preserve design tokens/accessibility; verify matching build plugin release | [4.3 release family](https://tailwindcss.com/blog/tailwindcss-v4-3) |
| shadcn CLI | 4.21.1 | Owned component source, not a single runtime package version; add with official CLI, review changes and record generated versions | [CLI release](https://github.com/shadcn-ui/ui/releases/tag/shadcn@4.21.1) |
| Bun | 1.4.2 | API/worker leading runtime candidate; Bun package manager is separate from mandating Next runtime | [Release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2) |
| Hono | 4.13.12 | Small explicit API adapter, portable deployment options; validate RPC/public-schema boundaries and SSE behavior | [Release](https://github.com/honojs/hono/releases/tag/v4.13.12) |
| Elysia | 1.4.30 | User familiarity is valuable; stable v1 security-maintenance versus v2 beta must be explicit; do not choose beta silently | [Stable release](https://github.com/elysiajs/elysia/releases/tag/1.4.30) |

Stable does not mean every integration setting is stable. TS7 is stable while Next's switch to its CLI is experimental, and TS7's programmatic API is not available as a stable drop-in. WP-003 must compile a representative form, MDX page, async server component, generated schema and tooling checks with the actual selected releases. Any compatibility fallback needs a recorded reason and user-visible decision; it is not permission to silently downgrade the requested model or dependencies.

## Integration sources and choices

Use one public origin with `/api` routed to the chosen backend. Database-backed sessions support authoritative revocation; SSR must forward credentials and propagate `Set-Cookie` correctly. Verify trusted origins, cookie flags and CSRF behavior, not just CORS. Better Auth supports [Hono integration](https://better-auth.com/docs/integrations/hono), [Next integration](https://better-auth.com/docs/integrations/next), [session management](https://better-auth.com/docs/concepts/session-management) and [database ownership](https://better-auth.com/docs/concepts/database). One schema release owner coordinates auth and domain migrations.

Neither jobs nor types alone require a separate deploy: [Hono in Next routes](https://hono.dev/docs/getting-started/nextjs) and [Elysia in Next routes](https://elysiajs.com/integrations/nextjs) offer a hybrid. Independent API releases, long connections and worker/runtime needs are stronger reasons to split. [Next `after`](https://nextjs.org/docs/app/api-reference/functions/after) extends request-associated work but is not the durable job system proposed here. [pg-boss](https://github.com/timgit/pg-boss) is a PostgreSQL-backed candidate if it reduces lease/retry implementation work. TanStack Query should be added for demonstrated interaction/cache needs, not blanket duplication of server state; see [SSR guidance](https://tanstack.com/query/latest/docs/framework/react/guides/advanced-ssr).

## Retain, replace and defer the old dependency surface

The machine-readable [v2 dependency inventory](evidence/dependency-inventory.json) lists every direct main/alpha manifest dependency, its current declared range and disposition. Ancillary versions in that inventory are **not claimed as latest**. Each selected ancillary package must pass WP-003/WP-050: resolve its official stable release, compatibility/security/license posture, pin it in the future lockfile, and record the result before production. Installing the old dependency list wholesale is not a rebuild strategy.

| Family | Direction | Why / preserved need |
|---|---|---|
| React/React DOM/Next tooling | Retain supported Next peers | Server/client rendering and accessibility; use the selected Next release's peer support rather than unrelated newest experimental React |
| Drizzle ORM/Kit, Postgres driver | Retain conditional; replace HTTP-only transaction boundary | Clear SQL schema/relations; one migration owner; interactive transaction proof required |
| Custom argon2/auth helpers | Replace credential/session ownership with Better Auth | Preserve recovery, verification, rate limits and domain grants; do not double-own credential state |
| Zod/drizzle-zod | Zod4 boundary contracts; generated DB schemas only where helpful | Domain requests must not expose persistence representations or accept protected columns |
| AI SDK/OpenAI adapter | Retain conditional structured output support | Rubric-grounded judge/evals; model/provider and latest adapter compatibility remain explicit gate |
| Langfuse/OpenTelemetry/Sentry | Retain only needed observability, consolidate overlapping exporters | Request/job/assessment tracing and privacy controls; do not duplicate telemetry stacks without separate purpose |
| AWS S3 SDK/presigner | Retain conditional storage adapter | Private scoped photos/files/docs; provider selection remains open |
| Resend/React Email | Retain conditional shared provider/templates | Transactional invitations/recovery and communication delivery; suppression/idempotency unified |
| docx/exceljs/React PDF/jszip/XML parser | Retain format-specific capabilities, isolate rendering worker | DOCX/XLSX/PDF generation, merged-document previews and Office parsing; test Bun/native/font compatibility, keep patched parser |
| MDX/remark/rehype/slugger | Retain only actual approved Wiki rendering requirements | Existing approved knowledge/content topology; sanitized authored content and safe server rendering |
| Radix/shadcn/CVA/clsx/tailwind-merge/lucide/sonner/themes | Retain minimal owned UI set | Accessible primitives, feedback, icons and theme; avoid duplicate umbrella and per-component dependencies when not required |
| Charts and drag/drop | Add only preserved feature needs | Actual analytics/org-chart/reorder behavior, keyboard accessibility and bundle checks |
| date-fns | Retain utility if useful, not domain clock authority | Local dates/instants are explicit contracts; timezone scheduling tested independently |
| confetti/debounce/tiny-invariant | Optional narrow utilities | Preserve actual UX where meaningful; no generic state/event layer justified by utility presence |
| ESLint/Prettier/tsx/node types/react test renderer | Refresh selected tooling; replace tests by purpose, not count | Meaningful domain/integration/RTL/Playwright tests; stable TS7 API compatibility gate |
| New React Hook Form | Conditional complex forms only | Draft preservation/validation accessibility; do not install for simple buttons |
| New Vitest/RTL/Playwright | Proposed testing tools, exact pins future gate | Domain/component/browser acceptance ownership; integration races use real Postgres |
| Eve/runtime patch | Do not assume framework retention | Preserve assistant capabilities via shared operations; latency, recovery and maintenance comparison decides runtime |
| Redis/vector DB/event broker/RPC stacks | Defer absent a concrete requirement | PostgreSQL/pgvector where appropriate, durable jobs and typed operations cover current needs |

No packages were installed or upgraded during this documentation task. The versions are a dated implementation baseline, not a perpetual latest claim.
