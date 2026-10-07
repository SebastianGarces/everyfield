# Evry implemented and historical inventory

Audit date: 2026-10-03. Documentation only; no source mutation, provider call, application runtime, build, database, migration or outbound delivery. [Machine feature matrix](../../audits/evry.json) holds every ID, native action/route, source/commit, table, permission, lifecycle, validation, failure, v3 operation, acceptance and work package. [Surface inventory](../../audits/evry-surfaces.json) separately records actual tools/preparations, source exports/API handlers/hashes, tests and advertised parity. [Evry design](../evry-design.md) supplies implementable v3 contracts and acceptance procedures.

## Version resolution

| Source | Commit | Actual finding |
|---|---|---|
| Main current | `18fc1a505c64615fe9ef197dba0e2cd037063d31` | Runtime retired; historical schema remains. |
| Alpha current | `2107df58885c883960422ce7e60719f0adbac0e4` | Runtime retired; newer domain corrections take precedence over old local snapshots. |
| Main pre-retirement | `a94276a01978e360ffa4cceba8c736dd8f16395c` | Infrastructure and Communication production composition. |
| Local broad Evry | `b3bb9f52af6e0c64b537f7ba1316b2edf0f373ae` | Unmerged Eve/runtime/domain packs. Descends from b4c3461e; later two commits add Jev evals only. Not ancestor of main. |

Current decision #854 retires Evry in v2 on 2026-09-26. User v3 direction explicitly restores Evry as a first-class operational assistant, so retirement cannot authorize feature deletion. `dead` identifies formerly implemented main infrastructure removed from current main; `implemented-local-only` identifies unmerged source, not completed live acceptance. No feature removal is approved.

Main pre-retirement `capabilities/production.ts` wires Communication only. Local `capabilities/production.ts` + `capabilities/execution.ts` wire the broad packs. Generated `supported` parity classifies routes/actions; it does not establish a tool is installed, correctly answered or safely executed.

Local branch scan: the [surface inventory](../../audits/evry-surfaces.json) pins 46 local Evry/Eve/Jev-named branch tips, ancestry and generated contract identity sets. No extra advertised contract identities occur outside the broad local snapshot. Divergent/rebased tips are not assumed implementation-equivalent; installed broad-local behavior and pre-retirement main were inspected independently. This scan is a scope check, not execution proof.

## Coverage

| Inventory | Count | Interpretation |
|---|---:|---|
| Stable EVR records | 255 | 34 infrastructure +191 pack contracts +30 richer read/helper tools. |
| Pack contracts | 191 | 76 reads;115 reviewed effects. Every operation below has its own ID. |
| Read/helper tools | 30 | Relational/bulk queries and source content/status/calendar/context helpers. |
| Exact preparation operations | 117 | Frozen catalog enumerates typed reviewed operations; some map to the same native command. |
| Native agent tool files | 8 | Includes loaders, drafts, code mode, framework question/todo. |
| Local API handler files | 22 | Methods and endpoints explicitly enumerated in machine inventory. |
| Lexical export declarations | 2149 | Source discovery including types/proofs; not feature coverage. |
| Local test files | 283 | Source evidence, not passing-test claim. |
| Hashed local source files | 808 | Reproducible source manifest. |
| Current retained tables | 13 | Twelve plan/conversation/run +Eve session metadata. |
| Local-only Evry table | 1 | `evry_eve_attachments`. |
| Adjacent local-only Communication table | 1 | `communication_failed_retries` for exact provider-confirmed retry. |

Local corpus:126 historical questions +32 regressions =158 scenarios, 19 areas, 23 contracts. 108 default fixture bindings, 110 with two optional transports, 48 unbound. Inventory and grader tests do not establish agent success. Recorded Sept21 correction evidence holds integration, notes 18–24 second first-text latency/repeated overview prose and incomplete browser acceptance. Later actual `agent/agent.ts` has 40M/1M session token backstops; earlier correction note says 300k/30k. Current code establishes behavior; stale historical prose is not copied as a constraint.

## Infrastructure capabilities

| ID | Capability | Status | Evidence owner | Important acceptance/edge |
|---|---|---|---|
| EVR-001 | Application-only policy and fixed pastoral boundary | dead | `src/lib/evry/policy/core.ts` | mixed/ambiguous/provider failure gives zero app access |
| EVR-002 | Fresh tenancy, account and per-operation permission | dead | `src/lib/evry/eligibility/viewer.ts` | foreign actor/plant, revoked seat, own-task exceptions |
| EVR-003 | Authorized read registration and bounded source artifacts | dead | `src/lib/evry/reads/contract.ts` | missing/inaccessible/empty/partial are distinct |
| EVR-004 | Measured model selection and server-side provider options | dead | `src/lib/evry/models/selection.ts` | historical prices/thresholds are not v3 releases |
| EVR-005 | Global launcher, contextual panel and dedicated workspace | dead | `src/components/evry/evry-shell.tsx` | focus/scroll, double submit and unsent draft recovery |
| EVR-006 | Visible page context and safe entity references | dead | `src/lib/evry/resolvers/page-context.ts` | same-name/stale entities; URLs and aliases grant no authority |
| EVR-007 | Contextual suggestions and eligibility probe | dead | `src/components/evry/suggestions/catalog.ts` | advertised suggestions must match current operation authority |
| EVR-008 | Durable conversations, search, messages and replay | dead | `src/lib/evry/conversations/service.ts` | response-loss replay, sequence/request uniqueness and actor privacy |
| EVR-009 | Bounded structured references, choices and context | dead | `src/lib/evry/conversations/context.ts` | summaries are context only; completed work never auto-replays |
| EVR-010 | Typed read, clarification, review, progress, receipt and boundary cards | dead | `src/lib/evry/artifacts/review.ts` | public projection, source cards and immutable review disclosure |
| EVR-011 | Immutable proposals, canonical fingerprints and revision supersession | dead | `src/lib/evry/plans/service.ts` | an edit invalidates approval; historical TTL15 minutes |
| EVR-012 | Trusted visible approval, cancellation and expiration | dead | `src/lib/evry/plans/service.ts` | model text yes never approves; exact actor/revision review |
| EVR-013 | Executor, partial results, dependency skips and safe retry | dead | `src/lib/evry/executor/core.ts` | crash-after-commit and stale target fail/recover precisely |
| EVR-014 | Durable effect claims and exact relational audit identity | dead | `src/lib/evry/executor/statements.ts` | unique effect/step keys; duplicate executors cannot duplicate domain effects |
| EVR-015 | Deterministic recipes and dependency-output reuse | dead | `src/lib/evry/recipes/compiler.ts` | only registered trusted recipe/disclosure/retry policies |
| EVR-016 | Active run claim, streaming, reconnect and restart recovery | dead | `src/lib/evry/runs/service.ts` | disconnect stops observation; GET never repeats effects |
| EVR-017 | Plant-local natural-language date resolution | dead | `src/lib/evry/resolvers/datetime.ts` | DST gaps/overlaps, ambiguous weekday/year and stored wall-clock semantics |
| EVR-018 | Append-only product audit and exact-plan inspection | dead | `src/lib/evry/audit/repository.ts` | closed event/result codes; product evidence separate from telemetry |
| EVR-019 | Cost, latency, usage normalization and privacy-safe Langfuse tracing | dead | `src/lib/evry/observability/contract.ts` | metadata only by default; unknown usage and sink failure |
| EVR-020 | Generated source parity inventory and explicit exclusions | dead | `src/lib/evry/capabilities/contract.ts` | supported is advertised parity, not installed/evaluated tool proof |
| EVR-021 | Local Eve runtime, transport allowlist and private session ownership | implemented-local-only | `src/lib/evry/eve/runtime/session-store.ts` | cookie auth, same-origin mutations, actor/plant owner and scoped operation ID |
| EVR-022 | Dynamic tool/schema loaders and optional workflow hints | implemented-local-only | `src/lib/evry/eve/runtime/tool-selection.ts` | 8 tools/3 preparations, add/replace, hints never allowlists |
| EVR-023 | Revisioned planning notes, clarification and todo | implemented-local-only | `src/lib/evry/eve/runtime/task-state.ts` | optimistic revision; user/record/inferred facts never authority |
| EVR-024 | Source-bound result cards and compatible selection | implemented-local-only | `src/lib/evry/eve/runtime/results.ts` | same-turn authorized rows; selected total is not query total |
| EVR-025 | Staged private file manifests, session binding and cleanup | implemented-local-only | `src/lib/evry/eve/runtime/attachments.ts` | CSV/photo/commitment digest/expiry/owner; cleanup-execution race |
| EVR-026 | Restricted code-mode parallel tool composition | implemented-local-only | `src/lib/evry/eve/composition/runner.ts` | QuickJS/WASM isolation; no network/fs/imports/secrets/executor/approval |
| EVR-027 | Optional Jev discovery and measured routing experiments | implemented-local-only | `src/lib/evry/eve/jev/discovery.ts` | routing oracle/calibration, known holdout and systematic tool omissions |
| EVR-028 | Eleven authored operational workflow skills | implemented-local-only | `src/lib/evry/eve/runtime/authored-skills.generated.ts` | daily work, interview, meeting/invite/followup, staffing, launch, recovery, import, outreach, cleanup, insight |
| EVR-029 | Processing budgets, compaction failure and explicit retry | implemented-local-only | `src/lib/evry/eve/runtime/processing-budget-policy.ts` | 24 calls/2M input/64k output per turn;8k per call; patched Eve recovery |
| EVR-030 | Independent agent corpus, fixture/effect proofs and quality grading | implemented-local-only | `src/lib/evry/eve/evals/README.md` | 158 scenarios;48 unbound; facts/effects/safety precede semantic quality |
| EVR-031 | Complete history, Unicode note continuation and event/entry dates | implemented-local-only | `src/lib/evry/eve/runtime/history-continuation.ts` | record cursor separate from note offset; complete/partial not atomic snapshot |
| EVR-032 | Sanitized errors, credential scrubbing and trusted boundaries | implemented-local-only | `src/lib/evry/eve/runtime/tool-errors.ts` | private exception causes withheld; scrubbing is best-effort |
| EVR-033 | Current-review status and historic durable receipts | implemented-local-only | `src/lib/evry/eve/runtime/action-status.ts` | planned vs affected counts; unavailable not no action; execution not delivery |
| EVR-034 | Recipe reuse with fresh resolution and new approval | implemented-local-only | `src/app/api/evry/conversations/[conversationId]/reuse/route.ts` | historic approval never authorizes a new run |

All entries link to their `AC-EVR-###` gate and `WP-evry` in the feature matrix. The root build plan resolves package IDs and cross-module ordering.

## Fine-grained domain tools

All entries below are implemented-local-only at the pinned local source. Communication additionally has pre-retirement main composition. Listed permission is the native capability plus record/actor/tenant/lifecycle predicates. Reads used for planning may require write authority. An effect labeled `read` or `self.write` still has a lasting effect and historically required visible review. Each JSON record lists exact native action/source and proposed read or draft/propose/execute operation.

### people

| ID | Exact operation | Kind | Native permission |
|---|---|---|---|
| EVR-100 | `people.crm.assessments.create-assessment` | effect | `people.write` |
| EVR-101 | `people.crm.assessments.create-commitment` | effect | `people.write` |
| EVR-102 | `people.crm.assessments.create-interview` | effect | `people.write` |
| EVR-103 | `people.crm.assessments.get-assessments` | read | `read` |
| EVR-104 | `people.crm.assessments.get-commitment-download-url` | read | `read` |
| EVR-105 | `people.crm.assessments.get-commitments` | read | `read` |
| EVR-106 | `people.crm.assessments.get-interviews` | read | `read` |
| EVR-107 | `people.crm.assessments.get-latest-commitment` | read | `read` |
| EVR-108 | `people.crm.duplicates.check-for-duplicates` | read | `read` |
| EVR-109 | `people.crm.exports.export-people` | read | `read` |
| EVR-110 | `people.crm.households.add-to-household` | effect | `people.write` |
| EVR-111 | `people.crm.households.create-household-with-head` | effect | `people.write` |
| EVR-112 | `people.crm.households.delete-household` | effect | `people.write` |
| EVR-113 | `people.crm.households.get-household` | read | `read` |
| EVR-114 | `people.crm.households.get-household-members` | read | `read` |
| EVR-115 | `people.crm.households.list-households` | read | `read` |
| EVR-116 | `people.crm.households.propagate-address` | effect | `people.write` |
| EVR-117 | `people.crm.households.remove-from-household` | effect | `people.write` |
| EVR-118 | `people.crm.households.update-household` | effect | `people.write` |
| EVR-119 | `people.crm.imports.download-csv-template` | read | `read` |
| EVR-120 | `people.crm.imports.execute-bulk-import` | effect | `people.write` |
| EVR-121 | `people.crm.imports.preview-import` | read | `people.write` |
| EVR-122 | `people.crm.notes.add-note` | effect | `people.write` |
| EVR-123 | `people.crm.notes.delete-note` | effect | `people.write` |
| EVR-124 | `people.crm.notes.edit-note` | effect | `people.write` |
| EVR-125 | `people.crm.notes.get-activities` | read | `read` |
| EVR-126 | `people.crm.notes.get-more-activities` | read | `read` |
| EVR-127 | `people.crm.people.change-status` | effect | `people.write` |
| EVR-128 | `people.crm.people.change-status-with-reason` | effect | `people.write` |
| EVR-129 | `people.crm.people.create-person` | effect | `people.write` |
| EVR-130 | `people.crm.people.delete-person` | effect | `people.write` |
| EVR-131 | `people.crm.people.get-person` | read | `read` |
| EVR-132 | `people.crm.people.get-person-photo` | read | `read` |
| EVR-133 | `people.crm.people.list-people` | read | `read` |
| EVR-134 | `people.crm.people.load-more-people` | read | `read` |
| EVR-135 | `people.crm.people.quick-add-person` | effect | `people.write` |
| EVR-136 | `people.crm.people.remove-person-photo` | effect | `people.write` |
| EVR-137 | `people.crm.people.update-person` | effect | `people.write` |
| EVR-138 | `people.crm.people.upload-person-photo` | effect | `people.write` |
| EVR-139 | `people.crm.skills.add-skill` | effect | `people.write` |
| EVR-140 | `people.crm.skills.get-person-skills` | read | `read` |
| EVR-141 | `people.crm.skills.remove-skill` | effect | `people.write` |
| EVR-142 | `people.crm.skills.update-skill` | effect | `people.write` |
| EVR-143 | `people.crm.stages.get-pipeline-data` | read | `read` |
| EVR-144 | `people.crm.stages.reorder-pipeline` | effect | `people.write` |
| EVR-145 | `people.crm.tags.assign-tag` | effect | `people.write` |
| EVR-146 | `people.crm.tags.create-tag` | effect | `people.write` |
| EVR-147 | `people.crm.tags.delete-tag` | effect | `people.write` |
| EVR-148 | `people.crm.tags.get-person-tags` | read | `read` |
| EVR-149 | `people.crm.tags.list-tags` | read | `read` |
| EVR-150 | `people.crm.tags.remove-tag` | effect | `people.write` |
| EVR-151 | `people.crm.tags.update-tag` | effect | `people.write` |
### meetings

| ID | Exact operation | Kind | Native permission |
|---|---|---|---|
| EVR-152 | `meetings.add-guests` | effect | `meetings.write` |
| EVR-153 | `meetings.agenda.replace` | effect | `meetings.write` |
| EVR-154 | `meetings.attendance.add` | effect | `meetings.write` |
| EVR-155 | `meetings.attendance.batch-record` | effect | `meetings.write` |
| EVR-156 | `meetings.attendance.finalize` | effect | `meetings.write` |
| EVR-157 | `meetings.attendance.note` | effect | `meetings.write` |
| EVR-158 | `meetings.attendance.person-create-and-add` | effect | `meetings.write` |
| EVR-159 | `meetings.attendance.person-create-and-walk-in` | effect | `meetings.write` |
| EVR-160 | `meetings.attendance.remove` | effect | `meetings.write` |
| EVR-161 | `meetings.attendance.toggle` | effect | `meetings.write` |
| EVR-162 | `meetings.attendance.walk-in.add` | effect | `meetings.write` |
| EVR-163 | `meetings.checklist.toggle` | effect | `meetings.write` |
| EVR-164 | `meetings.checklist.update` | effect | `meetings.write` |
| EVR-165 | `meetings.create` | effect | `meetings.write` |
| EVR-166 | `meetings.evaluation.create` | effect | `meetings.write` |
| EVR-167 | `meetings.guests.person-create-and-add` | effect | `meetings.write` |
| EVR-168 | `meetings.guests.remove` | effect | `meetings.write` |
| EVR-169 | `meetings.guests.rsvp` | effect | `meetings.write` |
| EVR-170 | `meetings.lifecycle.delete` | effect | `meetings.write` |
| EVR-171 | `meetings.lifecycle.status` | effect | `meetings.write` |
| EVR-172 | `meetings.lifecycle.update` | effect | `meetings.write` |
| EVR-173 | `meetings.location.create` | effect | `meetings.write` |
| EVR-174 | `meetings.location.update` | effect | `meetings.write` |
| EVR-175 | `meetings.read.analytics` | read | `read` |
| EVR-176 | `meetings.read.detail` | read | `read` |
| EVR-177 | `meetings.read.list` | read | `read` |
| EVR-178 | `meetings.read.schedule` | read | `meetings.write` |
| EVR-179 | `meetings.response-card.clear` | effect | `meetings.write` |
| EVR-180 | `meetings.response-card.record` | effect | `meetings.write` |
### tasks

| ID | Exact operation | Kind | Native permission |
|---|---|---|---|
| EVR-181 | `tasks.bulk.complete` | effect | `tasks.own` |
| EVR-182 | `tasks.bulk.reschedule` | effect | `tasks.write` |
| EVR-183 | `tasks.checklist.add` | effect | `tasks.own` |
| EVR-184 | `tasks.checklist.completion` | effect | `tasks.own` |
| EVR-185 | `tasks.create` | effect | `tasks.write` |
| EVR-186 | `tasks.follow-up.assign` | effect | `tasks.write` |
| EVR-187 | `tasks.follow-up.create-and-assign` | effect | `tasks.write` |
| EVR-188 | `tasks.follow-up.handoff` | effect | `tasks.write` |
| EVR-189 | `tasks.lifecycle.complete` | effect | `tasks.own` |
| EVR-190 | `tasks.lifecycle.delete` | effect | `tasks.write` |
| EVR-191 | `tasks.lifecycle.reopen` | effect | `tasks.own` |
| EVR-192 | `tasks.lifecycle.status` | effect | `tasks.own` |
| EVR-193 | `tasks.lifecycle.update` | effect | `tasks.write` |
| EVR-194 | `tasks.phase-template.dismiss` | effect | `phase.signal` |
| EVR-195 | `tasks.phase-template.import` | effect | `tasks.write` |
| EVR-196 | `tasks.quick-create` | effect | `tasks.write` |
| EVR-197 | `tasks.read.counts` | read | `read` |
| EVR-198 | `tasks.read.detail` | read | `read` |
| EVR-199 | `tasks.read.follow-up-ownership` | read | `read` |
| EVR-200 | `tasks.read.list` | read | `read` |
| EVR-201 | `tasks.read.phase-template-prompt` | read | `phase.signal` |
| EVR-202 | `tasks.read.planning-options` | read | `tasks.write` |
| EVR-203 | `tasks.read.templates` | read | `tasks.write` |
| EVR-204 | `tasks.template.import` | effect | `tasks.write` |
### teams

| ID | Exact operation | Kind | Native permission |
|---|---|---|---|
| EVR-205 | `teams.create` | effect | `teams.write` |
| EVR-206 | `teams.initialize` | effect | `teams.write` |
| EVR-207 | `teams.initialize-with-roles` | effect | `teams.write` |
| EVR-208 | `teams.leader.assign` | effect | `teams.write` |
| EVR-209 | `teams.meetings.create` | effect | `teams.write` |
| EVR-210 | `teams.members.assign` | effect | `teams.write` |
| EVR-211 | `teams.members.remove` | effect | `teams.write` |
| EVR-212 | `teams.read.candidates` | read | `read` |
| EVR-213 | `teams.read.detail` | read | `read` |
| EVR-214 | `teams.read.health` | read | `read` |
| EVR-215 | `teams.read.list` | read | `read` |
| EVR-216 | `teams.read.meetings` | read | `read` |
| EVR-217 | `teams.read.person-assignments` | read | `read` |
| EVR-218 | `teams.read.person-training` | read | `read` |
| EVR-219 | `teams.read.responsibilities` | read | `read` |
| EVR-220 | `teams.read.training` | read | `read` |
| EVR-221 | `teams.responsibilities.completion` | effect | `teams.write` |
| EVR-222 | `teams.responsibilities.create` | effect | `teams.write` |
| EVR-223 | `teams.responsibilities.delete` | effect | `teams.write` |
| EVR-224 | `teams.responsibilities.initialize` | effect | `read` |
| EVR-225 | `teams.responsibilities.update` | effect | `teams.write` |
| EVR-226 | `teams.roles.create` | effect | `teams.write` |
| EVR-227 | `teams.roles.delete` | effect | `teams.write` |
| EVR-228 | `teams.roles.import` | effect | `teams.write` |
| EVR-229 | `teams.roles.update` | effect | `teams.write` |
| EVR-230 | `teams.training.complete` | effect | `teams.write` |
| EVR-231 | `teams.training.create-program` | effect | `teams.write` |
| EVR-232 | `teams.update` | effect | `teams.write` |
### communication

| ID | Exact operation | Kind | Native permission |
|---|---|---|---|
| EVR-233 | `communication.compose.get-church-merge-data` | read | `read` |
| EVR-234 | `communication.compose.get-context` | read | `read` |
| EVR-235 | `communication.delivery.get-church-totals` | read | `read` |
| EVR-236 | `communication.delivery.get-meeting-tracking` | read | `read` |
| EVR-237 | `communication.delivery.get-message` | read | `read` |
| EVR-238 | `communication.delivery.get-message-recipients` | read | `read` |
| EVR-239 | `communication.history.get-meeting` | read | `read` |
| EVR-240 | `communication.history.get-person` | read | `read` |
| EVR-241 | `communication.history.list` | read | `read` |
| EVR-242 | `communication.messages.send` | effect | `communication.send` |
| EVR-243 | `communication.recipients.list-teams` | read | `read` |
| EVR-244 | `communication.recipients.resolve-group` | read | `read` |
| EVR-245 | `communication.recipients.search-people` | read | `read` |
| EVR-246 | `communication.resends.get-eligible-non-openers` | read | `read` |
| EVR-247 | `communication.resends.send-to-non-openers` | effect | `communication.send` |
| EVR-248 | `communication.templates.create` | effect | `communication.send` |
| EVR-249 | `communication.templates.delete` | effect | `communication.send` |
| EVR-250 | `communication.templates.fork` | effect | `communication.send` |
| EVR-251 | `communication.templates.get` | read | `read` |
| EVR-252 | `communication.templates.list` | read | `read` |
| EVR-253 | `communication.templates.update` | effect | `communication.send` |
### launch

| ID | Exact operation | Kind | Native permission |
|---|---|---|---|
| EVR-254 | `launch.milestone.complete` | effect | `launch.milestone` |
| EVR-255 | `launch.milestone.reopen` | effect | `launch.milestone` |
| EVR-256 | `launch.outcome.correct` | effect | `launch.schedule` |
| EVR-257 | `launch.outcome.record` | effect | `launch.schedule` |
| EVR-258 | `launch.read.journal` | read | `read` |
| EVR-259 | `launch.read.readiness` | read | `read` |
| EVR-260 | `launch.read.status` | read | `read` |
| EVR-261 | `launch.schedule` | effect | `launch.schedule` |
| EVR-262 | `launch.task.set-completion` | effect | `launch.milestone` |
### plant-intelligence

| ID | Exact operation | Kind | Native permission |
|---|---|---|---|
| EVR-263 | `plant-intelligence.assessments.acknowledge` | effect | `phase.declare` |
| EVR-264 | `plant-intelligence.assessments.read` | read | `phase.declare` |
| EVR-265 | `plant-intelligence.attestations.read` | read | `phase.declare` |
| EVR-266 | `plant-intelligence.attestations.set` | effect | `phase.signal` |
| EVR-267 | `plant-intelligence.checkins.read` | read | `phase.declare` |
| EVR-268 | `plant-intelligence.checkins.save` | effect | `phase.signal` |
| EVR-269 | `plant-intelligence.declarations.read` | read | `phase.declare` |
| EVR-270 | `plant-intelligence.declarations.transition` | effect | `phase.declare` |
| EVR-271 | `plant-intelligence.feedback.read` | read | `phase.declare` |
| EVR-272 | `plant-intelligence.feedback.submit` | effect | `self.write` |
| EVR-273 | `plant-intelligence.signals.read` | read | `phase.declare` |
### documents-wiki

| ID | Exact operation | Kind | Native permission |
|---|---|---|---|
| EVR-274 | `documents.generate` | effect | `read` |
| EVR-275 | `documents.history.download` | read | `read` |
| EVR-276 | `documents.history.list` | read | `read` |
| EVR-277 | `documents.templates.list` | read | `read` |
| EVR-278 | `wiki.article.read` | read | `read` |
| EVR-279 | `wiki.bookmark.set` | effect | `self.write` |
| EVR-280 | `wiki.feedback.set` | effect | `self.write` |
| EVR-281 | `wiki.navigation.read` | read | `read` |
| EVR-282 | `wiki.progress.read` | read | `read` |
| EVR-283 | `wiki.progress.set` | effect | `self.write` |
| EVR-284 | `wiki.search` | read | `read` |
### platform

| ID | Exact operation | Kind | Native permission |
|---|---|---|---|
| EVR-285 | `dashboard.summary.get` | read | `read` |
| EVR-286 | `notifications.badge.unread-count` | read | `read` |
| EVR-287 | `notifications.feed.list` | read | `read` |
| EVR-288 | `notifications.feed.mark-all-read` | effect | `self.write` |
| EVR-289 | `notifications.feed.mark-one-read` | effect | `self.write` |
| EVR-290 | `platform.feedback.submit` | effect | `self.write` |

## Rich relational queries and helpers

These are actual model-visible local tools, separate from advertised parity and simple domain-pack readers.

| ID | Tool | Semantics / limits |
|---|---|---|
| EVR-400 | `results.select` | Build a result card from selected rows already returned by compatible list reads in the current turn. Use it to project or combine displayed rows, not to run a new query, compute a new total, or combine incompatible result types. |
| EVR-401 | `people.query` | Search, count, or group people and households, including cohorts defined by stage, tags, skills, recorded-history existence, attendance counts, contact availability, or ministry membership. Use relational filters here when the request needs only cohort membership, not the underlying history records. |
| EVR-402 | `people.get_many` | Read known person or household records with profile, contact, household, tag, skill, or background-check fields. It does not search by name or return interview, assessment, attendance, or other history. |
| EVR-403 | `people.history.query` | Read actual interviews, individual assessments, commitments, notes, activities, or person-linked follow-up history for a people cohort. Use it for record content, dates, or outcomes, not for an existence predicate already handled by people.query or for Plant Intelligence reports. |
| EVR-404 | `attendance.query` | Read event-specific attendance, RSVP, response-card, and linked follow-up evidence across people and meetings. Use people.query instead when only attendance counts are needed to define a cohort. |
| EVR-405 | `tasks.query` | Search, count, or group tasks and checklist rows by status, priority, assignment, dates, links, prerequisites, milestones, or parents. It also exposes the task-template catalog and current phase-template suggestions; use tasks.get_many only when full task or checklist detail is needed. |
| EVR-406 | `tasks.get_many` | Read known tasks with full descriptions, dependency identities, assignees, and checklist contents. It is unnecessary for fields already returned by tasks.query. |
| EVR-407 | `tasks.assignees.search` | Resolve a named eligible task assignee to an account identity or inspect eligible assignment options. It is not a general people directory and is unnecessary when a retained account ID or known person ID already suffices. |
| EVR-408 | `meetings.query` | Search, count, or group existing meetings by date, type, status, team, title, location, preparation state, or evaluation presence. It is not needed merely to create a new meeting unless existing-meeting evidence or a conflict check was requested. |
| EVR-409 | `meetings.get_many` | Read known meetings with agenda, preparation checklist, notes, evaluation, and other full details. It does not search for or choose a meeting. |
| EVR-410 | `teams.query` | Query ministry teams, roles, assignments, people by assignment, rosters, vacancies, leaders, responsibilities, and completion state. Use it for staffing relationships; people stages alone do not establish ministry assignments. |
| EVR-411 | `teams.get_many` | Read known teams or roles with full details, roster, responsibilities, skills, time commitment, background-check requirement, and required training. Use teams.query first when the team or role identity is unknown. |
| EVR-412 | `training.query` | Query training programs, role-derived requirements, and recorded completions by person, team, role, program, completion state, or date. It does not provide certification or background-check expiry dates. |
| EVR-413 | `communication.query` | Search, count, or group messages, recipient deliveries, templates, or distinct recipients, including failure and retry evidence. Use communication.get_many when full message or template content is required. |
| EVR-414 | `communication.get_many` | Read full subject, body, placeholders, and resend-relevant content for known messages or templates. It does not search for IDs or return per-recipient delivery rows. |
| EVR-415 | `documents.query` | Search document-generation templates or generated-document metadata, including formats, placeholders, history, and download links. It does not read document contents. |
| EVR-416 | `documents.read` | Read bounded text with citations from known generated PDF, DOCX, or XLSX documents. It does not search arbitrary uploads, local files, or the filesystem. |
| EVR-417 | `wiki.search` | Search or browse visible published wiki articles and return ranked passages, article identities, and citation slugs. Use wiki.read_many for full surrounding article content. |
| EVR-418 | `wiki.read_many` | Read bounded content for known visible wiki citation slugs, including section and reading-progress evidence. It does not search for articles. |
| EVR-419 | `launch.query` | Read launch status, milestones, milestone-linked tasks, and journal events, including recorded blocking relationships. It does not reconstruct past task or staffing state from current records. |
| EVR-420 | `intelligence.query` | Read stored Plant Intelligence assessments, insights, attestations, transitions, check-ins, feedback, or operational signals. Use it for stored report claims and report-time evidence, not individual People assessments or a newly generated judgment. |
| EVR-421 | `notifications.query` | Read, count, or group the current account's notification feed by unread state, category, source, or entity. Reading the feed does not mark notifications read. |
| EVR-422 | `files.inspect` | Inspect an authorized conversation-attached People CSV and return import-preview rows, duplicates, and validation issues. It does not import records or inspect arbitrary URLs, documents, or filesystem paths. |
| EVR-423 | `people.commitment-download` | Return a download link for the document attached to a known commitment. Use people.history.query first when the commitment identity is unknown. |
| EVR-424 | `context.get` | Read the authoritative current phase together with the server reference time, church-local date, and timezone. Use it when those shared facts are themselves needed, not when a domain query already handles the requested date period. |
| EVR-425 | `calendar.resolve` | Resolve a relative date, period, weekday, omitted-year date, or local meeting time against the church clock and timezone. Use it when another capability needs explicit calendar bounds or DST-aware time resolution, but omit it when the target query natively handles the requested period. |
| EVR-426 | `locations.query` | Search or list saved active meeting locations and return their identities, addresses, and capacity. Use it for venue discovery, not general facility or lease research. |
| EVR-427 | `locations.get` | Read one known saved meeting location with its address, capacity, and active state. It does not search by name. |
| EVR-428 | `templates.for_meeting` | Read the full invitation subject, body, and placeholders for a known meeting type, honoring the plant's visible template fork or default. It is the direct template reader for meeting invitations and does not send or prepare a message. |
| EVR-429 | `actions.status` | Read the saved status and recorded step counts of the current conversation's existing review. Use it when whether the review was only prepared or later applied is uncertain; it does not provide email-delivery evidence. |

`actions.prepare` is the31st baseline catalog entry; it is infrastructure, not a read/helper.117 exact preparations are enumerated in `preparation_operations` in the surface inventory. Native tool files: `ask_question`, `capability`, `code_mode`, `draft_get`, `draft_update`, `load_skill`, `load_tools`, `todo`. Authored skills: daily-work, interview-review, meeting-invite, meeting-followup, staffing-review, launch-review, delivery-recovery, import-review, prospect-outreach, task-cleanup, insight-to-action.

## Visible and hidden API/UI

Historical endpoints cover request policy, conversations/messages/artifacts, run observation, eligibility probe, datetime resolution, plan confirm/execute/audit and guarded preview fixtures. Local adapters add recipe reuse, Eve session/current-plan recovery (GET read; POST confirm/retry/cancel/edit), private attachments/staging/cleanup, CSV export/template and commitment download. Full exact handler list and exported source symbols are in the machine inventory. Preview fixture endpoints are test tooling, not customer functionality.

The Eve transport allowlist is `POST /eve/v1/session`, `GET|POST /eve/v1/session/:sessionId`, `GET /eve/v1/session/:sessionId/stream`, `POST /eve/v1/session/:sessionId/cancel`, `GET|HEAD /eve/v1/health`. It excludes remote callbacks, webhooks, arbitrary file endpoints and subagents. These are historical runtime exposure choices, not unapproved v3 removals.

UI includes global launcher, contextual panel, durable `/evry` workspace/search, page-context chips, suggestions, typed read/clarification/Settings/review/progress/result/boundary cards, submit/steer/cancel/retry states, unsent draft retention, streamed evidence cards and focus/scroll recovery. Confirm/Edit/Cancel are trusted application controls. Model text saying yes is not approval.

## Named variants that require separate preservation gates

Three installed local preparation aliases refine broader feature identities. They remain subfeatures of the existing records, rather than duplicate rows for all 117 preparation aliases. Their source is local commit `b3bb9f52`, not current main/alpha.

| Owning feature / named variant | Actual implemented behavior | Specific v3 acceptance |
|---|---|---|
| EVR-242 `communication.retry_failed` | `preparations/content.ts` routes to Communication send with an exact failed source. `communication/failed-retry.ts` accepts only failed email recipients with proven `provider_delivery_failed`, provider external ID and no delivery/open/click evidence. It excludes uncertain acceptance, legacy/null failure provenance, bounce/suppression, deleted people, changed email and claimed sources. The reviewed cohort is limited to 100. Source→retry-child uniqueness, fresh source/suppression authorization checks, frozen outbound bytes and a stable effect+child provider key protect retry. Attempts stop 23 hours after the first provider attempt; no replacement key bypasses expiry. | `AC-EVR-242-FAILED-RETRY`: fixture every eligibility exclusion; prove exact ≤100 cohort; concurrent claims produce one child per source; changed eligibility excludes dispatch; crash/retry reuses child/outbound/key; expiry refuses. Sources `src/lib/communication/failed-retry.ts`, `evry-send.ts`; tests `failed-retry.test.ts`, `scripts/evry-eve-failed-retry-fixture.test.ts`, `evry-eve-communication-retry-fixture.test.ts`. |
| EVR-289 `notifications.mark_selected_read` | `preparations/content.ts` builds one exact reviewed subset of 1–10 deduplicated IDs, using `notifications.feed.mark-one-read` steps. The current actor must own those unread notifications. It is distinct from one-read and all-read scopes. | `AC-EVR-289-SELECTED`: selected owned notifications change once; unselected unread notifications remain unread; foreign/stale IDs refuse or report precise exclusions; >10 rejects. Sources `src/lib/evry/capabilities/platform/effects.ts`, `preparations/content.ts`; test `scripts/evry-eve-selected-notifications-fixture.test.ts`. |
| EVR-015 `recipe.meeting-invite` | Eve preparation resolves `meeting.invitation.reference`: create-meeting →add-guests →send-invitations. Guests bind the actual persisted meeting output; invitation send depends on guests. One review shows exact type/date/time/zone/duration/location/audience/exclusions and subject/body. All steps declare same-plan retry. An existing meeting invitation uses `communication.send`. Reuse resolves fresh facts and requires new approval. | `AC-EVR-015-MEETING-INVITE`: create one meeting and correct guests/send targets; missing/failed dependencies block later steps; invitation failure/reconnect preserves created outputs; retry never recreates the meeting/guests or completed sends. Sources `src/lib/evry/eve/preparation/index.ts`, `recipes/meeting-invitation.ts`, `capabilities/meetings/dependency-output.ts`; tests `meeting-invitation.test.ts`, `meeting-invitation-reuse.test.ts`, `scripts/evry-eve-orientation-invitations-fixture.test.ts`. |

## Tables and important relations

| Table | Actual purpose / relations | Current disposition | v3 target |
|---|---|---|---|
| evry_action_plans | Immutable actor/church/request-bound document, canonical fingerprint, supersedes relation. | Retained; dead runtime. | Proposal revision. |
| evry_action_plan_states | Mutable status/version for exact immutable plan+church FK. | Retained; dead runtime. | Proposal state/version; may combine header if immutable revision remains separate. |
| evry_plan_confirmations | Unique exact actor/church/fingerprint approval relation. | Retained; dead runtime. | Approval bound to proposal revision. |
| evry_product_audit_events | Closed append-only request/plan lifecycle; unique event keys. | Retained; dead runtime. | Shared command audit with assistant origin/correlation. |
| evry_execution_attempts | Exact plan/proposal/confirmation FKs and attempt key. | Retained; dead runtime. | Command run/attempt. |
| evry_execution_effect_claims | Unique effect/step claim with repeated attempt/actor/plan identity. | Retained; dead runtime. | Shared command idempotency +execution-step uniqueness. |
| evry_execution_outcomes | Attempt/step receipts, counts, effect key, closed shape. | Retained; dead runtime. | Durable step outcomes; partial/unknown retained. |
| evry_conversations | Actor/church private header, title, sequence/activity and active exact plan FK. | Retained; dead runtime. | App-owned conversation. |
| evry_conversation_states | Versioned bounded validated references/choices/clarification state. | Retained; dead runtime. | Verified context state separate from model notes. |
| evry_conversation_messages | Sequence/request uniqueness, request fingerprint, author/page context/relevance/delivery. | Retained; dead runtime. | Durable message/turn replay identity. |
| evry_conversation_artifacts | Scoped message FK, ordinal and typed versioned document. | Retained; dead runtime. | Typed artifact or result reference. |
| evry_active_runs | Unique actor/church/request claim, lifecycle/version/expiry, optional exact plan FK. | Retained; dead runtime. | One run protocol and observer. |
| evry_eve_sessions | Framework ID→generated conversation ID +actor/church ownership/archive; generated conversation ID has no legacy-conversation FK. | Retained; dead runtime. | Optional provider reference on one app-owned conversation. |
| evry_eve_attachments | Local session/actor/church private reference/hash/digest/kind/expiry, unique session+hash. | Local-only schema. | Shared staging handles with owner/session/tenant/digest binding. |
| communication_failed_retries | Local-only source-recipient primary key →unique retry recipient; church and exact Evry plan FK; frozen outbound/first attempt snapshot. `src/db/schema/communication.ts#communicationFailedRetries`, migration0080 at b3bb9f52. Absent current main/alpha. | Local-only adjacent domain schema. | Shared delivery retry claim/outbox with source-bound idempotency. |

No customer migration: create new proportional schema only. Preserve v2 historical data/applied migrations. `evry_eve_attachments` session FK alone does not prove matching actor/church; service joins enforce it. V3 should encode ownership with composite FKs or equivalent transaction predicates.

Historic plan states: draft→awaiting_confirmation→approved→executing→completed|partially_failed|failed; pre-execution cancel/supersede; review/approved expire. Terminal plans are not simply re-approved. Recipe retries reuse durable completed dependencies and only repeat declared safe steps. GET recovery observes; disconnect never authorizes duplicates. No general v2 undo tool was found; correction/reopen domain operations exist. V3 undo requires command-specific compensation.

## Concrete lessons and limitations

1. Local advertised parity contains251 surfaces (67 routes +184 actions),179 supported, 70 excluded, 2 unreachable, 0 unclassified. That source classification is not the installed or evaluated assistant surface. Keep three ledgers.
2. Typed preparations convert back to native form strings in Teams; domain effect files repeat SQL/snapshots separate from UI actions. Extract one typed domain command handler, reuse for UI/Evry, keep proposal disclosure separate.
3. Legacy app history, Eve checkpoint/session, model task notes, pending review, result caches and receipt presentation duplicate ownership and serializers. Keep one app-owned conversation/run/proposal, bounded verified context and optional runtime checkpoint.
4. Patched Eve compaction recovery is a maintenance burden. Preserve saved transcript/retry semantics; compare a plain AI SDK runner before retaining framework patches.
5. Cursor/Unicode continuation parsed from display facts is brittle. Return typed cursor/completeness fields; exhaustive history requires all pages/notes, and separate reads do not establish atomicity.
6. Preserve query meaning: today excludes overdue; RSVP is not attendance; current signals are not historical assessments; role groups are not distinct teams; team responsibilities have no individual assignee; missing future launch outcomes are not readiness gaps.
7. Jev routing experiments are not end-to-end proof. Tuned exact repeat accuracy72.6%; minimal-input exact combinations55–71/158; known holdout and different routing/planning oracle. Keep hints advisory.
8.158 scenarios/hundreds of test files do not mean every feature passes.48 unbound scenarios, integration hold, latency/repeated prose and browser acceptance remain evidence gaps.
9. V3 first-class operational scope is required; final autonomous write authority remains an explicit decision. Proposed starting policy is reviewed writes.
10. Alpha corrections/new role/task behavior must replace stale local domain snapshots before v3 implementation. This audit did not rerun live QA or modify sources.

## Accepted target amendments · 2026-10-03

PD-001 accepts reviewed writes as the initial Evry authority; every durable change requires exact human review/approval. PD-002 excludes private weekly check-ins from every Evry tool/model context. Historical EVR-267/268 read/save adapters remain evidence but are prohibited in the target assistant catalog; native PI-038/040/041 retain entry, history and correction capability. This is an explicitly user-approved assistant access restriction, not deletion of the private-care product. Other historical capability inventories remain preservation targets unless separately decided.

Authority and exact discussion provenance: [five accepted product rulings](../decisions/user-rulings.md). Central feature target decisions and acceptance gates are amended; detailed source audit JSON remains the original observed evidence. These five decisions do not establish holistic architectural readiness or approve starting implementation.
