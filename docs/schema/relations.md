# Complete proposed target relations

The catalog owns all120proposed tables, 1873columns and435proposed FK constraints. Keys/types/nullable ownership/deletion policies are planning contracts; physical SQL/race/privacy proof remains future-not-run. Optionality follows nullable FK columns; partial current-row uniqueness stays in the exact [catalog](target.json).

```mermaid
erDiagram
  auth_user {
    uuid id PK
  }
  auth_account {
    uuid id PK
  }
  auth_session {
    uuid id PK
  }
  auth_verification {
    uuid id PK
  }
  auth_throttle {
    uuid id PK
  }
  app_account {
    uuid id PK
  }
  tenancy_membership {
    uuid id PK
  }
  platform_grant {
    uuid id PK
  }
  access_invitation {
    uuid id PK
  }
  account_person_link {
    uuid id PK
  }
  plant {
    uuid id PK
  }
  organization {
    uuid id PK
  }
  organization_network_link {
    uuid id PK
  }
  plant_affiliation {
    uuid id PK
  }
  organization_sharing_settings {
    uuid id PK
  }
  discovery_profile {
    uuid id PK
  }
  discovery_association {
    uuid id PK
  }
  association_invitation {
    uuid id PK
  }
  association_event {
    uuid id PK
  }
  household {
    uuid id PK
  }
  person {
    uuid id PK
  }
  person_tag_definition {
    uuid id PK
  }
  person_tag {
    uuid id PK
  }
  person_skill {
    uuid id PK
  }
  person_4c_assessment {
    uuid id PK
  }
  person_interview {
    uuid id PK
  }
  person_commitment {
    uuid id PK
  }
  person_activity {
    uuid id PK
  }
  record_correction {
    uuid id PK
  }
  person_merge {
    uuid id PK
  }
  ministry_team {
    uuid id PK
  }
  team_role {
    uuid id PK
  }
  team_membership {
    uuid id PK
  }
  team_responsibility {
    uuid id PK
  }
  training_program {
    uuid id PK
  }
  training_requirement_version {
    uuid id PK
  }
  training_assignment_episode {
    uuid id PK
  }
  training_assignment_event {
    uuid id PK
  }
  training_completion {
    uuid id PK
  }
  meeting_location {
    uuid id PK
  }
  meeting {
    uuid id PK
  }
  meeting_participation {
    uuid id PK
  }
  meeting_invitation {
    uuid id PK
  }
  meeting_rsvp_token {
    uuid id PK
  }
  vision_response {
    uuid id PK
  }
  meeting_evaluation {
    uuid id PK
  }
  meeting_checklist_item {
    uuid id PK
  }
  meeting_event {
    uuid id PK
  }
  recurrence_series {
    uuid id PK
  }
  follow_up_obligation {
    uuid id PK
  }
  task {
    uuid id PK
  }
  task_relation {
    uuid id PK
  }
  task_dependency {
    uuid id PK
  }
  task_status_event {
    uuid id PK
  }
  follow_up_outcome {
    uuid id PK
  }
  phase_template_offer_response {
    uuid id PK
  }
  template_import_receipt {
    uuid id PK
  }
  phase_transition {
    uuid id PK
  }
  plant_attestation {
    uuid id PK
  }
  person_attestation {
    uuid id PK
  }
  launch {
    uuid id PK
  }
  launch_event {
    uuid id PK
  }
  launch_milestone {
    uuid id PK
  }
  launch_milestone_task {
    uuid id PK
  }
  launch_person_attendance {
    uuid id PK
  }
  planter_checkin {
    uuid id PK
  }
  planter_checkin_event {
    uuid id PK
  }
  reference_release {
    uuid id PK
  }
  reference_activation {
    uuid id PK
  }
  reference_section {
    uuid id PK
  }
  wiki_article {
    uuid id PK
  }
  wiki_source {
    uuid id PK
  }
  wiki_article_version {
    uuid id PK
  }
  organization_wiki_article_state {
    uuid id PK
  }
  plant_wiki_source_order {
    uuid id PK
  }
  plant_wiki_source_order_entry {
    uuid id PK
  }
  wiki_read_progress {
    uuid id PK
  }
  wiki_read_event {
    uuid id PK
  }
  wiki_bookmark {
    uuid id PK
  }
  wiki_article_feedback {
    uuid id PK
  }
  reference_chunk {
    uuid id PK
  }
  reference_template_version {
    uuid id PK
  }
  owned_documents {
    uuid id PK
  }
  owned_document_revisions {
    uuid id PK
  }
  generated_document {
    uuid id PK
  }
  upload_intent {
    uuid id PK
  }
  object_metadata {
    uuid id PK
  }
  assessment_demand {
    uuid id PK
  }
  intelligence_assessment_run {
    uuid id PK
  }
  intelligence_insight {
    uuid id PK
  }
  organization_intelligence_runs {
    uuid id PK
  }
  organization_intelligence_contributor {
    uuid id PK
  }
  organization_intelligence_assessments {
    uuid id PK
  }
  intelligence_feedback {
    uuid id PK
  }
  message_template {
    uuid id PK
  }
  communication {
    uuid id PK
  }
  communication_recipient {
    uuid id PK
  }
  email_intent {
    uuid id PK
  }
  email_attempt {
    uuid id PK
  }
  provider_event_receipt {
    uuid id PK
  }
  communication_delivery_retry {
    uuid id PK
  }
  email_suppression {
    uuid id PK
  }
  notification_preference {
    uuid id PK
  }
  inbox_entry {
    uuid id PK
  }
  assistant_conversation {
    uuid id PK
  }
  assistant_message {
    uuid id PK
  }
  assistant_artifact {
    uuid id PK
  }
  assistant_attachment {
    uuid id PK
  }
  assistant_plan {
    uuid id PK
  }
  assistant_approval {
    uuid id PK
  }
  operation_execution {
    uuid id PK
  }
  operation_effect {
    uuid id PK
  }
  operation_result {
    uuid id PK
  }
  product_feedback {
    uuid id PK
  }
  feedback_publication {
    uuid id PK
  }
  command_receipt {
    uuid id PK
  }
  job {
    uuid id PK
  }
  audit_event {
    uuid id PK
  }
  deletion_witness {
    uuid id PK
  }
  recovery_manifest {
    uuid id PK
  }
  auth_user ||--o{ auth_account : "user_id"
  auth_user ||--o{ auth_session : "user_id"
  auth_user ||--o| app_account : "auth_user_id"
  object_metadata o|--o{ app_account : "avatar_object_id,id"
  operation_execution o|--o{ app_account : "auth_mutation_execution_id,id"
  auth_session o|--o{ app_account : "preserved_session_id"
  plant o|--o{ tenancy_membership : "plant_id"
  organization o|--o{ tenancy_membership : "organization_id,organization_kind"
  app_account o|--o{ tenancy_membership : "account_id"
  app_account ||--o{ tenancy_membership : "principal_account_id"
  access_invitation o|--o{ tenancy_membership : "source_invitation_id"
  app_account ||--o{ platform_grant : "account_id"
  app_account o|--o{ platform_grant : "granted_by_account_id"
  plant o|--o{ access_invitation : "plant_id"
  organization o|--o{ access_invitation : "organization_id,organization_kind"
  app_account o|--o{ access_invitation : "account_id"
  app_account o|--o{ access_invitation : "actor_account_id"
  app_account o|--o{ access_invitation : "accepted_account_id"
  plant ||--o{ account_person_link : "plant_id"
  app_account ||--o{ account_person_link : "account_id"
  person ||--o{ account_person_link : "person_id,plant_id"
  intelligence_assessment_run o|--o{ plant : "current_assessment_run_id,id"
  organization_intelligence_assessments o|--o{ organization : "current_assessment_id,id,kind"
  organization ||--o{ organization_network_link : "sending_church_id,sending_church_kind"
  organization ||--o{ organization_network_link : "network_id,network_kind"
  plant ||--o{ plant_affiliation : "plant_id"
  association_invitation o|--o{ plant_affiliation : "source_invitation_id"
  organization ||--o{ plant_affiliation : "organization_id,organization_kind"
  plant ||--o{ organization_sharing_settings : "plant_id"
  plant_affiliation ||--o{ organization_sharing_settings : "affiliation_id,plant_id,organization_id,organization_kind"
  app_account ||--o| discovery_profile : "account_id"
  plant o|--o{ discovery_profile : "created_plant_id"
  owned_documents o|--o{ discovery_profile : "core_values_document_id,account_id"
  app_account ||--o{ discovery_association : "account_id"
  organization ||--o{ discovery_association : "organization_id,organization_kind"
  plant o|--o{ association_invitation : "plant_id"
  organization o|--o{ association_invitation : "organization_id,organization_kind"
  app_account o|--o{ association_invitation : "account_id"
  app_account o|--o{ association_invitation : "actor_account_id"
  plant o|--o{ association_invitation : "target_plant_id"
  app_account o|--o{ association_invitation : "target_account_id"
  app_account o|--o{ association_invitation : "responded_account_id"
  organization o|--o{ association_invitation : "target_sending_church_id,target_sending_church_kind"
  plant o|--o{ association_event : "plant_id"
  organization o|--o{ association_event : "organization_id,organization_kind"
  app_account o|--o{ association_event : "account_id"
  app_account o|--o{ association_event : "actor_account_id"
  association_invitation o|--o{ association_event : "source_invitation_id"
  plant ||--o{ household : "plant_id"
  person o|--o{ household : "head_person_id,plant_id"
  plant ||--o{ person : "plant_id"
  app_account o|--o{ person : "actor_account_id"
  object_metadata o|--o{ person : "photo_object_id,plant_id"
  household o|--o{ person : "household_id,plant_id"
  person o|--o{ person : "merged_into_person_id,plant_id"
  plant ||--o{ person_tag_definition : "plant_id"
  plant ||--o{ person_tag : "plant_id"
  person ||--o{ person_tag : "person_id,plant_id"
  person_tag_definition ||--o{ person_tag : "tag_id,plant_id"
  plant ||--o{ person_skill : "plant_id"
  person ||--o{ person_skill : "person_id,plant_id"
  plant ||--o{ person_4c_assessment : "plant_id"
  app_account o|--o{ person_4c_assessment : "actor_account_id"
  person ||--o{ person_4c_assessment : "person_id,plant_id"
  plant ||--o{ person_interview : "plant_id"
  app_account o|--o{ person_interview : "actor_account_id"
  person ||--o{ person_interview : "person_id,plant_id"
  plant ||--o{ person_commitment : "plant_id"
  app_account o|--o{ person_commitment : "actor_account_id"
  person ||--o{ person_commitment : "person_id,plant_id"
  object_metadata o|--o{ person_commitment : "document_object_id,plant_id"
  app_account o|--o{ person_commitment : "witness_account_id"
  plant ||--o{ person_activity : "plant_id"
  app_account o|--o{ person_activity : "actor_account_id"
  person ||--o{ person_activity : "person_id,plant_id"
  plant ||--o{ record_correction : "plant_id"
  app_account o|--o{ record_correction : "actor_account_id"
  command_receipt ||--o{ record_correction : "command_receipt_id,plant_id"
  plant ||--o{ person_merge : "plant_id"
  app_account o|--o{ person_merge : "actor_account_id"
  person ||--o{ person_merge : "source_person_id,plant_id"
  person ||--o{ person_merge : "survivor_person_id,plant_id"
  command_receipt o|--o{ person_merge : "inverse_receipt_id,plant_id"
  plant ||--o{ ministry_team : "plant_id"
  app_account o|--o{ ministry_team : "actor_account_id"
  person o|--o{ ministry_team : "leader_person_id,plant_id"
  team_role o|--o{ ministry_team : "leader_role_id,plant_id"
  ministry_team o|--o{ ministry_team : "reports_to_team_id,plant_id"
  plant ||--o{ team_role : "plant_id"
  app_account o|--o{ team_role : "actor_account_id"
  ministry_team ||--o{ team_role : "team_id,plant_id"
  team_role o|--o{ team_role : "reports_to_role_id,plant_id"
  plant ||--o{ team_membership : "plant_id"
  app_account o|--o{ team_membership : "actor_account_id"
  ministry_team ||--o{ team_membership : "team_id,plant_id"
  person ||--o{ team_membership : "person_id,plant_id"
  team_role o|--o{ team_membership : "role_id,team_id,plant_id"
  plant ||--o{ team_responsibility : "plant_id"
  app_account o|--o{ team_responsibility : "actor_account_id"
  ministry_team ||--o{ team_responsibility : "team_id,plant_id"
  plant ||--o{ training_program : "plant_id"
  app_account o|--o{ training_program : "actor_account_id"
  ministry_team o|--o{ training_program : "team_id,plant_id"
  training_requirement_version o|--o{ training_program : "current_requirement_version_id,id,plant_id"
  plant ||--o{ training_requirement_version : "plant_id"
  app_account o|--o{ training_requirement_version : "actor_account_id"
  training_program ||--o{ training_requirement_version : "program_id,plant_id"
  plant ||--o{ training_assignment_episode : "plant_id"
  app_account o|--o{ training_assignment_episode : "actor_account_id"
  training_program ||--o{ training_assignment_episode : "program_id,plant_id"
  person ||--o{ training_assignment_episode : "person_id,plant_id"
  training_requirement_version ||--o{ training_assignment_episode : "requirement_version_id,program_id,plant_id"
  plant ||--o{ training_assignment_event : "plant_id"
  app_account o|--o{ training_assignment_event : "actor_account_id"
  training_assignment_episode ||--o{ training_assignment_event : "assignment_episode_id,plant_id"
  plant ||--o{ training_completion : "plant_id"
  app_account o|--o{ training_completion : "actor_account_id"
  training_program ||--o{ training_completion : "program_id,plant_id"
  person ||--o{ training_completion : "person_id,plant_id"
  training_requirement_version ||--o{ training_completion : "requirement_version_id,program_id,plant_id"
  training_assignment_episode o|--o{ training_completion : "assignment_episode_id,program_id,person_id,plant_id"
  training_completion o|--o{ training_completion : "supersedes_completion_id,program_id,person_id,plant_id"
  plant ||--o{ meeting_location : "plant_id"
  app_account o|--o{ meeting_location : "actor_account_id"
  plant ||--o{ meeting : "plant_id"
  app_account o|--o{ meeting : "actor_account_id"
  meeting_location o|--o{ meeting : "location_id,plant_id"
  ministry_team o|--o{ meeting : "team_id,plant_id"
  plant ||--o{ meeting_participation : "plant_id"
  app_account o|--o{ meeting_participation : "actor_account_id"
  meeting ||--o{ meeting_participation : "meeting_id,plant_id"
  person ||--o{ meeting_participation : "person_id,plant_id"
  person o|--o{ meeting_participation : "invited_by_person_id,plant_id"
  meeting o|--o{ meeting_participation : "classification_prior_meeting_id,plant_id"
  plant ||--o{ meeting_invitation : "plant_id"
  meeting ||--o{ meeting_invitation : "meeting_id,plant_id"
  person o|--o{ meeting_invitation : "inviter_person_id,plant_id"
  person ||--o{ meeting_invitation : "invitee_person_id,plant_id"
  plant ||--o{ meeting_rsvp_token : "plant_id"
  meeting ||--o{ meeting_rsvp_token : "meeting_id,plant_id"
  person ||--o{ meeting_rsvp_token : "person_id,plant_id"
  plant ||--o{ vision_response : "plant_id"
  app_account o|--o{ vision_response : "actor_account_id"
  meeting_participation ||--o{ vision_response : "participation_id,meeting_id,person_id,plant_id"
  person ||--o{ vision_response : "person_id,plant_id"
  plant ||--o{ meeting_evaluation : "plant_id"
  app_account o|--o{ meeting_evaluation : "actor_account_id"
  meeting ||--o{ meeting_evaluation : "meeting_id,plant_id"
  plant ||--o{ meeting_checklist_item : "plant_id"
  meeting ||--o{ meeting_checklist_item : "meeting_id,plant_id"
  person o|--o{ meeting_checklist_item : "assigned_person_id,plant_id"
  plant ||--o{ meeting_event : "plant_id"
  app_account o|--o{ meeting_event : "actor_account_id"
  meeting ||--o{ meeting_event : "meeting_id,plant_id"
  command_receipt ||--o{ meeting_event : "command_receipt_id,plant_id"
  plant ||--o{ recurrence_series : "plant_id"
  plant ||--o{ follow_up_obligation : "plant_id"
  person ||--o{ follow_up_obligation : "person_id,plant_id"
  meeting ||--o{ follow_up_obligation : "origin_meeting_id,plant_id"
  app_account o|--o{ follow_up_obligation : "assigned_account_id"
  plant ||--o{ task : "plant_id"
  app_account o|--o{ task : "actor_account_id"
  app_account o|--o{ task : "assigned_account_id"
  app_account o|--o{ task : "completed_by_account_id"
  task o|--o{ task : "parent_task_id,plant_id"
  recurrence_series o|--o{ task : "recurrence_series_id,plant_id"
  task o|--o{ task : "predecessor_task_id,plant_id"
  follow_up_obligation o|--o{ task : "follow_up_obligation_id,plant_id"
  plant ||--o{ task_relation : "plant_id"
  task ||--o{ task_relation : "task_id,plant_id"
  person o|--o{ task_relation : "person_id,plant_id"
  meeting o|--o{ task_relation : "meeting_id,plant_id"
  ministry_team o|--o{ task_relation : "team_id,plant_id"
  launch o|--o{ task_relation : "launch_id,plant_id"
  plant ||--o{ task_dependency : "plant_id"
  task ||--o{ task_dependency : "task_id,plant_id"
  task ||--o{ task_dependency : "prerequisite_task_id,plant_id"
  plant ||--o{ task_status_event : "plant_id"
  app_account o|--o{ task_status_event : "actor_account_id"
  task ||--o{ task_status_event : "task_id,plant_id"
  plant ||--o{ follow_up_outcome : "plant_id"
  app_account o|--o{ follow_up_outcome : "actor_account_id"
  follow_up_obligation ||--o{ follow_up_outcome : "obligation_id,plant_id"
  person ||--o{ follow_up_outcome : "person_id,plant_id"
  task o|--o{ follow_up_outcome : "task_id,plant_id"
  follow_up_outcome o|--o{ follow_up_outcome : "supersedes_outcome_id,plant_id"
  plant ||--o{ phase_template_offer_response : "plant_id"
  app_account o|--o{ phase_template_offer_response : "actor_account_id"
  phase_transition ||--o{ phase_template_offer_response : "phase_transition_id,plant_id"
  reference_template_version ||--o{ phase_template_offer_response : "template_version_id"
  plant ||--o{ template_import_receipt : "plant_id"
  app_account o|--o{ template_import_receipt : "actor_account_id"
  reference_template_version ||--o{ template_import_receipt : "template_version_id"
  phase_template_offer_response o|--o{ template_import_receipt : "offer_response_id,plant_id"
  plant ||--o{ phase_transition : "plant_id"
  app_account o|--o{ phase_transition : "actor_account_id"
  plant ||--o{ plant_attestation : "plant_id"
  app_account o|--o{ plant_attestation : "actor_account_id"
  plant ||--o{ person_attestation : "plant_id"
  app_account o|--o{ person_attestation : "actor_account_id"
  person ||--o{ person_attestation : "person_id,plant_id"
  plant ||--o| launch : "plant_id"
  app_account o|--o{ launch : "actor_account_id"
  plant ||--o{ launch_event : "plant_id"
  app_account o|--o{ launch_event : "actor_account_id"
  launch ||--o{ launch_event : "launch_id,plant_id"
  plant ||--o{ launch_milestone : "plant_id"
  launch ||--o{ launch_milestone : "launch_id,plant_id"
  app_account o|--o{ launch_milestone : "completed_by_account_id"
  plant ||--o{ launch_milestone_task : "plant_id"
  launch_milestone ||--o{ launch_milestone_task : "milestone_id,plant_id"
  task ||--o{ launch_milestone_task : "task_id,plant_id"
  plant ||--o{ launch_person_attendance : "plant_id"
  app_account o|--o{ launch_person_attendance : "actor_account_id"
  launch ||--o{ launch_person_attendance : "launch_id,plant_id"
  person ||--o{ launch_person_attendance : "person_id,plant_id"
  plant ||--o{ planter_checkin : "plant_id"
  app_account ||--o{ planter_checkin : "original_author_account_id"
  plant ||--o{ planter_checkin_event : "plant_id"
  app_account ||--o{ planter_checkin_event : "original_author_account_id"
  planter_checkin ||--o{ planter_checkin_event : "checkin_id,original_author_account_id,plant_id"
  app_account o|--o{ reference_activation : "actor_account_id"
  reference_release ||--o{ reference_activation : "release_id"
  reference_activation o|--o{ reference_activation : "previous_activation_id"
  reference_release ||--o{ reference_section : "release_id"
  reference_section o|--o{ reference_section : "parent_section_id"
  organization o|--o{ wiki_article : "origin_organization_id,origin_organization_kind"
  organization o|--o{ wiki_source : "organization_id,organization_kind"
  app_account o|--o{ wiki_article_version : "actor_account_id"
  wiki_article ||--o{ wiki_article_version : "article_id"
  wiki_source ||--o{ wiki_article_version : "source_id"
  reference_release o|--o{ wiki_article_version : "release_id"
  wiki_article_version o|--o{ wiki_article_version : "upstream_version_id"
  reference_section o|--o{ wiki_article_version : "section_id"
  organization ||--o{ organization_wiki_article_state : "organization_id,organization_kind"
  app_account o|--o{ organization_wiki_article_state : "actor_account_id"
  wiki_article ||--o{ organization_wiki_article_state : "article_id"
  wiki_source ||--o{ organization_wiki_article_state : "source_id"
  wiki_article_version o|--o{ organization_wiki_article_state : "current_version_id"
  wiki_article_version o|--o{ organization_wiki_article_state : "based_on_upstream_version_id"
  plant ||--o{ plant_wiki_source_order : "plant_id"
  plant ||--o{ plant_wiki_source_order_entry : "plant_id"
  plant_wiki_source_order ||--o{ plant_wiki_source_order_entry : "order_id,plant_id"
  plant_affiliation ||--o{ plant_wiki_source_order_entry : "affiliation_id,plant_id,organization_id,organization_kind"
  app_account ||--o{ wiki_read_progress : "account_id"
  wiki_article ||--o{ wiki_read_progress : "article_id"
  wiki_source ||--o{ wiki_read_progress : "source_id"
  plant o|--o{ wiki_read_progress : "plant_context_id"
  wiki_article_version ||--o{ wiki_read_progress : "last_version_id,article_id,source_id"
  wiki_article_version o|--o{ wiki_read_progress : "completed_version_id,article_id,source_id"
  app_account ||--o{ wiki_read_event : "account_id"
  wiki_article ||--o{ wiki_read_event : "article_id"
  wiki_source ||--o{ wiki_read_event : "source_id"
  plant o|--o{ wiki_read_event : "plant_context_id"
  wiki_article_version ||--o{ wiki_read_event : "version_id,article_id,source_id"
  app_account ||--o{ wiki_bookmark : "account_id"
  wiki_article ||--o{ wiki_bookmark : "article_id"
  wiki_source ||--o{ wiki_bookmark : "source_id"
  wiki_article_version o|--o{ wiki_bookmark : "created_version_id"
  app_account ||--o{ wiki_article_feedback : "account_id"
  wiki_article ||--o{ wiki_article_feedback : "article_id"
  wiki_source ||--o{ wiki_article_feedback : "source_id"
  plant o|--o{ wiki_article_feedback : "plant_context_id"
  wiki_article_version ||--o{ wiki_article_feedback : "version_id,article_id,source_id"
  reference_release ||--o{ reference_chunk : "release_id"
  wiki_article_version o|--o{ reference_chunk : "article_version_id"
  reference_release ||--o{ reference_template_version : "release_id"
  plant o|--o{ owned_documents : "plant_id"
  organization o|--o{ owned_documents : "organization_id,organization_kind"
  app_account o|--o{ owned_documents : "account_id"
  app_account o|--o{ owned_documents : "actor_account_id"
  owned_document_revisions o|--o{ owned_documents : "current_revision_id"
  owned_documents o|--o{ owned_documents : "copied_from_document_id"
  plant o|--o{ owned_document_revisions : "plant_id"
  organization o|--o{ owned_document_revisions : "organization_id,organization_kind"
  app_account o|--o{ owned_document_revisions : "account_id"
  app_account o|--o{ owned_document_revisions : "actor_account_id"
  owned_documents ||--o{ owned_document_revisions : "document_id"
  object_metadata o|--o{ owned_document_revisions : "import_object_id"
  plant o|--o{ generated_document : "plant_id"
  organization o|--o{ generated_document : "organization_id,organization_kind"
  app_account o|--o{ generated_document : "account_id"
  app_account o|--o{ generated_document : "actor_account_id"
  reference_template_version ||--o{ generated_document : "template_version_id"
  object_metadata ||--o{ generated_document : "object_id"
  plant o|--o{ upload_intent : "plant_id"
  organization o|--o{ upload_intent : "organization_id,organization_kind"
  app_account o|--o{ upload_intent : "account_id"
  app_account ||--o{ upload_intent : "uploader_account_id"
  object_metadata o|--o{ upload_intent : "finalized_object_id"
  plant o|--o{ object_metadata : "plant_id"
  organization o|--o{ object_metadata : "organization_id,organization_kind"
  app_account o|--o{ object_metadata : "account_id"
  upload_intent o|--o{ object_metadata : "upload_intent_id"
  plant o|--o{ assessment_demand : "plant_id"
  organization o|--o{ assessment_demand : "organization_id,organization_kind"
  app_account o|--o{ assessment_demand : "account_id"
  reference_release ||--o{ assessment_demand : "reference_release_id"
  job o|--o{ assessment_demand : "job_id"
  reference_activation ||--o{ assessment_demand : "reference_activation_number"
  plant ||--o{ intelligence_assessment_run : "plant_id"
  assessment_demand ||--o{ intelligence_assessment_run : "demand_id,plant_id"
  job ||--o{ intelligence_assessment_run : "job_id,plant_id"
  reference_release ||--o{ intelligence_assessment_run : "reference_release_id"
  reference_activation ||--o{ intelligence_assessment_run : "reference_activation_number"
  plant ||--o{ intelligence_insight : "plant_id"
  intelligence_assessment_run ||--o{ intelligence_insight : "assessment_run_id,plant_id"
  organization ||--o{ organization_intelligence_runs : "organization_id,organization_kind"
  assessment_demand ||--o{ organization_intelligence_runs : "demand_id,organization_id,organization_kind"
  job ||--o{ organization_intelligence_runs : "job_id,organization_id,organization_kind"
  reference_release ||--o{ organization_intelligence_runs : "reference_release_id"
  reference_activation ||--o{ organization_intelligence_runs : "reference_activation_number"
  organization ||--o{ organization_intelligence_contributor : "organization_id,organization_kind"
  organization_intelligence_runs ||--o{ organization_intelligence_contributor : "run_id,organization_id,organization_kind"
  plant ||--o{ organization_intelligence_contributor : "plant_id"
  plant_affiliation ||--o{ organization_intelligence_contributor : "affiliation_id,plant_id,organization_id,organization_kind"
  organization ||--o{ organization_intelligence_assessments : "organization_id,organization_kind"
  organization_intelligence_runs ||--o{ organization_intelligence_assessments : "run_id,organization_id,organization_kind"
  reference_release ||--o{ organization_intelligence_assessments : "reference_release_id"
  plant o|--o{ intelligence_feedback : "plant_id"
  organization o|--o{ intelligence_feedback : "organization_id,organization_kind"
  app_account o|--o{ intelligence_feedback : "account_id"
  app_account o|--o{ intelligence_feedback : "actor_account_id"
  reference_release ||--o{ intelligence_feedback : "reference_release_id"
  intelligence_insight o|--o{ intelligence_feedback : "plant_insight_id"
  intelligence_assessment_run o|--o{ intelligence_feedback : "plant_assessment_run_id"
  organization_intelligence_assessments o|--o{ intelligence_feedback : "organization_assessment_id"
  plant o|--o{ message_template : "plant_id"
  organization o|--o{ message_template : "organization_id,organization_kind"
  app_account o|--o{ message_template : "account_id"
  app_account o|--o{ message_template : "actor_account_id"
  reference_template_version o|--o{ message_template : "source_template_version_id"
  plant ||--o{ communication : "plant_id"
  app_account o|--o{ communication : "actor_account_id"
  message_template o|--o{ communication : "template_id"
  meeting o|--o{ communication : "meeting_id,plant_id"
  assistant_approval o|--o{ communication : "approval_id,plant_id"
  plant ||--o{ communication_recipient : "plant_id"
  communication ||--o{ communication_recipient : "communication_id,plant_id"
  person ||--o{ communication_recipient : "person_id,plant_id"
  email_intent o|--o{ communication_recipient : "email_intent_id,plant_id"
  plant o|--o{ email_intent : "plant_id"
  organization o|--o{ email_intent : "organization_id,organization_kind"
  app_account o|--o{ email_intent : "account_id"
  app_account o|--o{ email_intent : "recipient_account_id"
  communication_recipient o|--o{ email_intent : "communication_recipient_id"
  inbox_entry o|--o{ email_intent : "inbox_entry_id"
  job o|--o{ email_intent : "job_id"
  plant o|--o{ email_attempt : "plant_id"
  organization o|--o{ email_attempt : "organization_id,organization_kind"
  app_account o|--o{ email_attempt : "account_id"
  email_intent ||--o{ email_attempt : "email_intent_id"
  email_intent o|--o{ provider_event_receipt : "email_intent_id"
  plant ||--o{ communication_delivery_retry : "plant_id"
  communication_recipient ||--o{ communication_delivery_retry : "source_recipient_id,plant_id"
  communication_recipient ||--o{ communication_delivery_retry : "retry_recipient_id,plant_id"
  operation_execution o|--o{ communication_delivery_retry : "operation_execution_id,plant_id"
  app_account o|--o{ email_suppression : "cleared_by_account_id"
  app_account ||--o{ notification_preference : "account_id"
  plant o|--o{ inbox_entry : "plant_id"
  organization o|--o{ inbox_entry : "organization_id,organization_kind"
  app_account o|--o{ inbox_entry : "account_id"
  app_account ||--o{ inbox_entry : "recipient_account_id"
  plant o|--o{ assistant_conversation : "plant_id"
  organization o|--o{ assistant_conversation : "organization_id,organization_kind"
  app_account o|--o{ assistant_conversation : "account_id"
  app_account ||--o{ assistant_conversation : "owner_account_id"
  job o|--o{ assistant_conversation : "active_job_id"
  plant o|--o{ assistant_message : "plant_id"
  organization o|--o{ assistant_message : "organization_id,organization_kind"
  app_account o|--o{ assistant_message : "account_id"
  app_account ||--o{ assistant_message : "owner_account_id"
  assistant_conversation ||--o{ assistant_message : "conversation_id"
  plant o|--o{ assistant_artifact : "plant_id"
  organization o|--o{ assistant_artifact : "organization_id,organization_kind"
  app_account o|--o{ assistant_artifact : "account_id"
  app_account ||--o{ assistant_artifact : "owner_account_id"
  assistant_conversation ||--o{ assistant_artifact : "conversation_id"
  assistant_message o|--o{ assistant_artifact : "message_id"
  object_metadata o|--o{ assistant_artifact : "object_id"
  plant o|--o{ assistant_attachment : "plant_id"
  organization o|--o{ assistant_attachment : "organization_id,organization_kind"
  app_account o|--o{ assistant_attachment : "account_id"
  app_account ||--o{ assistant_attachment : "owner_account_id"
  assistant_conversation ||--o{ assistant_attachment : "conversation_id"
  upload_intent ||--o{ assistant_attachment : "upload_intent_id"
  object_metadata ||--o{ assistant_attachment : "object_id"
  plant o|--o{ assistant_plan : "plant_id"
  organization o|--o{ assistant_plan : "organization_id,organization_kind"
  app_account o|--o{ assistant_plan : "account_id"
  app_account ||--o{ assistant_plan : "owner_account_id"
  assistant_conversation ||--o{ assistant_plan : "conversation_id"
  plant o|--o{ assistant_approval : "plant_id"
  organization o|--o{ assistant_approval : "organization_id,organization_kind"
  app_account o|--o{ assistant_approval : "account_id"
  app_account ||--o{ assistant_approval : "owner_account_id"
  assistant_plan ||--o{ assistant_approval : "plan_id"
  app_account ||--o{ assistant_approval : "approved_by_account_id"
  plant o|--o{ operation_execution : "plant_id"
  organization o|--o{ operation_execution : "organization_id,organization_kind"
  app_account o|--o{ operation_execution : "account_id"
  app_account o|--o{ operation_execution : "initiated_by_account_id"
  assistant_approval o|--o{ operation_execution : "approval_id"
  command_receipt o|--o{ operation_execution : "command_receipt_id"
  plant o|--o{ operation_effect : "plant_id"
  organization o|--o{ operation_effect : "organization_id,organization_kind"
  app_account o|--o{ operation_effect : "account_id"
  operation_execution ||--o{ operation_effect : "execution_id"
  job o|--o{ operation_effect : "job_id"
  plant o|--o{ operation_result : "plant_id"
  organization o|--o{ operation_result : "organization_id,organization_kind"
  app_account o|--o{ operation_result : "account_id"
  operation_execution ||--o{ operation_result : "execution_id"
  app_account ||--o{ product_feedback : "account_id"
  plant o|--o{ product_feedback : "plant_context_id"
  feedback_publication o|--o{ product_feedback : "public_summary_id"
  app_account ||--o{ product_feedback : "original_author_account_id"
  app_account ||--o{ feedback_publication : "account_id"
  product_feedback ||--o{ feedback_publication : "feedback_id"
  operation_effect o|--o{ feedback_publication : "operation_effect_id"
  plant o|--o{ command_receipt : "plant_id"
  organization o|--o{ command_receipt : "organization_id,organization_kind"
  app_account o|--o{ command_receipt : "account_id"
  app_account o|--o{ command_receipt : "actor_account_id"
  plant o|--o{ job : "plant_id"
  organization o|--o{ job : "organization_id,organization_kind"
  app_account o|--o{ job : "account_id"
  plant o|--o{ audit_event : "plant_id"
  organization o|--o{ audit_event : "organization_id,organization_kind"
  app_account o|--o{ audit_event : "account_id"
  app_account o|--o{ audit_event : "actor_account_id"
  app_account o|--o{ audit_event : "initiated_by_account_id"
  app_account o|--o{ audit_event : "approved_by_account_id"
  assistant_approval o|--o{ audit_event : "approval_id"
  operation_execution o|--o{ audit_event : "operation_execution_id"
```
