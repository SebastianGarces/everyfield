import * as S from "@everyfield/contracts/settings";
import * as N from "@everyfield/contracts/settings/native";
import type { z } from "zod";
import type {
	DeletionPort,
	DeletionStatus,
	Relationship,
	Reply,
	SectionResult,
	SettingsError,
	SettingsPort,
	SettingsViewer,
	TimezonePreference,
} from "../port";

// The fixture API for the design preview (WP-010/ui R4). It keeps per-persona state in memory and answers like the
// contract says: every reply goes through the contract schema, so a fixture that drifts from the contract throws.
// Faults let the preview and the browser tests make the next call of one operation fail in a chosen way.

export type PreviewPersona = "owner" | "admin" | "member" | "network";
export const PERSONAS: readonly PreviewPersona[] = ["owner", "admin", "member", "network"];
export const PERSONA_LABEL: Record<PreviewPersona, string> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
	network: "Network admin",
};
export function parsePersona(value: string | null | undefined): PreviewPersona {
	return (PERSONAS as readonly string[]).includes(value ?? "") ? (value as PreviewPersona) : "owner";
}

const uuid = (n: number, group = 1) =>
	`${String(group).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PLANT = { kind: "plant" as const, id: uuid(1, 2) };
const NETWORK = { kind: "organization" as const, id: uuid(2, 2), organizationKind: "sending_network" as const };
const SENDING = { kind: "organization" as const, id: uuid(3, 2), organizationKind: "sending_church" as const };
const ACCOUNT: Record<PreviewPersona, string> = { owner: uuid(1), admin: uuid(2), member: uuid(3), network: uuid(4) };
const PEOPLE: Record<PreviewPersona, { name: string; email: string }> = {
	owner: { name: "Daniel Reyes", email: "daniel@harvestpoint.org" },
	admin: { name: "Ana Lee", email: "ana@harvestpoint.org" },
	member: { name: "Tom Baker", email: "tom@harvestpoint.org" },
	network: { name: "Rachel Kim", email: "rachel@austinsending.org" },
};

export function previewViewer(persona: PreviewPersona): SettingsViewer {
	if (persona === "network")
		return {
			context: "organization",
			accountId: ACCOUNT.network,
			organization: NETWORK,
			role: "admin",
		};
	return {
		context: "plant",
		accountId: ACCOUNT[persona],
		plant: PLANT,
		role: persona,
	};
}

export const PREVIEW_RELATIONSHIPS: Relationship[] = [
	{ relationshipId: uuid(10, 3), revision: "4", organization: NETWORK, organizationName: "Austin Sending Network" },
	{ relationshipId: uuid(11, 3), revision: "2", organization: SENDING, organizationName: "Grace Fellowship" },
];

export type Operation =
	| "getSection"
	| "saveSection"
	| "previewPlantTimezone"
	| "setPlantTimezone"
	| "finalizeAvatar"
	| "requestEmailChange"
	| "changePassword"
	| "setPersonalTimezone"
	| "requestAccountDeletion"
	| "requestWorkspaceDeletion"
	| "getStatus"
	| "cancel";
export type Fault = SettingsError["code"] | "offline";

type Store = {
	sections: Map<string, SectionResult>;
	personalZone: TimezonePreference;
	previews: Map<string, { zone: string; expiresAt: number }>;
	avatars: Map<string, string>;
	staged: Map<string, Blob>;
};

const nowIso = (ms: number) => new Date(ms).toISOString();
let counter = 100;
const nextId = () => uuid(++counter, 9);

function initialSections(persona: PreviewPersona): Map<string, SectionResult> {
	const account = ACCOUNT[persona];
	const rows: SectionResult[] = [
		S.sectionResult.parse({
			section: "account",
			accountId: account,
			revision: "3",
			name: PEOPLE[persona].name,
			email: PEOPLE[persona].email,
			avatar: { status: "absent" },
		}),
		S.sectionResult.parse({
			section: "notifications",
			accountId: account,
			revision: "5",
			values: {
				choices:
					persona === "network"
						? [
								{ category: "oversight_digest", channel: "email", enabled: true },
								{ category: "oversight_digest", channel: "in_app", enabled: true },
								{ category: "relationship_milestone", channel: "email", enabled: true },
								{ category: "relationship_milestone", channel: "in_app", enabled: true },
								{ category: "sharing_milestone", channel: "in_app", enabled: true },
								{ category: "sharing_milestone", channel: "email", enabled: false },
								{ category: "phase_milestone", channel: "in_app", enabled: true },
								{ category: "phase_milestone", channel: "email", enabled: false },
							]
						: [
								{ category: "task_due", channel: "in_app", enabled: true },
								{ category: "task_due", channel: "email", enabled: true },
								{ category: "task_overdue", channel: "in_app", enabled: true },
								{ category: "task_overdue", channel: "email", enabled: true },
								{ category: "meeting_reminder", channel: "in_app", enabled: true },
								{ category: "meeting_reminder", channel: "email", enabled: true },
								{ category: "meeting_announcement", channel: "in_app", enabled: true },
								{ category: "meeting_announcement", channel: "email", enabled: false },
								{ category: "planter_digest", channel: "in_app", enabled: true },
								{ category: "planter_digest", channel: "email", enabled: true },
								{ category: "launch_milestone", channel: "in_app", enabled: true },
								{ category: "launch_milestone", channel: "email", enabled: true },
								{ category: "wiki_upstream_review", channel: "in_app", enabled: false },
							],
				planterCadence: persona === "network" ? null : "weekly",
				oversightCadence: persona === "network" ? "daily" : null,
				suppression: persona === "owner" ? "suppressed" : "clear",
			},
		}),
	];
	if (persona !== "network") {
		rows.push(
			S.sectionResult.parse({
				section: "plant",
				plant: PLANT,
				revision: "7",
				values: {
					profile: {
						name: "Harvest Point Church",
						street: "4100 Duval St",
						city: "Austin",
						stateProvince: "Texas",
						country: "United States",
						description: null,
					},
					timeZone: "America/Chicago",
					inactivity: { warningDays: 14, alertDays: 30 },
					digest: { cadence: "weekly", weekday: 0, hour: 16 },
				},
			}),
		);
		const admin = persona !== "member";
		for (const [r, choices] of [
			[
				PREVIEW_RELATIONSHIPS[0]!,
				{
					people: false,
					meetings: true,
					tasks: false,
					ministry_teams: false,
					wiki: true,
					activity: true,
					shared_findings: false,
				},
			],
			[
				PREVIEW_RELATIONSHIPS[1]!,
				{
					people: true,
					meetings: true,
					tasks: true,
					ministry_teams: true,
					wiki: true,
					activity: false,
					shared_findings: true,
				},
			],
		] as const) {
			const info = {
				plant: PLANT,
				organization: r.organization,
				organizationDisplayName: r.organizationName,
				activeAffiliation: true,
			};
			rows.push(
				S.sectionResult.parse({
					section: "affiliations",
					values: admin
						? { view: "plant_administration", ...info, consentRevision: "7", choices }
						: { view: "plant_member", ...info },
				}),
			);
		}
	} else {
		rows.push(
			S.sectionResult.parse({
				section: "organization",
				values: {
					status: "available",
					organization: NETWORK,
					revision: "9",
					profile: {
						name: "Austin Sending Network",
						city: "Austin",
						stateProvince: "Texas",
						country: "United States",
						description: "We send and support new churches across Central Texas.",
						contactEmail: "office@austinsending.org",
						contactPhone: null,
					},
					timeZone: "America/Chicago",
				},
			}),
		);
	}
	return new Map(rows.map((row) => [keyOf(row), row]));
}

function keyOf(row: SectionResult | z.input<typeof S.getSectionRequest>): string {
	switch (row.section) {
		case "account":
		case "notifications":
			return row.section;
		case "plant":
			return "plant";
		case "teams":
			return `teams:${row.teamId}`;
		case "organization":
			return "organization";
		case "affiliations":
			return `affiliations:${"values" in row && "organization" in row.values ? row.values.organization.id : (row as { organization: { id: string } }).organization.id}`;
	}
}

export type FixtureControls = {
	/** Make the next call of `op` fail with `fault`. */
	failNext: (op: Operation, fault: Fault) => void;
	/** How many times each operation was called, for the preview dock and the tests. */
	calls: Record<string, number>;
	onChange: (listener: () => void) => () => void;
};

/** A fixture port for one persona. `delay` is the reply time in milliseconds. */
export function createFixturePort(
	persona: PreviewPersona,
	{ delay = 450, now = () => Date.now() }: { delay?: number; now?: () => number } = {},
): { port: SettingsPort; controls: FixtureControls } {
	const store: Store = {
		sections: initialSections(persona),
		personalZone:
			persona === "owner"
				? ({ status: "confirmed", timeZone: "America/Chicago", revision: "2" } as TimezonePreference)
				: ({ status: "unconfirmed" } as TimezonePreference),
		previews: new Map(),
		avatars: new Map(),
		staged: new Map(),
	};
	const faults = new Map<Operation, Fault>();
	const calls: Record<string, number> = {};
	const listeners = new Set<() => void>();

	const wait = (ms = delay) => new Promise((r) => setTimeout(r, ms));
	const refuse = (code: SettingsError["code"]): { status: "refused"; error: SettingsError } => ({
		status: "refused",
		error: S.settingsError.parse({
			code,
			details: {},
			correlationId: nextId(),
			retry:
				code === "conflict" || code === "stale_preview"
					? "refresh"
					: code === "temporary"
						? "same_request"
						: code === "unknown"
							? "reconcile"
							: "never",
		}),
	});
	/** Counts the call, waits, then applies a queued fault. A thrown "offline" fault looks like a lost connection. */
	async function enter(op: Operation): Promise<{ status: "refused"; error: SettingsError } | null> {
		calls[op] = (calls[op] ?? 0) + 1;
		listeners.forEach((l) => l());
		await wait();
		const fault = faults.get(op);
		if (!fault) return null;
		faults.delete(op);
		listeners.forEach((l) => l());
		if (fault === "offline") throw new TypeError("Failed to fetch");
		return refuse(fault);
	}
	const ok = <T>(schema: z.ZodType<T>, value: unknown): Reply<T> => ({ status: "ok", value: schema.parse(value) });

	const bump = (revision: string) => String(BigInt(revision) + 1n);
	const canAdminPlant = persona === "owner" || persona === "admin";

	const port: SettingsPort = {
		async getSection(request) {
			const fault = await enter("getSection");
			if (fault) return fault;
			S.getSectionRequest.parse(request);
			if (request.section === "plant" && !canAdminPlant) return refuse("access_denied");
			const row = store.sections.get(keyOf(request));
			return row ? ok(S.sectionResult, row) : refuse("access_denied");
		},
		async saveSection(raw) {
			const fault = await enter("saveSection");
			if (fault) return fault;
			const request = S.saveSectionRequest.parse(raw);
			const input = request.input;
			const key = keyOf(input as z.input<typeof S.getSectionRequest>);
			const row = store.sections.get(key);
			if (!row) return refuse("access_denied");
			if ((input.section === "plant" || input.section === "teams") && !canAdminPlant) return refuse("access_denied");
			let next: SectionResult;
			switch (input.section) {
				case "account": {
					if (row.section !== "account") return refuse("invalid_input");
					if (row.revision !== request.expectedRevision) return refuse("conflict");
					next = { ...row, name: input.name, revision: bump(row.revision) as typeof row.revision };
					break;
				}
				case "notifications": {
					if (row.section !== "notifications") return refuse("invalid_input");
					if (row.revision !== request.expectedRevision) return refuse("conflict");
					const p = input.patch;
					const values =
						p.kind === "channel"
							? {
									...row.values,
									choices: row.values.choices.map((c) =>
										c.category === p.choice.category && c.channel === p.choice.channel ? p.choice : c,
									),
								}
							: p.kind === "planter_cadence"
								? { ...row.values, planterCadence: p.cadence }
								: { ...row.values, oversightCadence: p.cadence };
					next = { ...row, values, revision: bump(row.revision) as typeof row.revision };
					break;
				}
				case "plant": {
					if (row.section !== "plant") return refuse("invalid_input");
					if (row.revision !== request.expectedRevision) return refuse("conflict");
					const c = input.change;
					const values =
						c.kind === "profile"
							? { ...row.values, profile: { ...row.values.profile, ...c.patch } }
							: c.kind === "inactivity"
								? { ...row.values, inactivity: c.value }
								: { ...row.values, digest: c.value };
					next = { ...row, values, revision: bump(row.revision) as typeof row.revision };
					break;
				}
				case "organization": {
					if (row.section !== "organization" || row.values.status !== "available") return refuse("access_denied");
					if (row.values.revision !== request.expectedRevision) return refuse("conflict");
					next = {
						...row,
						values: {
							...row.values,
							profile: { ...row.values.profile, ...input.patch },
							revision: bump(row.values.revision) as typeof row.values.revision,
						},
					};
					break;
				}
				case "affiliations": {
					if (row.section !== "affiliations" || "status" in row.values || row.values.view !== "plant_administration")
						return refuse("access_denied");
					const rel = PREVIEW_RELATIONSHIPS.find((r) => r.relationshipId === input.relationshipId);
					if (!rel || rel.revision !== request.expectedRevision) return refuse("conflict");
					if (row.values.consentRevision !== input.expectedConsentRevision) return refuse("conflict");
					next = {
						...row,
						values: {
							...row.values,
							consentRevision: bump(row.values.consentRevision) as typeof row.values.consentRevision,
							choices: S.applyAffiliationPatch(row.values.choices, input.patch),
						},
					};
					break;
				}
				case "teams":
					return refuse("unavailable");
			}
			store.sections.set(key, next);
			return ok(S.savedSectionResult, {
				current: next,
			});
		},
		async previewPlantTimezone(request) {
			const fault = await enter("previewPlantTimezone");
			if (fault) return fault;
			const row = store.sections.get("plant");
			if (!row || row.section !== "plant" || !canAdminPlant) return refuse("access_denied");
			const previewId = nextId();
			const at = now();
			store.previews.set(previewId, { zone: request.timeZone, expiresAt: at + 10 * 60_000 });
			const shift = (base: number) => {
				const offset = (zone: string, ms: number) => {
					const local = new Date(new Date(ms).toLocaleString("en-US", { timeZone: zone }));
					const utc = new Date(new Date(ms).toLocaleString("en-US", { timeZone: "UTC" }));
					return local.getTime() - utc.getTime();
				};
				return base + offset(row.values.timeZone, base) - offset(request.timeZone, base);
			};
			const day = 86_400_000;
			const slots = (count: number, start: number) =>
				Array.from({ length: count }, (_, i) => {
					const before = Math.floor((at + start + i * 7 * day) / 3_600_000) * 3_600_000;
					return { id: nextId(), before: nowIso(before), after: nowIso(shift(before)) };
				});
			return ok(S.plantTimezonePreview, {
				previewId,
				plant: PLANT,
				expectedRevision: row.revision,
				asOf: nowIso(at),
				expiresAt: nowIso(at + 10 * 60_000),
				oldZone: row.values.timeZone,
				newZone: request.timeZone,
				meetings: slots(3, 2 * day),
				digests: slots(2, 4 * day),
				reminders: slots(2, day),
				preservedTaskDates: [
					{ id: nextId(), date: new Date(at + 6 * day).toISOString().slice(0, 10) },
					{ id: nextId(), date: new Date(at + 13 * day).toISOString().slice(0, 10) },
				],
				completeness: "complete",
				warnings: [],
			});
		},
		async setPlantTimezone(raw) {
			const fault = await enter("setPlantTimezone");
			if (fault) return fault;
			const request = S.setPlantTimezoneRequest.parse(raw);
			const row = store.sections.get("plant");
			if (!row || row.section !== "plant") return refuse("access_denied");
			const preview = store.previews.get(request.input.previewId);
			if (!preview || preview.zone !== request.input.timeZone || preview.expiresAt <= now())
				return refuse("stale_preview");
			if (row.revision !== request.expectedRevision) return refuse("conflict");
			const revision = bump(row.revision);
			store.sections.set("plant", {
				...row,
				revision: revision as typeof row.revision,
				values: { ...row.values, timeZone: request.input.timeZone },
			});
			return ok(S.plantTimezoneResult, {
				status: "changed",
				plant: PLANT,
				timeZone: request.input.timeZone,
				revision,
				replanIntentId: nextId(),
			});
		},
		flows: {
			async requestAvatarUpload(request) {
				await wait(150);
				S.requestAvatarUpload.parse(request);
				return ok(S.avatarUploadResult, { uploadId: nextId(), expiresAt: nowIso(now() + 15 * 60_000) });
			},
			async uploadAvatarBytes(uploadId, file) {
				await wait(300);
				store.staged.set(uploadId, file);
				return { status: "ok", value: null };
			},
			async finalizeAvatar(raw) {
				const fault = await enter("finalizeAvatar");
				if (fault) return fault;
				const request = S.finalizeAvatarRequest.parse(raw);
				const bytes = store.staged.get(request.input.uploadId);
				const row = store.sections.get("account");
				if (!bytes || !row || row.section !== "account") return refuse("invalid_input");
				const versionId = nextId();
				store.avatars.set(versionId, URL.createObjectURL(bytes));
				const avatar = S.avatarResult.parse({
					status: "available",
					avatar: { accountId: ACCOUNT[persona], versionId },
				});
				store.sections.set("account", { ...row, avatar, revision: bump(row.revision) as typeof row.revision });
				return { status: "ok", value: avatar };
			},
			async removeAvatar(raw) {
				await wait();
				S.removeAvatarRequest.parse(raw);
				const row = store.sections.get("account");
				if (!row || row.section !== "account") return refuse("invalid_input");
				const avatar = S.avatarResult.parse({ status: "absent" });
				store.sections.set("account", { ...row, avatar, revision: bump(row.revision) as typeof row.revision });
				return { status: "ok", value: avatar };
			},
			avatarSrc(avatar) {
				return store.avatars.get(avatar.versionId) ?? S.avatarRoute(avatar);
			},
			async requestEmailChange(request) {
				const fault = await enter("requestEmailChange");
				if (fault) return fault;
				N.requestEmailChange.parse(request);
				return { status: "ok", value: { status: "verification_requested" } };
			},
			async confirmEmailChange(request) {
				await wait();
				N.confirmEmailChange.parse(request);
				const correlationId = nextId();
				if (request.proof === "valid")
					return N.credentialOutcome.parse({
						status: "succeeded",
						correlationId,
						accountId: ACCOUNT[persona],
						action: "email_changed",
						reporting: { status: "recorded", eventId: nextId(), mailIntentId: nextId() },
					});
				return N.credentialOutcome.parse({
					status: request.proof === "unknown" ? "unknown" : "refused",
					correlationId,
				});
			},
			async changePassword(request) {
				const fault = await enter("changePassword");
				const correlationId = nextId();
				if (fault)
					return N.credentialOutcome.parse({
						status: fault.error.code === "unknown" ? "unknown" : "refused",
						correlationId,
					});
				N.changePasswordRequest.parse(request);
				if (request.currentPassword !== "correct horse" || request.newPassword === request.currentPassword)
					return N.credentialOutcome.parse({ status: "refused", correlationId });
				return N.credentialOutcome.parse({
					status: "succeeded",
					correlationId,
					accountId: ACCOUNT[persona],
					action: "password_changed",
					reporting: { status: "recorded", eventId: nextId(), mailIntentId: nextId() },
				});
			},
			async getPersonalTimezone() {
				await wait(200);
				return ok(S.timezonePreference, store.personalZone);
			},
			async previewPersonalTimezone(request) {
				await wait(250);
				N.previewPersonalTimezoneRequest.parse(request);
				const previewId = nextId();
				const at = now();
				store.previews.set(previewId, { zone: request.timeZone, expiresAt: at + 10 * 60_000 });
				return ok(N.personalTimezonePreview, {
					previewId,
					preference: store.personalZone,
					expectedRevision: store.personalZone.status === "confirmed" ? store.personalZone.revision : "0",
					newZone: request.timeZone,
					asOf: nowIso(at),
					expiresAt: nowIso(at + 10 * 60_000),
				});
			},
			async setPersonalTimezone(raw) {
				const fault = await enter("setPersonalTimezone");
				if (fault) return fault;
				const request = N.setPersonalTimezoneRequest.parse(raw);
				const preview = store.previews.get(request.input.previewId);
				if (!preview || preview.zone !== request.input.timeZone || preview.expiresAt <= now())
					return refuse("stale_preview");
				const current = store.personalZone.status === "confirmed" ? store.personalZone.revision : "0";
				if (current !== request.expectedRevision) return refuse("conflict");
				store.personalZone = S.timezonePreference.parse({
					status: "confirmed",
					timeZone: request.input.timeZone,
					revision: bump(current),
				});
				return ok(N.personalTimezoneResult, { preference: store.personalZone });
			},
			async requestAccountDeletion(raw) {
				const fault = await enter("requestAccountDeletion");
				if (fault) return fault;
				S.requestAccountDeletion.parse(raw);
				if (persona === "owner") return refuse("manual_owner_exception_required");
				return ok(N.deletionStatus, pending({ kind: "account", id: ACCOUNT[persona] }, now()));
			},
			async requestWorkspaceDeletion(raw) {
				const fault = await enter("requestWorkspaceDeletion");
				if (fault) return fault;
				S.requestWorkspaceDeletion.parse(raw);
				if (persona !== "owner") return refuse("access_denied");
				return ok(N.deletionStatus, pending(PLANT, now()));
			},
		},
	};

	return {
		port,
		controls: {
			failNext: (op, fault) => {
				faults.set(op, fault);
				listeners.forEach((l) => l());
			},
			calls,
			onChange: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
}

function pending(subject: { kind: "account" | "plant"; id: string }, at: number) {
	const requestedAt = new Date(Math.floor(at / 1000) * 1000);
	return {
		status: "pending_deletion",
		subject,
		requestId: nextId(),
		revision: "1",
		requestedAt: requestedAt.toISOString(),
		cancelUntil: new Date(requestedAt.getTime() + 30 * 86_400_000).toISOString(),
	};
}

export type DeletionScenario = "pending" | "late" | "skew" | "purging" | "purged" | "cancelled";
export const DELETION_SCENARIOS: readonly DeletionScenario[] = [
	"pending",
	"late",
	"skew",
	"purging",
	"purged",
	"cancelled",
];

/**
 * The restricted deletion session for the preview. "late" is a request whose 30 days ended while the purge has not
 * started; "skew" ends one minute after the page's clock, but the server already counts it as ended.
 */
export function createDeletionPort(
	subjectKind: "account" | "plant",
	scenario: DeletionScenario,
	{ now = () => Date.now(), delay = 400 }: { now?: () => number; delay?: number } = {},
): DeletionPort {
	const subject = subjectKind === "account" ? { kind: "account" as const, id: ACCOUNT.admin } : PLANT;
	const day = 86_400_000;
	const at = now();
	const requestedAt =
		scenario === "late" || scenario === "purging" || scenario === "purged"
			? at - 31 * day
			: scenario === "skew"
				? at - 30 * day + 60_000
				: at - 3 * day;
	let status: DeletionStatus = N.deletionStatus.parse(
		scenario === "purging"
			? { ...pending(subject, requestedAt), status: "purging" }
			: scenario === "purged"
				? {
						...pending(subject, requestedAt),
						status: "purged",
						livePurgedAt: new Date(requestedAt + 30 * day + 3_600_000).toISOString(),
						copyExpiresAt: new Date(requestedAt + 37 * day).toISOString(),
					}
				: scenario === "cancelled"
					? {
							...pending(subject, requestedAt),
							status: "cancelled",
							cancelledAt: new Date(requestedAt + day).toISOString(),
						}
					: pending(subject, requestedAt),
	);
	const wait = () => new Promise((r) => setTimeout(r, delay));
	const refuse = (code: SettingsError["code"]): Reply<DeletionStatus> => ({
		status: "refused",
		error: S.settingsError.parse({
			code,
			details: {},
			correlationId: nextId(),
			retry: code === "conflict" ? "refresh" : "never",
		}),
	});
	return {
		async getStatus() {
			await wait();
			return { status: "ok", value: status };
		},
		async cancel(expectedRevision) {
			await wait();
			if (status.status !== "pending_deletion") return refuse("conflict");
			if (expectedRevision !== status.revision) return refuse("conflict");
			// The server's own deadline: "skew" has already ended on the server even though the page shows one minute left.
			const serverNow = scenario === "skew" ? now() + 120_000 : now();
			if (serverNow >= Date.parse(status.cancelUntil)) return refuse("deadline_passed");
			status = N.deletionStatus.parse({
				...status,
				status: "cancelled",
				revision: "2",
				cancelledAt: new Date(now()).toISOString(),
			});
			return { status: "ok", value: status };
		},
	};
}
