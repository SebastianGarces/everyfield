# Architecture decisions

These owner and coordinator rulings govern the current build. Later rulings override earlier mechanisms. [Everyfield patterns](patterns.md) records the current implementation defaults; requirements and acceptance cases define product behavior.

## D59, 2026-10-19: one actor per request

Resolve the verified session, account, selected owner and seat once per server request and share that context across its callers. Domain reads accept it; writes confirm current authority when changing data. Prefer a short shared read transaction where practical and count page round trips. This removes repeated actor resolution. D60 and D64 refine the authentication mechanism; D70 refines write checks; C13 refines read checks.

## D60 and its update, 2026-10-19 and 2026-10-22: standard request authentication

Use a server-only data access layer with one cached session lookup through auth.api.getSession and one cached viewer lookup per request. The proxy checks cookie presence only for redirects; real authorization stays on the server. Domain reads receive the verified viewer. This replaces synthetic requests through the identity handler and hidden proxy routing headers with the supported framework pattern.

Update, 2026-10-22 (RT-1, RT-3, RT-4): the session lookup and the viewer lookup are now one cached statement per request. It reads the session, its user and the viewer by the token of a cookie whose signature the server has verified. auth.api.getSession runs only when that statement finds no live session, so Better Auth deletes the expired row and clears the cookie, or when the session is due for its expiry extension. D64 still holds: the cookie cache stays off and every request reads the database, so a revoked session fails on the next request. A simple write request then sends the session statement and its write: one statement on the one-statement path, or BEGIN, the write gate, its locked reads, the write and COMMIT on the established path (C88). tests/integration/writes/statements.test.mts counts every statement of real HTTP requests on the production build and holds each request, write and page variant to the count in limits.json.

## D64 and its update, 2026-10-19: cookie cache stays off

Use the framework's session cookie, request cache and optimistic proxy redirect without custom authentication layers. The initial five-minute cookie-cache proposal was withdrawn the same day. The current ruling keeps Better Auth's cookie cache off: auth.api.getSession checks the database once per request inside React's request cache, so a revoked session fails on the next request. This preserves immediate revocation while removing duplicate session lookups.

## D65, 2026-10-19: one app-wide authentication path

Every server mount uses the shared cached session/viewer lookup. Use one shared web database pool, retaining a separate role only where a distinct login requires it. Move onboarding and organization data reads into the domain and delete per-mount pools and synthetic session requests. This applies the same behavior across the app without duplicate authentication and connection machinery; behavior and tests remain unchanged.

## D66, 2026-10-19: code quality is part of review

Every verifier review includes a Code quality section with concrete simplifications and a verdict. Check laziness-protocol, minimize-reader-load, subtract-before-you-add, test-behavior-not-implementation and other principles the change touches. Working code that adds needless layers, duplicates patterns or keeps dead code still requires changes. Acceptance alone cannot establish maintainable implementation.

## D67, 2026-10-19: People uses page numbers

People lists, cards and pipeline columns use page numbers with 24-row UI pages and filters in the URL. The server derives the church from the session; URLs carry no owner, query hash or signature. Filter changes return to page one. A page past the end shows the last page or an empty state, never an error. This removes cursor signing, page trails and expired-cursor recovery, superseding D50 and the cursor portions of D46/D47. Person detail has no cursor; activity history describes authorized paging rather than a cursor representation.

## D68, 2026-10-19: one fast pipeline move

One move uses one server action and one transaction to change stage when needed and set position. Return only the changed columns' order and relevant state with one query per changed column. The UI updates optimistically and reconciles the answer without a page refresh; warnings load with pipeline data or when the stage dialog opens, not on every move. Target under 300 milliseconds of server time on a production build from Sebastian's Mac, with a fixed small query count. This removes the repeated requests and full rereads that made dragging slow.

## D69, 2026-10-19: bounded write work

Every simple write uses a fixed small statement count, about four to six in total, with a production target under 100 milliseconds. Reuse the verified viewer, combine authority and required bookkeeping where possible, batch row changes and return only changed data. History records changed fields unless a product requirement needs full snapshots. Each module checks statement counts for its writes. This removes one round trip per bookkeeping step and work that grows with row count; D70 defines the shared audit and retry mechanism.

## D70, 2026-10-19: shared write and audit patterns

Follow [Everyfield patterns](patterns.md): authority in the write, one append-only audit record with permitted changed fields, request keys only for repeatable actions, conflict checks where concurrent edits require them, and recoverable jobs for side effects. Replace redundant operation, result, event and history bookkeeping with the shared audit record. Audit, privacy, safe retries and recoverable consequences remain required; a deviation needs a product reason in the PR. This keeps writes small without dropping product behavior.

## 2026-10-19: performance budget and optimistic UI

Every simple read or write completes in under one second end to end on a production build. Reports and analytics may take longer with the exception stated in their PR. Actions update the screen optimistically and confirm or clearly roll back on failure; verification checks smoothness and needless requests. The budget measures the person's experience, not just an isolated database statement. A review judges the actions a PR changes: slowness that main already has, measured with the same setup, is recorded in the review with its owning task and does not count against the PR, while a PR that makes an action slower than main fails the budget. The Settings section full load of 1.1 to 1.4 seconds on main 6ac8e8d is pre-existing and belongs to [Settings section pages load under 1 second](intent://local/task/cee6d6b9-c0a5-45a9-8de0-4a29d0688adf).

## 2026-10-19: requirements describe the end state

Requirements and acceptance cases preserve product behavior and case IDs while leaving tables, receipts, revision fields, locks and execution machinery to the implementation patterns. This prevents a chosen mechanism from becoming a permanent product obligation.

## 2026-10-19: S1 waits for simplification

Do not start S1 until the simplification phase is complete and reviewed: decide patterns, remove mechanism prescriptions, apply the patterns to shipped code, encode budget and smoothness checks, and review every shipped module. This prevents later features from copying the current complexity.

## D71, 2026-10-19: durable rules live in the repository

Keep durable rulings here and implementation defaults in [Everyfield patterns](patterns.md), with short pointers in the agent instructions and roles. Use repository links between these documents because other workspaces cannot read this workspace's notes.

## D72, 2026-10-19: plan and schema grow with features

The plan keeps packages, dependencies, owning paths, product features and acceptance case IDs. It does not prescribe outputs, interfaces or mechanism gates. After the writes round, remove tables no shipped feature reads or writes while retaining authentication, early-access data and the migration ledger. Later packages design and migrate their own tables when their features are built and tested. This avoids implementing a speculative whole-app schema. D73 supersedes the original separate production-approval requirement before customer launch.

## D73, 2026-10-19: migrations before customer launch

Sebastian confirmed that the product has no customers yet. Until launch to real customers, schema changes and their production migrations need no separate owner approval. Preserve the early-access tables and their rows, which contain real sign-ups from the WP-097 site. Revisit this rule when the product ships to real customers. This changes migration approval only; spending, credential, deployment and merge authority still applies.

## D74, 2026-10-20: preview slots

The preview supervisor runs four previews at a time. The managed portless launcher in the home bin folder sets the preview limit environment variable to 4. The supervisor reads it when it starts. Builders and verifiers get preview slots first. The coordinator may stop Sebastian's review preview at any time to free a slot and restarts it later on main. No agent stops a preview that belongs to another workspace. This keeps build and verification work moving without losing anyone else's running preview.

## D75, 2026-10-20: S1 plan review

Sebastian approved the S1 plan review. A case is an acceptance gate for a package only when that package or one of its dependencies owns every operation the case calls; the package context plan check enforces this, and the case-action baseline is empty. WP-016, WP-021, WP-052 and WP-060 are retired into WP-017, WP-020, WP-051 and WP-059. Tables on main are not a contract: S1 briefs say so, and the schema reference is labelled as the current schema on main. The internal Evry steps evry.claimEffect, evry.appendAudit and evry.recordEffectResult are no longer catalog operations; an executed effect writes its audit record with the change. Their former authority rule, "required owning domain consequence or bounded operator protocol", now applies to evry.executeProposal. This keeps every gate provable when its package closes and keeps requirements free of mechanisms.

## D76, 2026-10-21: migration numbers follow main at merge time

Parallel api parts pick the same migration number: in wave 1, PRs #177 to #180 all added 0016, and three of them renumbered by hand and waited for a new review. A branch now renumbers its new migrations when it includes main: the evf migrations renumber command moves them after main's last number and rebuilds the Drizzle journal and snapshot chain from main's files plus the branch's own changes, and evf verify, pr open and ship refuse a number that main already uses. Reviewed SQL bytes stay the same; a table that main and the branch both change needs new generation on current main. This replaces D31, where the coordinator allocated numbers before each wave.

## C13, 2026-10-21: live access inside every tenant read

In S1, PR #178 (task reads), PR #180 (Evry reads and stream) and PR #181 (Settings reads) each had a read that trusted the request actor resolved at the start of the request. A seat that ended or a role that changed after that lookup still read tenant data. A read that returns tenant data now checks the live session, seat, role and lifecycle inside the same statement, with no extra statement. D59 and D60 still apply: one cached viewer lookup per request identifies the actor, and each read checks that the actor still has access. Main has no shared fragment for the whole check. The access.writeVisibility fragment covers lifecycle only. PR #180 adds a fragment in packages/evry/src/context/authority.ts that checks session, seat and lifecycle but not role. A shared fragment in packages/domain/src/access/ that also checks role is a follow-up. This closes the gap between the first lookup of a request and each later read.

## D77, 2026-10-21: Evry model spending during development (G-SPEND, Q1)

Sebastian approved paid model use for Evry during development: "in regards to G-SPEND we are prob looking at $40/mo tops during development... We are likely to use GPT luna". Evry uses OpenAI gpt-6-luna through the AI SDK, the exact id the OpenAI models list returned on 2026-10-21. A deployment selects it only when its server environment sets EVRY_MODEL=gpt-6-luna and OPENAI_API_KEY. Each database keeps a monthly spend counter. Before the provider sees a paid model call, the call reserves its worst-case cost in one statement, which refuses it when the month would pass EVRY_MONTHLY_CAP_USD (default 20 USD). The worst case counts one input token for each UTF-8 byte of the request, which no byte-level tokenizer exceeds, plus the call's output limit, at the long-context price when the bound passes 272,000 tokens. The call then settles to its reported usage. A call that never reports usage keeps the whole reservation, and deleting conversations never lowers the counter. The shared development database and production together therefore stay within 40 USD. Automated tests and CI use only the scripted model and make no paid calls. A different model or a higher limit needs Sebastian's approval again.

## D78, 2026-10-22: migrations apply by name and new ones take a timestamp

Sequential migration numbers made 15 renumber commits in one day, #193 alone five times, and a renumbered head cannot carry an approval (velocity audit P3). The runner now applies every file in packages/db/migrations that schema_migration lacks, by name and in name order, and still refuses an applied migration whose bytes changed. The generate command names a new migration by its UTC creation time in 14 digits (YYYYMMDDHHMMSS), an underscore and its name, with no Kit journal entry and no snapshot of its own. One snapshot, migrations/meta/current.json, is Kit's diff base, and two branches that change different tables change it in separate places. A branch no longer renumbers. After it includes main, it changes only when both sides changed the same table, and then it generates its migration again on current main. Numbered migrations keep their names, journal entries and snapshot chain. A branch that already has one may extend the numbered chain until the first timestamped migration reaches main; the evf renumber command and number check still guard those branches. This supersedes D76.

## D79, 2026-10-22: evf ship queues and updates behind branches (OPS-40)

On 2026-10-21 the S1 coordinator ordered ships by hand (C45, C59, C61, C67), because each merge to main left the other approved PRs behind main and their gates invalid. Branch protection requires an up-to-date branch. evf ship now waits in one machine-wide queue in the home checkout's Git folder, first come first served, and a stopped holder loses the lock. Inside the queue it merges main into a behind branch with gh pr update-branch, waits for required CI on the new head and merges only when the approval carries under the EVF-Carry rule. When main changed a path the PR changes, or CI fails, ship refuses with "Fresh gate needed". Owner routes from PR #13 are unchanged. This replaces C45, C59, C61 and C67; coordinators no longer order ships.

## D80, 2026-10-22: machine load limit in evf (OPS-40)

Load on the shared Mac reached 60 to 136 on 2026-10-22, and Portless answered 502 under that load. The S1 rulings C51 and C81 asked agents to check uptime and wait while the 1-minute load is above 24 (two per core on 12 cores). evf now enforces it: task start, verify and browser run wait while the load is above 2 × CPU cores, print one line per minute and stop after 30 minutes. An optional machine load setting in evf.config.json overrides the default in tools/evf/load.ts. An --ignore-load reason runs at once and evf logs it. Tests of Portless itself use their own state folder and never restart the shared service, because one restart at 02:04 UTC removed every live preview.

## 2026-10-23: Everyfield brand spelling (OPS-44, WP-103)

Sebastian said: "Go with the lead's suggestions, and also change the Wiki seed through the Wiki approval route." The brand spelling is "Everyfield". OPS-44 changes documentation and workflow copy, including the early-access mail acceptance fixtures. WP-103 changes app copy and email and notification text (R2). Wiki F6 changes the published Wiki seed through its approval route.

Keep the legacy spelling permanently in the DB default and migrations (R1), stored phase-history reasons (R3), frozen reference files (R4) and the recorded kickoff quote (R6). These include docs/schema/target.json, docs/schema/schema-diagram.html, docs/acceptance/intelligence.json, docs/product/methodology-intelligence.md's quoted declaration reason, docs/reference/ outside the Wiki seed, and docs/plan/release-gates.json. Lowercase identifiers, paths, URLs, domains, buckets and storage keys stay unchanged. The production EMAIL_FROM display name and social preview caches stay with Sebastian.

Sebastian chose "Exemption, start soon (recommended)" on 2026-10-23. Only WP-103 may declare the copy-only overlap exemption, linked to this ruling. It owns the narrowest directories for the selected copy files, excluding apps/web/README.md and bin/wiki, and adds no prerequisites or future dependents. It changes text only: no logic, schema, route or file moves. Every other plan and merge check stays in force. An open PR that changes the same files as WP-103 needs a new review after WP-103 merges under the evf ship fresh-gate rule. The exemption avoids adding a copy change to future packages' prerequisite chains; it does not carry their reviews across overlapping changes.
