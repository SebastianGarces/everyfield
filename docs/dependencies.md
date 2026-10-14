# Dependencies and compatibility gate

Stable publisher registry versions were checked on **2026-10-13**. No package was installed. Pin exact compatible versions when implementation is separately authorized; a stable tag does not establish working Next/auth/driver/TS integration.

| Package | Stable checked version | Purpose |
|---|---|---|
| [next](https://registry.npmjs.org/next/latest) | 16.4.0 | Sole application/backend framework |
| [typescript](https://registry.npmjs.org/typescript/latest) | 7.0.2 | Typed contracts/compiler; prove native compiler/tooling support |
| [better-auth](https://registry.npmjs.org/better-auth/latest) | 1.7.7 | Application-owned credential/session boundary |
| [tailwindcss](https://registry.npmjs.org/tailwindcss/latest) | 4.3.3 | Design styling |
| [shadcn](https://registry.npmjs.org/shadcn/latest) | 4.21.4 | Owned accessible component source via official CLI |
| [react](https://registry.npmjs.org/react/latest) | 19.3.0 | Selected Next-compatible rendering peer |
| [drizzle-orm](https://registry.npmjs.org/drizzle-orm/latest) | 0.45.4 | Explicit SQL/domain data adapter |
| [drizzle-kit](https://registry.npmjs.org/drizzle-kit/latest) | 0.31.11 | Versioned reviewed migration authoring |
| [postgres](https://registry.npmjs.org/postgres/latest) | 3.4.9 | Interactive transaction-capable PostgreSQL driver |
| [zod](https://registry.npmjs.org/zod/latest) | 4.6.7 | Closed request/result validation |
| [ai](https://registry.npmjs.org/ai/latest) | 7.0.138 | Conditional structured model/tool transport; no authority ownership |
| [@ai-sdk/openai](https://registry.npmjs.org/@ai-sdk%2fopenai/latest) | 4.0.92 | Conditional model provider adapter |
| [resend](https://registry.npmjs.org/resend/latest) | 6.32.1 | Selected shared mail delivery adapter |

### Selected design libraries

The [design handoff](../design/handoff/README.md) selects these. Versions were read from the npm registry on **2026-10-14**. Their registry evidence is not yet in [dependencies.json](dependencies.json); record it when you pin them. No package was installed.

| Package | Stable checked version | Purpose |
|---|---|---|
| [@hugeicons/react](https://registry.npmjs.org/@hugeicons%2freact/latest) | 1.1.10 | Icon component; the prototype is drawn with Hugeicons stroke rounded |
| [@hugeicons/core-free-icons](https://registry.npmjs.org/@hugeicons%2fcore-free-icons/latest) | 4.3.5 | Free Hugeicons set only, tree-shaken per icon |
| [@react-email/components](https://registry.npmjs.org/@react-email%2fcomponents/latest) | 1.0.12 | Email templates with fixed light colors and a 600px column |
| [@react-email/render](https://registry.npmjs.org/@react-email%2frender/latest) | 2.1.0 | Renders React Email templates to HTML and plain text; peer of `resend` |

The icon library is Hugeicons. Do not add lucide or a second icon set.

Select Node24 LTS for the Next deployment and operator artifact; it meets the selected engine constraints (AI SDK requires Node22 or later). Vercel currently supports24.x (default) and22.x per its [official runtime documentation](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), checked2026-10-13. Actual deployment/runtime compatibility remains unproved. WP003 must compile representative RSC/client forms, route/stream transport, schema/MDX and document formats with the actual runtime and selected versions; prove interactive rollback, resumable auth and cookie/origin rules. Record official security advisories/peer constraints and licensed generated components in the lockfile review. If compatibility fails, keep the package blocked with a concrete supported-version proposal; do not quietly downgrade or claim a tested stack.

One modular Next deployment is selected. Server Components call scoped server-only domain reads directly; Server Actions and Route Handlers are thin validated adapters. Better Auth owns identity; a shared domain transaction owns grants and records. No separate Bun/Hono/Elysia backend is part of the build. Their earlier comparison informed the selected topology; no alternative backend must be installed to retain capability.

Retain format-specific DOCX/XLSX/PDF/Office parsing and rendering adapters only for named existing formats; isolate heavy work in bounded jobs and test bytes/fonts/previews in the selected runtime. Use private Tigris objects and the shared Resend delivery ledger. Use one privacy-safe telemetry path, not overlapping tracing stacks. Choose UI/chart/drag/drop dependencies only for specified behaviors and accessibility. Redis, another vector service, event broker, RPC framework, generic workflow engine and blanket client query cache are unnecessary for current scope. Global approved reference embeddings can use PostgreSQL/pgvector; per-organization reference material keeps current entitlement checks.

The [registry evidence](dependencies.json) records versions/engines/peer metadata and response hashes. Actual provider tiers, recurring usage and backup/operator cost require a concrete owner-approved envelope before commitment. These are future compatibility/configuration/security/restore proofs, not completed runtime tests.
