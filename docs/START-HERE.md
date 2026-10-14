# Current specification and bounded reading

EveryField is an operational workspace for church planting, with native work and the Evry assistant sharing domain operations. The SME church-planting Playbook and Plant Intelligence rubric are authoritative product foundations. Meetings, ministries, commitments, interviews, 4Cs and phases follow them. Software design may change without changing their methodology. The separate Network Intelligence rubric describes organization-level shared evidence; it does not rewrite the Plant rubric.

The rebuild is a fresh project with no customers or data migration. One modular Next.js application uses TypeScript, Better Auth, Tailwind CSS and owned shadcn/ui components. PostgreSQL on Neon owns relational records; private Tigris storage owns bytes; Vercel hosts the app and Resend sends mail. Native UI, server adapters and Evry use the same server-only scoped domain behavior. The plan fixes behavior, rules, privacy boundaries and test cases. Code structure, file names, function names, signatures and internal types are the builder's choice, proven by tests and cross-model review. The schema is a reviewed starting design; change it through a reviewed migration when the code shows a better shape. Screens follow the design prototype closely for look, layout and components; behavior comes from the requirements. No separate Bun backend, provider broker, universal workflow engine or service per feature is required.

An account has at most one active tenant seat. Plants and organizations are separate tenants; organization kind distinguishes a sending church from a sending network. Multiple plant affiliations are independent scoped relationships, not additional membership or inherited authority. Current Owner/Admin seats share routine administration; Owner alone requests workspace deletion. A lead-planter CRM/ministry role grants no application access. Members retain only the exact duties and projections specified by each operation.

Every durable Evry action requires review of its exact effects and human approval, followed by fresh authority/revision checks. Authorized reads and drafts need no blanket write grant. Evry has no pastoral judgment, prayer or biblical-counsel role. Native weekly private care belongs only to its original author and remains outside assistant/model/PI/organization/export/generic audit and existence-revealing telemetry paths.

Genuine historical acquisitions survive a person's later withdrawal: current cohort size shrinks, while an invalid historical entry can be corrected with history. Rejoining is not another new person. Discovery reading requires one eligible actual reader to complete all six canonical articles above the threshold; different people's partial reading cannot be pooled. Creating a plant enters Phase 1 independently of checklist completion.

Personal-account and Owner-requested workspace deletion suspend normal affected access immediately and hold affected content privately for 30 days solely for cancellation. Restricted cancellation ends strictly at the deadline. Coherent eligible live purge starts a seven-day recovery-copy horizon. Shared church-owned facts survive personal removal with minimal attribution. Restore must reapply current deletion/access witnesses before opening service and cannot reset expiry. Provider cleanup is asynchronous; exact universal physical day 37 erasure is not promised.

Safe feedback summaries create and triage issues automatically in a separate public repository; private originals and bounded own-user status remain separate. No raw fallback or publication of private records is allowed. The other agent's owner-provided merged workflow determines development routing; this specification adds no competing rubric, auto-merge or deployment authority.

During the build, recovery relies on Neon native seven-day database history and Tigris native seven-day object history. Before customer data, G-RECOVERY requires encrypted dated daily DB-plus-byte copies in a separate private Tigris backup bucket, expiring daily snapshots, current deletion/access witness synchronization and a restricted scheduled operator host with recoverable keys excluded from ordinary app/build/preview. These backup mechanisms are not build kickoff prerequisites. Current lifecycle witnesses must represent pending, cancelled and completed deletion now; restore reapplies current authority before opening access and never resets expiry. Shared-provider/account risk is accepted. Ordinary internal RPO at most one hour and RTO at most four hours require measured coherent database-and-file proof; a fresh surviving accessible daily copy may permit at most 24-hour loss fallback. No disaster availability/RTO or customer SLA is selected.

Requirement JSON in `docs/catalog/requirements/` is the behavior authority. Product chapters are readable summaries; when a summary differs, the requirement wins and the summary must be corrected. Features project their own requirement title and text. Run `python3 docs/catalog/project-features.py --write` to regenerate feature titles/behavior and the Evry tool list; run it without flags to check for drift. Original SME sources remain the methodology foundations.

`~/dev/everyfield_v2` is an optional reference, with `docs/lessons.md` as the index. Builders may read how v2 did something and what went wrong; they do not copy its structure.

## Reading an assigned package

Read AGENTS.md, this orientation and the global security/audit contracts. Coordinators use the evidence-backed progress workflow to plan and acknowledge milestones. Generate the assigned packet with the documented package-context tool. It selects concrete requirements, cases, operations, schema and direct-prerequisite interfaces from the verified context manifest. Do not recursively load all upstream packets or the entire repository. Read original reference passages and relevant approved design sections on demand. Schema/contract and final integration owners necessarily read broader indexed sets; context budgets never justify dropping requirements.

[The glossary](product/glossary.md) explains receipt, projection, witness, subject, Unknown and revision terms.

Current domain chapters:

- [Identity and access](product/identity-access.md), [People](product/people.md), [teams and training](product/teams-training.md)
- [Meetings and follow-up](product/meetings-follow-up.md), [tasks](product/tasks.md)
- [Communications and notifications](product/communications-notifications.md), [knowledge and documents](product/knowledge-documents.md)
- [Methodology and intelligence](product/methodology-intelligence.md), [Launch](product/launch.md)
- [Evry](product/evry.md), [operations](product/operations.md)

## Readiness and authority

Complete current behavior, schemas, transaction/lease/ownership contracts, named fixtures, operation parity, dependencies and independent semantic review constitute the design gate. Actual runtime evidence constitutes a separate implementation gate. [Canonical build progress](build-progress.json) records package milestones and completion. Exact paid spending, account/repository configuration and restricted backup invocation context need their future concrete approval/setup evidence. G-WORKFLOW records the remaining runner, identity/review receipt, key, remote, configuration and proof-plan bootstrap obligations; local repository preparation grants no implementation kickoff. These external gates do not justify leaving internal design contradictory or starting a partial rebuild before full-plan review.

The WP-097-only fast-track completion handoff is defined in [the ship skill](../.agents/skills/ship/SKILL.md). The documentation maintenance utilities change only documentation projections and progress after evidence-backed authorization. This consolidation does not authorize code, databases, credentials, provider setup, spending, repositories, PRs or deployment.
