# Global reference releases

Global references use immutable reviewed generations and atomic activation. The approved starter inventory is checksummed in the [bootstrap manifest](../reference/bootstrap/manifest.json). The [reference inventory](../reference/manifest.json) preserves the original Playbook, rubric and templates. Seven system message templates are distinct from eleven generated-document templates. Original reference bytes remain unchanged.

Editorial conflict with the authoritative SME rubric/Playbook requires content-owner resolution before activation. Accepted starter inventory does not authorize rewriting methodology. Customer records, private organization content, reader state, credentials and unversioned vectors are excluded from bootstrap. There is no customer migration requirement.

## Identities and manifest

`reference_item` identifies canonical articles, sections and packaged definition kinds. `reference_version` pins packaged reviewed artifacts. `article_revision` owns published article versions. `reference_release` binds candidate manifest, hashes and derivative profile; `passage` holds source-bound text and vectors. Every version preserves exact source/hash and owner, not a display name as identity. The six canonical Discovery article IDs are explicit.

The reviewed manifest pins topology, source revisions, content hashes, required templates, rubric/Playbook versions, chunking profile, embedding model/dimensions and expected derivative keys/checksums. Repeated deterministic content/chunk construction yields the same manifest. Provider vectors have stored checksums and model provenance; generation is not assumed bit-identical.

`reference_activation` is append-only. The serving release is derived from the highest committed `reference_activation.activation_number`, not another editable active flag. `reference_activation.previous_id` records lineage. Activation and rollback compare the expected current activation under one serialized boundary. Concurrent promotions have one winner; the loser revalidates against the changed state.

## Complete activation boundary

A candidate cannot activate with missing, duplicate, obsolete, dimension-invalid or mismatched source/derivative keys. Validate article/section/template topology, safe content grammar, required Discovery identities, supported formats, source/rubric/Playbook coherence and absence of customer/secret canaries. Global curated MDX uses reviewed safe components without arbitrary imports or expressions. Organization editor content never executes MDX.

Same immutable ID/hash replay is a no-op; changed bytes under that ID conflict without overwriting source or tenant work. Bounded reference-generation work carries current manifest and claim fences. A stale worker cannot mark a candidate complete. Existing vector rows without provenance are not proof of readiness. Partial or failed builds leave the prior complete release serving with truthful diagnostics.

An authorized reference operator reviews the complete manifest, diff and real validation receipt. One transaction commits activation/history/audit/receipt and the coherent eligible publication mapping. Readers cannot see half a new corpus or a mix of old/new content and derivatives. Provider/model calls stay outside locks. Postcommit cache/wake-up failure does not undo durable activation; consumers resolve current activation and entitlement.

## Consumers and rollback

Assessment snapshots pin exact activation, rubric, policy and immutable sources; publication compares current activation plus source/claim fences. A new activation invalidates stale publication without rewriting historical results. Citations preserve canonical source/revision lineage and require current body entitlement on every read.

Organization Wiki edits are live per-article publication under own-org authority, without an organization-edition adoption gate. Global derivatives are eligible only for the selected global version; an organization-specific source cannot borrow them as its own. Scoped derivatives, search, caches and citations inherit current source rights. Departure denies old organization bodies across history/export/Evry and rollback. Organization edits do not rewrite the methodology rubric/Playbook.

The current plant prompt uses the complete exact reviewed rubric with the separately versioned [operational adapter](../reference/plant-operational-adapter-v1.json). The adapter retains final C12 biweekly wording, separate Prayer Leader/rhythms, saved training assignments, actual contact/origin evidence and the current criterion map. Preserve original prompt bytes and explain technical drift corrections through source diffs and semantic fixtures. A methodological number or meaning change needs an SME release. Network Intelligence has its own rubric; feedback cannot activate it automatically.

Rollback appends a new reviewed activation of a revalidated prior complete generation. It preserves history and attribution, and rechecks current schema/profile/content eligibility and deletion/entitlement policy. It does not restore cancelled mail, deleted tenant subjects, personal reading state or organization customizations. Even identical old content has a new activation identity, so earlier workers remain stale.

## Future proof

REFREL-001 through REFREL-008 require repeat install/no-op and changed-hash refusal, coherent second-release switching, missing-derivative failure, concurrent promotion/stale-worker refusal, new attributable rollback, departed-source denial, incorrect-hash/secret rejection and assessment freshness fencing. Reader credit and organization custom/hide behavior survive eligible global updates. These are future SQL, browser and model proofs. This document authorizes no CMS platform, paid model usage or provider setup.
