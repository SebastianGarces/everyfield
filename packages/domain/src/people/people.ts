import { randomUUID } from "node:crypto";
import type { z } from "zod";
import * as c from "@everyfield/contracts/people";
import type { PeopleWriter, AccountPersonProducer } from "@everyfield/contracts/people";
import { owner } from "@everyfield/contracts/common";
import {
	authorize,
	deny,
	expected,
	live,
	hash,
	lockOwner,
	mutation,
	parse,
	patchPerson,
	person,
	personRow,
	project,
	reply,
} from "./core.ts";
import type { Context, WriteContext, Tx, Person } from "./core.ts";

export async function insertPerson(
	tx: Tx,
	context: Pick<Context, "selected">,
	raw: z.infer<typeof c.createPersonRequest>["input"] | z.infer<typeof c.createOrganizationPersonRequest>["input"],
) {
	const id = randomUUID(),
		plant = context.selected.kind === "plant";
	const p = c.createPersonRequest.shape.input.parse(raw);
	await tx.query(
		`INSERT INTO person(id,tenant_id,plant_id,organization_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'live',clock_timestamp())`,
		[
			id,
			context.selected.id,
			plant ? context.selected.id : null,
			plant ? null : context.selected.id,
			p.displayName,
			plant ? p.source : "other",
			plant ? p.stage : null,
			plant ? p.adultClassification : null,
			plant ? "unknown" : null,
			plant ? 0 : null,
		],
	);
	const { displayName: _, ...patch } = raw;
	void _;
	await patchPerson(tx, id, patch);
	return person(tx, context, id, true);
}
async function output(tx: Tx, ctx: Context, p: Person, id: string, needsOwner: string[] = [], outcome = "changed") {
	return {
		person: await project(tx, ctx, p),
		receiptId: id,
		outcome,
		needsOwner,
	};
}
export async function openDuties(tx: Tx, ctx: Context, p: Person) {
	if (ctx.selected.kind !== "plant") return [];
	// Tasks store account assignees; Person subjects are separate references.
	const r = await tx.query(
		`SELECT id,revision,due_date,parent_id FROM task WHERE plant_id=$1 AND (person_id=$2 OR (assignee_id=$3 AND $3::uuid IS NOT NULL)) AND deleted_at IS NULL AND status NOT IN ('complete','no_longer_needed') ORDER BY id FOR UPDATE`,
		[ctx.selected.id, p.id, p.linked_account_id],
	);
	return r.rows;
}
async function handoff(tx: Tx, ctx: Context, p: Person, choices: z.infer<typeof c.handoffChoice>[]) {
	const duties = await openDuties(tx, ctx, p),
		byId = new Map(choices.map((c) => [c.dutyId, c]));
	if (byId.size !== choices.length || duties.length !== choices.length || duties.some((d) => !byId.has(d.id)))
		deny("conflict");
	const needsOwner: string[] = [];
	for (const duty of duties) {
		const choice = byId.get(duty.id)!;
		if (choice.expectedRevision !== duty.revision) deny("conflict");
		if (choice.kind === "assign") {
			const target = await person(tx, ctx, choice.toPersonId, true);
			live(target);
			if (target.id === p.id) deny("invalid_subject");
			const eligible = await tx.query(
				"SELECT id FROM seat WHERE plant_id=$1 AND account_id=$2 AND ended_at IS NULL AND accepted_at<=clock_timestamp() FOR SHARE",
				[ctx.selected.id, target.linked_account_id],
			);
			if (!eligible.rowCount) deny();
			await tx.query("UPDATE task SET assignee_id=$2,revision=revision+1 WHERE id=$1", [
				duty.id,
				target.linked_account_id,
			]);
		} else {
			await tx.query("UPDATE task SET assignee_id=NULL,revision=revision+1 WHERE id=$1", [duty.id]);
			needsOwner.push(duty.id);
		}
	}
	return needsOwner;
}
export const peopleWriter: PeopleWriter<Tx> = {
	async createPerson(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.createPersonRequest, raw);
			return c.plantPersonMutationResult.parse(
				await mutation(tx, ctx, "people.createPerson", input, async (_a, id) => {
					const after = await insertPerson(tx, ctx, input.input);
					return {
						value: await output(tx, ctx, after, id),
						subject: after.id,
						action: "people.created",
						after,
					};
				}),
			);
		});
	},
	async updatePerson(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.updatePersonRequest, raw);
			return c.plantPersonMutationResult.parse(
				await mutation(tx, ctx, "people.updatePerson", input, async (_a, id) => {
					const before = await person(tx, ctx, input.input.personId, true);
					live(before);
					expected(before, input.expectedRevision);
					await patchPerson(tx, before.id, input.input.patch);
					const after = await person(tx, ctx, before.id, true);
					return {
						value: await output(tx, ctx, after, id),
						subject: before.id,
						action: "people.updated",
						before,
						after,
					};
				}),
			);
		});
	},
	async changeStatus(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.changeStatusRequest, raw);
			return c.plantPersonMutationResult.parse(
				await mutation(tx, ctx, "people.changeStatus", input, async (_a, id) => {
					const before = await person(tx, ctx, input.input.personId, true);
					live(before);
					expected(before, input.expectedRevision);
					const noop = before.stage === input.input.stage;
					const leaving =
						["core_group", "launch_team", "leader"].includes(before.stage!) &&
						!["core_group", "launch_team", "leader"].includes(input.input.stage);
					const needsOwner = !noop && leaving ? await handoff(tx, ctx, before, input.input.handoffs) : [];
					if (!leaving && input.input.handoffs.length) deny("invalid_input");
					if (!noop)
						await tx.query("UPDATE person SET stage=$2,revision=revision+1 WHERE id=$1", [
							before.id,
							input.input.stage,
						]);
					const after = await person(tx, ctx, before.id, true);
					return {
						value: await output(tx, ctx, after, id, needsOwner, noop ? "noop" : "changed"),
						subject: before.id,
						action: "people.stage_changed",
						before,
						after,
						reason: input.input.reason,
						outcome: noop ? "noop" : "changed",
					};
				}),
			);
		});
	},
	async retirePerson(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.retirePersonRequest, raw);
			return c.plantPersonMutationResult.parse(await retire(tx, ctx, input, "people.deletePerson"));
		});
	},
	async restorePerson(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.restorePersonRequest, raw);
			return c.plantPersonMutationResult.parse(await restore(tx, ctx, input, "people.restorePerson"));
		});
	},
	async addNote(tx, ctx, raw) {
		return reply(tx, async () => {
			const input = parse(c.addNoteRequest, raw);
			return c.noteMutationResult.parse(await note(tx, ctx, input, "add"));
		});
	},
	async editNote(tx, ctx, raw) {
		return reply(tx, async () => {
			const input = parse(c.editNoteRequest, raw);
			return c.noteMutationResult.parse(await note(tx, ctx, input, "edit"));
		});
	},
	async deleteNote(tx, ctx, raw) {
		return reply(tx, async () => {
			const input = parse(c.deleteNoteRequest, raw);
			return c.noteMutationResult.parse(await note(tx, ctx, input, "delete"));
		});
	},
	async recordAdultClassification(tx, ctx, raw) {
		return classify(tx, ctx, raw, false);
	},
	async correctAdultClassification(tx, ctx, raw) {
		return classify(tx, ctx, raw, true);
	},
	async reorderPipeline(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.reorderPipelineRequest, raw);
			return pipelineOrder(tx, ctx, input);
		});
	},
};
export async function retire(tx: Tx, ctx: WriteContext, input: z.infer<typeof c.retirePersonRequest>, name: string) {
	return mutation(tx, ctx, name, input, async (_a, id) => {
		const before = await person(tx, ctx, input.input.personId, true);
		expected(before, input.expectedRevision);
		if (before.state === "merged") deny("use_reviewed_unmerge");
		const review =
			ctx.selected.kind === "plant"
				? (await tx.query("SELECT material_revision FROM plant WHERE id=$1 FOR SHARE", [ctx.selected.id])).rows[0]
						.material_revision
				: before.revision;
		if (input.input.reviewRevision !== review) deny("conflict");
		const needsOwner = before.state === "live" ? await handoff(tx, ctx, before, input.input.handoffs) : [];
		// Existing historical endpoints remain; current leadership is ended explicitly.
		if (before.state === "live") {
			await tx.query("UPDATE person SET state='retired',retired_at=clock_timestamp(),revision=revision+1 WHERE id=$1", [
				before.id,
			]);
			if (ctx.selected.kind === "plant") {
				await tx.query(
					"UPDATE team_tenure SET ended_on=(clock_timestamp() AT TIME ZONE (SELECT timezone FROM plant WHERE id=$2))::date,revision=revision+1 WHERE person_id=$1 AND plant_id=$2 AND ended_on IS NULL",
					[before.id, ctx.selected.id],
				);
				await tx.query("UPDATE person SET household_id=NULL,household_role=NULL WHERE id=$1", [before.id]);
				await tx.query(
					"UPDATE team SET leader_person_id=NULL,leader_source=NULL,leader_role_id=NULL,revision=revision+1 WHERE plant_id=$1 AND leader_person_id=$2",
					[ctx.selected.id, before.id],
				);
			}
		}
		const after = await person(tx, ctx, before.id, true),
			outcome = before.state === "retired" ? "noop" : "changed";
		return {
			value: await output(tx, ctx, after, id, needsOwner, outcome),
			subject: before.id,
			action: "people.retired",
			before,
			after,
			reason: input.input.reason,
			outcome,
		};
	});
}
export async function restore(tx: Tx, ctx: WriteContext, input: z.infer<typeof c.restorePersonRequest>, name: string) {
	return mutation(tx, ctx, name, input, async (_a, id) => {
		const before = await person(tx, ctx, input.input.personId, true);
		expected(before, input.expectedRevision);
		if (before.state === "merged") deny("use_reviewed_unmerge");
		if (before.state === "retired")
			await tx.query("UPDATE person SET state='live',retired_at=NULL,revision=revision+1 WHERE id=$1", [before.id]);
		const after = await person(tx, ctx, before.id, true),
			outcome = before.state === "live" ? "noop" : "changed";
		return {
			value: await output(tx, ctx, after, id, [], outcome),
			subject: before.id,
			action: "people.restored",
			before,
			after,
			outcome,
		};
	});
}
type NoteInput =
	z.infer<typeof c.addNoteRequest> | z.infer<typeof c.editNoteRequest> | z.infer<typeof c.deleteNoteRequest>;
async function note(tx: Tx, ctx: WriteContext, input: NoteInput, kind: "add" | "edit" | "delete") {
	// Organization notes remain native-only, including when the author is an admin.
	if (ctx.selected.kind === "organization" && ctx.purpose !== "native") deny();
	return mutation(
		tx,
		ctx,
		"people." + (kind === "add" ? "addNote" : kind === "edit" ? "editNote" : "deleteNote"),
		input,
		async (actor, id) => {
			const before = await person(tx, ctx, input.input.personId, true);
			live(before);
			const noteId = "noteId" in input.input ? input.input.noteId : randomUUID();
			let noteRevision = "1";
			if (kind === "add") {
				expected(before, input.expectedRevision);
				let participation: string | null = null;
				if ("meetingId" in input.input && input.input.meetingId) {
					const r = await tx.query(
						"SELECT id FROM participation WHERE meeting_id=$1 AND person_id=$2 AND plant_id=$3 FOR SHARE",
						[input.input.meetingId, before.id, ctx.selected.id],
					);
					if (r.rowCount !== 1) deny();
					participation = r.rows[0].id;
				}
				if (!("body" in input.input)) deny("invalid_input");
				await tx.query(
					`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,participation_id,body,occurred_at,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp())`,
					[noteId, ctx.selected.id, before.plant_id, before.id, actor, participation, input.input.body],
				);
			} else {
				const r = await tx.query(
					"SELECT * FROM person_note WHERE id=$1 AND tenant_id=$2 AND person_id=$3 AND removed_at IS NULL FOR UPDATE",
					[noteId, ctx.selected.id, before.id],
				);
				if (!r.rowCount || r.rows[0].author_id !== actor) deny();
				if (r.rows[0].revision !== input.expectedRevision) deny("conflict");
				const body = kind === "delete" ? "" : "body" in input.input ? input.input.body : deny("invalid_input");
				// Exact old/new note bodies live only in protected Person history.
				await tx.query(
					`INSERT INTO people_history(tenant_id,person_id,operation_id,actor_id,actor_token,action,occurred_at,before_revision,after_revision,before_value,after_value,reason) VALUES($1,$2,$3,$4,$5,'note_correction',$6,$7,$8,$9,$10,$11)`,
					[
						ctx.selected.id,
						before.id,
						id,
						actor,
						hash([ctx.selected.id, actor]),
						r.rows[0].occurred_at,
						r.rows[0].revision,
						(BigInt(r.rows[0].revision) + 1n).toString(),
						JSON.stringify({ noteId, body: r.rows[0].body }),
						JSON.stringify({ noteId, body }),
						"reason" in input.input ? input.input.reason : null,
					],
				);
				await tx.query(
					`UPDATE person_note SET body=$2,edited_at=clock_timestamp(),removed_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,revision=revision+1 WHERE id=$1`,
					[noteId, body, kind === "delete"],
				);
				noteRevision = (BigInt(r.rows[0].revision) + 1n).toString();
			}
			await tx.query("UPDATE person SET revision=revision+1 WHERE id=$1", [before.id]);
			const after = await person(tx, ctx, before.id, true);
			return {
				value: {
					receiptId: id,
					noteId,
					revision: noteRevision,
					outcome: "changed",
				},
				subject: before.id,
				action: "people.updated",
				before,
				after,
			};
		},
	);
}
async function classify(tx: Tx, ctx: WriteContext, raw: unknown, correction: boolean) {
	return reply(tx, async () => {
		if (ctx.selected.kind !== "plant") deny();
		const input = parse(c.classifyAdultRequest, raw);
		return c.classificationMutationResult.parse(
			await mutation(
				tx,
				ctx,
				correction ? "people.correctAdultClassification" : "people.recordAdultClassification",
				input,
				async (_a, id) => {
					const before = await person(tx, ctx, input.input.personId, true);
					live(before);
					expected(before, input.expectedRevision);
					const now = (
						await tx.query(
							"SELECT (clock_timestamp() AT TIME ZONE timezone)::date AS today,timezone FROM plant WHERE id=$1",
							[ctx.selected.id],
						)
					).rows[0];
					if (input.input.occurredOn > now.today.toISOString().slice(0, 10)) deny("invalid_input");
					await tx.query("UPDATE person SET adult_classification=$2,revision=revision+1 WHERE id=$1", [
						before.id,
						input.input.classification,
					]);
					const after = await person(tx, ctx, before.id, true),
						dto = c.plantPerson.parse(await project(tx, ctx, after));
					const first = await tx.query(
						"SELECT id,signed_on FROM commitment WHERE plant_id=$1 AND person_id=$2 AND voided_at IS NULL ORDER BY signed_on,id LIMIT 1",
						[ctx.selected.id, before.id],
					);
					return {
						value: {
							receiptId: id,
							outcome: "changed",
							observation: {
								owner: ctx.selected,
								personId: after.id,
								asOf: new Date().toISOString(),
								zone: now.timezone,
								sourceRevision: after.revision,
								lifecycle: dto.lifecycle,
								classification: dto.adultClassification,
								current: dto.commitment,
								firstAcquisition: first.rowCount
									? {
											status: "known",
											occurredOn: first.rows[0].signed_on.toISOString().slice(0, 10),
											evidenceId: first.rows[0].id,
										}
									: { status: "unknown" },
							},
						},
						subject: before.id,
						action: correction ? "people.corrected" : "people.recorded",
						before,
						after,
						reason: input.input.reason,
					};
				},
			),
		);
	});
}
async function pipelineOrder(tx: Tx, ctx: WriteContext, input: z.infer<typeof c.reorderPipelineRequest>) {
	return c.noteMutationResult.pick({ receiptId: true, outcome: true }).parse(
		await mutation(tx, ctx, "people.reorderPipeline", input, async (actor, id) => {
			await tx.query("INSERT INTO people_column(plant_id,column_name) VALUES($1,$2) ON CONFLICT DO NOTHING", [
				ctx.selected.id,
				input.input.column,
			]);
			const col = await tx.query("SELECT revision FROM people_column WHERE plant_id=$1 AND column_name=$2 FOR UPDATE", [
				ctx.selected.id,
				input.input.column,
			]);
			if (col.rows[0].revision !== input.expectedRevision) deny("conflict");
			const ids = input.input.personIds;
			if (!ids.length)
				return {
					value: { receiptId: id, outcome: "noop" },
					subject: ctx.selected.id,
					action: "people.updated",
					outcome: "noop",
				};
			const stages =
				input.input.column === "core_group" ? ["core_group", "launch_team", "leader"] : [input.input.column];
			const rows = await tx.query(
				"SELECT * FROM person WHERE plant_id=$1 AND state='live' AND stage=ANY($2) ORDER BY id FOR UPDATE",
				[ctx.selected.id, stages],
			);
			if (rows.rowCount !== ids.length || rows.rows.some((p) => !ids.includes(p.id))) deny("conflict");
			for (const [i, pid] of ids.entries()) {
				const before = personRow.parse(rows.rows.find((p) => p.id === pid));
				await tx.query("UPDATE person SET pipeline_position=$2,revision=revision+1 WHERE id=$1", [pid, i]);
				const after = await person(tx, ctx, pid, true);
				await tx.query(
					`INSERT INTO people_history(tenant_id,person_id,operation_id,actor_id,actor_token,action,occurred_at,before_revision,after_revision,before_value,after_value) VALUES($1,$2,$3,$4,$5,'people.updated',clock_timestamp(),$6,$7,$8,$9)`,
					[
						ctx.selected.id,
						pid,
						id,
						actor,
						hash([ctx.selected.id, actor]),
						before.revision,
						after.revision,
						JSON.stringify(before),
						JSON.stringify(after),
					],
				);
			}
			await tx.query("UPDATE people_column SET revision=revision+1 WHERE plant_id=$1 AND column_name=$2", [
				ctx.selected.id,
				input.input.column,
			]);
			return {
				value: { receiptId: id, outcome: "changed" },
				subject: ctx.selected.id,
				action: "people.updated",
			};
		}),
	);
}
export const accountPersonProducer: AccountPersonProducer<Tx> = {
	async ensureAccountPerson(tx, raw) {
		return reply(tx, async () => {
			const input = raw,
				selected = owner.parse(input.owner);
			if (selected.kind !== "plant") deny();
			// Trusted collaborator, never a client account selector. Provisioning owns
			// account proof/eligibility and enclosing transaction; these locks arbitrate retries.
			const account = await tx.query("SELECT id FROM account WHERE id=$1 FOR UPDATE", [input.accountId]);
			if (!account.rowCount) deny();
			await tx.query("SELECT id FROM plant WHERE id=$1 FOR UPDATE", [selected.id]);
			const exact = await tx.query(
				"SELECT id FROM person WHERE plant_id=$1 AND linked_account_id=$2 AND state='live' FOR UPDATE",
				[selected.id, input.accountId],
			);
			if (exact.rowCount)
				return c.accountPersonResolution.parse({
					status: "linked",
					personId: exact.rows[0].id,
				});
			const ctx = { selected };
			const candidates = await tx.query(
				"SELECT p.id FROM person p JOIN access_account_contact($1) a ON lower(p.email)=lower(a.email) WHERE p.plant_id=$2 AND p.state='live' AND p.linked_account_id IS NULL AND a.verified ORDER BY p.id LIMIT 100 FOR UPDATE OF p",
				[input.accountId, selected.id],
			);
			if (input.selection.kind === "resolve")
				return candidates.rowCount
					? c.accountPersonResolution.parse({
							status: "needs_selection",
							candidatePersonIds: candidates.rows.map((p) => p.id),
						})
					: deny("invalid_subject");
			let p: Person;
			if (input.selection.kind === "reviewed_contact") {
				if (input.selection.person.owner.id !== selected.id || input.selection.person.owner.kind !== "plant") deny();
				p = await person(tx, ctx, input.selection.person.personId, true);
				live(p);
				expected(p, input.selection.person.revision);
				if (p.linked_account_id || !candidates.rows.some((x) => x.id === p.id)) deny();
			} else
				p = await insertPerson(tx, ctx, {
					displayName: input.selection.displayName,
					stage: "prospect",
					source: "other",
					adultClassification: "unknown",
				});
			await tx.query("UPDATE person SET linked_account_id=$2,revision=revision+1 WHERE id=$1", [p.id, input.accountId]);
			const linked = await person(tx, ctx, p.id, true),
				op = randomUUID(),
				key = "account-person:" + selected.id + ":" + input.accountId + ":" + p.id;
			await tx.query(
				`INSERT INTO operation(id,tenant_id,actor_id,name,request_key,request_digest,state,outcome,started_at,completed_at,tool_calls,reserved_input,reserved_output,used_input,used_output) VALUES($1,$2,$3,'people.ensureAccountPerson',$4,$5,'complete','committed',clock_timestamp(),clock_timestamp(),0,0,0,0,0)`,
				[op, selected.id, input.accountId, key, hash(input)],
			);
			await tx.query(
				`INSERT INTO people_history(tenant_id,person_id,operation_id,actor_id,actor_token,action,occurred_at,before_revision,after_revision,before_value,after_value) VALUES($1,$2,$3,$4,$5,'people.updated',clock_timestamp(),$6,$7,$8,$9)`,
				[
					selected.id,
					p.id,
					op,
					input.accountId,
					hash([selected.id, input.accountId]),
					p.revision,
					linked.revision,
					JSON.stringify(p),
					JSON.stringify(linked),
				],
			);
			await tx.query(
				`INSERT INTO event(tenant_id,target_record_id,operation_id,actor_id,kind,occurred_at,recorded_at,before_revision,after_revision,event_key,action) VALUES($1,$2,$3,$4,'edit',clock_timestamp(),clock_timestamp(),$5,$6,$3::uuid::text,'people.updated')`,
				[selected.id, p.id, op, input.accountId, p.revision, linked.revision],
			);
			await tx.query("UPDATE plant SET material_revision=material_revision+1 WHERE id=$1", [selected.id]);
			return c.accountPersonResolution.parse({
				status: "linked",
				personId: p.id,
			});
		});
	},
	async ensureGuest(tx, ctx, raw) {
		return reply(tx, async () => {
			const input = parse(c.guestSelection, raw);
			if (ctx.selected.kind !== "plant") deny();
			await lockOwner(tx, ctx);
			await authorize(tx, ctx, true);
			let p: Person;
			if (input.kind === "existing") p = await person(tx, ctx, input.personId, true);
			else {
				const created = await peopleWriter.createPerson(
					tx,
					ctx,
					c.createPersonRequest.parse({
						requestKey: randomUUID(),
						input: {
							displayName: input.displayName,
							email: input.email,
							phone: input.phone,
						},
					}),
				);
				if (created.status !== "ok") deny(created.error.code);
				p = await person(tx, ctx, created.value.person.id, true);
			}
			live(p);
			return c.lockedPersonReference.parse({
				owner: ctx.selected,
				personId: p.id,
				revision: p.revision,
				state: "live",
			});
		});
	},
};
