# Adopted schema relations

Generated from `target.json`. Compound FK owner pairs and named exceptions are part of the authority. FKs establish identity/integrity; current authorization still comes from the native operation. SQL and trigger proof have not run.

| Child columns | Parent columns | On delete | Scope exception |
|---|---|---|---|
| `auth_account(user_id)` | `auth_user(id)` | RESTRICT |  |
| `auth_session(user_id)` | `auth_user(id)` | RESTRICT |  |
| `account(auth_user_id)` | `auth_user(id)` | restrict |  |
| `account(security_operation_id, id)` | `operation(id, tenant_id)` | restrict |  |
| `account(preserved_session_id)` | `auth_session(id)` | restrict |  |
| `account(avatar_object_id, id)` | `file_object(id, tenant_id)` | restrict |  |
| `account(id)` | `tenant(id)` | restrict |  |
| `account(id)` | `record(id)` | restrict | Root identity FK uses id as owner; record CHECK kind not in ('account','plant','organization') or tenant_id = id enforces equal ownership, and the trusted subtype trigger validates the exact root kind. |
| `identity_proof(account_id)` | `account(id)` | restrict |  |
| `identity_proof(deletion_subject_id)` | `lifecycle_witness(id)` | restrict | Cancellation proof names the exact deletion witness; addressed proof boundary locks the witness and validates requester, subject, purpose, original deadline and current cancellation authority. |
| `plant(id)` | `tenant(id)` | restrict |  |
| `plant(id)` | `record(id)` | restrict | Root identity FK uses id as owner; record CHECK kind not in ('account','plant','organization') or tenant_id = id enforces equal ownership, and the trusted subtype trigger validates the exact root kind. |
| `organization(id)` | `tenant(id)` | restrict |  |
| `organization(id)` | `record(id)` | restrict | Root identity FK uses id as owner; record CHECK kind not in ('account','plant','organization') or tenant_id = id enforces equal ownership, and the trusted subtype trigger validates the exact root kind. |
| `discovery(account_id)` | `account(id)` | restrict |  |
| `discovery(converted_plant_id)` | `plant(id)` | restrict |  |
| `discovery(conversion_operation_id)` | `operation(id)` | restrict | Conversion creates a plant from the own-account context; validate account owner, original conversion receipt and resulting plant atomically. |
| `discovery(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `seat(account_id)` | `account(id)` | restrict |  |
| `seat(plant_id)` | `plant(id)` | restrict |  |
| `seat(organization_id)` | `organization(id)` | restrict |  |
| `seat(invitation_id)` | `invitation(id)` | restrict | Invitation owner is an endpoint, not always the plant. Serialized acceptance validates exact endpoints and tenant kind; consent cannot be inherited. |
| `seat(id)` | `record(id)` | restrict | Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable. |
| `platform_grant(account_id)` | `account(id)` | restrict |  |
| `platform_grant(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `invitation(tenant_id)` | `tenant(id)` | restrict |  |
| `invitation(inviter_id)` | `account(id)` | restrict |  |
| `invitation(accepted_account_id)` | `account(id)` | restrict |  |
| `invitation(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `affiliation(plant_id)` | `plant(id)` | restrict |  |
| `affiliation(account_id)` | `account(id)` | restrict |  |
| `affiliation(sending_church_id)` | `organization(id)` | restrict |  |
| `affiliation(organization_id)` | `organization(id)` | restrict |  |
| `affiliation(invitation_id)` | `invitation(id)` | restrict | Invitation owner is an endpoint, not always the plant. Serialized acceptance validates exact endpoints and tenant kind; consent cannot be inherited. |
| `affiliation(recognition_operation_id)` | `operation(id)` | restrict | Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership. |
| `affiliation(id)` | `record(id)` | restrict | Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable. |
| `person(plant_id)` | `plant(id)` | restrict |  |
| `person(linked_account_id)` | `account(id)` | restrict |  |
| `person(household_id, plant_id)` | `household(id, plant_id)` | restrict |  |
| `person(photo_object_id, plant_id)` | `file_object(id, tenant_id)` | restrict |  |
| `person(merged_into_person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `person(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `household(plant_id)` | `plant(id)` | restrict |  |
| `household(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `person_note(plant_id)` | `plant(id)` | restrict |  |
| `person_note(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `person_note(author_id)` | `account(id)` | restrict |  |
| `person_note(participation_id, plant_id)` | `participation(id, plant_id)` | restrict |  |
| `person_note(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `tag(plant_id)` | `plant(id)` | restrict |  |
| `tag(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `person_tag(plant_id)` | `plant(id)` | restrict |  |
| `person_tag(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `person_tag(tag_id, plant_id)` | `tag(id, plant_id)` | restrict |  |
| `person_skill(plant_id)` | `plant(id)` | restrict |  |
| `person_skill(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `person_skill(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `four_cs(plant_id)` | `plant(id)` | restrict |  |
| `four_cs(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `four_cs(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `interview(plant_id)` | `plant(id)` | restrict |  |
| `interview(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `interview(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `commitment(plant_id)` | `plant(id)` | restrict |  |
| `commitment(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `commitment(witness_person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `commitment(object_id, plant_id)` | `file_object(id, tenant_id)` | restrict |  |
| `commitment(corrected_commitment_id, plant_id)` | `commitment(id, plant_id)` | restrict |  |
| `commitment(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `person_merge(plant_id)` | `plant(id)` | restrict |  |
| `person_merge(source_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `person_merge(survivor_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `person_merge(operation_id)` | `operation(id)` | restrict | Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership. |
| `person_merge(reversed_operation_id)` | `operation(id)` | restrict | Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership. |
| `person_merge(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `team(plant_id)` | `plant(id)` | restrict |  |
| `team(template_version_id)` | `reference_version(id)` | restrict |  |
| `team(leader_person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `team(leader_role_id, plant_id)` | `team_role(id, plant_id)` | restrict |  |
| `team(responsibility_offer_version_id)` | `reference_version(id)` | restrict |  |
| `team(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `team_role(plant_id)` | `plant(id)` | restrict |  |
| `team_role(team_id, plant_id)` | `team(id, plant_id)` | restrict |  |
| `team_role(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `team_tenure(plant_id)` | `plant(id)` | restrict |  |
| `team_tenure(role_id, plant_id)` | `team_role(id, plant_id)` | restrict |  |
| `team_tenure(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `team_tenure(previous_tenure_id, plant_id)` | `team_tenure(id, plant_id)` | restrict |  |
| `team_tenure(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `responsibility(plant_id)` | `plant(id)` | restrict |  |
| `responsibility(team_id, plant_id)` | `team(id, plant_id)` | restrict |  |
| `responsibility(source_version_id)` | `reference_version(id)` | restrict |  |
| `responsibility(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `training_program(plant_id)` | `plant(id)` | restrict |  |
| `training_program(team_id, plant_id)` | `team(id, plant_id)` | restrict |  |
| `training_program(current_version_id, plant_id)` | `training_version(id, plant_id)` | restrict |  |
| `training_program(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `training_version(plant_id)` | `plant(id)` | restrict |  |
| `training_version(program_id, plant_id)` | `training_program(id, plant_id)` | restrict |  |
| `training_version(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `training_version(compatible_prior_id, program_id)` | `training_version(id, program_id)` | restrict | Same-program compound FK fixes compatibility to program_id; both versions inherit the same plant through their compound program FK. No cross-plant version is possible. |
| `training_requirement(plant_id)` | `plant(id)` | restrict |  |
| `training_requirement(version_id, plant_id)` | `training_version(id, plant_id)` | restrict |  |
| `training_requirement(article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `training_requirement(source_revision_id)` | `article_revision(id)` | restrict | Pinned training article source may be global or an entitled organization revision; native assignment validates canonical article, published state and current exact source rights. |
| `training_requirement(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `training_assignment(plant_id)` | `plant(id)` | restrict |  |
| `training_assignment(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `training_assignment(program_id, plant_id)` | `training_program(id, plant_id)` | restrict |  |
| `training_assignment(version_id, program_id)` | `training_version(id, program_id)` | restrict | Same-program compound FK fixes the version to program_id; assignment and version inherit the same plant through their compound program FK. No cross-plant assignment is possible. |
| `training_assignment(selection_operation_id)` | `operation(id)` | restrict | Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership. |
| `training_assignment(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `training_credit(plant_id)` | `plant(id)` | restrict |  |
| `training_credit(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `training_credit(version_id, plant_id)` | `training_version(id, plant_id)` | restrict |  |
| `training_credit(assignment_id, plant_id)` | `training_assignment(id, plant_id)` | restrict |  |
| `training_credit(prior_credit_id, plant_id)` | `training_credit(id, plant_id)` | restrict |  |
| `training_credit(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `venue(plant_id)` | `plant(id)` | restrict |  |
| `venue(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `meeting(plant_id)` | `plant(id)` | restrict |  |
| `meeting(creator_id)` | `account(id)` | restrict |  |
| `meeting(team_id, plant_id)` | `team(id, plant_id)` | restrict |  |
| `meeting(venue_id, plant_id)` | `venue(id, plant_id)` | restrict |  |
| `meeting(reference_version_id)` | `reference_version(id)` | restrict |  |
| `meeting(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `meeting_item(plant_id)` | `plant(id)` | restrict |  |
| `meeting_item(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `meeting_item(assigned_person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `meeting_item(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `participation(plant_id)` | `plant(id)` | restrict |  |
| `participation(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `participation(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `participation(inviter_person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `participation(prior_vision_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `participation(card_author_id)` | `account(id)` | restrict |  |
| `participation(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `rsvp_proof(plant_id)` | `plant(id)` | restrict |  |
| `rsvp_proof(participation_id, plant_id)` | `participation(id, plant_id)` | restrict |  |
| `meeting_evaluation(plant_id)` | `plant(id)` | restrict |  |
| `meeting_evaluation(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `meeting_evaluation(reference_version_id)` | `reference_version(id)` | restrict |  |
| `meeting_evaluation(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `task(plant_id)` | `plant(id)` | restrict |  |
| `task(creator_id)` | `account(id)` | restrict |  |
| `task(assignee_id)` | `account(id)` | restrict |  |
| `task(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `task(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `task(team_id, plant_id)` | `team(id, plant_id)` | restrict |  |
| `task(launch_id)` | `launch(plant_id)` | restrict | Launch uses plant_id as its primary key; task CHECK launch_id = plant_id enforces the same plant whenever this optional relation exists. |
| `task(parent_id, plant_id)` | `task(id, plant_id)` | restrict |  |
| `task(series_id, plant_id)` | `recurrence(id, plant_id)` | restrict |  |
| `task(predecessor_id, plant_id)` | `task(id, plant_id)` | restrict |  |
| `task(obligation_id, plant_id)` | `obligation(id, plant_id)` | restrict |  |
| `task(source_template_id)` | `reference_version(id)` | restrict |  |
| `task(import_operation_id)` | `operation(id)` | restrict | Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership. |
| `task(milestone_id, plant_id)` | `launch_milestone(id, plant_id)` | restrict |  |
| `task(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `task_dependency(plant_id)` | `plant(id)` | restrict |  |
| `task_dependency(task_id, plant_id)` | `task(id, plant_id)` | restrict |  |
| `task_dependency(prerequisite_id, plant_id)` | `task(id, plant_id)` | restrict |  |
| `recurrence(plant_id)` | `plant(id)` | restrict |  |
| `recurrence(source_task_id, plant_id)` | `task(id, plant_id)` | restrict |  |
| `recurrence(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `obligation(plant_id)` | `plant(id)` | restrict |  |
| `obligation(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `obligation(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `obligation(assignee_id)` | `account(id)` | restrict |  |
| `obligation(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `contact_outcome(plant_id)` | `plant(id)` | restrict |  |
| `contact_outcome(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `contact_outcome(task_id, plant_id)` | `task(id, plant_id)` | restrict |  |
| `contact_outcome(obligation_id, plant_id)` | `obligation(id, plant_id)` | restrict |  |
| `contact_outcome(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `contact_outcome(supersedes_id, plant_id)` | `contact_outcome(id, plant_id)` | restrict |  |
| `contact_outcome(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `phase_transition(plant_id)` | `plant(id)` | restrict |  |
| `phase_transition(operation_id)` | `operation(id)` | restrict | Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership. |
| `phase_transition(criterion_version_id)` | `reference_version(id)` | restrict |  |
| `phase_transition(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `attestation(plant_id)` | `plant(id)` | restrict |  |
| `attestation(reference_version_id)` | `reference_version(id)` | restrict |  |
| `attestation(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `attestation(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `launch(plant_id)` | `plant(id)` | restrict |  |
| `launch(reference_version_id)` | `reference_version(id)` | restrict |  |
| `launch(summary_document_id, plant_id)` | `document(id, tenant_id)` | restrict |  |
| `launch_milestone(source_version_id)` | `reference_version(id)` | restrict |  |
| `launch_milestone(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `launch_milestone(plant_id)` | `launch(plant_id)` | restrict |  |
| `launch_guest(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `launch_guest(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `launch_guest(plant_id)` | `launch(plant_id)` | restrict |  |
| `launch_debrief(form_version_id)` | `reference_version(id)` | restrict |  |
| `launch_debrief(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `launch_debrief(plant_id)` | `launch(plant_id)` | restrict |  |
| `private_calendar(account_id)` | `account(id)` | restrict |  |
| `private_week(plant_id)` | `plant(id)` | restrict |  |
| `private_week(author_id)` | `account(id)` | restrict |  |
| `private_week_revision(plant_id)` | `plant(id)` | restrict |  |
| `private_week_revision(week_id, author_id)` | `private_week(id, author_id)` | restrict |  |
| `private_week_revision(author_id)` | `account(id)` | restrict |  |
| `reference_release(tenant_id)` | `tenant(id)` | restrict |  |
| `reference_release(source_revision_id, tenant_id)` | `article_revision(id, tenant_id)` | restrict |  |
| `reference_release(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `reference_item(tenant_id)` | `tenant(id)` | restrict |  |
| `reference_item(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `reference_version(item_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `reference_version(release_id)` | `reference_release(id)` | restrict | Packaged reference versions are global-only; trusted subtype trigger binds the record to the global tenant and validates that both release and item are global approved definitions. |
| `reference_version(id)` | `record(id)` | restrict | Packaged reference versions are global-only; trusted subtype trigger binds the record to the global tenant and validates that both release and item are global approved definitions. |
| `reference_activation(release_id)` | `reference_release(id)` | restrict | Serving reference activation is global-only; trusted activation boundary verifies a complete approved global release and binds its record to the global tenant. |
| `reference_activation(previous_id)` | `reference_activation(id)` | restrict |  |
| `reference_activation(actor_id)` | `account(id)` | restrict |  |
| `reference_activation(id)` | `record(id)` | restrict | Serving reference activation is global-only; trusted activation boundary verifies a complete approved global release and binds its record to the global tenant. |
| `article_revision(article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `article_revision(tenant_id)` | `tenant(id)` | restrict |  |
| `article_revision(release_id, tenant_id)` | `reference_release(id, tenant_id)` | restrict |  |
| `article_revision(upstream_revision_id)` | `article_revision(id)` | restrict | Entitled upstream content may belong to global or another organization source; publication validates source rights, canonical article identity and immutable lineage. |
| `article_revision(parent_article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `article_revision(author_id)` | `account(id)` | restrict |  |
| `article_revision(section_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `article_revision(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `article_editor_state(organization_id)` | `organization(id)` | restrict |  |
| `article_editor_state(article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `article_editor_state(current_revision_id, organization_id)` | `article_revision(id, tenant_id)` | restrict |  |
| `article_editor_state(draft_revision_id, organization_id)` | `article_revision(id, tenant_id)` | restrict |  |
| `article_editor_state(based_on_upstream_id)` | `article_revision(id)` | restrict | Inherited upstream revision is a cross-owner source; editing validates exact source rights, canonical article identity and published lineage. |
| `article_editor_state(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `article_link(revision_id)` | `article_revision(id)` | restrict |  |
| `article_link(target_article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `wiki_preference(plant_id)` | `plant(id)` | restrict |  |
| `wiki_preference(plant_id, organization_id)` | `affiliation(plant_id, organization_id)` | restrict |  |
| `wiki_preference(recognition_operation_id)` | `operation(id)` | restrict | Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership. |
| `wiki_preference(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `wiki_preference(organization_id, group_kind)` | `organization(id, kind)` | restrict |  |
| `reading(account_id)` | `account(id)` | restrict |  |
| `reading(article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `reading(last_revision_id)` | `article_revision(id)` | restrict | Private account reading refers to global or entitled organization content; read boundary validates canonical article, exact plant context and current source rights. |
| `reading(plant_context_id)` | `plant(id)` | restrict |  |
| `reading(completed_revision_id)` | `article_revision(id)` | restrict | Private completion evidence pins an entitled published source revision; completion boundary validates canonical article and exact reader/source rights. |
| `reading(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `passage(release_id, tenant_id)` | `reference_release(id, tenant_id)` | restrict |  |
| `passage(revision_id, tenant_id)` | `article_revision(id, tenant_id)` | restrict |  |
| `passage(tenant_id)` | `tenant(id)` | restrict |  |
| `passage(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `file_object(tenant_id)` | `tenant(id)` | restrict |  |
| `file_object(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `document(tenant_id)` | `tenant(id)` | restrict |  |
| `document(current_revision_id, tenant_id)` | `document_revision(id, tenant_id)` | restrict |  |
| `document(copied_from_revision_id)` | `document_revision(id)` | restrict | Explicit account-to-plant copy may cite a differently owned source; validate source rights and immutable hash without transferring ownership. |
| `document(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `document_revision(tenant_id)` | `tenant(id)` | restrict |  |
| `document_revision(document_id, tenant_id)` | `document(id, tenant_id)` | restrict |  |
| `document_revision(import_object_id, tenant_id)` | `file_object(id, tenant_id)` | restrict |  |
| `document_revision(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `generated_document(tenant_id)` | `tenant(id)` | restrict |  |
| `generated_document(template_version_id)` | `reference_version(id)` | restrict |  |
| `generated_document(object_id, tenant_id)` | `file_object(id, tenant_id)` | restrict |  |
| `generated_document(generation_operation_id)` | `operation(id)` | restrict | The initiating operation can use an account conversation context while generating an explicitly reviewed plant-owned output; authorize exact output owner at execution. |
| `generated_document(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `assessment(tenant_id)` | `tenant(id)` | restrict |  |
| `assessment(reference_activation_id)` | `reference_activation(id)` | restrict |  |
| `assessment(rubric_version_id)` | `reference_version(id)` | restrict |  |
| `assessment(job_id, tenant_id)` | `job(id, tenant_id)` | restrict |  |
| `assessment(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `assessment_fact(tenant_id)` | `tenant(id)` | restrict |  |
| `assessment_fact(assessment_id, tenant_id)` | `assessment(id, tenant_id)` | restrict |  |
| `assessment_fact(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `finding(tenant_id)` | `tenant(id)` | restrict |  |
| `finding(assessment_id, tenant_id)` | `assessment(id, tenant_id)` | restrict |  |
| `finding(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `assessment_contributor(organization_id)` | `organization(id)` | restrict |  |
| `assessment_contributor(assessment_id, organization_id)` | `assessment(id, tenant_id)` | restrict |  |
| `assessment_contributor(plant_id)` | `plant(id)` | restrict |  |
| `assessment_contributor(recognition_operation_id)` | `operation(id)` | restrict | Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership. |
| `assessment_contributor(plant_assessment_id, plant_id)` | `assessment(id, tenant_id)` | restrict | Organization contributor intentionally pins another-owner plant result; the compound plant FK plus exact pair affiliation, recognition, release and category grants constrain eligibility. |
| `assessment_contributor(geography_id, plant_id)` | `plant_geography(id, plant_id)` | restrict | Organization contributor pins the source plant geography at assessment time; compound plant FK enforces source identity, and serialized portfolio boundary validates exact relationship and grants. |
| `assessment_contributor(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `assessment_contributor(plant_id, organization_id)` | `affiliation(plant_id, organization_id)` | restrict |  |
| `reader_feedback(plant_context_id)` | `plant(id)` | restrict |  |
| `reader_feedback(organization_context_id)` | `organization(id)` | restrict |  |
| `reader_feedback(account_id)` | `account(id)` | restrict |  |
| `reader_feedback(assessment_id)` | `assessment(id)` | restrict | Feedback is account-private with an entitled plant/organization target; exact optional context must match assessment owner. |
| `reader_feedback(finding_id)` | `finding(id)` | restrict | Account-private vote may target an entitled finding; validate target and current exact context. |
| `reader_feedback(reference_version_id)` | `reference_version(id)` | restrict |  |
| `reader_feedback(article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `reader_feedback(article_revision_id)` | `article_revision(id)` | restrict | Account-private feedback targets an entitled global or organization article revision; feedback boundary validates canonical article, exact source organization and current plant-context rights. |
| `reader_feedback(organization_source_id)` | `organization(id)` | restrict |  |
| `reader_feedback(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `plant_geography(plant_id)` | `plant(id)` | restrict |  |
| `plant_geography(region_item_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `plant_geography(reference_version_id)` | `reference_version(id)` | restrict |  |
| `plant_geography(supersedes_id, plant_id)` | `plant_geography(id, plant_id)` | restrict |  |
| `plant_geography(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `message_template(plant_id)` | `plant(id)` | restrict |  |
| `message_template(source_version_id)` | `reference_version(id)` | restrict |  |
| `message_template(source_item_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `message_template(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `communication(plant_id)` | `plant(id)` | restrict |  |
| `communication(author_id)` | `account(id)` | restrict |  |
| `communication(template_id, plant_id)` | `message_template(id, plant_id)` | restrict |  |
| `communication(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `communication(review_id)` | `review(id)` | restrict | Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership. |
| `communication(original_communication_id, plant_id)` | `communication(id, plant_id)` | restrict |  |
| `communication(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `communication_recipient(plant_id)` | `plant(id)` | restrict |  |
| `communication_recipient(communication_id, plant_id)` | `communication(id, plant_id)` | restrict |  |
| `communication_recipient(person_id, plant_id)` | `person(id, plant_id)` | restrict |  |
| `communication_recipient(mail_id, plant_id)` | `mail(id, tenant_id)` | restrict |  |
| `communication_recipient(original_recipient_id, plant_id)` | `communication_recipient(id, plant_id)` | restrict |  |
| `communication_recipient(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `mail(tenant_id)` | `tenant(id)` | restrict |  |
| `mail(recipient_account_id)` | `account(id)` | restrict |  |
| `mail(recipient_person_id, tenant_id)` | `person(id, plant_id)` | restrict |  |
| `mail(operation_id, tenant_id)` | `operation(id, tenant_id)` | restrict |  |
| `mail(notice_id, tenant_id)` | `notice(id, tenant_id)` | restrict |  |
| `mail(job_id, tenant_id)` | `job(id, tenant_id)` | restrict |  |
| `mail(original_mail_id, tenant_id)` | `mail(id, tenant_id)` | restrict |  |
| `mail(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `mail_request(tenant_id)` | `tenant(id)` | restrict |  |
| `mail_request(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `mail_request_member(tenant_id)` | `tenant(id)` | restrict |  |
| `mail_request_member(request_id, tenant_id)` | `mail_request(id, tenant_id)` | restrict |  |
| `mail_request_member(mail_id, tenant_id)` | `mail(id, tenant_id)` | restrict |  |
| `mail_attempt(tenant_id)` | `tenant(id)` | restrict |  |
| `mail_attempt(request_id, tenant_id)` | `mail_request(id, tenant_id)` | restrict |  |
| `mail_attempt(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `provider_event(mail_id)` | `mail(id)` | restrict | Signed external event may refer to mail in any tenant; restrict callback processing to its exact provider/message identity. |
| `provider_event(id)` | `record(id)` | restrict |  |
| `suppression(source_event_id)` | `provider_event(id)` | restrict |  |
| `suppression(clear_operation_id)` | `operation(id)` | restrict | Global address suppression recovery uses authenticated current self-address proof, not tenant ownership. |
| `suppression(id)` | `record(id)` | restrict |  |
| `notification_preference(account_id)` | `account(id)` | restrict |  |
| `notification_preference(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `notice(tenant_id)` | `tenant(id)` | restrict |  |
| `notice(recipient_id)` | `account(id)` | restrict |  |
| `notice(source_record_id)` | `record(id)` | restrict | Own inbox context may refer to an exact entitled source in another tenant; no inherited grant. |
| `notice(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `digest_coverage(tenant_id)` | `tenant(id)` | restrict |  |
| `digest_coverage(recipient_id)` | `account(id)` | restrict |  |
| `digest_coverage(last_mail_id, tenant_id)` | `mail(id, tenant_id)` | restrict |  |
| `digest_coverage(last_operation_id, tenant_id)` | `operation(id, tenant_id)` | restrict |  |
| `digest_coverage(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `conversation(tenant_id)` | `tenant(id)` | restrict |  |
| `conversation(owner_id)` | `account(id)` | restrict |  |
| `conversation(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `conversation_entry(tenant_id)` | `tenant(id)` | restrict |  |
| `conversation_entry(conversation_id, tenant_id)` | `conversation(id, tenant_id)` | restrict |  |
| `conversation_entry(object_id, tenant_id)` | `file_object(id, tenant_id)` | restrict |  |
| `conversation_entry(review_id, tenant_id)` | `review(id, tenant_id)` | restrict |  |
| `conversation_entry(operation_id, tenant_id)` | `operation(id, tenant_id)` | restrict |  |
| `conversation_entry(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `conversation_entry(bound_effect_id, tenant_id)` | `effect(id, tenant_id)` | restrict |  |
| `review(tenant_id)` | `tenant(id)` | restrict |  |
| `review(conversation_id, tenant_id)` | `conversation(id, tenant_id)` | restrict |  |
| `review(approved_by_id)` | `account(id)` | restrict |  |
| `review(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `operation(tenant_id)` | `tenant(id)` | restrict |  |
| `operation(actor_id)` | `account(id)` | restrict |  |
| `operation(review_id, tenant_id)` | `review(id, tenant_id)` | restrict |  |
| `operation(conversation_id, tenant_id)` | `conversation(id, tenant_id)` | restrict |  |
| `operation(job_id, tenant_id)` | `job(id, tenant_id)` | restrict |  |
| `operation(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `effect(tenant_id)` | `tenant(id)` | restrict |  |
| `effect(operation_id, tenant_id)` | `operation(id, tenant_id)` | restrict |  |
| `effect(review_id, tenant_id)` | `review(id, tenant_id)` | restrict |  |
| `effect(target_record_id)` | `record(id)` | restrict | Reviewed targets can be global sources or an explicitly different output owner; exact command authorizes owner and kind. |
| `effect(source_record_id)` | `record(id)` | restrict | Entitled source may be public/global or another explicitly authorized owner; source is not a grant. |
| `effect(job_id, tenant_id)` | `job(id, tenant_id)` | restrict |  |
| `effect(result_record_id)` | `record(id)` | restrict | Reviewed effect output may acquire its explicit domain owner; validated before bind. |
| `effect(inverse_effect_id, tenant_id)` | `effect(id, tenant_id)` | restrict |  |
| `effect(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `effect_dependency(tenant_id)` | `tenant(id)` | restrict |  |
| `effect_dependency(effect_id, tenant_id)` | `effect(id, tenant_id)` | restrict |  |
| `effect_dependency(prerequisite_id, tenant_id)` | `effect(id, tenant_id)` | restrict |  |
| `event(tenant_id)` | `tenant(id)` | restrict |  |
| `event(target_record_id)` | `record(id)` | restrict | Immutable history may target retained body-free identities, or an authorized cross-owner consequence; validate actual target kind/owner at write. |
| `event(operation_id, tenant_id)` | `operation(id, tenant_id)` | restrict |  |
| `event(effect_id, tenant_id)` | `effect(id, tenant_id)` | restrict |  |
| `event(actor_id)` | `account(id)` | restrict |  |
| `event(mail_attempt_id, mail_request_id, tenant_id)` | `mail_attempt(id, request_id, tenant_id)` | restrict |  |
| `event(mail_request_id, mail_position, tenant_id)` | `mail_request_member(request_id, position, tenant_id)` | restrict |  |
| `job(tenant_id)` | `tenant(id)` | restrict |  |
| `job(subject_record_id)` | `record(id)` | restrict | Restricted global purge/cleanup sweep may process an explicitly authorized other-owner subject; producer validates purpose/owner. |
| `job(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `feedback(account_id)` | `account(id)` | restrict |  |
| `feedback(plant_context_id)` | `plant(id)` | restrict |  |
| `feedback(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `feedback_publication(account_id)` | `account(id)` | restrict |  |
| `feedback_publication(feedback_id, account_id)` | `feedback(id, account_id)` | restrict |  |
| `feedback_publication(effect_id)` | `effect(id)` | restrict | Restricted public publication can use its own global effect, independently of private intake ownership; clear private linkage on purge. |
| `feedback_publication(id)` | `record(id)` | restrict | Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable. |
| `prompt_dismissal(account_id)` | `account(id)` | restrict |  |
| `prompt_dismissal(plant_id)` | `plant(id)` | restrict |  |
| `prompt_dismissal(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `lifecycle_witness(account_id)` | `account(id)` | restrict |  |
| `lifecycle_witness(plant_id)` | `plant(id)` | restrict |  |
| `lifecycle_witness(requester_id)` | `account(id)` | restrict |  |
| `lifecycle_witness(seat_id)` | `seat(id)` | restrict | Body-free revocation witness identifies a seat endpoint; synchronized witness writer validates exact seat kind and original identity before clearing live linkage on purge. |
| `lifecycle_witness(affiliation_id)` | `affiliation(id)` | restrict | Body-free revocation witness identifies a relationship endpoint; synchronized witness writer validates exact affiliation identity and permitted counterparty before clearing live linkage on purge. |
| `lifecycle_witness(counterparty_organization_id)` | `organization(id)` | restrict |  |
| `lifecycle_witness(id)` | `record(id)` | restrict | Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable. |
| `evidence_link(tenant_id)` | `tenant(id)` | restrict |  |
| `evidence_link(event_id, tenant_id)` | `event(id, tenant_id)` | restrict |  |
| `evidence_link(target_record_id)` | `record(id)` | restrict | Entitled source/selected record can have a different actual owner; validate purpose, source rights, exact grant and kind. |
| `evidence_link(source_operation_id, tenant_id)` | `operation(id, tenant_id)` | restrict |  |
| `evidence_link(prior_record_id)` | `record(id)` | restrict | Exact inverse prior endpoint can be cross-owner only where the reviewed native command permits; lock and validate before inverse. |
| `evidence_link(resulting_record_id)` | `record(id)` | restrict | Exact inverse result endpoint can be cross-owner only where the reviewed native command permits; lock and validate before inverse. |
| `evidence_link(consumer_record_id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `record(tenant_id)` | `tenant(id)` | restrict |  |

## Person references

Every declared Person FK has one registration in `target.json.person_references`. Each registration names lock order, collision/merge choice, guarded inverse, retirement, immutable evidence, private authorship and consumer packages.

| Consumer | Person field and owner | Producers |
|---|---|---|
| `person` | `merged_into_person_id, plant_id` | WP-004, WP-006, WP-011, WP-012 |
| `person_note` | `person_id, plant_id` | WP-004, WP-014 |
| `person_tag` | `person_id, plant_id` | WP-004, WP-013 |
| `person_skill` | `person_id, plant_id` | WP-004, WP-013 |
| `four_cs` | `person_id, plant_id` | WP-004, WP-014 |
| `interview` | `person_id, plant_id` | WP-004, WP-014 |
| `commitment` | `person_id, plant_id` | WP-004, WP-014 |
| `commitment` | `witness_person_id, plant_id` | WP-004, WP-014 |
| `person_merge` | `source_id, plant_id` | WP-004, WP-015 |
| `person_merge` | `survivor_id, plant_id` | WP-004, WP-015 |
| `team` | `leader_person_id, plant_id` | WP-004, WP-016 |
| `team_tenure` | `person_id, plant_id` | WP-004, WP-017 |
| `training_assignment` | `person_id, plant_id` | WP-004, WP-019 |
| `training_credit` | `person_id, plant_id` | WP-004, WP-019 |
| `meeting_item` | `assigned_person_id, plant_id` | WP-004, WP-020, WP-022 |
| `participation` | `person_id, plant_id` | WP-004, WP-021, WP-022 |
| `participation` | `inviter_person_id, plant_id` | WP-004, WP-021, WP-022 |
| `task` | `person_id, plant_id` | WP-004, WP-024 |
| `obligation` | `person_id, plant_id` | WP-004, WP-024 |
| `contact_outcome` | `person_id, plant_id` | WP-004, WP-023 |
| `attestation` | `person_id, plant_id` | WP-004, WP-039 |
| `launch_guest` | `person_id, plant_id` | WP-004, WP-046 |
| `communication_recipient` | `person_id, plant_id` | WP-004, WP-029 |
| `mail` | `recipient_person_id, tenant_id` | WP-004, WP-028, WP-031 |
