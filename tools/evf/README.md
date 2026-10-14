# Local workflow reconciliation

This tooling branch adapts the received workflow to the current standalone plan. It does not authorize application implementation, run the live feedback desk, configure GitHub protections or commit spending. G-AUTH remains unopened, G-WORKFLOW remains open for the qualified runner/setup handoff, and [canonical progress](../../docs/build-progress.json) records implementation state.

Run local tooling regressions with the Node version resolved by `bin/evf`:

```sh
bin/evf test
```

Tests create disposable Git repositories/worktrees. `gh` and the attestation service are external fakes; no real GitHub, paid providers or application databases are contacted. A fixture's signed “application qualified” result tests this tool's proof protocol and is not v3 application acceptance. The current repository config uses `kind: tooling`, `applicationQualified: false`, no attestation runner, no stack and no active proof plans.

Intent owns task execution, delegation, conflicts, model sessions, owner discussions and hook lifecycle. `evf` provides local planning/context/evidence/merge guards around that harness. The receipt adapter must consume Intent’s verified review/identity and approval evidence; it must not add a parallel scheduler or model execution system. The concrete Intent receipt interface remains unconfigured.

## Current context, planning and gates

Current clauses/cases/operations come from `docs/catalog/index.json`; missing inputs fail instead of falling back to an empty old registry. Briefs validate `docs/plan/context-manifest.json` and name the selected cases. Start with the short package brief and read linked details on demand; the reviewed proof plan still accounts for every selected obligation. Deleted PD/V2 material is not a prerequisite or recreated decision store.

Planning precomputes all selected package endpoints before wiring dependencies, preserving the 26 forward references. Selection follows the canonical topological order. UI paths are presentation/features/components and browser tests; Next server adapters and API routes stay with the implementor. Split contract prerequisites need retained merged-part evidence included in current main.

Implementation kickoff and workflow approval are current action gates, rechecked before start, stack-up, application proof, publication and merge. Read-only briefs and separately authorized local tooling work do not open them. Runtime/recovery evidence gates close after their producers run; they do not prevent those producers starting. Explicit paid-provider declarations trigger the concrete spending approval before usage; purely local/synthetic work does not imply spending. `--allow-unready` grants no bypass.

## Proof and staged acceptance

The reviewed root config installs a sparse `verification.proofPlans` entry for each active task before task creation/rebase. It has:

- `risk`: an explicitly reviewed `ordinary`, `sensitive`, `security`, `privacy` or `irreversible` classification; unknown risk fails closed.
- `stage`: `producer`, `contract`, `api`, `ui`, or `full-target` for WP-056/WP-057;
- `ownedPortion`: `reference`, `platform`, `contract`, `domain`, `native`, `assistant` or `integration`, plus `requiresStack`;
- `cases`: every current selected ID exactly once, `requiredPortions` and explicit `deferred: [{portion, ownerTask}]`;
- `gates`: every DAG gate index exactly once with the same portion structure. The source fingerprint binds the gate text/order, so an index is not a mutable substitute for an obligation.

Own-scope obligations cannot be omitted. Deferrals name the actual downstream case producer/adapter, or a valid sibling adapter; a contract can defer to API/UI, and an API can defer a native UI portion to its peer UI. A prerequisite sibling cannot supply a future deferral. API/UI can build from a frozen shared contract in parallel. Whole-target proof permits no deferrals. A producer or split proof establishes only its declared portion; every deferred portion remains part of package/full-target closure.

The operator must review these mappings against exact clause/case expectations and actual adapter owners. This tool validates completeness, ownership and dependency direction; it cannot infer assertion coverage from a count, a portion label or a signature. Installing the real per-stage assertion/report driver is part of the remaining setup.

A separately trusted runner reproduces the applicable real checks and signs an Ed25519 JSON payload binding `task`, `role`, `mode`, `sha`, `baseSha`, `fingerprint`, `casePortions`, `gatePortions`, `checkDigest`, `actorId`, `modelFamily` and `passed`. The attestation command receives `{request}`; private signing keys/provider identity must stay outside author/verifier worktrees and agent credentials. The signed verifier payload additionally includes `review: {verdict: "approved", reviewedSha, risk}` from Intent’s actual independent review; passing checks alone cannot mint review approval. A CLI role, a Git author, the current CLI account or a file copied by an agent is not trusted identity. Author/verifier identities and model families must differ. The earlier routine same-family capacity fallback remains disabled until an explicit reviewed operator policy exists.

This is an operator trust boundary: cryptography binds a claim to the configured runner, while the runner is responsible for reproducing evidence and authenticating actual provider/session identity. Root configuration and keys must be independently reviewed; agents cannot self-authorize their own proof-plan/key changes. Context/policy changes merge separately before consumer verification.

Before any verification check/runner or stack-up command, worktree control/context bytes must match the reviewed root. Relabeling a worktree proof as tooling cannot bypass application or risk gates. Checks and runner return before final HEAD/clean/base/fingerprint checks. Consumption revalidates task, selected context, staged plan, gate names, exact log hashes, signature and current full head/base. Quick proof cannot borrow a historical full pass. External PR/ship paths fetch current main before consumption. A changed branch stops for fresh proof and the review requirements in `ship`.

## Feedback and human ownership

The original P0/P1 immediate, P2/P3 Monday, small-feature draft-prototype, large-feature idea, duplicate/question/spam rubric remains in `.agents/roles/feedback-desk.md`. No new severity rubric replaces it.

Configure verified numeric `botAuthorId`, `triageActorIds`, `ownerActorIds` and merge `humanActorIds`. Use separate agent and human credentials. Direct mutation paths validate bot provenance and explicit actor trust; the currently authenticated account is never automatically trusted. Source repository numeric/node IDs, issue number/node ID, original public summary and locator are frozen. A changed repository cannot reinterpret an existing FB number; the private internal repository is bound too. Repository renames with the same immutable identity preserve the original locator.

The inbound public issue must match the reviewed closed publisher title/body templates, approved public-area list and opaque UUID marker; bot authorship alone does not authorize arbitrary raw text. Those adapter protocol fields are empty until the actual publisher contract is reviewed. Nonconforming/richer public text is held for authorized human triage; the automated model path receives only the closed projection.

Automatic public triage contains a fixed class/status, optional verified public duplicate number and opaque token. Private reason, area, feature/package routing and actor ID stay private. HTML comments are public. An arbitrary reply is blocked unless a configured owner approves the exact source/body SHA-256 in `replyApprovals`; the reviewed question-answer path then posts that exact reply and closes the question. Without a reviewed reply, a question remains open. Large ideas retain demand ranking and owner-approved promotion via `promotionApprovals`; promotion creates private planning evidence, not implementation permission.

Feedback starts require a reviewed current package/context and matching feature scope. P0/sensitive work and over-limit P0 exceptions require recorded owner approval; severity itself grants no authority. Every application task has a reviewed risk classification. Nonordinary tasks stop before implementation or merge and escalate through Intent’s existing owner channel; the scoped owner-approval receipt adapter remains unconfigured. The definitive sensitive-scope policy and approved start records must be supplied at the external handoff; this task does not decide broader autonomous authority. A native private-original/reproduction bridge remains unconfigured. Purpose-filtered reproduction access must preserve private-care/security exclusions before any model/runtime access.

Daily slots count actual starts plus current reservations, never triage-cache presence. Reusing a completed start consumes one slot; a historical reservation must charge the actual new start day. The quiet-day queue includes new intake, due P2/P3 Monday work, immediately due backlog and unresolved reservations. Previously budget-held work returns when a later day has room. Concurrent local mutations fail on the lock; stale/incomplete lock ownership requires explicit reconciliation rather than a racing takeover.

Internal creation is source-marker keyed in a verified private repo. A lost response becomes `unknown`; retry first searches for the exact marker and reconciles a single existing issue, refusing zero/ambiguous unknown outcomes. Public shipped updates record pending/unknown/complete outcomes and never report closure after a failed call. Inspect provider evidence and record a reviewed reconciliation before retrying unknown writes; do not delete caches or blindly repeat them.

Merge authority and Git safety live in `.agents/skills/ship/SKILL.md`. `github setup` performs no
writes; concrete protection configuration remains a separate owner action.

## Progress and integration

Only evf writes `docs/build-progress.json`, on ship and coordinator acknowledgement. Shipped records
retain author/verifier proofs, proven/deferred case/gate portions and merge commits. A coordinator
reviews `evf shipped`, then acknowledges with `evf shipped --clear <task>`; exact replays are
idempotent. Commit the evf-generated change through reviewed `OPS-n` maintenance as described in
[the coordinator role](../../.agents/roles/coordinator.md). No package patch or offline explorer
closure checklist is required.

Reconcile new and retired plan IDs with `node tools/evf/progress.ts --reconcile` using Node 24+,
then commit the generated change through the same reviewed OPS task. This writer preserves
evidence and refuses unknown package IDs. Generate a read-only explorer outside the checkout
with `python3 docs/render-build-explorer.py --output /tmp/everyfield-build-explorer.html`.

Reviewed producer/interface milestones unlock dependents while full closure stays at integration.
A contract milestone unlocks consumers; without a contract split the API/producer milestone does.
Milestone readiness rechecks retained signed independent proof, main ancestry and actual merged
owning-path bytes. Full closure still needs all parts, obligations, gates and canonically done
prerequisites. A reviewed full-target integration plan may declare
`packageClosures: [{packageId, gateIndexes}]`, covering every target package gate and case.
Acknowledgement validates its full integration portions, acknowledged merged parts and done direct
prerequisites, then closes only those explicitly reviewed packages. Feedback and upkeep do not change
package progress.

## Proof plan drafts, case coverage and upkeep

`evf proof draft WP-001` prints a draft from the context manifest's selected cases and DAG gates.
The operator reviews risk, portions, applicable layers and downstream adapter owners, then installs
only the approved plan under root `verification.proofPlans`. Draft output never changes the config.

Application checks write `EVF_TEST_REPORT`, or the reviewed `verification.testReport` path. Format:

```json
{"tests":[{"name":"AC:MTG-CASE-001 AC:MTG-CASE-002 finalization produces expected tasks","status":"passed","annotations":["AC:MTG-CASE-003"]}]}
```

Only `passed` tests count; `failed` and `skipped` do not. Names and string annotations share the
`AC:<case-id>` form used by `{acGrep}`. One test can cover several cases. evf clears stale reports,
checks every selected case and retains the report in hashed proof evidence before attestation.
Duplicate case coverage is reported for verifier review. Broad current proof stays outside the repo;
regression tests follow `test-standard` and protect costly silent failures.

`OPS-n` is tooling maintenance. The operator registers its title, owning paths and local tooling `checks` in `maintenanceTasks`,
reviews and installs its maintenance draft, then uses the same task, verify, PR and ship commands.
It runs no application stack and has no package cases or gates. Independent signed author/verifier
proof and approved review still apply; OPS proof kind is always tooling. It grants no application or
external setup authority. A runner remains necessary before remote shipping.

## Remaining external setup

Before any application/automation execution: explicit kickoff; the qualified stage driver/signer and independently reviewed sparse proof plans; disposable runtime/provider fakes and actual assertion/report checks; verified feedback/main repository and bot/triage/human identities; purpose-filtered reproduction bridge; sensitive-start/approval policy;  separately approved protection configuration and paid usage where applicable. Source `G-WORKFLOW` is intentionally not claimed closed by these local fixes.


## Intent starting-state checklist

Local preparation here covers the coherent entry/role/skill paths, current bounded context, DAG-to-Intent dependencies/conflicts and evidence/merge guards. Reconcile stale workspace checkouts through a preserved checkpoint; do not discard their dirty state or use a force switch. Use the normal development folder for the eventual Intent workspace; the agent's detached review checkout need not own main.

Owner/harness setup remains: explicit kickoff; the actual Intent review/identity and scoped sensitive-approval receipt interface; independently reviewed task risk/stage plans; verified feedback/bot/human identities and safe publisher/reproduction protocol; concrete protection and paid usage approvals where applicable. Map the receipt adapter to existing Intent capabilities before choosing any additional service. Follow `ship` for review and protection requirements.

Read [canonical progress](../../docs/build-progress.json) for implementation milestones. Future proof covers contract/reference/platform/schema producers, native/assistant slices, runtime/database/browser/evaluation assertions and operational/recovery behavior. Keep stage evidence and package closure separate; do not bootstrap applications or launch the first wave during repository preparation.
