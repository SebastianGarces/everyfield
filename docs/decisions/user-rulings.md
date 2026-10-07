# Accepted product rulings

These five user decisions amend the future v3 target as of 2026-10-03. The SME Playbook and Plant Intelligence rubric remain authoritative. Source inventories, v2 behavior descriptions and historical reviews retain their original evidence meaning. No application behavior has been changed.

The machine-readable authority is [user-rulings.json](user-rulings.json). Each source ID identifies the user discussion supplied by the parent thread; these IDs are provenance, not public URLs.

## PD-001 · Evry uses reviewed writes

**Accepted:** OD-003 · 2026-10-03. Source: `Sentinel_db80dbb114bc8191879f652e7b218520`. User response: “I think review first makes sense, we can improve on that later”.

Authorized reads and non-persistent drafts may run immediately. Every durable Evry change requires human review and approval of the exact proposal before execution. Autonomous mutation classes are deferred; future exceptions require a new decision.

Features: All durable Evry domain operations. Packages: WP-051, WP-052, WP-053, WP-055.

## PD-002 · Private weekly check-ins remain outside Evry

**Accepted:** AR-01 · 2026-10-03. Source: `Sentinel_5ea77666a3e0819185af69fd4dda5d7a`. User response: “this makes sense”.

Initially exclude private weekly check-in answers, notes and history from every Evry tool and model context, while preserving native planter-only entry, corrections and history. An ordinary Owner grant is not permission to transmit these records to a model. Any future access to explicitly selected entries requires a new product decision. Coaching, network and oversight access is not broadened.

Features: PI-038, PI-039, PI-040, PI-041, EVR-267, EVR-268. Packages: WP-039, WP-052, WP-053, WP-073, WP-074.

## PD-003 · Recording preserves an advanced person stage

**Accepted:** OD-004 · 2026-10-03. Source: `Sentinel_f6d0ee30ec08819184f42303a10d74bb`. User response: “yes, that’s correct”.

Recording another interview or commitment preserves an already advanced person stage. Only an explicit stage-change action may demote the person. Interview outcomes, human judgments and commitment meaning remain intact; this ruling does not invent additional progression rules.

Features: PPL-013, PPL-014, PPL-015, PPL-020. Packages: WP-014, WP-015, WP-022, WP-023.

## PD-004 · First-time Vision attendance uses Vision history

**Accepted:** OD-018 · 2026-10-03. Source: `Sentinel_451520044bb88191b3478d221c245408`. User response: “yes”.

First-time Vision attendance is based on prior attended Vision meetings. Attendance at an unrelated team or ministry meeting does not make someone a returning Vision attendee. Invitations and RSVPs are not attendance. Use the existing chronological meeting basis, and preserve the distinct committed/core-group classification. The automatic first-time Vision follow-up uses this definition.

Features: MTG-010, MTG-012, TSK-011. Packages: WP-022, WP-023.

## PD-005 · Separate follow-up outcome from task completion

**Accepted:** OD-017 · 2026-10-03. Source: `Sentinel_69ba9a0452108191a71460286605ee2c`. User response: “That makes sense”.

Record contacted, attempted but no contact, administrative completion, and no longer needed as distinct follow-up outcomes. Only confirmed contact updates actual-contact freshness. Task completion is measured separately; completing a person-linked administrative task or logging an attempt does not establish contact. No longer needed remains closure without successful-completion credit.

Features: TSK-003, TSK-004, TSK-011, COM-011, PI-013. Packages: WP-023, WP-024, WP-025, WP-029, WP-040.

## Remaining work

[Other decisions](../open-decisions.md) and [architectural review findings](../reviews/astra-implementation-readiness-review.md) remain open unless explicitly marked accepted above. Complete the holistic plan and resolve architectural/product interactions before implementation. Staged slices describe eventual execution order; passing a first-slice prerequisite gate is not approval or readiness to begin the whole rebuild. No new rubric, church-phase, commitment, prayer, pastoral judgment or coaching disclosure rules are approved here. Exact contract shapes and concurrency evidence remain implementation acceptance work.
