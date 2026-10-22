"use server";

import { requestDatabase } from "@/server/database";
import { drainObjectCleanup } from "@/server/jobs/drain-object-cleanup";
import { requestKey, revision } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import type { PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import type { Transaction } from "@everyfield/db/client";
import { peopleReader, personFields as f, uploadPersonPhoto } from "@everyfield/domain/people";
import { z } from "zod";
import { boundary, invalid, outcome, receipt, type Receipt } from "../boundary.ts";
import type { Outcome } from "../../../components/save/model.ts";
import { read, write } from "../server.ts";
import type { ChurchTag, HouseholdResult, PersonTag, PhotoResult, Skill } from "./model.ts";
import { privateStorage } from "@everyfield/db/schema";
import { peopleContext } from "./server.ts";

// Server actions for the person fields (REQ-PPL-005, 009, 010, 011). Each parses the browser's input with the WP-012
// contract, runs one producer write in one transaction and answers with what changed, so the screen updates from the
// answer and never reloads the page. A write that changes the Person (household membership, address propagation, photo)
// also answers with the Person as saved, read in the same transaction, so the page's next save sends the new revision.

type PlantPerson = z.infer<typeof c.plantPerson>;
type Tx = Transaction;
type PersonId = z.infer<typeof c.personRequest>["personId"];
type Ctx = PeopleWriteContext;

/** The Person as saved by this transaction's write, which just changed this live plant Person. */
async function savedPerson(tx: Tx, ctx: Ctx, personId: PersonId): Promise<PeopleReply<PlantPerson>> {
	const r = await peopleReader.getPerson(tx, ctx, { personId });
	if (r.status !== "ok") return r;
	if (r.value.status !== "available" || !("stage" in r.value.person)) throw new Error("written person not readable");
	return { status: "ok", value: r.value.person };
}
/** Runs a Person-changing write and reads the Person after it, in the same transaction. */
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

// Tags (REQ-PPL-010).

export async function listChurchTags(): Promise<Outcome<ChurchTag[]>> {
	return boundary(c.listTagsRequest, {}, async (v, request) =>
		outcome(await read(v, (tx, ctx) => f.listTags(tx, ctx, request)), (r) => r.items),
	);
}

const addTagInput = z.union([
	z.strictObject({ personId: c.personFieldsRequest.shape.personId, tagId: z.uuid() }),
	z.strictObject({ personId: c.personFieldsRequest.shape.personId, name: c.tagName }),
]);
/**
 * Puts a tag on a person: an existing church tag by ID, or a new name. A new name creates the church tag and assigns
 * it in one transaction; a name that matches an existing tag (case and outer spaces aside) uses that tag.
 */
export async function addPersonTag(
	requestKey: string,
	input: unknown,
): Promise<Outcome<{ tags: PersonTag[]; created: ChurchTag | null; receipt: Receipt }>> {
	return boundary(addTagInput, input, async (v, i) =>
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
	return boundary(c.tagAssignmentRequest, { requestKey, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.removeTag(tx, ctx, request)), (r) => ({ tags: r.tags, receipt: receipt(r) })),
	);
}

export async function createChurchTag(requestKey: string, input: unknown): Promise<Outcome<ChurchTag>> {
	return boundary(c.createTagRequest, { requestKey, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.createTag(tx, ctx, request)), (r) => r.tag),
	);
}

export async function updateChurchTag(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<ChurchTag>> {
	return boundary(c.updateTagRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.updateTag(tx, ctx, request)), (r) => r.tag),
	);
}

export async function deleteChurchTag(
	requestKey: string,
	expectedRevision: string,
	tagId: string,
): Promise<Outcome<{ tagId: string; removedLinks: number }>> {
	return boundary(c.deleteTagRequest, { requestKey, expectedRevision, input: { tagId } }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.deleteTag(tx, ctx, request)), (r) => ({
			tagId: r.tagId,
			removedLinks: r.removedLinks,
		})),
	);
}

// Skills (REQ-PPL-011).

type SkillsSaved = { skills: Skill[]; receipt: Receipt };
const skillsSaved = (r: { skills: Skill[]; receiptId: string; outcome: "changed" | "noop" }): SkillsSaved => ({
	skills: r.skills,
	receipt: receipt(r),
});

/** The person's skills as saved now: a refused edit or removal reads them again, so the next try starts from them. */
export async function readSkills(personId: string): Promise<Outcome<Skill[]>> {
	return boundary(c.personFieldsRequest, { personId }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => f.getPersonSkills(tx, ctx, request)), (r) => r.skills),
	);
}

export async function addSkill(requestKey: string, input: unknown): Promise<Outcome<SkillsSaved>> {
	return boundary(c.addSkillRequest, { requestKey, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.addSkill(tx, ctx, request)), skillsSaved),
	);
}

export async function updateSkill(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<SkillsSaved>> {
	return boundary(c.updateSkillRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.updateSkill(tx, ctx, request)), skillsSaved),
	);
}

export async function removeSkill(
	requestKey: string,
	expectedRevision: string,
	skillId: string,
): Promise<Outcome<SkillsSaved>> {
	return boundary(c.removeSkillRequest, { requestKey, expectedRevision, input: { skillId } }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.removeSkill(tx, ctx, request)), skillsSaved),
	);
}

// Households (REQ-PPL-009).

/** A membership change: the household as it is now for this person, the Person as saved and the receipt. */
/**
 * A membership change: the household as it is now for this person, and the receipt. `person` is the Person as saved,
 * read in the same transaction, only after leaving; otherwise the answer's member row already carries this person's
 * new revision and address, so no second read is spent on it.
 */
export type MembershipSaved = { household: HouseholdResult; person: PlantPerson | null; receipt: Receipt };
type HouseholdAnswer = z.infer<typeof c.householdMutationResult>;
const membershipSaved = (r: { value: HouseholdAnswer; person?: PlantPerson }): MembershipSaved => ({
	household: r.value.result,
	person: r.person ?? null,
	receipt: receipt(r.value),
});
const asMember = (value: HouseholdAnswer) => membershipSaved({ value });

export async function findHouseholds(search: string, page = 1): Promise<Outcome<z.infer<typeof c.householdsPage>>> {
	return boundary(c.listHouseholdsRequest, { search, page, limit: 20 }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => f.listHouseholds(tx, ctx, request)), (r) => r),
	);
}

/** The person's household as it is now: the address-copy preview reads it fresh, and a refused household change too. */
export async function readHousehold(personId: string): Promise<Outcome<HouseholdResult>> {
	return boundary(c.personFieldsRequest, { personId }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => f.getHousehold(tx, ctx, request)), (r) => r),
	);
}

export async function startHousehold(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<MembershipSaved>> {
	return boundary(c.createHouseholdWithHeadRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.createHouseholdWithHead(tx, ctx, request)), asMember),
	);
}

export async function joinHousehold(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<MembershipSaved>> {
	return boundary(c.addToHouseholdRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.addToHousehold(tx, ctx, request)), asMember),
	);
}

export async function setHouseholdRole(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<MembershipSaved>> {
	return boundary(c.setHouseholdRoleRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.setHouseholdRole(tx, ctx, request)), asMember),
	);
}

const leaveInput = z.strictObject({
	personId: c.personFieldsRequest.shape.personId,
	// The household to delete once this person has left it, when they were its last member.
	deleteEmpty: z.uuid().nullable(),
});
/**
 * Takes a person out of their household; their own address stays. When they were the last member and the screen asks
 * for it, the empty household is deleted in the same transaction, so a refusal leaves both as they were.
 */
export async function leaveHousehold(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<MembershipSaved & { deleted: boolean }>> {
	return boundary(leaveInput, input, async (v, i) => {
		const request = { requestKey, expectedRevision, input: { personId: i.personId } };
		const saved = await write(v, async (tx, ctx) => {
			const left = await f.removeFromHousehold(tx, ctx, request);
			if (left.status !== "ok" || !i.deleteEmpty) return andPerson(tx, ctx, i.personId, left);
			// Leaving moved the household's revision on; delete it at the revision read now, in this transaction.
			const now = await f.getHousehold(tx, ctx, { householdId: i.deleteEmpty });
			if (now.status !== "ok") return now;
			if (now.value.status === "available") {
				const gone = await f.deleteHousehold(tx, ctx, {
					requestKey: `${requestKey}:delete`,
					expectedRevision: now.value.household.revision,
					input: { householdId: i.deleteEmpty },
				});
				if (gone.status !== "ok") return gone;
			}
			return andPerson(tx, ctx, i.personId, left);
		});
		return outcome(saved, (r) => ({ ...membershipSaved(r), deleted: i.deleteEmpty !== null }));
	});
}

export async function updateHousehold(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<HouseholdResult>> {
	return boundary(c.updateHouseholdRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.updateHousehold(tx, ctx, request)), (r) => r.result),
	);
}

/**
 * Copies the household address over every member shown in the reviewed preview, all at once. The household revision and
 * each member's revision come from that preview; a change to any of them refuses the whole copy.
 */
export async function propagateAddress(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<MembershipSaved & { updatedPeople: number }>> {
	return boundary(c.propagateAddressRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => f.propagateAddress(tx, ctx, request)), (r) => ({
			...asMember(r),
			updatedPeople: r.updatedPeople ?? 0,
		})),
	);
}

// Photo (REQ-PPL-005).

export type PhotoSaved = { photo: PhotoResult; personRevision: string; receipt: Receipt };
const photoForm = z.object({
	requestKey,
	expectedRevision: revision,
	personId: c.personFieldsRequest.shape.personId,
	file: z.instanceof(File),
});
/**
 * Stores a new photo for a person: ask for an upload, send the verified bytes to the private bucket, then point the
 * Person at that exact version. Until the last step succeeds the person keeps the photo they had (REQ-PPL-005).
 */
export async function uploadPhoto(form: FormData): Promise<Outcome<PhotoSaved>> {
	const parsed = photoForm.safeParse(Object.fromEntries(form));
	if (!parsed.success) return invalid;
	const { requestKey, expectedRevision, personId, file } = parsed.data;
	const mime = c.photoMime.safeParse(file.type);
	if (!mime.success || file.size < 1 || file.size > c.PHOTO_MAX_BYTES) return invalid;
	drainObjectCleanup(); // after the response: delete the bytes of the photo this change released
	return boundary(c.personFieldsRequest, { personId }, async (v) => {
		const storage = privateStorage();
		const db = requestDatabase();
		if (!storage || !db) return { status: "refused", code: "storage_unavailable" };
		const staged = outcome(
			await write(v, (tx, ctx) =>
				f.requestPersonPhotoUpload(tx, ctx, { personId, mime: mime.data, byteLength: file.size }),
			),
			(r) => r,
		);
		if (staged.status !== "ok") return staged;
		const bytes = new Uint8Array(await file.arrayBuffer());
		const stored = await uploadPersonPhoto(db, storage, peopleContext(v), {
			uploadId: staged.value.uploadId,
			bytes,
		}).catch(() => ({ status: "failed" }) as const);
		if (stored.status !== "ok")
			return stored.status === "failed" ? { status: "lost" } : { status: "refused", code: stored.error.code };
		return outcome(
			await write(v, (tx, ctx) =>
				f.setPersonPhoto(tx, ctx, {
					requestKey,
					expectedRevision,
					input: { personId, uploadId: staged.value.uploadId },
				}),
			),
			(r) => ({ photo: r.photo, personRevision: r.personRevision, receipt: receipt(r) }),
		);
	});
}

/** The person's photo as saved now: a refused photo change reads it again, so the header shows the current one. */
export async function readPhoto(personId: string): Promise<Outcome<PhotoResult>> {
	return boundary(c.personFieldsRequest, { personId }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => f.getPersonPhoto(tx, ctx, request)), (r) => r),
	);
}

export async function removePhoto(
	requestKey: string,
	expectedRevision: string,
	personId: string,
): Promise<Outcome<PhotoSaved>> {
	drainObjectCleanup(); // after the response: delete the bytes of the photo this change released
	return boundary(
		c.removePersonPhotoRequest,
		{ requestKey, expectedRevision, input: { personId } },
		async (v, request) =>
			outcome(await write(v, (tx, ctx) => f.removePersonPhoto(tx, ctx, request)), (r) => ({
				photo: r.photo,
				personRevision: r.personRevision,
				receipt: receipt(r),
			})),
	);
}
