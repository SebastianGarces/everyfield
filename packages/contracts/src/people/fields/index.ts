import { z } from "zod";
import { instant } from "../../common/time.ts";
import { personId, recordId, requestKey, revision } from "../../common/values.ts";
import { commandEnvelope } from "../../common/writes.ts";
import { contactFields, pageInput } from "../values.ts";

export const tagName = z.string().trim().min(1).max(100);
export const namedTagColors = [
	"gray",
	"red",
	"orange",
	"amber",
	"yellow",
	"green",
	"teal",
	"blue",
	"indigo",
	"purple",
	"pink",
] as const;
export const tagColor = z.union([
	z.enum(namedTagColors),
	z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/)
		.transform((hex) => hex.toLowerCase()),
]);
export const skillCategory = z.enum(["worship", "tech", "admin", "teaching", "hospitality", "leadership", "other"]);
export const proficiency = z.enum(["beginner", "intermediate", "advanced", "expert"]);
export const skillName = z.string().trim().min(1).max(100);
export const skillNotes = z.string().trim().max(5000);
export const householdRole = z.enum(["head", "spouse", "child", "other"]);
export const householdMembership = z.strictObject({ householdId: recordId, name: z.string(), role: householdRole });
export const householdName = z.string().trim().min(1).max(255);
const addressFields = {
	street: contactFields.street,
	city: contactFields.city,
	stateProvince: contactFields.stateProvince,
	postalCode: contactFields.postalCode,
	country: contactFields.country,
};
const householdId = recordId,
	tagId = recordId,
	skillId = recordId;
export const photoMime = z.enum(["image/jpeg", "image/png", "image/webp"]);
export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;

export const personFieldsRequest = z.strictObject({ personId });
export const listTagsRequest = z.strictObject({});
export const createTagRequest = z.strictObject({
	requestKey,
	input: z.strictObject({ name: tagName, color: tagColor.nullable().default(null) }),
});
export const updateTagRequest = commandEnvelope(
	z.strictObject({ tagId, name: tagName.optional(), color: tagColor.nullable().optional() }),
);
export const deleteTagRequest = commandEnvelope(z.strictObject({ tagId }));
export const tagAssignmentRequest = z.strictObject({ requestKey, input: z.strictObject({ personId, tagId }) });

export const addSkillRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		personId,
		name: skillName,
		category: skillCategory,
		proficiency: proficiency.nullable().default(null),
		notes: skillNotes.nullable().default(null),
	}),
});
export const updateSkillRequest = commandEnvelope(
	z.strictObject({
		skillId,
		patch: z.strictObject({
			name: skillName.optional(),
			category: skillCategory.optional(),
			proficiency: proficiency.nullable().optional(),
			notes: skillNotes.nullable().optional(),
		}),
	}),
);
export const removeSkillRequest = commandEnvelope(z.strictObject({ skillId }));

export const listHouseholdsRequest = z.strictObject({ ...pageInput, search: z.string().trim().max(255).optional() });
export const householdRequest = z.union([z.strictObject({ householdId }), z.strictObject({ personId })]);
export const createHouseholdWithHeadRequest = commandEnvelope(
	z.strictObject({ name: householdName, ...addressFields, headPersonId: personId }),
);
export const updateHouseholdRequest = commandEnvelope(
	z.strictObject({ householdId, patch: z.strictObject({ name: householdName.optional(), ...addressFields }) }),
);
export const deleteHouseholdRequest = commandEnvelope(z.strictObject({ householdId }));
export const addToHouseholdRequest = commandEnvelope(z.strictObject({ householdId, personId, role: householdRole }));
export const removeFromHouseholdRequest = commandEnvelope(z.strictObject({ personId }));
export const setHouseholdRoleRequest = commandEnvelope(z.strictObject({ personId, role: householdRole }));
export const propagateAddressRequest = commandEnvelope(
	z.strictObject({
		householdId,
		members: z.array(z.strictObject({ personId, revision })).min(1).max(100),
	}),
);

export const requestPhotoUploadRequest = z.strictObject({
	requestKey,
	personId,
	mime: photoMime,
	byteLength: z.int().min(1).max(PHOTO_MAX_BYTES),
});
export const setPersonPhotoRequest = commandEnvelope(z.strictObject({ personId, uploadId: recordId }));
export const removePersonPhotoRequest = commandEnvelope(z.strictObject({ personId }));

export const tag = z.strictObject({
	id: tagId,
	name: tagName,
	color: tagColor.nullable(),
	revision,
	linkedPeople: z.int().min(0),
});
export const tagsResult = z.strictObject({ items: z.array(tag).max(1000) });
export const personTag = tag.pick({ id: true, name: true, color: true });
export const personTagsResult = z.strictObject({ personId, tags: z.array(personTag).max(1000) });
const outcome = z.enum(["changed", "noop"]);
export const tagMutationResult = z.strictObject({ tag, outcome, receiptId: recordId });
export const deleteTagResult = z.strictObject({ tagId, removedLinks: z.int().min(0), receiptId: recordId });
export const tagAssignmentResult = z.strictObject({
	personId,
	tags: z.array(personTag).max(1000),
	outcome,
	receiptId: recordId,
});

export const skill = z.strictObject({
	id: skillId,
	personId,
	name: skillName,
	category: skillCategory,
	proficiency: proficiency.nullable(),
	notes: skillNotes.nullable(),
	revision,
});
export const personSkillsResult = z.strictObject({ personId, skills: z.array(skill).max(1000) });
export const skillMutationResult = z.strictObject({
	personId,
	skills: z.array(skill).max(1000),
	outcome,
	receiptId: recordId,
});

const address = {
	street: z.string().nullable(),
	city: z.string().nullable(),
	stateProvince: z.string().nullable(),
	postalCode: z.string().nullable(),
	country: z.string().nullable(),
};
export const household = z.strictObject({
	id: householdId,
	name: householdName,
	...address,
	revision,
	memberCount: z.int().min(0),
});
export const householdMember = z.strictObject({
	personId,
	displayName: z.string(),
	role: householdRole,
	revision,
	...address,
});
export const householdResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("none") }),
	z.strictObject({ status: z.literal("available"), household, members: z.array(householdMember).max(100) }),
]);
export const householdsPage = z.strictObject({
	items: z.array(household).max(100),
	next: z.int().min(2).nullable(),
	total: z.int().min(0),
});
export const householdMutationResult = z.strictObject({
	result: householdResult,
	outcome,
	receiptId: recordId,
	updatedPeople: z.int().min(0).optional(),
});

export const photoUploadResult = z.strictObject({ uploadId: recordId, expiresAt: instant });
export const personPhotoResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("absent") }),
	z.strictObject({ status: z.literal("available"), personId, versionId: recordId }),
]);
export const photoMutationResult = z.strictObject({
	photo: personPhotoResult,
	personRevision: revision,
	outcome,
	receiptId: recordId,
});
