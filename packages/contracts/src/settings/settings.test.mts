import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import * as C from "@everyfield/contracts/settings";
import * as N from "@everyfield/contracts/settings/native";
import type {
	SettingsContext,
	SettingsWriteContext,
	NativeSettingsContext,
} from "@everyfield/contracts/settings/server";
import { accountId } from "../common/values.ts";

const id = "10000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000001";
const plant = { kind: "plant", id: other };
const organization = { kind: "organization", id, organizationKind: "sending_church" };
const now = "2026-10-18T16:00:00.000Z";
const command = <T,>(input: T) => ({ requestKey: "settings-save", expectedRevision: "7", input });
const wire = <T,>(schema: z.ZodType<T>, value: unknown): T => schema.parse(JSON.parse(JSON.stringify(value)));
const refuses = (schema: z.ZodType, value: unknown) => assert.throws(() => wire(schema, value), z.ZodError);
const choices = {
	people: true,
	meetings: false,
	tasks: true,
	ministry_teams: true,
	wiki: false,
	activity: false,
	shared_findings: true,
};
const profile = { name: "Grace", street: null, city: "Boston", stateProvince: null, country: null, description: null };
const plantValues = {
	profile,
	timeZone: "America/Chicago",
	inactivity: { warningDays: 14, alertDays: 30 },
	digest: { cadence: "weekly", weekday: 0, hour: 16 },
};

test("AC:TARGET-IDN-010 settings section requests round trip exact subjects and reject caller authority or cross-section fields", () => {
	const rows = [
		{ section: "account" },
		{ section: "notifications" },
		{ section: "plant", plant },
		{ section: "teams", plant, teamId: id },
		{ section: "organization", organization },
		{ section: "affiliations", plant, organization },
	];
	for (const row of rows) {
		assert.deepEqual(wire(C.getSectionRequest, row), row);
		for (const extra of [{ actorId: id }, { purpose: "model" }, { sessionId: "mine" }, { privateCalendar: true }])
			refuses(C.getSectionRequest, { ...row, ...extra });
	}
	for (const row of [
		{ section: "billing" },
		{ section: "plant", plant: organization },
		{ section: "organization", organization: plant },
		{ section: "teams", plant },
		{ section: "account", accountId: other },
	])
		refuses(C.getSectionRequest, row);
	const writes = [
		{ section: "account", name: "Grace" },
		{
			section: "notifications",
			patch: { kind: "channel", choice: { category: "task_due", channel: "email", enabled: false } },
		},
		{ section: "plant", plant, change: { kind: "profile", patch: { city: null } } },
		{ section: "plant", plant, change: { kind: "inactivity", value: { warningDays: 14, alertDays: 30 } } },
		{ section: "plant", plant, change: { kind: "digest", value: { cadence: "off" } } },
		{ section: "teams", plant, teamId: id, name: "Welcome" },
		{ section: "organization", organization, patch: { name: "Grace" } },
		{
			section: "affiliations",
			plant,
			organization,
			relationshipId: id,
			expectedConsentRevision: "8",
			patch: { teams: false },
		},
	];
	for (const row of writes) {
		assert.deepEqual(wire(C.saveSectionRequest, command(row)), command(row));
		refuses(C.saveSectionRequest, { ...command(row), actorId: id });
		refuses(C.saveSectionRequest, command({ ...row, role: "owner" }));
	}
	refuses(C.saveSectionRequest, command({ section: "account", name: "Grace", newPassword: "password123" }));
	refuses(C.saveSectionRequest, command({ section: "plant", plant, change: { kind: "timezone", timeZone: "UTC" } }));
	refuses(C.saveSectionRequest, command({ section: "plant", plant, change: { kind: "profile", patch: {} } }));
	refuses(C.saveSectionRequest, command({ section: "organization", organization, patch: {} }));
	refuses(
		C.saveSectionRequest,
		command({ section: "organization", organization, patch: { organizationKind: "sending_network" } }),
	);
	refuses(
		C.saveSectionRequest,
		command({ section: "affiliations", plant, organization, relationshipId: id, patch: { teams: false } }),
	);
});

test("AC:ORG55-001 affiliation settings map teams/activity and preserve each omitted consent including explicit false", () => {
	const patch = wire(C.affiliationPatch, { teams: false, activityPush: true });
	assert.deepEqual(C.applyAffiliationPatch(choices, patch), {
		people: true,
		meetings: false,
		tasks: true,
		ministry_teams: false,
		wiki: false,
		activity: true,
		shared_findings: true,
	});
	for (const key of ["people", "meetings", "tasks", "wiki", "shared_findings"]) {
		assert.deepEqual(C.applyAffiliationPatch(choices, wire(C.affiliationPatch, { [key]: false })), {
			...choices,
			[key]: false,
		});
	}
	assert.deepEqual(
		C.applyAffiliationPatch(
			choices,
			wire(C.affiliationPatch, {
				people: true,
				meetings: true,
				tasks: false,
				teams: false,
				wiki: true,
				activityPush: true,
				shared_findings: false,
			}),
		),
		{
			people: true,
			meetings: true,
			tasks: false,
			ministry_teams: false,
			wiki: true,
			activity: true,
			shared_findings: false,
		},
	);
	for (const invalid of [
		{},
		{ finance: true },
		{ ministry_teams: true },
		{ activity: true },
		{ teams: null },
		{ teams: "false" },
	])
		refuses(C.affiliationPatch, invalid);
});

test("AC:TARGET-IDN-011 church profile and digest validate independent locality, thresholds and distinct schedules", () => {
	assert.deepEqual(wire(C.plantSettings, plantValues), plantValues);
	assert.deepEqual(
		wire(C.updatePlantProfileRequest, command({ plant, patch: { name: "  Grace  ", street: null, country: null } })),
		command({ plant, patch: { name: "Grace", street: null, country: null } }),
	);
	for (const patch of [
		{},
		{ name: " " },
		{ name: "x".repeat(201) },
		{ street: "x".repeat(501) },
		{ city: "x".repeat(201) },
		{ stateProvince: "x".repeat(201) },
		{ country: "x".repeat(201) },
		{ description: "x".repeat(5001) },
		{ population: 100 },
	])
		refuses(C.updatePlantProfileRequest, command({ plant, patch }));
	for (const bad of [
		{ warningDays: 0, alertDays: 30 },
		{ warningDays: 366, alertDays: 365 },
		{ warningDays: 14, alertDays: 0 },
		{ warningDays: 14, alertDays: 366 },
		{ warningDays: 30, alertDays: 30 },
		{ warningDays: 31, alertDays: 30 },
		{ warningDays: 1.5, alertDays: 30 },
	])
		refuses(C.inactivity, bad);
	for (const schedule of [
		{ cadence: "off" },
		{ cadence: "daily", hour: 9 },
		{ cadence: "weekly", weekday: 6, hour: 23 },
	])
		assert.deepEqual(wire(C.setDigestScheduleRequest, command({ plant, schedule })), command({ plant, schedule }));
	for (const schedule of [
		{ cadence: "off", hour: 9 },
		{ cadence: "daily" },
		{ cadence: "daily", hour: -1 },
		{ cadence: "daily", hour: 24 },
		{ cadence: "weekly", hour: 16, weekday: -1 },
		{ cadence: "weekly", hour: 16, weekday: 7 },
		{ cadence: "weekly", hour: 24, weekday: 0 },
		{ cadence: "weekly", hour: -1, weekday: 0 },
		{ cadence: "monthly", hour: 9 },
	])
		refuses(C.setDigestScheduleRequest, command({ plant, schedule }));
	refuses(C.plantSettings, { ...plantValues, timeZone: "Mars/Base" });
});

test("AC:WP010-IDN-012 notification DTOs contain only registered choices and truthful suppression, with Wiki in-app only", () => {
	const values = {
		choices: [
			{ category: "wiki_upstream_review", channel: "in_app", enabled: true },
			{ category: "planter_digest", channel: "email", enabled: false },
		],
		planterCadence: "weekly",
		oversightCadence: null,
		suppression: "suppressed",
	};
	const section = { section: "notifications", accountId: id, revision: "7", values };
	assert.deepEqual(wire(C.sectionResult, section), section);
	for (const extra of [{ privateCare: true }, { weekId: id }, { nudgeCount: 1 }, { mailbox: "another@example.test" }])
		refuses(C.notificationSettings, { ...values, ...extra });
	for (const choice of [
		{ category: "private_care", channel: "email", enabled: true },
		{ category: "wiki_upstream_review", channel: "email", enabled: true },
		{ category: "task_due", channel: "sms", enabled: true },
	])
		refuses(C.notificationChoice, choice);
	for (const patch of [
		{ kind: "planter_cadence", cadence: "off" },
		{ kind: "oversight_cadence", cadence: "monthly" },
		{ kind: "channel", choice: values.choices[0], cadence: "daily" },
	])
		refuses(C.notificationPatch, patch);
	refuses(C.notificationSettings, { ...values, suppression: "sent" });
});

test("AC:TARGET-IDN-006 private avatars round trip authenticated account/version references and refuse raw keys, URLs and invalid upload sizes", () => {
	const avatar = { accountId: id, versionId: other };
	assert.deepEqual(wire(C.avatarResult, { status: "available", avatar }), { status: "available", avatar });
	refuses(C.avatarResult, { status: "available", avatar, url: "https://storage.example.test/avatar" });
	assert.equal(C.avatarRoute(wire(C.avatarReference, avatar)), `/api/accounts/${id}/avatar/${other}`);
	assert.deepEqual(wire(C.avatarResult, { status: "absent" }), { status: "absent" });
	for (const mime of ["image/jpeg", "image/png", "image/webp"])
		assert.deepEqual(wire(C.requestAvatarUpload, { mime, byteLength: 3145728 }), { mime, byteLength: 3145728 });
	for (const row of [
		{ mime: "image/svg+xml", byteLength: 1 },
		{ mime: "image/gif", byteLength: 1 },
		{ mime: "application/pdf", byteLength: 1 },
		{ mime: "image/png", byteLength: 0 },
		{ mime: "image/png", byteLength: 3145729 },
		{ mime: "image/png", byteLength: 1.5 },
		{ mime: "image/png", byteLength: 1, key: "secret" },
	])
		refuses(C.requestAvatarUpload, row);
	for (const extra of [{ key: "raw" }, { url: "https://storage.example.test/avatar" }, { fileName: "original.png" }])
		refuses(C.avatarReference, { ...avatar, ...extra });
	assert.deepEqual(wire(C.finalizeAvatarRequest, command({ uploadId: id })), command({ uploadId: id }));
	refuses(C.finalizeAvatarRequest, command({ uploadId: id, verifiedMime: "image/png" }));
	refuses(C.finalizeAvatarRequest, command({ uploadId: id, key: "raw-key" }));
	refuses(C.finalizeAvatarRequest, command({ uploadId: id, url: "https://storage.example.test/avatar" }));
	assert.deepEqual(wire(C.removeAvatarRequest, command({})), command({}));
	refuses(C.removeAvatarRequest, command({ accountId: other }));
	assert.deepEqual(wire(C.getAvatarRequest, { versionId: id }), { versionId: id });
	refuses(C.getAvatarRequest, { versionId: id, key: "raw" });
});

test("AC:TARGET-IDN-007 AC:TARGET-IDN-008 native credential boundaries preserve truthful provider outcomes without account/session overrides", () => {
	assert.deepEqual(wire(N.requestEmailChange, { newEmail: "  NEW@Example.test  " }), { newEmail: "new@example.test" });
	refuses(N.requestEmailChange, { newEmail: "bad" });
	refuses(N.requestEmailChange, { newEmail: "new@example.test", accountId: other });
	assert.deepEqual(wire(N.confirmEmailChange, { proof: "fresh-proof" }), { proof: "fresh-proof" });
	for (const proof of ["", "x".repeat(4097)]) refuses(N.confirmEmailChange, { proof });
	const change = { currentPassword: "old-password", newPassword: "new-password", confirmPassword: "new-password" };
	assert.deepEqual(wire(N.changePasswordRequest, change), change);
	for (const invalid of [
		{ ...change, confirmPassword: "different" },
		{ ...change, newPassword: "short", confirmPassword: "short" },
		{ ...change, newPassword: "x".repeat(1025), confirmPassword: "x".repeat(1025) },
		{ ...change, currentPassword: "" },
		{ ...change, revokeOtherSessions: false },
		{ ...change, sessionId: "foreign" },
	])
		refuses(N.changePasswordRequest, invalid);
	const succeeded = {
		status: "succeeded",
		correlationId: id,
		accountId: id,
		action: "email_changed",
		reporting: { status: "pending_investigation" },
	};
	assert.deepEqual(wire(N.credentialOutcome, succeeded), succeeded);
	for (const status of ["refused", "unknown"]) {
		const value = { status, correlationId: id };
		assert.deepEqual(wire(N.credentialOutcome, value), value);
		refuses(N.credentialOutcome, { ...value, eventId: id });
	}
	refuses(N.credentialOutcome, { ...succeeded, proof: "secret" });
});

const deletion = {
	subject: { kind: "account", id },
	requestId: other,
	revision: "8",
	requestedAt: now,
	cancelUntil: "2026-11-17T16:00:00.000Z",
};
test("AC:TARGET-IDN-032 AC:WP010-KNOW-072 deletion states require exact elapsed deadlines and coherent completion, never partial purge success", () => {
	for (const status of ["pending_deletion", "purging"]) {
		const value = { status, ...deletion };
		assert.deepEqual(wire(N.deletionStatus, value), value);
		refuses(N.deletionStatus, { ...value, livePurgedAt: now });
	}
	const purged = {
		status: "purged",
		...deletion,
		livePurgedAt: "2026-11-18T16:00:00.000Z",
		copyExpiresAt: "2026-11-25T16:00:00.000Z",
	};
	assert.deepEqual(wire(N.deletionStatus, purged), purged);
	refuses(N.deletionStatus, {
		...purged,
		livePurgedAt: "2026-11-17T15:59:59.999Z",
		copyExpiresAt: "2026-11-18T15:59:59.999Z",
	});
	refuses(N.deletionStatus, { ...purged, copyExpiresAt: "2026-11-18T15:59:59.999Z" });
	refuses(N.deletionStatus, { ...purged, copyExpiresAt: "2026-11-25T16:00:00.001Z" });
	refuses(N.deletionStatus, { ...purged, copyExpiresAt: undefined });
	for (const cancelUntil of ["2026-11-17T15:59:59.999Z", "2026-11-17T16:00:00.001Z"])
		refuses(N.deletionStatus, { status: "pending_deletion", ...deletion, cancelUntil });
	refuses(N.deletionSubject, organization);
	assert.deepEqual(wire(N.deletionSubject, plant), plant);
});

test("AC:DEL58-002 AC:WP010-KNOW-073 cancellation is strictly before deadline and cannot target an organization or select a new request", () => {
	const cancelled = { status: "cancelled", ...deletion, cancelledAt: "2026-11-17T15:59:59.999Z" };
	assert.deepEqual(wire(N.deletionStatus, cancelled), cancelled);
	for (const cancelledAt of ["2026-10-18T15:59:59.999Z", deletion.cancelUntil, "2026-11-17T16:00:00.001Z"])
		refuses(N.deletionStatus, { ...cancelled, cancelledAt });
	const statusRequest = { subject: deletion.subject, requestId: other };
	const workspaceRequest = { subject: plant, requestId: other };
	assert.deepEqual(wire(N.getWorkspaceDeletionStatusRequest, workspaceRequest), workspaceRequest);
	assert.deepEqual(wire(N.cancelWorkspaceDeletionRequest, command(workspaceRequest)), command(workspaceRequest));
	refuses(N.getAccountDeletionStatusRequest, workspaceRequest);
	refuses(N.cancelAccountDeletionRequest, command(workspaceRequest));
	refuses(N.getWorkspaceDeletionStatusRequest, statusRequest);
	refuses(N.cancelWorkspaceDeletionRequest, command(statusRequest));
	assert.deepEqual(wire(N.getAccountDeletionStatusRequest, statusRequest), statusRequest);
	assert.deepEqual(wire(N.cancelAccountDeletionRequest, command(statusRequest)), command(statusRequest));
	refuses(N.cancelAccountDeletionRequest, command({ ...statusRequest, now: "2026-11-01T00:00:00Z" }));
	refuses(N.cancelAccountDeletionRequest, command({ ...statusRequest, restoreAffiliations: true }));
	assert.deepEqual(wire(C.requestAccountDeletion, command({ confirmed: true })), command({ confirmed: true }));
	refuses(C.requestAccountDeletion, command({ confirmed: false }));
	refuses(C.requestAccountDeletion, command({ confirmed: true, accountId: other }));
	assert.deepEqual(
		wire(C.requestWorkspaceDeletion, command({ plant, confirmed: true })),
		command({ plant, confirmed: true }),
	);
	refuses(C.requestWorkspaceDeletion, command({ plant: organization, confirmed: true }));
	refuses(C.requestWorkspaceDeletion, command({ plant, confirmed: false }));
});

test("AC:B03-017 future timezone previews bind expected revision and expire without exposing private calendar data", () => {
	const preview = {
		previewId: id,
		plant,
		expectedRevision: "7",
		asOf: now,
		expiresAt: "2026-10-18T16:15:00.000Z",
		oldZone: "America/Chicago",
		newZone: "Pacific/Auckland",
		meetings: [],
		digests: [],
		reminders: [],
		preservedTaskDates: [{ id, date: "2026-11-01" }],
		completeness: "complete",
		warnings: [],
	};
	assert.deepEqual(wire(C.plantTimezonePreview, preview), preview);
	for (const expiresAt of [now, "2026-10-18T15:59:59.999Z"]) refuses(C.plantTimezonePreview, { ...preview, expiresAt });
	refuses(C.plantTimezonePreview, { ...preview, weekId: other });
	assert.deepEqual(
		wire(C.setPlantTimezoneRequest, command({ plant, timeZone: "Pacific/Auckland", previewId: id })),
		command({ plant, timeZone: "Pacific/Auckland", previewId: id }),
	);
	refuses(C.setPlantTimezoneRequest, command({ plant, timeZone: "Pacific/Auckland" }));
	const nativePreview = {
		previewId: id,
		preference: { status: "unconfirmed" },
		expectedRevision: "0",
		newZone: "Pacific/Auckland",
		asOf: now,
		expiresAt: "2026-10-18T16:15:00.000Z",
	};
	assert.deepEqual(wire(N.personalTimezonePreview, nativePreview), nativePreview);
	refuses(N.personalTimezonePreview, { ...nativePreview, expiresAt: now });
	refuses(N.personalTimezonePreview, { ...nativePreview, expiresAt: "2026-10-18T15:59:59.999Z" });
	refuses(N.personalTimezonePreview, { ...nativePreview, privateCalendarExists: false });
	assert.deepEqual(
		wire(N.setPersonalTimezoneRequest, command({ timeZone: "UTC", previewId: id, confirmed: true })),
		command({ timeZone: "UTC", previewId: id, confirmed: true }),
	);
	refuses(N.setPersonalTimezoneRequest, command({ timeZone: "UTC", previewId: id, confirmed: false }));
	refuses(
		N.setPersonalTimezoneRequest,
		command({ timeZone: "UTC", previewId: id, confirmed: true, calendarRevision: "7" }),
	);
	refuses(C.timezonePreference, { status: "confirmed" });
	refuses(C.timezonePreference, { status: "unconfirmed", timeZone: "UTC" });
});

test("INV-settings-native: model entry point excludes native secrets and private or restricted metadata", () => {
	for (const key of [
		"requestEmailChange",
		"confirmEmailChange",
		"changePasswordRequest",
		"deletionStatus",
		"getAccountDeletionStatusRequest",
		"getWorkspaceDeletionStatusRequest",
		"cancelAccountDeletionRequest",
		"cancelWorkspaceDeletionRequest",
		"personalTimezonePreview",
		"setPersonalTimezoneRequest",
	])
		assert.equal(key in C, false, key);
	const account = {
		section: "account",
		accountId: id,
		revision: "7",
		name: "Grace",
		email: "grace@example.test",
		avatar: { status: "absent" },
		personalTimezone: { status: "unconfirmed" },
	};
	assert.deepEqual(wire(C.sectionResult, account), account);
	const confirmed = { ...account, personalTimezone: { status: "confirmed", timeZone: "UTC", revision: "1" } };
	assert.deepEqual(wire(C.sectionResult, confirmed), confirmed);
	for (const extra of [
		{ privateCalendarExists: false },
		{ password: "secret" },
		{ deletionStatus: "pending_deletion" },
	])
		refuses(C.sectionResult, { ...account, ...extra });
});

// Compile-time refusal fixtures are deliberately unreachable at runtime.
function contextTypes(
	native: NativeSettingsContext,
	write: SettingsWriteContext,
	restricted: N.RestrictedDeletionContext,
) {
	const context: SettingsContext = native;
	// @ts-expect-error restricted deletion identity has no ordinary settings authority
	const ordinary: SettingsContext = restricted;
	// @ts-expect-error model purpose cannot claim native write origin
	const forged: SettingsWriteContext = { ...native, purpose: "model", origin: { kind: "native" } };
	// @ts-expect-error a model write cannot be used as a native account context
	const nativeOnly: NativeSettingsContext = write;
	// @ts-expect-error account identifiers cannot select a server session
	const wrongSession: SettingsContext = { ...native, session: accountId.parse(id) };
	const workspaceDeletion = N.getWorkspaceDeletionStatusRequest.parse({ subject: plant, requestId: other });
	// @ts-expect-error workspace deletion cannot be passed to the account deletion operation
	const accountDeletion: z.infer<typeof N.getAccountDeletionStatusRequest> = workspaceDeletion;
	return { context, ordinary, forged, nativeOnly, wrongSession, accountDeletion };
}
void contextTypes;

test("AC:WP010-KNOW-069 shared retained facts keep actual church ownership and minimal removed attribution", () => {
	const history = { owner: plant, attribution: { kind: "removed_account" } };
	assert.deepEqual(wire(N.retainedHistoryReference, history), history);
	refuses(N.retainedHistoryReference, { owner: { kind: "account", id }, attribution: { kind: "removed_account" } });
	refuses(N.retainedHistoryReference, {
		...history,
		attribution: { kind: "removed_account", email: "old@example.test" },
	});
});

test("INV-settings-receipt: saved sections bind receipt to exact owner and never return organization consent or unavailable success", () => {
	const receipt = {
		id,
		request: {
			owner: { kind: "account", id },
			actorId: id,
			operation: "settings.saveSection",
			requestKey: "settings-save",
			digest: "a".repeat(64),
			origin: { kind: "native" },
		},
		completedAt: now,
		outcome: "changed",
		subjects: [],
		eventIds: [id],
		effectIds: [],
	};
	const sections = [
		{
			current: {
				section: "account",
				accountId: id,
				revision: "7",
				name: "Grace",
				email: "grace@example.test",
				avatar: { status: "absent" },
				personalTimezone: { status: "unconfirmed" },
			},
			owner: { kind: "account", id },
		},
		{
			current: {
				section: "notifications",
				accountId: id,
				revision: "7",
				values: { choices: [], planterCadence: null, oversightCadence: null, suppression: "clear" },
			},
			owner: { kind: "account", id },
		},
		{ current: { section: "plant", plant, revision: "7", values: plantValues }, owner: plant },
		{ current: { section: "teams", plant, teamId: id, revision: "7", name: "Welcome" }, owner: plant },
		{
			current: {
				section: "organization",
				values: {
					status: "available",
					organization,
					revision: "7",
					profile: {
						name: "Sending",
						city: null,
						stateProvince: null,
						country: null,
						description: null,
						contactEmail: null,
						contactPhone: null,
					},
					timeZone: "America/Chicago",
				},
			},
			owner: organization,
		},
		{
			current: {
				section: "affiliations",
				values: {
					view: "plant_administration",
					plant,
					organization,
					organizationDisplayName: "Sending",
					activeAffiliation: true,
					consentRevision: "7",
					choices,
				},
			},
			owner: plant,
		},
	];
	for (const { current, owner } of sections) {
		const value = { current, receipt: { ...receipt, request: { ...receipt.request, owner } } };
		assert.deepEqual(wire(C.savedSectionResult, value), value);
		refuses(C.savedSectionResult, {
			...value,
			receipt: { ...value.receipt, request: { ...value.receipt.request, owner: { kind: "account", id: other } } },
		});
	}
	refuses(C.savedSectionResult, { receipt, current: { section: "organization", values: { status: "unavailable" } } });
	refuses(C.savedSectionResult, {
		receipt: { ...receipt, request: { ...receipt.request, owner: plant } },
		current: {
			section: "affiliations",
			values: {
				view: "organization",
				plant,
				organization,
				organizationDisplayName: "Sending",
				activeAffiliation: true,
				availability: choices,
			},
		},
	});
});

test("INV-settings-bounds: bounded timezone and notification projections refuse oversized payloads", () => {
	const change = { id, before: "2026-11-01T16:00:00.000Z", after: "2026-11-01T17:00:00.000Z" };
	const preview = {
		previewId: id,
		plant,
		expectedRevision: "7",
		asOf: now,
		expiresAt: "2026-10-18T16:15:00.000Z",
		oldZone: "America/Chicago",
		newZone: "Pacific/Auckland",
		meetings: [change],
		digests: [change],
		reminders: [change],
		preservedTaskDates: [{ id, date: "2026-11-01" }],
		completeness: "complete",
		warnings: ["dst_fold_earlier"],
	};
	assert.deepEqual(wire(C.plantTimezonePreview, preview), preview);
	for (const field of ["meetings", "digests", "reminders"])
		refuses(C.plantTimezonePreview, { ...preview, [field]: Array(101).fill(change) });
	refuses(C.plantTimezonePreview, { ...preview, preservedTaskDates: Array(101).fill({ id, date: "2026-11-01" }) });
	refuses(C.plantTimezonePreview, { ...preview, warnings: Array(4).fill("dst_fold_earlier") });
	const values = {
		choices: [{ category: "task_due", channel: "email", enabled: true }],
		planterCadence: "daily",
		oversightCadence: "weekly",
		suppression: "clear",
	};
	assert.deepEqual(wire(C.notificationSettings, values), values);
	const pairs = [
		"task_due",
		"task_overdue",
		"meeting_announcement",
		"meeting_reminder",
		"planter_digest",
		"oversight_digest",
		"relationship_milestone",
		"sharing_milestone",
		"phase_milestone",
		"launch_milestone",
	].flatMap((category) => [
		{ category, channel: "email", enabled: true },
		{ category, channel: "in_app", enabled: true },
	]);
	pairs.push({ category: "wiki_upstream_review", channel: "in_app", enabled: true });
	assert.deepEqual(wire(C.notificationSettings, { ...values, choices: pairs }), { ...values, choices: pairs });
	refuses(C.notificationSettings, {
		...values,
		choices: [...pairs, { category: "task_due", channel: "email", enabled: false }],
	});
	refuses(C.notificationSettings, {
		...values,
		choices: [
			{ category: "task_due", channel: "email", enabled: true },
			{ category: "task_due", channel: "email", enabled: false },
		],
	});
});

test("AC:B03-017 changed timezone requires a committed replan intent and no-op cannot claim another replan", () => {
	const receipt = {
		id,
		request: {
			owner: plant,
			actorId: id,
			operation: "plant.setTimezone",
			requestKey: "settings-save",
			digest: "a".repeat(64),
			origin: { kind: "native" },
		},
		completedAt: now,
		outcome: "changed",
		subjects: [],
		eventIds: [id],
		effectIds: [other],
	};
	const changed = {
		status: "changed",
		plant,
		timeZone: "Pacific/Auckland",
		revision: "8",
		replanIntentId: id,
		receipt,
	};
	assert.deepEqual(wire(C.plantTimezoneResult, changed), changed);
	refuses(C.plantTimezoneResult, { ...changed, replanIntentId: null });
	refuses(C.plantTimezoneResult, { ...changed, replanIntentId: undefined });
	refuses(C.plantTimezoneResult, { ...changed, receipt: { ...receipt, outcome: "unknown" } });
	const noop = {
		status: "noop",
		plant,
		timeZone: "Pacific/Auckland",
		revision: "8",
		receipt: { ...receipt, outcome: "noop" },
	};
	assert.deepEqual(wire(C.plantTimezoneResult, noop), noop);
	refuses(C.plantTimezoneResult, { ...noop, replanIntentId: id });
});

test("INV-settings-timezone: a saved personal timezone always carries a confirmed zone and revision", () => {
	const saved = { preference: { status: "confirmed", timeZone: "America/Chicago", revision: "8" } };
	assert.deepEqual(wire(N.personalTimezoneResult, saved), saved);
	refuses(N.personalTimezoneResult, { preference: { status: "unconfirmed" } });
});
