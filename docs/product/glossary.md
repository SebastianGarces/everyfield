# Glossary

These terms describe approved behavior. They grant no access and prescribe no storage or code names. Default mechanisms follow [EveryField patterns](intent://local/note/df294729-367b-493b-9faf-654cf6b25b62).

| Term | Meaning in EveryField |
|---|---|
| Receipt | A truthful saved outcome shown where an action requires it. A retry returns the known result without repeating committed effects. A separate receipt object or table is not required. A receipt can report partial completion or an unknown external outcome. Provider acceptance does not prove delivery. Tooling also uses receipts to bind reviewed authorization or proof to a particular task and revision. |
| Projection | The fields and records a caller may see for a particular purpose. The server derives this view from current rights and sharing rules. A saved result, affiliation or earlier response does not grant continuing access to its source records. |
| Witness | A minimal, body-free record of current deletion or access-revocation authority. Lifecycle witnesses distinguish pending deletion, cancellation and completed purge. Restore must apply current witnesses before reopening access, so an old backup cannot revive revoked access or reset expiry. |
| Subject | The account, plant, organization or other record an operation concerns. The subject can differ from the actor who requests the operation. Permission must cover that subject and the requested purpose. |
| Unknown | A fact or outcome that available evidence cannot establish. Missing evidence is different from zero, a recorded false answer or a confirmed failure. An unknown provider outcome requires reconciliation before another attempt; it is not permission to repeat an effect. |
| Source revision | The version of a particular source record or published content used by a read, calculation or reviewed change. Reviewed edits must detect relevant changes made after review without requiring a revision column. Reading evidence pins the published article revision that the person actually read. |
| Material revision | A legacy fixture label for assessment freshness. Relevant committed input changes make old work stale; retries, failed changes, no-ops and private care do not create new assessment evidence. It prescribes no stored counter or trigger. |

See [core transactions](../architecture/core.md), [access and projections](../architecture/security.md), [assessment freshness](../architecture/assessment.md), [lifecycle and recovery](../architecture/recovery.md) and [reading evidence](knowledge-documents.md). Requirement JSON remains the behavior authority.
