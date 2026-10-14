# Glossary

These terms describe the approved requirements. They do not prescribe code names or grant access.

| Term | Meaning in EveryField |
|---|---|
| Receipt | A durable record of an operation and its known outcome. An exact retry returns the existing receipt instead of repeating committed effects. A receipt can report partial completion or an unknown external outcome. Provider acceptance does not prove delivery. Tooling also uses receipts to bind reviewed authorization or proof to a particular task and revision. |
| Projection | The fields and records a caller may see for a particular purpose. The server derives this view from current rights and sharing rules. A saved result, affiliation or earlier response does not grant continuing access to its source records. |
| Witness | A minimal, body-free record of current deletion or access-revocation authority. Lifecycle witnesses distinguish pending deletion, cancellation and completed purge. Restore must apply current witnesses before reopening access, so an old backup cannot revive revoked access or reset expiry. |
| Subject | The account, plant, organization or other record an operation concerns. The subject can differ from the actor who requests the operation. Permission must cover that subject and the requested purpose. |
| Unknown | A fact or outcome that available evidence cannot establish. Missing evidence is different from zero, a recorded false answer or a confirmed failure. An unknown provider outcome requires reconciliation before another attempt; it is not permission to repeat an effect. |
| Source revision | The version of a particular source record or published content used by a read, calculation or reviewed change. Expected revisions detect edits made after review. Reading evidence pins the published article revision that the person actually read. |
| Material revision | A monotonic freshness counter for assessment-relevant facts. Database triggers advance the affected plant's counter in the same transaction as a relevant fact change; organization results also have a revision fence. One command can change several rows and advance the counter more than once. It is not a command count. Stale assessment work cannot publish against a newer revision. |

See [core transactions](../architecture/core.md), [access and projections](../architecture/security.md), [assessment freshness](../architecture/assessment.md), [lifecycle and recovery](../architecture/recovery.md) and [reading evidence](knowledge-documents.md). Requirement JSON remains the behavior authority.
