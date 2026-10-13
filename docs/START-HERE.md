# Current specification and bounded reading

EveryField is an operational workspace for church planting, with native work and the Evry assistant sharing domain operations. The SME church-planting Playbook and Plant Intelligence rubric are authoritative product foundations. Meetings, ministries, commitments, interviews, 4Cs and phases follow them. Software design may change without changing their methodology. The separate Network Intelligence rubric describes organization-level shared evidence; it does not rewrite the Plant rubric.

The rebuild is a fresh project with no customers or data migration. One modular Next.js application uses TypeScript, Better Auth, Tailwind CSS and owned shadcn/ui components. PostgreSQL on Neon owns relational records; private Tigris storage owns bytes; Vercel hosts the app and Resend sends mail. Native UI, server adapters and Evry use the same server-only scoped domain functions. No separate Bun backend, provider broker, universal workflow engine or service per feature is required.

An account has at most one active tenant seat. Plants and organizations are separate tenants; organization kind distinguishes a sending church from a sending network. Multiple plant affiliations are independent scoped relationships, not additional membership or inherited authority. Current Owner/Admin seats share routine administration; Owner alone requests workspace deletion. A lead-planter CRM/ministry role grants no application access. Members retain only the exact duties and projections specified by each operation.

Every durable Evry action requires review of its exact effects and human approval, followed by fresh authority/revision checks. Authorized reads and drafts need no blanket write grant. Evry has no pastoral judgment, prayer or biblical-counsel role. Native weekly private care belongs only to its original author and remains outside assistant/model/PI/organization/export/generic audit and existence-revealing telemetry paths.

Genuine historical acquisitions survive a person's later withdrawal: current cohort size shrinks, while an invalid historical entry can be corrected with history. Rejoining is not another new person. Discovery reading requires one eligible actual reader to complete all six canonical articles above the threshold; different people's partial reading cannot be pooled. Creating a plant enters Phase1 independently of checklist completion.

Personal-account and Owner-requested workspace deletion suspend normal affected access immediately and hold affected content privately for 30 days solely for cancellation. Restricted cancellation ends strictly at the deadline. Coherent eligible live purge starts a seven-day recovery-copy horizon. Shared church-owned facts survive personal removal with minimal attribution. Restore must reapply current deletion/access witnesses before opening service and cannot reset expiry. Provider cleanup is asynchronous; exact universal physical day37 erasure is not promised.

Safe feedback summaries create and triage issues automatically in a separate public repository; private originals and bounded own-user status remain separate. No raw fallback or publication of private records is allowed. The other agent's owner-provided merged workflow determines development routing; this specification adds no competing rubric, auto-merge or deployment authority.

Recovery uses seven-day native database/object history, expiring daily snapshots and encrypted dated daily copies in a separate private Tigris backup bucket. Dedicated backup access is excluded from the ordinary app. Shared-provider/account risk is accepted; no second provider is required. Ordinary internal RPO1h/RTO4h require coherent measured database-and-file proof. Daily disaster fallback may lose24h only when a sufficiently fresh successful copy survives and is accessible; no disaster availability/RTO or customer SLA is selected.

## Reading an assigned package

Read AGENTS.md, this orientation, the global security/audit contracts and the evidence-backed progress workflow. Generate the assigned packet with the documented package-context tool. It selects concrete requirements, cases, operations, schema and direct-prerequisite interfaces from the verified context manifest. Do not recursively load all upstream packets or the entire repository. Read original reference passages and relevant approved design sections on demand. Schema/contract and final integration owners necessarily read broader indexed sets; context budgets never justify dropping requirements.

Current domain chapters:

- [Identity and access](product/identity-access.md), [People](product/people.md), [teams and training](product/teams-training.md)
- [Meetings and follow-up](product/meetings-follow-up.md), [tasks](product/tasks.md)
- [Communications and notifications](product/communications-notifications.md), [knowledge and documents](product/knowledge-documents.md)
- [Methodology and intelligence](product/methodology-intelligence.md), [Launch](product/launch.md)
- [Evry](product/evry.md), [operations](product/operations.md)

## Readiness and authority

Complete current behavior, schemas, transaction/lease/ownership contracts, named fixtures, operation parity, dependencies and independent semantic review constitute the design gate. Actual runtime evidence constitutes a separate implementation gate. All packages remain not_started/revision0; browser-local overrides cannot establish completion. Exact paid spending, account/repository configuration and restricted backup invocation context need their future concrete approval/setup evidence. The merged development workflow is still awaited. These external gates do not justify leaving internal design contradictory or starting a partial rebuild before full-plan review.

The documentation maintenance utilities change only documentation projections and progress after evidence-backed authorization. This consolidation does not authorize code, databases, credentials, provider setup, spending, repositories, PRs or deployment.
