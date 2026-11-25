import "../../platform/setup.mts";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { owner as ownerValue, tenantId } from "../../../../packages/contracts/src/common/index.ts";
import { nativeFromText } from "../../../../packages/contracts/src/documents/index.ts";
import { connectionLink } from "../../../../packages/domain/src/proofs.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	communicationWriter,
	withCommunicationWrite,
	type DeliveryTransport,
} from "../../../../packages/domain/src/communication/index.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { supersedeDigests } from "../../../../packages/domain/src/jobs/digest.ts";
import { createMailService, type AuthorizeMail } from "../../../../packages/domain/src/jobs/mail.ts";
import { seatedNotificationService } from "../../../../packages/domain/src/jobs/seated-notifications.ts";
import {
	authorizeLaunchNotices,
	createLaunchReader,
	createLaunchWriter,
} from "../../../../packages/domain/src/launch/index.ts";
import { createSignals } from "../../../../packages/domain/src/intelligence/index.ts";
import { guestsWriter, meetingsWriter, withMeetingsWrite } from "../../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { createOrganizationAdapter } from "../../../../packages/domain/src/organizations/index.ts";
import {
	assessments,
	commitments,
	interviews,
	peopleWriter,
	withPeopleWrite,
} from "../../../../packages/domain/src/people/index.ts";
import {
	authorizeTaskReminders,
	createTaskWriter,
	withTaskWrite,
} from "../../../../packages/domain/src/tasks/index.ts";
import { teamsReader, teamsWriter, withTeamsWrite } from "../../../../packages/domain/src/teams/index.ts";
import { taskReminders } from "../../../../apps/web/src/features/tasks/reminders.ts";
import { launchNotices } from "../../../../apps/web/src/features/launch/notices.ts";
import { fixture, ok, type Actor, type Workspace } from "../../../support/fixture.mts";
import { MAILING } from "../../communication/church-address.mts";
import { MemoryClient } from "../../documents/storage.mts";

export const ROLES = ["owner", "admin", "lead", "member", "director"] as const;
export type Role = (typeof ROLES)[number];
export const NAMES: Record<Role, string> = {
	owner: "Olivia Owner",
	admin: "Adam Admin",
	lead: "Lena Lead",
	member: "Max Member",
	director: "Dana Director",
};
export const key = () => randomUUID();
export const origin = "https://everyfield.test";
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const hash = () => randomBytes(32).toString("hex");
const DAY = 86_400_000;
export const FUTURE = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);

const CATEGORIES = ["people", "meetings", "tasks", "ministry_teams", "wiki", "activity", "shared_findings"] as const;
type Category = (typeof CATEGORIES)[number];
type Reply = { status: string; value?: unknown; error?: { code?: string } };
export const refusal = (reply: Reply) =>
	reply.status === "refused" ? `refused:${reply.error?.code}` : `answered:${reply.status}`;

export async function rolesWorld(prefix: string) {
	const database = await fixture({ prefix, max: 8 });
	try {
		return await seed(database);
	} catch (error) {
		await database.close();
		throw error;
	}
}

async function seed(database: Awaited<ReturnType<typeof fixture>>) {
	const { admin } = database;
	const db = database.pools.runtime;
	const plant = await database.plant({ name: "Harvest Point", digest_weekday: 1, digest_hour: 8, ...MAILING });
	const named = (workspace: Workspace, role: "owner" | "admin" | "member", who: string) =>
		database.actor(workspace, role, { email: `${who}@example.test`, user: { name: NAMES[who as Role] ?? who } });
	const hidden = await database.plant({ name: "Hidden Hollow" });
	const grace = await database.organization("sending_church", { name: "Grace Austin", timezone: "America/Chicago" });
	const cedar = await database.organization("sending_church", { name: "Cedar Park Church" });
	const people: Record<Role, Actor> = {
		owner: await named(plant, "owner", "owner"),
		admin: await named(plant, "admin", "admin"),
		lead: await named(plant, "member", "lead"),
		member: await named(plant, "member", "member"),
		director: await named(grace, "owner", "director"),
	};
	const cedarOwner = await named(cedar, "owner", "cedar-owner");
	const hiddenOwner = await named(hidden, "owner", "hidden-owner");
	const as = async (who: Pick<Actor, "session">) => {
		const found = await RequestActor.resolve(db, who.session);
		if (!(found instanceof RequestActor)) throw Error("no actor");
		return found;
	};
	const actor = (role: Role) => as(people[role]);
	const ownerActor = await actor("owner");
	const rows = async <R extends Record<string, unknown>>(query: SQL) => (await admin.execute<R>(query)).rows;

	const mailKeys = { encryptionKey: randomBytes(32), addressKey: randomBytes(32) };
	const mailFor = (authorize: AuthorizeMail) =>
		createMailService({
			db,
			...mailKeys,
			from: "notices@example.test",
			authorize,
			transport: {
				async send(payload) {
					sentMail.push({ to: payload.to, subject: payload.subject, text: payload.text });
					return { kind: "accepted", id: key() };
				},
				async lookup() {
					return { kind: "unknown" };
				},
			},
		});
	const sentMail: { to: string; subject: string; text: string }[] = [];
	const reminders = taskReminders(seatedNotificationService(mailFor(authorizeTaskReminders)));
	const tasks = createTaskWriter({ reminders });
	const launch = createLaunchWriter({
		notices: launchNotices(seatedNotificationService(mailFor(authorizeLaunchNotices))),
	});
	const launchReader = createLaunchReader();
	const signals = createSignals();

	const write = {
		people: <V,>(body: Parameters<typeof withPeopleWrite<V>>[2]) => withPeopleWrite(db, ownerActor, body),
		meetings: <V,>(body: Parameters<typeof withMeetingsWrite<V>>[2]) => withMeetingsWrite(db, ownerActor, body),
		tasks: <V,>(body: Parameters<typeof withTaskWrite<V>>[2]) => withTaskWrite(db, ownerActor, body),
		teams: <V,>(body: Parameters<typeof withTeamsWrite<V>>[2]) => withTeamsWrite(db, ownerActor, body),
		messages: <V,>(body: Parameters<typeof withCommunicationWrite<V>>[2]) =>
			withCommunicationWrite(db, ownerActor, body),
	};
	const person = async (displayName: string, fields: object = {}, authority = ownerActor) =>
		ok(
			await withPeopleWrite(db, authority, (tx, c) =>
				peopleWriter.createPerson(tx, c, {
					requestKey: key(),
					input: { displayName, adultClassification: "adult", ...fields },
				}),
			),
		).person.id;
	const alma = await person("Alma Reyes", { email: "alma@example.test", phone: "+1 555 0101", stage: "core_group" });
	const ben = await person("Ben Cole", { email: "ben@example.test", stage: "prospect" });
	const lena = await person(NAMES.lead, { email: "lead@example.test", stage: "leader" });
	const max = await person(NAMES.member, { email: "member@example.test", stage: "launch_team" });
	const quinn = await person("Quinn Hidden", { email: "quinn@example.test" }, await as(hiddenOwner));
	for (const [id, who] of [
		[lena, people.lead],
		[max, people.member],
	] as const)
		await admin.execute(sql`UPDATE person SET linked_account_id=${who.id} WHERE id=${id}`);
	const lens = { score: 4, notes: "Private assessment words" };
	ok(
		await write.people((tx, c) =>
			assessments.createAssessment(tx, c, {
				requestKey: key(),
				input: {
					personId: ben,
					occurredOn: "2026-10-01",
					committed: lens,
					compelled: lens,
					contagious: lens,
					courageous: lens,
				},
			}),
		),
	);
	const pass = { rating: "pass" };
	ok(
		await write.people((tx, c) =>
			interviews.createInterview(tx, c, {
				requestKey: key(),
				input: {
					personId: ben,
					occurredOn: "2026-10-02",
					maturity: { rating: "pass", notes: "Private interview words" },
					gifted: pass,
					chemistry: pass,
					rightReasons: pass,
					season: pass,
					result: "qualified",
				},
			}),
		),
	);
	const commitment = ok(
		await write.people((tx, c) =>
			commitments.createCommitment(tx, c, {
				requestKey: key(),
				input: { personId: alma, kind: "core_group", occurredOn: "2026-10-03" },
			}),
		),
	).commitment.id;

	const team = async (name: string, leader: string | null, member: string | null) => {
		const id = ok(
			await write.teams((tx, c) =>
				teamsWriter.create(tx, c, { requestKey: key(), input: { name, description: null } }),
			),
		).team.id;
		if (member) {
			const role = ok(
				await write.teams((tx, c) =>
					teamsWriter.createRole(tx, c, { requestKey: key(), input: { teamId: id, name: `${name} helper` } }),
				),
			).role;
			ok(
				await write.teams((tx, c) =>
					teamsWriter.assignRole(tx, c, {
						requestKey: key(),
						expectedRevision: role.revision,
						input: { roleId: role.id, teamId: id, personId: member },
					}),
				),
			);
		}
		if (leader) {
			const { revision } = ok(await teamsReader.readRevision(db, ownerActor, { teamId: id }));
			ok(
				await write.teams((tx, c) =>
					teamsWriter.appointLeader(tx, c, {
						requestKey: key(),
						expectedRevision: revision,
						input: { teamId: id, personId: leader },
					}),
				),
			);
		}
		return id;
	};
	const welcome = await team("Welcome Team", lena, max);
	const kitchen = await team("Kitchen Team", null, null);

	const meeting = async (input: object) =>
		ok(
			await write.meetings((tx, c) =>
				meetingsWriter.schedule(tx, c, { requestKey: key(), input: { time: "18:00", ...input } }),
			),
		).meeting.id;
	const planning = await meeting({
		type: "team_meeting",
		teamId: welcome,
		title: "Welcome planning",
		date: FUTURE,
		guests: [lena],
	});
	const dinner = await meeting({ type: "orientation", title: "Orientation dinner", date: "2026-10-29" });

	const task = async (title: string, assigneeIds: string[], date: string) =>
		ok(
			await write.tasks((tx, c) =>
				tasks.create(tx, c, {
					requestKey: key(),
					input: { title, assigneeIds, due: { kind: "local_date", date } },
				}),
			),
		).task.id;
	const taskIds = {
		owner: await task("Call Ben", [people.owner.id], "2026-10-24"),
		admin: await task("Sign the lease", [people.admin.id], "2026-10-30"),
		lead: await task("Set out chairs", [people.lead.id], FUTURE),
		member: await task("Print programs", [people.member.id], FUTURE),
	};

	const hiddenActor = await as(hiddenOwner);
	ok(
		await withTaskWrite(db, hiddenActor, (tx, c) =>
			tasks.create(tx, c, { requestKey: key(), input: { title: "Walk the hollow" } }),
		),
	);
	const hollow = ok(
		await withTeamsWrite(db, hiddenActor, (tx, c) =>
			teamsWriter.create(tx, c, { requestKey: key(), input: { name: "Hollow Team", description: null } }),
		),
	).team.id;
	const helper = ok(
		await withTeamsWrite(db, hiddenActor, (tx, c) =>
			teamsWriter.createRole(tx, c, { requestKey: key(), input: { teamId: hollow, name: "Hollow helper" } }),
		),
	).role;
	ok(
		await withTeamsWrite(db, hiddenActor, (tx, c) =>
			teamsWriter.assignRole(tx, c, {
				requestKey: key(),
				expectedRevision: helper.revision,
				input: { roleId: helper.id, teamId: hollow, personId: quinn },
			}),
		),
	);
	ok(
		await withCommunicationWrite(db, hiddenActor, (tx, c) =>
			communicationWriter.saveDraft(tx, c, {
				requestKey: key(),
				input: {
					subject: "Hollow letter",
					bodyHtml: "<p>For the hollow</p>",
					audience: { groups: [], teamIds: [], personIds: [quinn] },
				},
			}),
		),
	);

	const draft = ok(
		await write.messages((tx, c) =>
			communicationWriter.saveDraft(tx, c, {
				requestKey: key(),
				input: {
					subject: "Draft about the budget",
					bodyHtml: "<p>Not ready</p>",
					audience: { groups: [], teamIds: [], personIds: [alma] },
				},
			}),
		),
	).communicationId;
	const letter = ok(
		await write.messages((tx, c) =>
			communicationWriter.saveDraft(tx, c, {
				requestKey: key(),
				input: {
					subject: "Welcome letter",
					bodyHtml: "<p>Glad you came</p>",
					audience: { groups: [], teamIds: [], personIds: [alma] },
				},
			}),
		),
	);
	const deliveryKeys = { ...mailKeys, from: "news@example.test", origin };
	const unreached = async () => {
		throw Error("No scheduled message is moved");
	};
	const transport: DeliveryTransport = {
		paused: false,
		cancel: unreached,
		reschedule: unreached,
		async send(batch) {
			return { outcome: "ids", ids: batch.messages.map(() => `prov-${key()}`) };
		},
	};
	const scheduled = ok(
		await write.messages((tx, c) =>
			communicationWriter.scheduleReviewed(tx, c, {
				requestKey: key(),
				expectedRevision: letter.revision,
				input: {
					communicationId: letter.communicationId,
					scheduledAt: new Date(Math.ceil((Date.now() + 7 * DAY) / 3_600_000) * 3_600_000).toISOString(),
				},
			}),
		),
	);
	ok(
		await communicationWriter.sendReviewed(
			db,
			ownerActor,
			{
				requestKey: key(),
				expectedRevision: scheduled.revision,
				input: { communicationId: letter.communicationId },
			},
			transport,
			deliveryKeys,
		),
	);

	const storage = { bucket: "roles", client: new MemoryClient() };
	const policy = ok(
		await documentsWriter.createFromTemplate(db, ownerActor, {
			templateId: "conflict-of-interest-policy",
			requestKey: key(),
		}),
	);
	ok(
		await documentsWriter.saveNative(db, ownerActor, {
			documentId: policy.id,
			expectedRevision: policy.revision,
			body: { ...policy.body, title: "Harvest conflict policy" },
		}),
	);
	const exported = ok(
		await documentsWriter.exportNative(
			db,
			ownerActor,
			{ documentId: policy.id, revision: 2, format: "pdf", requestKey: key() },
			storage,
		),
	).id;
	const values = ok(
		await documentsWriter.saveNative(db, ownerActor, {
			title: "Core values",
			body: nativeFromText("We love our city"),
			expectedRevision: "0",
		}),
	).id;

	const item = (id: string, kind: string, canonical: string, tenant: string) =>
		admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${id},${kind},${canonical},${tenant})`,
		);
	const [section, release] = [key(), key()];
	await item(section, "section", "framework/start", GLOBAL);
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,
		validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},'roles','memory://synthetic',${hash()},'validated',clock_timestamp(),clock_timestamp(),
		'memory://approval',${hash()},'v','profile',1,${GLOBAL},0)`);
	const article = async (
		title: string,
		tenant: string,
		body: string,
		content: string,
		state: "published" | "draft" | null = null,
	) => {
		const [id, revision] = [key(), key()];
		const slug = title.toLowerCase().replaceAll(" ", "-");
		await item(id, "article", slug, tenant);
		await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,
			excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
			VALUES(${revision},${id},${tenant},${tenant === GLOBAL ? release : null},1,${title},${slug},${title},${body},
			${content},1,1,${hash()},clock_timestamp(),true,1,${section})`);
		if (state)
			await admin.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
				VALUES(${key()},${tenant},${id},${state},${revision},1)`);
		return id;
	};
	const articles = {
		global: await article("Gathering core groups", GLOBAL, "Gather a core group of adults.", "safe_mdx"),
		grace: await article("Grace gathering guide", grace.id, "Gather the Grace way.", "safe_nodes", "published"),
		cedar: await article("Cedar gathering guide", cedar.id, "Gather the Cedar way.", "safe_nodes", "published"),
	};
	await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,
		reason,expected_prior_number) VALUES(${key()},${release},1,clock_timestamp(),'synthetic','test',0)`);

	ok(await launch.ensureReadiness(db, ownerActor));
	const plan = ok(await launchReader.readPlan(db, ownerActor)).plan;
	ok(
		await launch.schedule(db, ownerActor, {
			requestKey: key(),
			expectedRevision: plan.revision,
			input: { date: "2027-09-12", reason: null },
		}),
	);

	ok(
		await signals.attest(db, ownerActor, {
			requestKey: key(),
			expectedRevision: "0",
			input: { key: "prayer_rhythm_established", value: "yes" },
		}),
	);

	const proofs = new Map<string, string>();
	const connections = createOrganizationAdapter(
		{
			async invitation(_tx, v) {
				proofs.set(
					v.invitationId,
					connectionLink("https://example.test", "/connections/respond", v.invitationId, v.proof).split("#")[1]!,
				);
			},
			invalidate: (_tx, v) => supersedeDigests(v.sourceId),
		},
		{ candidates: () => sql`SELECT NULL::uuid WHERE false` },
	);
	const bound = <T,>(
		who: Actor,
		run: (
			tx: Parameters<Parameters<typeof gatedTransaction>[1]>[0],
			session: Actor["session"],
			selected: ReturnType<typeof ownerValue.parse>,
		) => Promise<T>,
	) =>
		gatedTransaction(db, async (tx) => {
			const selected = ownerValue.parse(who.selected);
			if (!(await RequestActor.claimWrite(tx, who.session, selected))) throw Error("unavailable");
			return run(tx, who.session, selected);
		});
	const graceOwner = { ...grace, id: tenantId.parse(grace.id) };
	async function connect(subject: Workspace, subjectOwner: Actor, share: readonly Category[]) {
		const plantOwner = ownerValue.parse(subject);
		const revision = (await rows<{ r: string }>(sql`SELECT revision::text AS r FROM plant WHERE id=${subject.id}`))[0]!
			.r;
		const invitation = await bound(subjectOwner, (tx, session, selected) =>
			connections["associations.invite"](tx, session, selected, {
				requestKey: key(),
				expectedRevision: revision,
				input: {
					pair: { kind: "plant", subject: plantOwner, organization: graceOwner },
					recipientEmail: people.director.email,
				},
			}),
		);
		const accepted = await bound(people.director, (tx, session, selected) =>
			connections["associations.acceptInvitation"](tx, session, selected, {
				requestKey: key(),
				expectedRevision: "1",
				input: {
					invitationId: invitation.invitationId,
					proof: proofs.get(invitation.invitationId),
					decision: "accept",
				},
			}),
		);
		if (accepted.status !== "accepted") throw Error(JSON.stringify(accepted));
		const granted = (
			await rows<
				Record<Category, boolean>
			>(sql`SELECT share_people AS people,share_meetings AS meetings,share_tasks AS tasks,
				share_ministry_teams AS ministry_teams,share_wiki AS wiki,share_activity AS activity,shared_findings
				FROM affiliation WHERE plant_id=${subject.id} AND organization_id=${grace.id}`)
		)[0]!;
		for (const category of CATEGORIES) {
			const enabled = share.includes(category);
			if (granted[category] === enabled) continue;
			const link = (
				await rows<{ id: string; r: string; c: string }>(sql`SELECT id,revision::text AS r,consent_revision::text AS c
					FROM affiliation WHERE plant_id=${subject.id} AND organization_id=${grace.id}`)
			)[0]!;
			await bound(subjectOwner, (tx, session, selected) =>
				connections["privacy.setSharing"](tx, session, selected, {
					requestKey: key(),
					expectedRevision: link.r,
					input: {
						plant: plantOwner,
						organization: graceOwner,
						relationshipId: link.id,
						expectedConsentRevision: link.c,
						category,
						enabled,
					},
				}),
			);
		}
	}
	await connect(plant, people.owner, ["people", "wiki", "activity"]);
	await connect(hidden, hiddenOwner, []);

	return {
		database,
		admin,
		db,
		plant,
		hidden,
		grace,
		people,
		actor,
		hiddenOwner,
		cedarOwner,
		as,
		rows,
		write,
		tasks,
		launch,
		launchReader,
		signals,
		mailFor,
		sentMail,
		deliveryKeys,
		storage,
		ids: {
			alma,
			ben,
			lena,
			max,
			quinn,
			commitment,
			welcome,
			kitchen,
			planning,
			dinner,
			tasks: taskIds,
			draft,
			letter: letter.communicationId,
			policy: policy.id,
			exported,
			values,
			articles,
		},
		guestsWriter,
		close: database.close,
	};
}
export type RolesWorld = Awaited<ReturnType<typeof rolesWorld>>;
