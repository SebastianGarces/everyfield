# Local workflow reconciliation

This tooling branch adapts the received workflow to the current standalone plan. It does not authorize application implementation, run the live feedback desk, configure GitHub protections or commit spending. G-AUTH remains unopened, G-WORKFLOW remains open for the qualified runner/setup handoff, and all 86 canonical package statuses remain `not_started`.

Run focused local tooling regressions with Node 24:

```sh
node --test tools/evf/tests/reconciliation.test.ts
```

Tests create disposable Git repositories/worktrees. `gh` and the attestation service are external fakes; no real GitHub, paid providers or application databases are contacted. A fixture's signed “application qualified” result tests this tool's proof protocol and is not v3 application acceptance. The current repository config uses `kind: tooling`, `applicationQualified: false`, no attestation runner, no stack and no active proof plans.

## Current context, planning and gates

Current clauses/cases/operations come from `docs/catalog/index.json`; missing inputs fail instead of falling back to an empty old registry. Briefs validate `docs/plan/context-manifest.json`, name every selected case and require every bounded detail page. Deleted PD/V2 material is not a prerequisite or recreated decision store.

Planning precomputes all selected package endpoints before wiring dependencies, preserving the 26 forward references. Selection follows the canonical topological order. UI paths are presentation/features/components and browser tests; Next server adapters and API routes stay with the implementor. Split contract prerequisites need retained merged-part evidence included in current main.

Implementation kickoff and workflow approval are current action gates, rechecked before start, stack-up, application proof, publication and merge. Read-only briefs and separately authorized local tooling work do not open them. Runtime/recovery evidence gates close after their producers run; they do not prevent those producers starting. Explicit paid-provider declarations trigger the concrete spending approval before usage; purely local/synthetic work does not imply spending. `--allow-unready` grants no bypass.

## Proof and staged acceptance

The reviewed root config installs a sparse `verification.proofPlans` entry for each active task before task creation/rebase. It has:

- `stage`: `producer`, `contract`, `api`, `ui`, or `full-target` for WP-056/WP-057;
- `ownedPortion`: `reference`, `platform`, `contract`, `domain`, `native`, `assistant` or `integration`, plus `requiresStack`;
- `cases`: every current selected ID exactly once, `requiredPortions` and explicit `deferred: [{portion, ownerTask}]`;
- `gates`: every DAG gate index exactly once with the same portion structure. The source fingerprint binds the gate text/order, so an index is not a mutable substitute for an obligation.

Own-scope obligations cannot be omitted. Deferrals name the actual downstream case producer/adapter, or a valid sibling adapter; a contract can defer to API/UI, and an API can defer a native UI portion to its peer UI. A prerequisite sibling cannot supply a future deferral. API/UI can build from a frozen shared contract in parallel. Whole-target proof permits no deferrals. A producer or split proof establishes only its declared portion; every deferred portion remains part of package/full-target closure.

The operator must review these mappings against exact clause/case expectations and actual adapter owners. This tool validates completeness, ownership and dependency direction; it cannot infer assertion coverage from a count, a portion label or a signature. Installing the real per-stage assertion/report driver is part of the remaining setup.

A separately trusted runner reproduces the applicable real checks and signs an Ed25519 JSON payload binding `task`, `role`, `mode`, `sha`, `baseSha`, `fingerprint`, `casePortions`, `gatePortions`, `checkDigest`, `actorId`, `modelFamily` and `passed`. The attestation command receives `{request}`; private signing keys/provider identity must stay outside author/verifier worktrees and agent credentials. A CLI role, a Git author, the current CLI account or a file copied by an agent is not trusted identity. Author/verifier identities and model families must differ. The earlier routine same-family capacity fallback remains disabled until an explicit reviewed operator policy exists.

This is an operator trust boundary: cryptography binds a claim to the configured runner, while the runner is responsible for reproducing evidence and authenticating actual provider/session identity. Root configuration and keys must be independently reviewed; agents cannot self-authorize their own proof-plan/key changes. Context/policy changes merge separately before consumer verification.

Checks and runner return before final HEAD/clean/base/fingerprint checks. Consumption revalidates task, selected context, staged plan, gate names, exact log hashes, signature and current full head/base. Quick proof cannot borrow a historical full pass. External PR/ship paths fetch current main before consumption. A changed branch stops for full author/verifier evidence and renewed human review. Strict enforced protection closes the race with a concurrently advancing main; its actual state is verified before feedback merge.

## Feedback and human ownership

The original P0/P1 immediate, P2/P3 Monday, small-feature draft-prototype, large-feature idea, duplicate/question/spam rubric remains in `.agents/roles/feedback-desk.md`. No new severity rubric replaces it.

Configure verified numeric `botAuthorId`, `triageActorIds`, `ownerActorIds` and merge `humanActorIds`. Use separate agent and human credentials. Direct mutation paths validate bot provenance and explicit actor trust; the currently authenticated account is never automatically trusted. Source repository numeric/node IDs, issue number/node ID, original public summary and locator are frozen. A changed repository cannot reinterpret an existing FB number; the private internal repository is bound too. Repository renames with the same immutable identity preserve the original locator.

The inbound public issue must match the reviewed closed publisher title/body templates, approved public-area list and opaque UUID marker; bot authorship alone does not authorize arbitrary raw text. Those adapter protocol fields are empty until the actual publisher contract is reviewed. Nonconforming/richer public text is held for authorized human triage; the automated model path receives only the closed projection.

Automatic public triage contains a fixed class/status, optional verified public duplicate number and opaque token. Private reason, area, feature/package routing and actor ID stay private. HTML comments are public. An arbitrary reply is blocked unless a configured owner approves the exact source/body SHA-256 in `replyApprovals`; the reviewed question-answer path then posts that exact reply and closes the question. Without a reviewed reply, a question remains open. Large ideas retain demand ranking and owner-approved promotion via `promotionApprovals`; promotion creates private planning evidence, not implementation permission.

Feedback starts require a reviewed current package/context and matching feature scope. P0/sensitive work and over-limit P0 exceptions require recorded owner approval; severity itself grants no authority. The definitive sensitive-scope policy and approved start records must be supplied at the external handoff; this task does not decide broader autonomous authority. A native private-original/reproduction bridge remains unconfigured. Purpose-filtered reproduction access must preserve private-care/security exclusions before any model/runtime access.

Daily slots count actual starts plus current reservations, never triage-cache presence. Reusing a completed start consumes one slot; a historical reservation must charge the actual new start day. The quiet-day queue includes new intake, due P2/P3 Monday work, immediately due backlog and unresolved reservations. Previously budget-held work returns when a later day has room. Concurrent local mutations fail on the lock; stale/incomplete lock ownership requires explicit reconciliation rather than a racing takeover.

Internal creation is source-marker keyed in a verified private repo. A lost response becomes `unknown`; retry first searches for the exact marker and reconciles a single existing issue, refusing zero/ambiguous unknown outcomes. Public shipped updates record pending/unknown/complete outcomes and never report closure after a failed call. Inspect provider evidence and record a reviewed reconciliation before retrying unknown writes; do not delete caches or blindly repeat them.

Feedback PR merge additionally requires the configured human's approval at the exact head, no outstanding decisive requested changes, full independent proof and actual strict enforced protection. COMMENTED/PENDING reviews do not erase an earlier request for changes. Ordinary merge authority remains `pending-owner-decision`; this branch does not infer all-PR human policy or autonomous ordinary merging. `github setup` performs no writes and reports that concrete protection configuration needs a separate owner action.

## Progress and integration

Owners submit their owned progress patch at start, blocker changes, reviewed milestones and handoff. One integration owner reviews/applies canonical patches and refreshes/checks the offline explorer. Shipped records retain proven/deferred case/gate portions, merge commit, part and `package_completion: false`; a merged part or scaffold proof cannot mark a whole package done. `shipped --clear` acknowledges the inbox while retaining prerequisite/proof provenance. Actual package closure still requires all parts, obligations, direct prerequisites, substantive reviewed output and the mandatory offline explorer checklist.

## Remaining external setup

Before any application/automation execution: explicit kickoff; the qualified stage driver/signer and independently reviewed sparse proof plans; disposable runtime/provider fakes and actual assertion/report checks; verified feedback/main repository and bot/triage/human identities; purpose-filtered reproduction bridge; sensitive-start/approval policy; final ordinary merge authority; separately approved protection configuration and paid usage where applicable. Source `G-WORKFLOW` is intentionally not claimed closed by these local fixes.
