# Adopted schema relations

Generated from `target.json`. Compound FK owner pairs and named exceptions are part of the authority. FKs establish identity/integrity; current authorization still comes from the native operation. SQL and trigger proof have not run.

| Child columns | Parent columns | On delete | Scope exception |
|---|---|---|---|
| `account(auth_user_id)` | `auth_user(id)` | restrict |  |
| `account(avatar_object_id, id)` | `file_object(id, tenant_id)` | restrict |  |
| `account(id)` | `tenant(id)` | restrict |  |
| `account(id)` | `record(id)` | restrict | Root identity FK uses id as owner; record CHECK kind not in ('account','plant','organization') or tenant_id = id enforces equal ownership, and the trusted subtype trigger validates the exact root kind. |
| `affiliation(plant_id)` | `plant(id)` | restrict |  |
| `affiliation(account_id)` | `account(id)` | restrict |  |
| `affiliation(sending_church_id)` | `organization(id)` | restrict |  |
| `affiliation(organization_id)` | `organization(id)` | restrict |  |
| `affiliation(invitation_id)` | `invitation(id)` | restrict | Invitation owner is an endpoint, not always the plant. Serialized acceptance validates exact endpoints and tenant kind; consent cannot be inherited. |
| `affiliation(recognition_operation_id)` | `audit_event(id)` | restrict | D70 command identity correlation; the producer validates the actual owner, exact source and current authority in its transaction. Retained evidence grants no access. |
| `affiliation(id)` | `record(id)` | restrict | Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable. |
| `article_editor_state(organization_id)` | `organization(id)` | restrict |  |
| `article_editor_state(article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `article_editor_state(current_revision_id, organization_id)` | `article_revision(id, tenant_id)` | restrict |  |
| `article_editor_state(draft_revision_id, organization_id)` | `article_revision(id, tenant_id)` | restrict |  |
| `article_editor_state(based_on_upstream_id)` | `article_revision(id)` | restrict | Inherited upstream revision is a cross-owner source; editing validates exact source rights, canonical article identity and published lineage. |
| `article_editor_state(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `article_revision(article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `article_revision(tenant_id)` | `tenant(id)` | restrict |  |
| `article_revision(release_id, tenant_id)` | `reference_release(id, tenant_id)` | restrict |  |
| `article_revision(upstream_revision_id)` | `article_revision(id)` | restrict | Entitled upstream content may belong to global or another organization source; publication validates source rights, canonical article identity and immutable lineage. |
| `article_revision(parent_article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `article_revision(author_id)` | `account(id)` | restrict |  |
| `article_revision(section_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `article_revision(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `attestation(plant_id)` | `plant(id)` | restrict |  |
| `attestation(reference_version_id)` | `reference_version(id)` | restrict |  |
| `attestation(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `attestation(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `audit_event(command_id)` | `audit_event(id)` | set_null | Original command correlation may cross the owned endpoint of a reviewed conversion. Cleanup may sever correlation while retaining only independently owned facts. |
| `audit_event(actor_id)` | `account(id)` | set_null |  |
| `audit_event(tenant_id)` | `tenant(id)` | no_action |  |
| `audit_event(subject_id)` | `record(id)` | no_action | D70 audit subject or original-command correlation may name an authorized bilateral endpoint or retained identity; pair/source checks and current authority remain mandatory. Operator projections omit protected history and retry content. |
| `auth_account(user_id)` | `auth_user(id)` | restrict |  |
| `auth_session(user_id)` | `auth_user(id)` | restrict |  |
| `commitment(plant_id)` | `plant(id)` | restrict |  |
| `commitment(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `commitment(witness_person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `commitment(object_id, plant_id)` | `file_object(id, tenant_id)` | restrict |  |
| `commitment(corrected_commitment_id, plant_id)` | `commitment(id, plant_id)` | restrict |  |
| `commitment(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `contact_outcome(plant_id)` | `plant(id)` | restrict |  |
| `contact_outcome(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `contact_outcome(task_id, plant_id)` | `task(id, plant_id)` | restrict |  |
| `contact_outcome(obligation_id, plant_id)` | `obligation(id, plant_id)` | restrict |  |
| `contact_outcome(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `contact_outcome(supersedes_id, plant_id)` | `contact_outcome(id, plant_id)` | restrict |  |
| `contact_outcome(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `conversation(account_id)` | `account(id)` | no_action |  |
| `conversation(active_session_id)` | `auth_session(id)` | set_null |  |
| `conversation(active_turn_id, tenant_id)` | `job(id, tenant_id)` | no_action |  |
| `conversation(tenant_id)` | `tenant(id)` | no_action |  |
| `conversation_event(conversation_id)` | `conversation(id)` | cascade |  |
| `conversation_event(turn_id)` | `job(id)` | no_action |  |
| `development_enrollment(organization_id)` | `organization(id)` | restrict |  |
| `development_enrollment(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `development_enrollment(person_id, organization_id)` | `person(id, tenant_id)` | restrict |  |
| `development_enrollment(program_id, organization_id)` | `development_program(id, organization_id)` | restrict |  |
| `development_enrollment(version_id, program_id, organization_id)` | `development_program_version(id, program_id, organization_id)` | restrict |  |
| `development_enrollment(current_stage_id, version_id, organization_id)` | `development_stage(id, version_id, organization_id)` | restrict |  |
| `development_program(organization_id)` | `organization(id)` | restrict |  |
| `development_program(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `development_program(director_seat_id)` | `seat(id)` | restrict | Current eligible duty seat belongs to the exact organization. Serialized boundary checks seat tenant/kind and current authority; the relation grants no broader access. |
| `development_program(current_version_id, id, organization_id)` | `development_program_version(id, program_id, organization_id)` | restrict |  |
| `development_program_version(organization_id)` | `organization(id)` | restrict |  |
| `development_program_version(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `development_program_version(program_id, organization_id)` | `development_program(id, organization_id)` | restrict |  |
| `development_stage(organization_id)` | `organization(id)` | restrict |  |
| `development_stage(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `development_stage(version_id, organization_id)` | `development_program_version(id, organization_id)` | restrict |  |
| `digest_coverage(tenant_id)` | `tenant(id)` | restrict |  |
| `digest_coverage(recipient_id)` | `account(id)` | restrict |  |
| `digest_coverage(last_mail_id, tenant_id)` | `mail(id, tenant_id)` | restrict |  |
| `digest_coverage(last_operation_id, tenant_id)` | `audit_event(id, tenant_id)` | restrict |  |
| `digest_coverage(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `discovery(account_id)` | `account(id)` | restrict |  |
| `discovery(converted_plant_id)` | `plant(id)` | restrict |  |
| `discovery(conversion_operation_id)` | `audit_event(id)` | restrict | D70 command identity correlation; the producer validates the actual owner, exact source and current authority in its transaction. Retained evidence grants no access. |
| `discovery(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `document(tenant_id)` | `tenant(id)` | restrict |  |
| `document(current_revision_id, tenant_id)` | `document_revision(id, tenant_id)` | restrict |  |
| `document(copied_from_revision_id)` | `document_revision(id)` | restrict | Explicit account-to-plant copy may cite a differently owned source; validate source rights and immutable hash without transferring ownership. |
| `document(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `document_revision(tenant_id)` | `tenant(id)` | restrict |  |
| `document_revision(document_id, tenant_id)` | `document(id, tenant_id)` | restrict |  |
| `document_revision(import_object_id, tenant_id)` | `file_object(id, tenant_id)` | restrict |  |
| `document_revision(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `file_object(tenant_id)` | `tenant(id)` | restrict |  |
| `file_object(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `four_cs(plant_id)` | `plant(id)` | restrict |  |
| `four_cs(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `four_cs(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `household(plant_id)` | `plant(id)` | restrict |  |
| `household(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `identity_proof(account_id)` | `account(id)` | restrict |  |
| `identity_proof(deletion_subject_id)` | `lifecycle_witness(id)` | restrict | Cancellation proof names the exact deletion witness; addressed proof boundary locks the witness and validates requester, subject, purpose, original deadline and current cancellation authority. |
| `interview(plant_id)` | `plant(id)` | restrict |  |
| `interview(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `interview(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `invitation(tenant_id)` | `tenant(id)` | restrict |  |
| `invitation(inviter_id)` | `account(id)` | restrict |  |
| `invitation(accepted_account_id)` | `account(id)` | restrict |  |
| `invitation(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `invitation(resident_person_id, tenant_id)` | `person(id, tenant_id)` | restrict |  |
| `job(tenant_id)` | `tenant(id)` | restrict |  |
| `job(subject_record_id)` | `record(id)` | restrict | Restricted global purge/cleanup sweep may process an explicitly authorized other-owner subject; producer validates purpose/owner. |
| `job(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `launch(plant_id)` | `plant(id)` | restrict |  |
| `launch(reference_version_id)` | `reference_version(id)` | restrict |  |
| `launch(summary_document_id, plant_id)` | `document(id, tenant_id)` | restrict |  |
| `launch_milestone(source_version_id)` | `reference_version(id)` | restrict |  |
| `launch_milestone(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `launch_milestone(plant_id)` | `launch(plant_id)` | restrict |  |
| `lifecycle_witness(account_id)` | `account(id)` | restrict |  |
| `lifecycle_witness(plant_id)` | `plant(id)` | restrict |  |
| `lifecycle_witness(requester_id)` | `account(id)` | restrict |  |
| `lifecycle_witness(seat_id)` | `seat(id)` | restrict | Body-free revocation witness identifies a seat endpoint; synchronized witness writer validates exact seat kind and original identity before clearing live linkage on purge. |
| `lifecycle_witness(affiliation_id)` | `affiliation(id)` | restrict | Body-free revocation witness identifies a relationship endpoint; synchronized witness writer validates exact affiliation identity and permitted counterparty before clearing live linkage on purge. |
| `lifecycle_witness(counterparty_organization_id)` | `organization(id)` | restrict |  |
| `lifecycle_witness(id)` | `record(id)` | restrict | Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable. |
| `mail(tenant_id)` | `tenant(id)` | restrict |  |
| `mail(recipient_account_id)` | `account(id)` | restrict |  |
| `mail(recipient_person_id, tenant_id)` | `person(id, tenant_id)` | restrict |  |
| `mail(operation_id, tenant_id)` | `audit_event(id, tenant_id)` | restrict |  |
| `mail(notice_id, tenant_id)` | `notice(id, tenant_id)` | restrict |  |
| `mail(job_id, tenant_id)` | `job(id, tenant_id)` | restrict |  |
| `mail(original_mail_id, tenant_id)` | `mail(id, tenant_id)` | restrict |  |
| `mail(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `mail_attempt(tenant_id)` | `tenant(id)` | restrict |  |
| `mail_attempt(request_id, tenant_id)` | `mail_request(id, tenant_id)` | restrict |  |
| `mail_attempt(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `mail_request(tenant_id)` | `tenant(id)` | restrict |  |
| `mail_request(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `mail_request_member(tenant_id)` | `tenant(id)` | restrict |  |
| `mail_request_member(request_id, tenant_id)` | `mail_request(id, tenant_id)` | restrict |  |
| `mail_request_member(mail_id, tenant_id)` | `mail(id, tenant_id)` | restrict |  |
| `meeting(plant_id)` | `plant(id)` | restrict |  |
| `meeting(creator_id)` | `account(id)` | restrict |  |
| `meeting(team_id, plant_id)` | `team(id, plant_id)` | restrict |  |
| `meeting(venue_id, plant_id)` | `venue(id, plant_id)` | restrict |  |
| `meeting(reference_version_id)` | `reference_version(id)` | restrict |  |
| `meeting(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `meeting_kit_item(plant_id)` | `plant(id)` | restrict |  |
| `meeting_kit_item(meeting_id, plant_id)` | `meeting(id, plant_id)` | cascade |  |
| `meeting_kit_item(assignee_person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `notice(tenant_id)` | `tenant(id)` | restrict |  |
| `notice(recipient_id)` | `account(id)` | restrict |  |
| `notice(source_record_id)` | `record(id)` | restrict | Own inbox context may refer to an exact entitled source in another tenant; no inherited grant. |
| `notice(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `notification_preference(account_id)` | `account(id)` | restrict |  |
| `notification_preference(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `obligation(plant_id)` | `plant(id)` | restrict |  |
| `obligation(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `obligation(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `obligation(assignee_id)` | `account(id)` | restrict |  |
| `obligation(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `onboarding_setup(account_id)` | `account(id)` | no_action |  |
| `onboarding_setup(creation_operation_id)` | `audit_event(id)` | no_action | D70 command identity correlation; the producer validates the actual owner, exact source and current authority in its transaction. Retained evidence grants no access. |
| `onboarding_setup(plant_id)` | `plant(id)` | no_action |  |
| `organization(id)` | `tenant(id)` | restrict |  |
| `organization(id)` | `record(id)` | restrict | Root identity FK uses id as owner; record CHECK kind not in ('account','plant','organization') or tenant_id = id enforces equal ownership, and the trusted subtype trigger validates the exact root kind. |
| `organization_person_removal(organization_id)` | `organization(id)` | restrict |  |
| `organization_person_removal(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `organization_person_removal(person_record_id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `organization_person_removal(requested_by)` | `account(id)` | restrict |  |
| `participation(plant_id)` | `plant(id)` | restrict |  |
| `participation(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `participation(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `participation(inviter_person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `participation(prior_vision_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `participation(card_author_id)` | `account(id)` | restrict |  |
| `participation(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `passage(release_id, tenant_id)` | `reference_release(id, tenant_id)` | restrict |  |
| `passage(revision_id, tenant_id)` | `article_revision(id, tenant_id)` | restrict |  |
| `passage(tenant_id)` | `tenant(id)` | restrict |  |
| `passage(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `people_column(plant_id)` | `plant(id)` | no_action |  |
| `person(plant_id)` | `plant(id)` | restrict |  |
| `person(linked_account_id)` | `account(id)` | restrict |  |
| `person(household_id, tenant_id)` | `household(id, plant_id)` | restrict |  |
| `person(photo_object_id, tenant_id)` | `file_object(id, tenant_id)` | restrict |  |
| `person(merged_into_person_id, tenant_id)` | `person(id, tenant_id)` | restrict |  |
| `person(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `person(tenant_id)` | `tenant(id)` | restrict |  |
| `person(organization_id)` | `organization(id)` | restrict |  |
| `person_import(actor_id)` | `account(id)` | set_null |  |
| `person_import(job_id, tenant_id)` | `job(id, tenant_id)` | cascade |  |
| `person_import(tenant_id)` | `tenant(id)` | no_action |  |
| `person_note(plant_id)` | `plant(id)` | restrict |  |
| `person_note(person_id, tenant_id)` | `person(id, tenant_id)` | restrict |  |
| `person_note(author_id)` | `account(id)` | restrict |  |
| `person_note(participation_id, tenant_id)` | `participation(id, plant_id)` | restrict |  |
| `person_note(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `person_note(tenant_id)` | `tenant(id)` | restrict |  |
| `person_skill(plant_id)` | `plant(id)` | restrict |  |
| `person_skill(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `person_skill(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `person_tag(plant_id)` | `plant(id)` | restrict |  |
| `person_tag(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `person_tag(tag_id, plant_id)` | `tag(id, plant_id)` | restrict |  |
| `phase_transition(plant_id)` | `plant(id)` | restrict |  |
| `phase_transition(operation_id)` | `audit_event(id)` | restrict | D70 command identity correlation; the producer validates the actual owner, exact source and current authority in its transaction. Retained evidence grants no access. |
| `phase_transition(criterion_version_id)` | `reference_version(id)` | restrict |  |
| `phase_transition(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `pipeline_person(organization_id)` | `organization(id)` | restrict |  |
| `pipeline_person(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `pipeline_person(person_id, organization_id)` | `person(id, tenant_id)` | restrict |  |
| `pipeline_person(stage_id, organization_id)` | `pipeline_stage(id, organization_id)` | restrict |  |
| `pipeline_person(responsible_seat_id)` | `seat(id)` | restrict | Current eligible duty seat belongs to the exact organization. Serialized boundary checks seat tenant/kind and current authority; the relation grants no broader access. |
| `pipeline_sharing(organization_id)` | `organization(id)` | restrict |  |
| `pipeline_sharing(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `pipeline_sharing(relationship_id)` | `affiliation(id)` | restrict | The affiliation must name this sending church and exact current sending network; no inherited or transitive sharing. |
| `pipeline_sharing(network_id)` | `organization(id)` | restrict |  |
| `pipeline_sharing(changed_by)` | `account(id)` | restrict | Account identity is an attribution or explicitly accepted resident endpoint, not an organization seat. Revalidate exact link and consent; purge private originals and retain minimal scope-local attribution on account removal. |
| `pipeline_stage(organization_id)` | `organization(id)` | restrict |  |
| `pipeline_stage(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `plant(id)` | `tenant(id)` | restrict |  |
| `plant(id)` | `record(id)` | restrict | Root identity FK uses id as owner; record CHECK kind not in ('account','plant','organization') or tenant_id = id enforces equal ownership, and the trusted subtype trigger validates the exact root kind. |
| `plant_geography(plant_id)` | `plant(id)` | restrict |  |
| `plant_geography(region_item_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `plant_geography(reference_version_id)` | `reference_version(id)` | restrict |  |
| `plant_geography(supersedes_id, plant_id)` | `plant_geography(id, plant_id)` | restrict |  |
| `plant_geography(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `platform_grant(account_id)` | `account(id)` | restrict |  |
| `platform_grant(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `proposal(account_id)` | `account(id)` | no_action |  |
| `proposal(approved_session_id)` | `auth_session(id)` | set_null |  |
| `proposal(conversation_id, tenant_id)` | `conversation(id, tenant_id)` | cascade |  |
| `proposal(job_id, tenant_id)` | `job(id, tenant_id)` | no_action |  |
| `proposal(tenant_id)` | `tenant(id)` | no_action |  |
| `provider_event(mail_id)` | `mail(id)` | restrict | Signed external event may refer to mail in any tenant; restrict callback processing to its exact provider/message identity. |
| `provider_event(id)` | `record(id)` | restrict |  |
| `reading(account_id)` | `account(id)` | restrict |  |
| `reading(article_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `reading(last_revision_id)` | `article_revision(id)` | restrict | Private account reading refers to global or entitled organization content; read boundary validates canonical article, exact plant context and current source rights. |
| `reading(plant_context_id)` | `plant(id)` | restrict |  |
| `reading(completed_revision_id)` | `article_revision(id)` | restrict | Private completion evidence pins an entitled published source revision; completion boundary validates canonical article and exact reader/source rights. |
| `reading(id, account_id)` | `record(id, tenant_id)` | restrict |  |
| `record(tenant_id)` | `tenant(id)` | restrict |  |
| `recurrence(plant_id)` | `plant(id)` | restrict |  |
| `recurrence(source_task_id, plant_id)` | `task(id, plant_id)` | restrict |  |
| `recurrence(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `reference_activation(release_id)` | `reference_release(id)` | restrict | Serving reference activation is global-only; trusted activation boundary verifies a complete approved global release and binds its record to the global tenant. |
| `reference_activation(previous_id)` | `reference_activation(id)` | restrict |  |
| `reference_activation(actor_id)` | `account(id)` | restrict |  |
| `reference_activation(id)` | `record(id)` | restrict | Serving reference activation is global-only; trusted activation boundary verifies a complete approved global release and binds its record to the global tenant. |
| `reference_item(tenant_id)` | `tenant(id)` | restrict |  |
| `reference_item(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `reference_release(tenant_id)` | `tenant(id)` | restrict |  |
| `reference_release(source_revision_id, tenant_id)` | `article_revision(id, tenant_id)` | restrict |  |
| `reference_release(id, tenant_id)` | `record(id, tenant_id)` | restrict |  |
| `reference_version(item_id)` | `reference_item(id)` | restrict | Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership. |
| `reference_version(release_id)` | `reference_release(id)` | restrict | Packaged reference versions are global-only; trusted subtype trigger binds the record to the global tenant and validates that both release and item are global approved definitions. |
| `reference_version(id)` | `record(id)` | restrict | Packaged reference versions are global-only; trusted subtype trigger binds the record to the global tenant and validates that both release and item are global approved definitions. |
| `relationship_invitation(account_id)` | `account(id)` | no_action |  |
| `relationship_invitation(invitation_id)` | `invitation(id)` | no_action | Invitation owner is the initiating endpoint. The native invitation command validates this exact typed pair and current subject authority. |
| `relationship_invitation(organization_id)` | `organization(id)` | no_action |  |
| `relationship_invitation(plant_id)` | `plant(id)` | no_action |  |
| `relationship_invitation(sending_church_id)` | `organization(id)` | no_action |  |
| `residency_link(organization_id)` | `organization(id)` | restrict |  |
| `residency_link(id, organization_id)` | `record(id, tenant_id)` | restrict |  |
| `residency_link(person_id, organization_id)` | `person(id, tenant_id)` | restrict |  |
| `residency_link(account_id)` | `account(id)` | restrict | Account identity is an attribution or explicitly accepted resident endpoint, not an organization seat. Revalidate exact link and consent; purge private originals and retain minimal scope-local attribution on account removal. |
| `residency_link(affiliation_id)` | `affiliation(id)` | restrict | The current exact account/organization affiliation must match the accepted link endpoints; it never authorizes general account or organization reads. |
| `residency_link(invitation_id, organization_id)` | `invitation(id, tenant_id)` | restrict |  |
| `responsibility(plant_id)` | `plant(id)` | restrict |  |
| `responsibility(team_id, plant_id)` | `team(id, plant_id)` | restrict |  |
| `responsibility(source_version_id)` | `reference_version(id)` | restrict |  |
| `responsibility(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `seat(account_id)` | `account(id)` | restrict |  |
| `seat(plant_id)` | `plant(id)` | restrict |  |
| `seat(organization_id)` | `organization(id)` | restrict |  |
| `seat(invitation_id)` | `invitation(id)` | restrict | Invitation owner is an endpoint, not always the plant. Serialized acceptance validates exact endpoints and tenant kind; consent cannot be inherited. |
| `seat(id)` | `record(id)` | restrict | Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable. |
| `settings_preview(account_id)` | `account(id)` | no_action |  |
| `settings_preview(tenant_id)` | `tenant(id)` | no_action |  |
| `suppression(source_event_id)` | `provider_event(id)` | restrict |  |
| `suppression(clear_operation_id)` | `audit_event(id)` | restrict | D70 command identity correlation; the producer validates the actual owner, exact source and current authority in its transaction. Retained evidence grants no access. |
| `suppression(id)` | `record(id)` | restrict |  |
| `tag(plant_id)` | `plant(id)` | restrict |  |
| `tag(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `task(plant_id)` | `plant(id)` | restrict |  |
| `task(creator_id)` | `account(id)` | restrict |  |
| `task(obligation_id, plant_id)` | `obligation(id, plant_id)` | restrict |  |
| `task(source_template_id)` | `reference_version(id)` | restrict |  |
| `task(import_operation_id)` | `audit_event(id)` | restrict | D70 command identity correlation; the producer validates the actual owner, exact source and current authority in its transaction. Retained evidence grants no access. |
| `task(milestone_id, plant_id)` | `launch_milestone(id, plant_id)` | restrict |  |
| `task(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `task(assignee_id)` | `account(id)` | restrict |  |
| `task(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `task(meeting_id, plant_id)` | `meeting(id, plant_id)` | restrict |  |
| `task(team_id, plant_id)` | `team(id, plant_id)` | restrict |  |
| `task(launch_id)` | `launch(plant_id)` | restrict | Launch uses plant_id as its primary key; task CHECK launch_id = plant_id enforces the same plant whenever this optional relation exists. |
| `task(parent_id, plant_id)` | `task(id, plant_id)` | restrict |  |
| `task(series_id, plant_id)` | `recurrence(id, plant_id)` | restrict |  |
| `task(predecessor_id, plant_id)` | `task(id, plant_id)` | restrict |  |
| `team(plant_id)` | `plant(id)` | restrict |  |
| `team(template_version_id)` | `reference_version(id)` | restrict |  |
| `team(leader_person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `team(leader_role_id, plant_id)` | `team_role(id, plant_id)` | restrict |  |
| `team(responsibility_offer_version_id)` | `reference_version(id)` | restrict |  |
| `team(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `team_role(plant_id)` | `plant(id)` | restrict |  |
| `team_role(team_id, plant_id)` | `team(id, plant_id)` | restrict |  |
| `team_role(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `team_tenure(plant_id)` | `plant(id)` | restrict |  |
| `team_tenure(role_id, plant_id)` | `team_role(id, plant_id)` | restrict |  |
| `team_tenure(person_id, plant_id)` | `person(id, tenant_id)` | restrict |  |
| `team_tenure(previous_tenure_id, plant_id)` | `team_tenure(id, plant_id)` | restrict |  |
| `team_tenure(id, plant_id)` | `record(id, tenant_id)` | restrict |  |
| `venue(plant_id)` | `plant(id)` | restrict |  |
| `venue(id, plant_id)` | `record(id, tenant_id)` | restrict |  |

## Person references

Every declared Person FK has one registration in `target.json.person_references`. Each registration names lock order, collision/merge choice, guarded inverse, retirement, immutable evidence, private authorship and consumer packages.

| Consumer | Person field and owner | Producers |
|---|---|---|
| `invitation` | `resident_person_id, tenant_id` | WP-004, WP-006, WP-008, WP-009 |
| `person` | `merged_into_person_id, tenant_id` | WP-004, WP-006, WP-011, WP-012 |
| `person_note` | `person_id, tenant_id` | WP-004, WP-006, WP-014, WP-098 |
| `person_skill` | `person_id, plant_id` | WP-004, WP-012 |
| `person_tag` | `person_id, plant_id` | WP-004, WP-013 |
| `four_cs` | `person_id, plant_id` | WP-004, WP-014 |
| `interview` | `person_id, plant_id` | WP-004, WP-014 |
| `commitment` | `person_id, plant_id` | WP-004, WP-014 |
| `commitment` | `witness_person_id, plant_id` | WP-004, WP-014 |
| `team` | `leader_person_id, plant_id` | WP-004, WP-017 |
| `team_tenure` | `person_id, plant_id` | WP-004, WP-017 |
| `participation` | `person_id, plant_id` | WP-004, WP-020, WP-022 |
| `participation` | `inviter_person_id, plant_id` | WP-004, WP-020, WP-022 |
| `task` | `person_id, plant_id` | WP-004, WP-024 |
| `obligation` | `person_id, plant_id` | WP-004, WP-024 |
| `contact_outcome` | `person_id, plant_id` | WP-004, WP-023 |
| `attestation` | `person_id, plant_id` | WP-004, WP-039 |
| `mail` | `recipient_person_id, tenant_id` | WP-004, WP-028, WP-031 |
| `pipeline_person` | `person_id, organization_id` | WP-004, WP-098 |
| `development_enrollment` | `person_id, organization_id` | WP-004, WP-099 |
| `residency_link` | `person_id, organization_id` | WP-004, WP-008 |
| `meeting_kit_item` | `assignee_person_id, plant_id` | WP-020 |
