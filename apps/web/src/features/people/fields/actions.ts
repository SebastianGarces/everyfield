"use server";

import { seated } from "@/server/request-context";
import { requestDatabase } from "@/server/database";
import { drainObjectCleanup } from "@/server/jobs/drain-object-cleanup";
import { requestKey, revision } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import type { PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import { peopleReader, personFields as f, uploadPersonPhoto } from "@everyfield/domain/people";
import { z } from "zod";
import { invalid, outcome, parsed, receipt, type Receipt } from "../boundary.ts";
import type { Outcome } from "../../../components/save/model.ts";
import { write } from "../server.ts";
import type { ChurchTag, HouseholdResult, PersonTag, PhotoResult, Skill } from "./model.ts";
import { privateStorage } from "@everyfield/db/schema";
import { leave } from "./leave.ts";
import { peopleContext } from "./server.ts";
import { transient } from "../../../server/platform/transient.ts";
import type { WriteTx } from "@everyfield/domain/access";

type PlantPerson = z.infer<typeof c.plantPerson>;
type Tx = WriteTx;
type PersonId = z.infer<typeof c.personRequest>["personId"];
type Ctx = PeopleWriteContext;

async function savedPerson(tx: Tx, ctx: Ctx, personId: PersonId): Promise<PeopleReply<PlantPerson>> {
	const r = await peopleReader.getPerson(tx, ctx, { personId });
	if (r.status !== "ok") return r;
	if (r.value.status !== "available" || !("stage" in r.value.person)) throw new Error("written person not readable");
	return { status: "ok", value: r.value.person };
}
async function andPerson<T>(
	tx: Tx,
	ctx: Ctx,
	personId: PersonId,
	done: PeopleReply<T>,
): Promise<PeopleReply<{ value: T; person: PlantPerson }>> {
	if (done.status !== "ok") return done;
	const person = await savedPerson(tx, ctx, personId);
	return person.status === "ok" ? { status: "ok", value: { value: done.value, person: person.value } } : person;
}

const addTagInput = z.union([
	z.strictObject({ personId: c.personFieldsRequest.shape.personId, tagId: z.uuid() }),
	z.strictObject({ personId: c.personFieldsRequest.shape.personId, name: c.tagName }),
]);
export async function addPersonTag(
	requestKey: string,
	input: unknown,
): Promise<Outcome<{ tags: PersonTag[]; created: ChurchTag | null; receipt: Receipt }>> {
	return parsed(addTagInput, input, async (v, i) =>
		outcome(
			await write(v, async (tx, ctx) => {
				let created: ChurchTag | null = null;
				let tagId = "tagId" in i ? i.tagId : null;
				if (!tagId) {
					const made = await f.createTag(tx, ctx, {
						requestKey: `${requestKey}:tag`,
						input: { name: (i as { name: string }).name },
					});
					if (made.status !== "ok") return made;
					created = made.value.tag;
					tagId = made.value.tag.id;
				}
				const done = await f.assignTag(tx, ctx, { requestKey, input: { personId: i.personId, tagId } });
				return done.status === "ok" ? { status: "ok", value: { ...done.value, created } } : done;
			}),
			(r) => ({ tags: r.tags, created: r.created, receipt: receipt(r) }),
		),
	);
}

export async function removePersonTag(
	requestKey: string,
	input: unknown,
): Promise<Outcome<{ tags: PersonTag[]; receipt: Receipt }>> {
	return seated("access_denied", async (v) =>
		outcome(await write(v, (tx, ctx) => f.removeTag(tx, ctx, { requestKey, input })), (r) => ({
			tags: r.tags,
			receipt: receipt(r),
		})),
	);
}

export async function createChurchTag(requestKey: string, input: unknown): Promise<Outcome<ChurchTag>> {
	return seated("access_denied", async (v) =>
		outcome(await write(v, (tx, ctx) => f.createTag(tx, ctx, { requestKey, input })), (r) => r.tag),
	);
}

export async function updateChurchTag(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<ChurchTag>> {
	return seated("access_denied", async (v) =>
		outcome(await write(v, (tx, ctx) => f.updateTag(tx, ctx, { requestKey, expectedRevision, input })), (r) => r.tag),
	);
}

export async function deleteChurchTag(
	requestKey: string,
	expectedRevision: string,
	tagId: string,
): Promise<Outcome<{ tagId: string; removedLinks: number }>> {
	return seated("access_denied", async (v) =>
		outcome(
			await write(v, (tx, ctx) => f.deleteTag(tx, ctx, { requestKey, expectedRevision, input: { tagId } })),
			(r) => ({
				tagId: r.tagId,
				removedLinks: r.removedLinks,
			}),
		),
	);
}

type SkillsSaved = { skills: Skill[]; receipt: Receipt };
const skillsSaved = (r: { skills: Skill[]; receiptId: string; outcome: "changed" | "noop" }): SkillsSaved => ({
	skills: r.skills,
	receipt: receipt(r),
});

export async function addSkill(requestKey: string, input: unknown): Promise<Outcome<SkillsSaved>> {
	return seated("access_denied", async (v) =>
		outcome(await write(v, (tx, ctx) => f.addSkill(tx, ctx, { requestKey, input })), skillsSaved),
	);
}

export async function updateSkill(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<SkillsSaved>> {
	return seated("access_denied", async (v) =>
		outcome(await write(v, (tx, ctx) => f.updateSkill(tx, ctx, { requestKey, expectedRevision, input })), skillsSaved),
	);
}

export async function removeSkill(
	requestKey: string,
	expectedRevision: string,
	skillId: string,
): Promise<Outcome<SkillsSaved>> {
	return seated("access_denied", async (v) =>
		outcome(
			await write(v, (tx, ctx) => f.removeSkill(tx, ctx, { requestKey, expectedRevision, input: { skillId } })),
			skillsSaved,
		),
	);
}

export type MembershipSaved = { household: HouseholdResult; person: PlantPerson | null; receipt: Receipt };
type HouseholdAnswer = z.infer<typeof c.householdMutationResult>;
const membershipSaved = (r: { value: HouseholdAnswer; person?: PlantPerson }): MembershipSaved => ({
	household: r.value.result,
	person: r.person ?? null,
	receipt: receipt(r.value),
});
const asMember = (value: HouseholdAnswer) => membershipSaved({ value });

export async function startHousehold(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<MembershipSaved>> {
	return seated("access_denied", async (v) =>
		outcome(
			await write(v, (tx, ctx) => f.createHouseholdWithHead(tx, ctx, { requestKey, expectedRevision, input })),
			asMember,
		),
	);
}

export async function joinHousehold(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<MembershipSaved>> {
	return seated("access_denied", async (v) =>
		outcome(await write(v, (tx, ctx) => f.addToHousehold(tx, ctx, { requestKey, expectedRevision, input })), asMember),
	);
}

export async function setHouseholdRole(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<MembershipSaved>> {
	return seated("access_denied", async (v) =>
		outcome(
			await write(v, (tx, ctx) => f.setHouseholdRole(tx, ctx, { requestKey, expectedRevision, input })),
			asMember,
		),
	);
}

const leaveInput = z.strictObject({
	personId: c.personFieldsRequest.shape.personId,
	deleteEmpty: z.boolean(),
});
export async function leaveHousehold(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<MembershipSaved>> {
	return parsed(leaveInput, input, async (v, i) => {
		const request = { requestKey, expectedRevision, input: { personId: i.personId } };
		const saved = await write(v, async (tx, ctx) =>
			andPerson(tx, ctx, i.personId, await leave(tx, ctx, request, i.deleteEmpty)),
		);
		return outcome(saved, membershipSaved);
	});
}

export async function updateHousehold(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<HouseholdResult>> {
	return seated("access_denied", async (v) =>
		outcome(
			await write(v, (tx, ctx) => f.updateHousehold(tx, ctx, { requestKey, expectedRevision, input })),
			(r) => r.result,
		),
	);
}

export async function propagateAddress(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<MembershipSaved & { updatedPeople: number }>> {
	return seated("access_denied", async (v) =>
		outcome(await write(v, (tx, ctx) => f.propagateAddress(tx, ctx, { requestKey, expectedRevision, input })), (r) => ({
			...asMember(r),
			updatedPeople: r.updatedPeople ?? 0,
		})),
	);
}

export type PhotoSaved = { photo: PhotoResult; personRevision: string; receipt: Receipt };
const photoForm = z.object({
	requestKey,
	expectedRevision: revision,
	personId: c.personFieldsRequest.shape.personId,
	file: z.instanceof(File),
});
function drainAfter<T>(saved: Outcome<T>): Outcome<T> {
	if (saved.status === "ok") drainObjectCleanup();
	return saved;
}

export async function uploadPhoto(form: FormData): Promise<Outcome<PhotoSaved>> {
	const parsed = photoForm.safeParse(Object.fromEntries(form));
	if (!parsed.success) return invalid;
	const { requestKey, expectedRevision, personId, file } = parsed.data;
	const mime = c.photoMime.safeParse(file.type);
	if (!mime.success || file.size < 1 || file.size > c.PHOTO_MAX_BYTES) return invalid;
	return seated("access_denied", async (v) => {
		const storage = privateStorage();
		if (!storage) return { status: "refused", code: "storage_unavailable" };
		const db = requestDatabase();
		const staged = outcome(
			await write(v, (tx, ctx) =>
				f.requestPersonPhotoUpload(tx, ctx, { requestKey, personId, mime: mime.data, byteLength: file.size }),
			),
			(r) => r,
		);
		if (staged.status !== "ok") return staged;
		const bytes = new Uint8Array(await file.arrayBuffer());
		const stored = await transient(
			{ component: "people", outcome: "photo_upload_failed" },
			() => uploadPersonPhoto(db, storage, peopleContext(v), { uploadId: staged.value.uploadId, bytes }),
			{ status: "failed" } as const,
		);
		if (stored.status !== "ok")
			return stored.status === "failed" ? { status: "lost" } : { status: "refused", code: stored.error.code };
		return drainAfter(
			outcome(
				await write(v, (tx, ctx) =>
					f.setPersonPhoto(tx, ctx, {
						requestKey,
						expectedRevision,
						input: { personId, uploadId: staged.value.uploadId },
					}),
				),
				(r) => ({ photo: r.photo, personRevision: r.personRevision, receipt: receipt(r) }),
			),
		);
	});
}

export async function removePhoto(
	requestKey: string,
	expectedRevision: string,
	personId: string,
): Promise<Outcome<PhotoSaved>> {
	return seated("access_denied", async (v) =>
		drainAfter(
			outcome(
				await write(v, (tx, ctx) =>
					f.removePersonPhoto(tx, ctx, { requestKey, expectedRevision, input: { personId } }),
				),
				(r) => ({
					photo: r.photo,
					personRevision: r.personRevision,
					receipt: receipt(r),
				}),
			),
		),
	);
}
