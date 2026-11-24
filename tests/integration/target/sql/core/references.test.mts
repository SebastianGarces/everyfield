import test, { after } from "node:test";
import assert from "node:assert/strict";
import { registry } from "../../../../../packages/domain/src/people/person-reference-registry/index.ts";
import { assessments, commitments, recordCorrections } from "../../../../../packages/domain/src/people/index.ts";
import { sql, type SQL } from "../../../../../packages/db/src/query.ts";
import { ok, refused } from "../../../../support/fixture.mts";
import { caseOf, key, world, type Case, type Row } from "./support.mts";

const w = await world("wp091refs");
const { P, ctx, tx, rows, one, insert, person, personRow } = w;
const foreign = await person("Foreign canary", {}, "foreign");
await w.admin.execute(sql`INSERT INTO launch(plant_id,status) VALUES(${P},'planning')`);
const foreignMerge = await w.merge(
	await person("Foreign source", {}, "foreign"),
	await person("Foreign survivor", {}, "foreign"),
	{},
	"foreign",
);
after(() => w.database.close());

const PAST = "2026-10-01T12:00:00Z";
type Table = { table: string; column?: string; id: string };
type Seed = {
	reference: Table | { redirect: true };
	history: Table | { row: () => Promise<Row>; person: (row: Row) => unknown };
	edit?: () => Promise<unknown>;
	kept?: () => Promise<unknown>;
};
type Family = { cases: string; file: string; seed: (p2: string, p1: string) => Promise<Seed> };

const meeting = (title: string) =>
	insert("meeting", {
		type: "vision_meeting",
		title,
		local_date: "2026-10-01",
		local_time: "18:00",
		timezone: "America/Chicago",
		starts_at: "2026-10-01T23:00:00Z",
		resolver_version: "1",
		status: "completed",
		attendance_revision: 1,
	});
const attend = (meetingId: string, personId: string, values: Row = {}) =>
	insert("participation", {
		meeting_id: meetingId,
		person_id: personId,
		roster_member: false,
		presence: "attended",
		...values,
	});
const task = (personId: string, values: Row = {}) =>
	insert("task", {
		title: "Call them",
		category: "follow_up",
		priority: "medium",
		status: "not_started",
		created_at: PAST,
		due_kind: "undated",
		person_id: personId,
		...values,
	});
const assignee = (taskId: string) =>
	w.admin.execute(
		sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${P},${taskId},${w.actors.member.id})`,
	);
const assigneeOf = (taskId: string) => rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${taskId}::uuid`);
const mail = (personId: string, values: Row) => {
	const id = key();
	return insert("mail", {
		id,
		plant_id: undefined,
		tenant_id: P,
		recipient_person_id: personId,
		purpose: "communication",
		logical_key: `communication/${id}/${personId}`,
		payload_hash: "payload",
		audience_hash: "audience",
		frozen_payload: JSON.stringify({ subject: "Welcome", to: "old@example.test" }),
		recipient_address_encrypted: "sealed-address",
		address_hash: "hash",
		created_at: PAST,
		...values,
	});
};
const audit = (personId: string, values: Row = {}) =>
	insert("audit_event", {
		plant_id: undefined,
		tenant_id: P,
		actor_id: w.actors.admin.id,
		action: "people.recorded",
		kind: "edit",
		subject_type: "person",
		subject_id: personId,
		occurred_at: PAST,
		after_revision: 1,
		metadata: JSON.stringify({ event: "interview_recorded" }),
		...values,
	});
const bump = (table: string, id: string) => () =>
	w.admin.execute(sql`UPDATE ${sql.identifier(table)} SET revision=revision+1 WHERE id=${id}::uuid`);
const audited = async (p2: string, action: string): Promise<Table> => ({
	table: "audit_event",
	column: "subject_id",
	id: String((await one(sql`SELECT id FROM audit_event WHERE subject_id=${p2}::uuid AND action=${action} LIMIT 1`)).id),
});
const stored = (query: SQL, read: (row: Row) => unknown) => ({
	row: () => one(query),
	person: read,
});

const families: Family[] = [
	{
		cases:
			"AC:PERSONREF-ACCOUNT-LINK-CONFLICT AC:PERSONREF-ACCOUNT-LINK-MERGE AC:PERSONREF-ACCOUNT-LINK-RETIRE AC:PERSONREF-ACCOUNT-LINK-UNMERGE the linked account stays with the survivor and no seat changes hands",
		file: "identity-access",
		async seed(p2, p1) {
			const account = await w.database.actor(w.database.tenant, "member");
			await w.admin.execute(sql`UPDATE person SET linked_account_id=${account.id} WHERE id=${p1}::uuid`);
			return {
				reference: { redirect: true },
				history: await audited(p2, "people.created"),
				kept: () =>
					one(sql`SELECT (SELECT linked_account_id FROM person WHERE id=${p1}::uuid) AS p1,
						(SELECT linked_account_id FROM person WHERE id=${p2}::uuid) AS p2,
						(SELECT jsonb_agg(to_jsonb(s)) FROM seat s WHERE s.account_id=${account.id}::uuid) AS seats,
						(SELECT to_jsonb(a) FROM account a WHERE a.id=${account.id}::uuid) AS account`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-ASSESSMENT-INTERVIEW-COMMITMENT-CONFLICT AC:PERSONREF-ASSESSMENT-INTERVIEW-COMMITMENT-MERGE AC:PERSONREF-ASSESSMENT-INTERVIEW-COMMITMENT-RETIRE AC:PERSONREF-ASSESSMENT-INTERVIEW-COMMITMENT-UNMERGE records keep their dates, recorder and corrections",
		file: "people",
		async seed(p2) {
			const lens = (score: number) => ({ score, notes: null });
			const made = ok(
				await tx((t) =>
					assessments.createAssessment(t, ctx(), {
						requestKey: key(),
						input: {
							personId: p2,
							occurredOn: "2026-10-01",
							committed: lens(4),
							compelled: lens(4),
							contagious: lens(4),
							courageous: lens(4),
						},
					}),
				),
			).assessment;
			const card = ok(
				await tx((t) =>
					commitments.createCommitment(t, ctx(), {
						requestKey: key(),
						input: { personId: p2, kind: "core_group", occurredOn: "2026-10-01" },
					}),
				),
			).commitment;
			return {
				reference: { table: "four_cs", id: made.id },
				history: await audited(p2, "people.recorded"),
				edit: async () =>
					ok(
						await tx((t) =>
							recordCorrections.correctPersonRecord(t, ctx(), {
								requestKey: key(),
								expectedRevision: made.revision,
								input: {
									recordType: "assessment",
									personId: p2,
									recordId: made.id,
									reason: "Wrong form",
									changes: { committed: lens(5) },
								},
							}),
						),
					),
				kept: () =>
					one(sql`SELECT (SELECT to_jsonb(k)-'person_id'-'revision' FROM commitment k WHERE k.id=${card.id}::uuid) AS card,
						(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM audit_event a
							WHERE a.subject_id=${p2}::uuid AND a.action='people.recorded') AS recorded`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-CONFLICT AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-MERGE AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-RETIRE AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-UNMERGE a prepared Evry review keeps the person, digest and receipt it was made with",
		file: "evry",
		async seed(p2) {
			const conversation = await insert("conversation", {
				plant_id: undefined,
				tenant_id: P,
				account_id: w.actors.admin.id,
				context_kind: "plant",
				title: "Chat",
			});
			const id = await insert("proposal", {
				plant_id: undefined,
				tenant_id: P,
				account_id: w.actors.admin.id,
				conversation_id: conversation,
				operation: "people.updatePerson",
				input: JSON.stringify({ input: { personId: p2, patch: { city: "Elgin" } }, expectedRevision: "1" }),
				review: JSON.stringify({ target: { kind: "person", id: p2, label: "Alex Chen" }, changes: [] }),
				digest: "b".repeat(64),
				state: "pending",
				expires_at: "2026-10-14T12:00:00Z",
			});
			const proposal = sql`SELECT to_jsonb(x) AS proposal FROM proposal x WHERE x.id=${id}::uuid`;
			return {
				reference: { redirect: true },
				history: stored(proposal, (row) => (row.proposal as { input: { input: Row } }).input.input.personId),
				kept: () => one(proposal),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-CANDIDATE-PERSON-ATTESTATION-CONFLICT AC:PERSONREF-CANDIDATE-PERSON-ATTESTATION-MERGE AC:PERSONREF-CANDIDATE-PERSON-ATTESTATION-RETIRE AC:PERSONREF-CANDIDATE-PERSON-ATTESTATION-UNMERGE the dated evidence keeps its interval and answer",
		file: "people",
		async seed(p2) {
			const evidence = {
				key: "leadership_candidate",
				person_id: p2,
				answer: true,
				as_of: "2026-10-01",
				period_start: "2026-07-20",
				period_end: "2026-10-01",
				attendance_continuous: true,
				volunteering_continuous: true,
			};
			const id = await insert("attestation", { ...evidence, state: "answered", attested_at: PAST });
			const revision = await insert("attestation_revision", {
				...evidence,
				attestation_id: id,
				revision: 1,
				kind: "answered",
				question_version: "1",
				request_key: key(),
				request_fingerprint: "f",
			});
			return {
				reference: { table: "attestation", id },
				history: { table: "attestation_revision", id: revision },
				edit: bump("attestation", id),
				kept: () =>
					one(sql`SELECT (SELECT to_jsonb(a)-'person_id'-'revision' FROM attestation a WHERE a.id=${id}::uuid) AS now,
						(SELECT to_jsonb(r) FROM attestation_revision r WHERE r.id=${revision}::uuid) AS history`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-COMMUNICATION-RECIPIENT-CONTACT-CONFLICT AC:PERSONREF-COMMUNICATION-RECIPIENT-CONTACT-MERGE AC:PERSONREF-COMMUNICATION-RECIPIENT-CONTACT-RETIRE AC:PERSONREF-COMMUNICATION-RECIPIENT-CONTACT-UNMERGE unsent email follows the person and sent email stays byte-equal",
		file: "communications-notifications",
		async seed(p2) {
			const waiting = await mail(p2, { state: "scheduled", scheduled_at: "2026-11-01T12:00:00Z" });
			const sent = await mail(p2, { state: "sent", sent_at: PAST, provider_message_id: key() });
			return {
				reference: { table: "mail", column: "recipient_person_id", id: waiting },
				history: { table: "mail", column: "recipient_person_id", id: sent },
				edit: bump("mail", waiting),
				kept: () =>
					one(sql`SELECT (SELECT to_jsonb(m) FROM mail m WHERE m.id=${sent}::uuid) AS sent,
						(SELECT to_jsonb(m)-'recipient_person_id'-'revision' FROM mail m WHERE m.id=${waiting}::uuid) AS waiting`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-DOCUMENT-COMMITMENT-EVIDENCE-CONFLICT AC:PERSONREF-DOCUMENT-COMMITMENT-EVIDENCE-MERGE AC:PERSONREF-DOCUMENT-COMMITMENT-EVIDENCE-RETIRE AC:PERSONREF-DOCUMENT-COMMITMENT-EVIDENCE-UNMERGE the signed file keeps its bytes and its signer",
		file: "knowledge",
		async seed(p2) {
			const file = await insert("file_object", {
				plant_id: undefined,
				tenant_id: P,
				purpose: "commitment",
				opaque_key: `private/${P}/${key()}`,
				media_type: "application/pdf",
				max_bytes: 100,
				byte_count: 42,
				sha256: "a".repeat(64),
				state: "ready",
				upload_key: key(),
				claim_generation: 0,
			});
			const card = await insert("commitment", {
				person_id: p2,
				kind: "core_group",
				signed_on: "2026-10-01",
				recorded_at: PAST,
				object_id: file,
			});
			const signed = await audit(p2, {
				metadata: JSON.stringify({ event: "commitment_recorded", recordId: card }),
			});
			return {
				reference: { table: "commitment", id: card },
				history: { table: "audit_event", column: "subject_id", id: signed },
				edit: bump("commitment", card),
				kept: () =>
					one(sql`SELECT (SELECT to_jsonb(f) FROM file_object f WHERE f.id=${file}::uuid) AS file,
						(SELECT to_jsonb(k)-'person_id'-'revision' FROM commitment k WHERE k.id=${card}::uuid) AS card,
						(SELECT to_jsonb(a) FROM audit_event a WHERE a.id=${signed}::uuid) AS signed`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-HOUSEHOLD-TAG-SKILL-NOTE-CONFLICT AC:PERSONREF-HOUSEHOLD-TAG-SKILL-NOTE-MERGE AC:PERSONREF-HOUSEHOLD-TAG-SKILL-NOTE-RETIRE AC:PERSONREF-HOUSEHOLD-TAG-SKILL-NOTE-UNMERGE the note keeps its author and shared tags and skills do not double",
		file: "people",
		async seed(p2, p1) {
			const household = await insert("household", { name: "Chen home" });
			await w.admin.execute(
				sql`UPDATE person SET household_id=${household}::uuid,household_role='head' WHERE id=${p2}::uuid`,
			);
			const name = `Volunteer ${key()}`;
			const tag = await insert("tag", { name, normalized_name: name.toLowerCase() });
			for (const id of [p1, p2]) {
				await w.admin.execute(sql`INSERT INTO person_tag(plant_id,person_id,tag_id) VALUES(${P},${id},${tag})`);
				await insert("person_skill", {
					person_id: id,
					name: id === p1 ? "Sound" : " sound",
					category: "tech",
				});
			}
			const own = await insert("person_skill", {
				person_id: p2,
				name: "Teaching",
				category: "teaching",
			});
			const note = await insert("person_note", {
				tenant_id: P,
				person_id: p2,
				author_id: w.actors.owner.id,
				body: "Met at the picnic",
				occurred_at: PAST,
				recorded_at: PAST,
			});
			return {
				reference: { table: "person_skill", id: own },
				history: await audited(p2, "people.created"),
				edit: bump("person_skill", own),
				kept: async () => ({
					...(await one(sql`SELECT (SELECT to_jsonb(n)-'person_id'-'revision' FROM person_note n WHERE n.id=${note}::uuid) AS note,
						(SELECT count(*)::int FROM person_tag WHERE person_id=${p1}::uuid AND tag_id=${tag}::uuid) AS tags,
						(SELECT count(*)::int FROM person_skill WHERE person_id=${p1}::uuid AND lower(btrim(name))='sound') AS skills`)),
				}),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-INTELLIGENCE-SNAPSHOT-CITATION-CONFLICT AC:PERSONREF-INTELLIGENCE-SNAPSHOT-CITATION-MERGE AC:PERSONREF-INTELLIGENCE-SNAPSHOT-CITATION-RETIRE AC:PERSONREF-INTELLIGENCE-SNAPSHOT-CITATION-UNMERGE a recorded assessment keeps its person, text and time",
		file: "intelligence",
		async seed(p2) {
			const id = await insert("assessment_run", {
				as_of: PAST,
				phase: 1,
				source_revision: "1",
				formula_version: "1",
				rubric_version: "v1",
				rubric_sha256: "a".repeat(64),
				model: "synthetic",
				outcome: "published",
				grounding: "grounded",
				model_input: "{}",
				result: "{}",
				available_at: PAST,
				facts: JSON.stringify({ cohesion: { disengaged: [{ id: p2, name: "Alex Chen" }] } }),
				drafts: "[]",
				attempts: 1,
				input_tokens: 0,
				output_tokens: 0,
				demand: "manual",
				demand_key: key(),
				captured_at: PAST,
				deadline_at: PAST,
				settled_at: PAST,
			});
			const run = sql`SELECT to_jsonb(r) AS run FROM assessment_run r WHERE r.id=${id}::uuid`;
			return {
				reference: { redirect: true },
				history: stored(
					run,
					(row) =>
						(row.run as { facts: { cohesion: { disengaged: { id: string }[] } } }).facts.cohesion.disengaged[0]?.id,
				),
				kept: () => one(run),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-LAUNCH-NAMED-GUEST-CONFLICT AC:PERSONREF-LAUNCH-NAMED-GUEST-MERGE AC:PERSONREF-LAUNCH-NAMED-GUEST-RETIRE AC:PERSONREF-LAUNCH-NAMED-GUEST-UNMERGE the guest link moves and the recorder stays",
		file: "launch",
		async seed(p2) {
			const id = await insert("launch_guest", {
				person_id: p2,
				recorded_by: w.actors.owner.id,
				recorded_at: PAST,
			});
			return {
				reference: { table: "launch_guest", id },
				history: await audited(p2, "people.created"),
				edit: bump("launch_guest", id),
				kept: () =>
					one(sql`SELECT to_jsonb(g)-'person_id'-'revision' AS guest FROM launch_guest g WHERE g.id=${id}::uuid`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-MEETING-CHECKLIST-PERSON-CONFLICT AC:PERSONREF-MEETING-CHECKLIST-PERSON-MERGE AC:PERSONREF-MEETING-CHECKLIST-PERSON-RETIRE AC:PERSONREF-MEETING-CHECKLIST-PERSON-UNMERGE the kit item moves and grants no login",
		file: "meetings-follow-up",
		async seed(p2) {
			const id = await insert("meeting_kit_item", {
				meeting_id: await meeting("Kit night"),
				item_key: key(),
				position: 1,
				category: "materials",
				text: "Welcome cards",
				assignee_person_id: p2,
			});
			return {
				reference: { table: "meeting_kit_item", column: "assignee_person_id", id },
				history: await audited(p2, "people.created"),
				edit: bump("meeting_kit_item", id),
				kept: () =>
					one(sql`SELECT (SELECT count(*)::int FROM seat) AS seats,(SELECT count(*)::int FROM account) AS accounts`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-MEETING-INVITATION-RSVP-ATTENDANCE-CARD-CONFLICT AC:PERSONREF-MEETING-INVITATION-RSVP-ATTENDANCE-CARD-MERGE AC:PERSONREF-MEETING-INVITATION-RSVP-ATTENDANCE-CARD-RETIRE AC:PERSONREF-MEETING-INVITATION-RSVP-ATTENDANCE-CARD-UNMERGE one attendance per meeting and no repeated first-Vision effects",
		file: "meetings-follow-up",
		async seed(p2, p1) {
			const id = await attend(await meeting("Only theirs"), p2, {
				rsvp: "confirmed",
				rsvp_source: "admin",
				rsvp_at: PAST,
				card_response: "interested",
				card_recorded_at: PAST,
				card_occurred_at: PAST,
				card_author_id: w.actors.owner.id,
			});
			const shared = await meeting("Both came");
			await attend(shared, p1);
			await attend(shared, p2);
			return {
				reference: { table: "participation", id },
				history: await audited(p2, "people.created"),
				edit: bump("participation", id),
				kept: () =>
					one(sql`SELECT (SELECT to_jsonb(g)-'person_id'-'revision' FROM participation g WHERE g.id=${id}::uuid) AS card,
						(SELECT count(*)::int FROM participation WHERE meeting_id=${shared}::uuid AND person_id=${p1}::uuid
							AND removed_at IS NULL) AS mine,
						(SELECT count(*)::int FROM task) AS tasks,(SELECT count(*)::int FROM obligation) AS obligations`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-NOTIFICATION-PERSON-SUBJECT-CONFLICT AC:PERSONREF-NOTIFICATION-PERSON-SUBJECT-MERGE AC:PERSONREF-NOTIFICATION-PERSON-SUBJECT-RETIRE AC:PERSONREF-NOTIFICATION-PERSON-SUBJECT-UNMERGE the notice keeps its recipient, text and time",
		file: "communications-notifications",
		async seed(p2) {
			const about = await task(p2, { title: "Call Alex Chen" });
			const id = await insert("notice", {
				plant_id: undefined,
				tenant_id: P,
				recipient_id: w.actors.admin.id,
				category: "task",
				purpose: "task_due",
				logical_key: `${P}/task_due/${about}/${p2}`,
				source_record_id: p2,
				source_revision: 1,
				title: "Call Alex Chen is due",
				eligible_at: PAST,
				created_at: PAST,
			});
			const notice = sql`SELECT to_jsonb(n) AS notice FROM notice n WHERE n.id=${id}::uuid`;
			return {
				reference: { table: "task", id: about },
				history: { table: "notice", column: "source_record_id", id },
				edit: bump("task", about),
				kept: () => one(notice),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-PERSON-REDIRECT-MERGE-HISTORY-CONFLICT AC:PERSONREF-PERSON-REDIRECT-MERGE-HISTORY-MERGE AC:PERSONREF-PERSON-REDIRECT-MERGE-HISTORY-RETIRE AC:PERSONREF-PERSON-REDIRECT-MERGE-HISTORY-UNMERGE a chained merge resolves to the last survivor and keeps each merge as it happened",
		file: "people",
		async seed(p2) {
			const earlier = await person("Alex C.");
			const { mergeId } = await w.merge(earlier, p2);
			return {
				reference: { table: "person", column: "merged_into_person_id", id: earlier },
				history: { table: "person_merge", column: "survivor_id", id: mergeId },
				edit: bump("person", earlier),
				kept: () => one(sql`SELECT to_jsonb(m) AS merge FROM person_merge m WHERE m.id=${mergeId}::uuid`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-SHARED-RECEIPT-AUDIT-PERSON-SUBJECT-CONFLICT AC:PERSONREF-SHARED-RECEIPT-AUDIT-PERSON-SUBJECT-MERGE AC:PERSONREF-SHARED-RECEIPT-AUDIT-PERSON-SUBJECT-RETIRE AC:PERSONREF-SHARED-RECEIPT-AUDIT-PERSON-SUBJECT-UNMERGE receipts and audit keep their subject",
		file: "people",
		async seed(p2) {
			const id = await audit(p2, { request_key: key() });
			return {
				reference: { redirect: true },
				history: { table: "audit_event", column: "subject_id", id },
				kept: () => one(sql`SELECT to_jsonb(a) AS audit FROM audit_event a WHERE a.id=${id}::uuid`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-TASK-PERSON-FOLLOW-UP-CONFLICT AC:PERSONREF-TASK-PERSON-FOLLOW-UP-MERGE AC:PERSONREF-TASK-PERSON-FOLLOW-UP-RETIRE AC:PERSONREF-TASK-PERSON-FOLLOW-UP-UNMERGE the owner account and contact evidence stay and nothing is contacted again",
		file: "tasks",
		async seed(p2, p1) {
			const met = await meeting("Follow-up night");
			const obligation = (personId: string) =>
				insert("obligation", {
					meeting_id: met,
					person_id: personId,
					kind: "follow_up",
					origin_at: PAST,
					origin_date: "2026-10-01",
					timezone: "America/Chicago",
					formula_version: "1",
					due_date: "2026-10-04",
				});
			await obligation(p1);
			const theirs = await obligation(p2);
			const id = await task(p2, { obligation_id: theirs });
			await assignee(id);
			const contacted = await insert("contact_outcome", {
				person_id: p2,
				obligation_id: theirs,
				outcome: "attempted_no_contact",
				occurred_at: PAST,
				recorded_at: PAST,
				contact_channel: "phone",
			});
			return {
				reference: { table: "task", id },
				history: { table: "obligation", id: theirs },
				edit: bump("task", id),
				kept: async () => ({
					owners: await assigneeOf(id),
					...(await one(sql`SELECT (SELECT to_jsonb(x)-'person_id'-'revision' FROM contact_outcome x WHERE x.id=${contacted}::uuid) AS contact,
						(SELECT count(*)::int FROM contact_outcome WHERE outcome='contacted') AS contacted,
						(SELECT to_jsonb(o) FROM obligation o WHERE o.id=${theirs}::uuid) AS duty`)),
				}),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-TEAM-ROLE-LEADER-CONFLICT AC:PERSONREF-TEAM-ROLE-LEADER-MERGE AC:PERSONREF-TEAM-ROLE-LEADER-RETIRE AC:PERSONREF-TEAM-ROLE-LEADER-UNMERGE the role moves and a title grants no access",
		file: "teams-training",
		async seed(p2) {
			const team = await insert("team", {
				name: `Hospitality ${key()}`,
				state: "active",
				sort_order: 1,
				leader_person_id: p2,
				leader_source: "explicit",
			});
			const role = await insert("team_role", {
				team_id: team,
				name: "Greeter",
				leadership: false,
				sort_order: 1,
			});
			const id = await insert("team_tenure", {
				role_id: role,
				person_id: p2,
				started_on: "2026-06-01",
			});
			return {
				reference: { table: "team_tenure", id },
				history: await audited(p2, "people.created"),
				edit: bump("team_tenure", id),
				kept: () => one(sql`SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) AS seats FROM seat s`),
			};
		},
	},
	{
		cases:
			"AC:PERSONREF-TRAINING-APPLICABILITY-COMPLETION-CONFLICT AC:PERSONREF-TRAINING-APPLICABILITY-COMPLETION-MERGE AC:PERSONREF-TRAINING-APPLICABILITY-COMPLETION-RETIRE AC:PERSONREF-TRAINING-APPLICABILITY-COMPLETION-UNMERGE the assignment moves once and the completion keeps its date",
		file: "teams-training",
		async seed(p2) {
			const program = await insert("training_program", {
				name: `Welcome ${key()}`,
				required: true,
			});
			const id = await insert("training_assignment", {
				program_id: program,
				person_id: p2,
				version: 1,
				state: "active",
				effective_on: "2026-10-01",
			});
			const credit = await insert("training_credit", {
				person_id: p2,
				program_id: program,
				kind: "earned",
				version: 1,
				earned_on: "2026-10-01",
				verifier_account_id: w.actors.owner.id,
				recorded_at: PAST,
			});
			return {
				reference: { table: "training_assignment", id },
				history: { table: "training_credit", id: credit },
				edit: bump("training_assignment", id),
				kept: () => one(sql`SELECT to_jsonb(c) AS credit FROM training_credit c WHERE c.id=${credit}::uuid`),
			};
		},
	},
];

type Pair = { p1: string; p2: string; seed: Seed };
async function pairOf(family: Family): Promise<Pair> {
	const p1 = await person("Alex Rivera"),
		p2 = await person("Alex Chen");
	return { p1, p2, seed: await family.seed(p2, p1) };
}
const label = (pair: Pair, id: unknown) => (id === pair.p1 ? "P1" : id === pair.p2 ? "P2" : id);
async function ownerOf(pair: Pair, at: Seed["reference"] | Seed["history"]) {
	if ("redirect" in at) return label(pair, ok(await w.destination(pair.p2)).destinationId);
	if ("row" in at) return label(pair, at.person(await at.row()));
	const column = sql.identifier(at.column ?? "person_id");
	const row = await one(sql`SELECT ${column} AS owner FROM ${sql.identifier(at.table)} WHERE id=${at.id}::uuid`);
	return label(pair, row.owner);
}
const reviewed = { P1: "fixture-state-4", P2: "fixture-state-3" } as const;
async function revisions(pair: Pair) {
	const { reference } = pair.seed;
	return {
		P1: (await personRow(pair.p1)).revision,
		P2: (await personRow(pair.p2)).revision,
		"reference-1":
			"redirect" in reference ? (await personRow(pair.p2)).revision : await w.revisionOf(reference.table, reference.id),
	};
}
async function stateOf(
	pair: Pair,
	consumer: unknown,
	expected: Record<string, unknown>,
	before: Awaited<ReturnType<typeof revisions>>,
) {
	const now = await revisions(pair);
	const expectedReference = expected["reference-1"] as { observed_state?: string } | undefined;
	const person = async (id: "P1" | "P2", personId: string) => ({
		id,
		plant: "P",
		name: (await personRow(personId)).display_name,
		observed_state: now[id] === before[id] ? reviewed[id] : "changed",
	});
	return {
		P1: await person("P1", pair.p1),
		P2: await person("P2", pair.p2),
		"reference-1": {
			consumer,
			person: await ownerOf(pair, pair.seed.reference),
			plant: "P",
			observed_state: now["reference-1"] === before["reference-1"] ? expectedReference?.observed_state : "changed",
		},
		"original-history": {
			consumer,
			person: await ownerOf(pair, pair.seed.history),
			occurred_at: PAST,
		},
	};
}
type Refusal = { status: string; error?: { code: string; details: unknown } };
const CODES: Record<string, string> = {
	"foreign-person-refused": "not_found",
	"member-mutation-refused": "access_denied",
};
async function checkRefusals(c: Case, pair: Pair, run: Record<string, () => Promise<unknown>>) {
	assert.deepEqual(
		c.subcases?.map((s) => s.name),
		["foreign-person-refused", "member-mutation-refused", "required-write-fault-rolls-back"],
	);
	for (const s of c.subcases ?? []) {
		const before = await w.everything(),
			at = await revisions(pair);
		const attempt = run[s.name];
		assert.ok(attempt);
		const result: Row = {};
		if (s.name === "required-write-fault-rolls-back") {
			result.error_code = await w.commitFault("audit_event", attempt);
			Object.assign(result, {
				additional_recorded_outcomes: (await w.changed(before)).length,
				audit_rows_added: (await w.changed(before)).filter((t) => t === "audit_event").length,
				history_rows_added: (await w.changed(before)).filter((t) => t === "person_merge").length,
			});
		} else {
			for (let n = 0; n < 2; n++) {
				const reply = (await attempt()) as Refusal;
				refused(reply);
				const text = JSON.stringify(reply);
				assert.ok(!/Alex|Foreign canary/.test(text), text);
				assert.deepEqual(reply.error?.details ?? {}, {});
			}
			const touched = await w.changed(before);
			const all: Row = {
				error_code: CODES[s.name],
				body: null,
				existence: null,
				writes: touched.length,
				additional_recorded_outcomes: touched.length,
			};
			for (const k of Object.keys(s.expected.result)) result[k] = all[k];
		}
		assert.deepEqual(await w.changed(before), [], `${c.id} ${s.name}`);
		assert.deepEqual(result, s.expected.result, `${c.id} ${s.name}`);
		const state: Row = await stateOf(pair, c.action.arguments.consumer, s.expected.state, at);
		for (const [k, v] of Object.entries(s.expected.state)) assert.deepEqual(state[k], v, `${c.id} ${s.name} ${k}`);
	}
}
const KEPT_WHEN_DUPLICATE = new Set(["skill", "obligation", "attestation", "launch_guest", "mail"]);
async function dangling(p2: string) {
	let n = 0;
	for (const e of registry) {
		if (e.treatment === "keep" || KEPT_WHEN_DUPLICATE.has(e.kind)) continue;
		const live = e.table === "participation" ? sql`AND removed_at IS NULL` : sql``;
		n += Number(
			(
				await one(
					sql`SELECT count(*)::int AS n FROM ${sql.identifier(e.table)} WHERE ${sql.identifier(e.column)}=${p2}::uuid ${live}`,
				)
			).n,
		);
	}
	return n;
}
const receipts = async (p1: string, action: string) =>
	(
		await one(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${p1}::uuid AND action=${action} AND kind<>'noop'`,
		)
	).n;

for (const family of families) {
	const ids = [...family.cases.matchAll(/AC:(\S+)/g)].map((m) => m[1]!);
	const caseFor = (operation: string) => {
		const id = ids.find((x) => x.endsWith("-" + operation));
		assert.ok(id, operation);
		return caseOf(family.file, id);
	};
	test(family.cases, async (t) => {
		await t.test("MERGE", async () => {
			const c = caseFor("MERGE");
			const pair = await pairOf(family);
			const { p1, p2, seed } = pair;
			const reviewDigest = await w.digestOf(p2, p1);
			const input = { sourceId: p2, survivorId: p1, reviewDigest };
			await checkRefusals(c, pair, {
				"foreign-person-refused": () => w.mergeWith({ ...input, survivorId: foreign }),
				"member-mutation-refused": () => w.mergeWith(input, { who: "member" }),
				"required-write-fault-rolls-back": () => w.mergeWith(input),
			});
			const sends = await w.effects(),
				kept = await seed.kept?.();
			const requestKey = key();
			const merged = ok(await w.mergeWith(input, { requestKey }));
			const settled = await w.everything();
			assert.deepEqual(ok(await w.mergeWith(input, { requestKey })), merged);
			assert.deepEqual(await w.changed(settled), []);
			assert.deepEqual(await w.effects(), sends);
			if (kept) assert.deepEqual(await seed.kept?.(), kept, "evidence unchanged");
			const historical = await ownerOf(pair, seed.history);
			const now = await personRow(p2);
			const reference = await ownerOf(pair, seed.reference);
			assert.deepEqual(
				{
					state: {
						P2: { retired: now.state === "merged" && now.retired },
						"reference-1": { person: reference },
						"original-history": { person: historical },
					},
					result: {
						current_reference_person: reference,
						historical_person: historical,
						receipts: await receipts(p1, "people.merged"),
						dangling_references: await dangling(p2),
					},
				},
				{ state: c.expected.state, result: c.expected.result },
			);
		});
		await t.test("CONFLICT", async () => {
			const c = caseFor("CONFLICT");
			const pair = await pairOf(family);
			const { p1, p2, seed } = pair;
			const stale = await w.digestOf(p2, p1);
			await (seed.edit ?? (() => w.update(p2, { phone: "555 010 2000" })))();
			const fresh = { sourceId: p2, survivorId: p1, reviewDigest: await w.digestOf(p2, p1) };
			await checkRefusals(c, pair, {
				"foreign-person-refused": () => w.mergeWith({ ...fresh, survivorId: foreign }),
				"member-mutation-refused": () => w.mergeWith(fresh, { who: "member" }),
				"required-write-fault-rolls-back": () => w.mergeWith(fresh),
			});
			const before = await w.everything(),
				at = await revisions(pair);
			const requestKey = key();
			for (let n = 0; n < 2; n++)
				refused(await w.mergeWith({ ...fresh, reviewDigest: stale }, { requestKey }), "conflict");
			const touched = await w.changed(before);
			const state: Row = await stateOf(pair, c.action.arguments.consumer, c.expected.state, at);
			const reference = state["reference-1"] as Row;
			assert.deepEqual(
				{
					state: {
						"reference-1": { person: reference.person, observed_state: reference.observed_state },
					},
					result: {
						error_code: "revision_conflict",
						changed_references: touched.length,
						external_effects: touched.filter((x) => ["mail", "mail_attempt", "job", "notice"].includes(x)).length,
					},
				},
				{ state: c.expected.state, result: c.expected.result },
			);
		});
		await t.test("UNMERGE", async () => {
			const c = caseFor("UNMERGE");
			const pair = await pairOf(family);
			const { p1, p2, seed } = pair;
			const before = { owner: await ownerOf(pair, seed.reference), kept: await seed.kept?.() };
			assert.equal(before.owner, "P2");
			const merged = await w.merge(p2, p1);
			const revision = ok(await w.preview(merged.mergeId)).reviewRevision;
			await checkRefusals(c, pair, {
				"foreign-person-refused": () => w.unmergeWith(foreignMerge.mergeId, revision),
				"member-mutation-refused": () => w.unmergeWith(merged.mergeId, revision, { who: "member" }),
				"required-write-fault-rolls-back": () => w.unmergeWith(merged.mergeId, revision),
			});
			const sends = await w.effects();
			const requestKey = key();
			const first = ok(await w.unmergeWith(merged.mergeId, revision, { requestKey }));
			const settled = await w.everything();
			assert.deepEqual(ok(await w.unmergeWith(merged.mergeId, revision, { requestKey })), first);
			assert.deepEqual(await w.changed(settled), []);
			assert.deepEqual(await seed.kept?.(), before.kept, "evidence unchanged");
			const now = await personRow(p2);
			assert.deepEqual(
				{
					state: {
						"reference-1": { person: await ownerOf(pair, seed.reference) },
						P2: { retired: now.state !== "live" },
					},
					result: {
						restored_person: label(pair, first.sourceId),
						inverse_receipts: await receipts(p1, "people.unmerged"),
						external_resends: JSON.stringify(await w.effects()) === JSON.stringify(sends) ? 0 : 1,
					},
				},
				{ state: c.expected.state, result: c.expected.result },
			);
			assert.equal(await ownerOf(pair, seed.history), "P2");
		});
		await t.test("RETIRE", async () => {
			const c = caseFor("RETIRE");
			const pair = await pairOf(family);
			const { p2, seed } = pair;
			const request = await w.retireRequest(p2);
			await checkRefusals(c, pair, {
				"foreign-person-refused": () => w.retireWith({ ...request, input: { ...request.input, personId: foreign } }),
				"member-mutation-refused": () => w.retireWith(request, "member"),
				"required-write-fault-rolls-back": () => w.retireWith(request),
			});
			const sends = await w.effects(),
				kept = await seed.kept?.();
			assert.equal(await w.selectable(p2, "Alex Chen"), true);
			ok(await w.retireWith(request));
			const settled = await w.everything();
			ok(await w.retireWith(request));
			assert.deepEqual(await w.changed(settled), []);
			if (kept) assert.deepEqual(await seed.kept?.(), kept, "evidence unchanged");
			const historical = await ownerOf(pair, seed.history);
			const now = await personRow(p2);
			assert.equal(now.display_name, "Alex Chen");
			assert.deepEqual(
				{
					state: {
						P2: { retired: now.state === "retired" && now.retired },
						"original-history": { person: historical },
					},
					result: {
						operational_selector_contains_P2: await w.selectable(p2, "Alex Chen"),
						historical_person: historical,
						new_external_effects: JSON.stringify(await w.effects()) === JSON.stringify(sends) ? 0 : 1,
					},
				},
				{ state: c.expected.state, result: c.expected.result },
			);
		});
	});
}
