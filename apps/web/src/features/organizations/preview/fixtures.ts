import * as C from "@everyfield/contracts/organizations";
import type { z } from "zod";
import { Refusal } from "../../../components/intent.ts";
import type { InviteTarget } from "../InviteDialog";
import type {
	Disclosure,
	History,
	NameOf,
	OperationName,
	Invitation,
	Relationship,
	RelationshipPair,
	Run,
} from "../port";

export const ORGANIZATION_FLOWS = [
	"connections",
	"organization",
	"invitation",
	"residency",
	"pipeline",
	"notices",
] as const;
export type OrganizationFlow = (typeof ORGANIZATION_FLOWS)[number];

export const VIEWERS = ["owner", "member"] as const;
export type Viewer = (typeof VIEWERS)[number];
export const VIEWER_LABEL: Record<Viewer, string> = { owner: "Owner or Admin", member: "Member" };

const SCENARIOS = ["connected", "none", "load-failed", "offline-once", "refused"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const SCENARIO_LABEL: Record<Scenario, string> = {
	connected: "Normal",
	none: "Nothing yet",
	"load-failed": "Load fails once",
	"offline-once": "Reply lost once",
	refused: "Server refuses",
};

export const FLOW_CONTROLS: Record<OrganizationFlow, { viewer: boolean; scenarios: readonly Scenario[] }> = {
	connections: { viewer: true, scenarios: SCENARIOS },
	organization: { viewer: true, scenarios: SCENARIOS },
	invitation: { viewer: false, scenarios: ["connected", "none", "offline-once", "refused"] },
	residency: { viewer: false, scenarios: ["connected", "load-failed", "offline-once", "refused"] },
	pipeline: { viewer: true, scenarios: ["connected", "load-failed", "offline-once", "refused"] },
	notices: { viewer: false, scenarios: [] },
};

export const ZONE = "America/Chicago";

const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-1b3d-4f5a-8c7e-9d0f1a2b3c4d`;
const PLANT = { kind: "plant", id: uuid(1) } as const;
const AUSTIN = { kind: "organization", id: uuid(2), organizationKind: "sending_network" } as const;
const GRACE = { kind: "organization", id: uuid(3), organizationKind: "sending_church" } as const;
const HILL = { kind: "organization", id: uuid(4), organizationKind: "sending_network" } as const;
const CEDAR = { kind: "organization", id: uuid(5), organizationKind: "sending_church" } as const;
const EASTSIDE = { kind: "plant", id: uuid(6) } as const;
const RIVERBEND = { kind: "organization", id: uuid(7), organizationKind: "sending_network" } as const;
const DANIEL = uuid(20);
const PRIYA = uuid(21);
const MARCUS = uuid(22);
const RESIDENT_LINK = uuid(40);

const NAMES: Record<string, string> = {
	[PLANT.id]: "Harvest Point Church",
	[AUSTIN.id]: "Austin Sending Network",
	[GRACE.id]: "Grace Fellowship",
	[HILL.id]: "Hill Country Network",
	[CEDAR.id]: "Cedar Creek Church",
	[EASTSIDE.id]: "Eastside Commons",
	[RIVERBEND.id]: "Riverbend Network",
	[DANIEL]: "Daniel Reyes",
	[PRIYA]: "Priya Natarajan",
	[MARCUS]: "Marcus Hale",
};
const knownName = (id: string) => {
	const name = NAMES[id];
	if (name === undefined) throw new Error(`No preview name for ${id}`);
	return name;
};
export const nameOf: NameOf = (endpoint) => NAMES[endpoint.id] ?? "Unnamed";

const pair = (
	subject: typeof PLANT | typeof EASTSIDE,
	organization: typeof AUSTIN | typeof GRACE | typeof HILL | typeof CEDAR | typeof RIVERBEND,
) => C.relationshipPair.parse({ kind: "plant", subject, organization });
const CHURCH_PAIR = C.relationshipPair.parse({ kind: "sending_church", subject: GRACE, organization: AUSTIN });

let counter = 100;
const nextId = () => uuid(counter++);
const READS = new Set<OperationName>([
	"privacy.getSharing",
	"associations.getHistory",
	"residency.readSharing",
	"pipelineSharing.readConsent",
]);
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const item = (
	p: RelationshipPair,
	event: "approved" | "ended",
	at: string,
	actor: string | null,
	reason: string | null,
	recordedAt = at,
) => ({ id: nextId(), pair: p, event, at, actor, reason, recordedAt });

export const PLANT_TARGETS: InviteTarget[] = [
	{ pair: pair(PLANT, CEDAR), name: knownName(CEDAR.id) },
	{ pair: pair(PLANT, HILL), name: knownName(HILL.id) },
];
const DISCLOSURES: Record<string, unknown> = {
	[CEDAR.id]: {
		kind: "first_invitation",
		organization: CEDAR,
		choices: {
			people: true,
			meetings: true,
			tasks: true,
			ministry_teams: true,
			wiki: true,
			activity: true,
			shared_findings: true,
		},
	},
	[HILL.id]: {
		kind: "existing_consent",
		organization: HILL,
		consentRevision: "6",
		choices: {
			people: true,
			meetings: true,
			tasks: false,
			ministry_teams: false,
			wiki: true,
			activity: false,
			shared_findings: false,
		},
	},
};
async function sampleDisclosure(p: RelationshipPair): Promise<Disclosure | null> {
	const raw = DISCLOSURES[p.organization.id];
	return raw ? C.sharingDisclosure.parse(raw) : null;
}

export function createBackend(side: "subject" | "organization", viewer: Viewer, scenario: Scenario) {
	const entitled = viewer === "owner";
	const failUntil = scenario === "load-failed" ? Date.now() + 1000 : 0;
	const dropped = new Set<OperationName>();
	const scope = side === "subject" ? { plant: PLANT } : { organization: AUSTIN };

	type Row = { relationship: Relationship; name: string };
	const active: Row[] = [];
	const events: ReturnType<typeof item>[] = [];
	if (scenario !== "none") {
		if (side === "subject") {
			const austin = C.relationshipProjection.parse({
				id: uuid(30),
				pair: pair(PLANT, AUSTIN),
				revision: "3",
				acceptedAt: "2026-03-02T15:00:00Z",
				endedAt: null,
			});
			const grace = C.relationshipProjection.parse({
				id: uuid(31),
				pair: pair(PLANT, GRACE),
				revision: "2",
				acceptedAt: "2026-06-14T16:30:00Z",
				endedAt: null,
			});
			active.push(
				{ relationship: grace, name: knownName(GRACE.id) },
				{ relationship: austin, name: knownName(AUSTIN.id) },
			);
			events.push(
				item(grace.pair, "approved", grace.acceptedAt, PRIYA, null),
				item(
					pair(PLANT, HILL),
					"ended",
					"2026-02-10T18:00:00Z",
					DANIEL,
					"We moved our residents to the Austin cohort.",
					"2026-02-11T09:00:00Z",
				),
				item(austin.pair, "approved", austin.acceptedAt, MARCUS, null),
				item(pair(PLANT, HILL), "approved", "2025-08-21T14:00:00Z", null, null),
				item(pair(PLANT, HILL), "ended", "2025-05-02T14:00:00Z", DANIEL, null),
				item(pair(PLANT, HILL), "approved", "2025-01-12T14:00:00Z", DANIEL, null),
			);
		} else {
			const harvest = C.relationshipProjection.parse({
				id: uuid(30),
				pair: pair(PLANT, AUSTIN),
				revision: "3",
				acceptedAt: "2026-03-02T15:00:00Z",
				endedAt: null,
			});
			const eastside = C.relationshipProjection.parse({
				id: uuid(32),
				pair: pair(EASTSIDE, AUSTIN),
				revision: "1",
				acceptedAt: "2026-09-08T15:00:00Z",
				endedAt: null,
			});
			const grace = C.relationshipProjection.parse({
				id: uuid(33),
				pair: CHURCH_PAIR,
				revision: "4",
				acceptedAt: "2025-11-20T15:00:00Z",
				endedAt: null,
			});
			active.push(
				{ relationship: eastside, name: knownName(EASTSIDE.id) },
				{ relationship: harvest, name: knownName(PLANT.id) },
				{ relationship: grace, name: knownName(GRACE.id) },
			);
			events.push(
				item(eastside.pair, "approved", eastside.acceptedAt, PRIYA, null),
				item(harvest.pair, "approved", harvest.acceptedAt, MARCUS, null),
				item(CHURCH_PAIR, "approved", grace.acceptedAt, PRIYA, null),
			);
		}
	}

	const historyItem = (e: (typeof events)[number]) => ({
		id: e.id,
		pair: e.pair,
		event: e.event,
		reason: entitled ? { status: "available", value: e.reason } : { status: "withheld" },
		occurredAt: e.at,
		recordedAt: e.recordedAt,
		actor: e.actor ? { kind: "account", accountId: e.actor } : { kind: "deleted_account", token: "deleted-7f2a" },
		sourceInvitationId: null,
	});

	const PAGE = 4;
	async function read(after: string | null) {
		if (Date.now() < failUntil) throw new TypeError("Failed to fetch");
		const start = after === null ? 0 : events.findIndex((e) => e.id === after) + 1;
		const page = events.slice(start, start + PAGE);
		const more = start + PAGE < events.length;
		const last = page.at(-1);
		return C.relationshipHistoryResult.parse({
			status: "available",
			scope,
			activeRelationships: active.map((r) => r.relationship),
			items: page.map((e) => historyItem(e)),
			next: more && last ? last.id : null,
			completeness: side === "subject" && !more && events.length > 0 ? "partial" : "complete",
		}) as History;
	}

	let pending: Invitation[] =
		(scenario === "connected" || scenario === "refused") && side === "subject"
			? [
					C.invitationResult.parse({
						status: "pending",
						invitationId: uuid(50),
						pair: pair(PLANT, RIVERBEND),
						revision: "1",
						expiresAt: days(19),
						inviterDescription: "Daniel Reyes, Owner of Harvest Point Church",
					}),
				]
			: [];

	type Consent = { revision: number; choices: Record<string, boolean> };
	const consent = new Map<string, Consent>();
	const consentOf = (id: string) => {
		const known = consent.get(id);
		if (known) return known;
		const fresh: Consent = {
			revision: 4,
			choices: {
				people: true,
				meetings: true,
				tasks: false,
				ministry_teams: true,
				wiki: false,
				activity: false,
				shared_findings: true,
			},
		};
		consent.set(id, fresh);
		return fresh;
	};
	let residency = {
		status: "active" as "active" | "ended",
		revision: 3,
		choices: { shareFoundations: true, shareMilestones: false },
	};
	let pipeline = { revision: 2, share: false };

	const replies = new Map<string, { body: string; reply: unknown }>();
	const addresses = new Map<string, string>();
	const run = (async (operation: OperationName, input: unknown) => {
		if (READS.has(operation)) return answer(operation, input);
		const key = `${operation}:${(input as { requestKey: string }).requestKey}`;
		const body = JSON.stringify(input);
		const seen = replies.get(key);
		if (seen && seen.body !== body) throw new Refusal("request_conflict");
		const reply = seen ?? { body, reply: answer(operation, input) };
		if (!seen) replies.set(key, reply);
		if (scenario === "offline-once" && !dropped.has(operation)) {
			dropped.add(operation);
			throw new TypeError("Failed to fetch");
		}
		return reply.reply;
	}) as Run;

	function answer(operation: OperationName, input: unknown) {
		const refuse = scenario === "refused";
		const command = input as { requestKey: string; input: Record<string, unknown> };
		switch (operation) {
			case "associations.invite": {
				const p = command.input.pair as RelationshipPair;
				if (refuse) throw new Refusal("invitation_limit");
				if (pending.some((i) => i.pair.organization.id === p.organization.id)) throw new Refusal("pending_invitation");
				const email = command.input.recipientEmail as string;
				if (pending.some((i) => addresses.get(i.invitationId) === email)) throw new Refusal("address_pending");
				const made = C.invitationResult.parse({
					status: "pending",
					invitationId: nextId(),
					pair: p,
					revision: "1",
					expiresAt: days(30),
					inviterDescription: "Daniel Reyes, Owner of Harvest Point Church",
				});
				addresses.set(made.invitationId, email);
				pending = [made, ...pending];
				return made;
			}
			case "associations.resendInvitation": {
				const original = pending.find((i) => i.invitationId === command.input.invitationId);
				if (refuse || !original) throw new Refusal(refuse ? "resend_cooldown" : "unavailable");
				const next = C.invitationResult.parse({
					...original,
					revision: String(Number(original.revision) + 1),
					expiresAt: original.expiresAt,
				});
				pending = pending.map((i) => (i.invitationId === next.invitationId ? next : i));
				return next;
			}
			case "associations.revokeInvitation": {
				const found = pending.some((i) => i.invitationId === command.input.invitationId);
				if (refuse || !found) return C.mutationResult.parse({ status: "unavailable" });
				pending = pending.filter((i) => i.invitationId !== command.input.invitationId);
				return C.mutationResult.parse({ status: "committed" });
			}
			case "associations.end": {
				const index = active.findIndex((r) => r.relationship.id === command.input.relationshipId);
				const row = active[index];
				if (refuse || !row) return C.mutationResult.parse({ status: "unavailable" });
				active.splice(index, 1);
				events.unshift(
					item(
						row.relationship.pair,
						"ended",
						new Date().toISOString(),
						DANIEL,
						(command.input.reason as string | null) ?? null,
					),
				);
				return C.mutationResult.parse({
					status: "committed",
				});
			}
			case "associations.respondInvitation": {
				if (refuse) return C.invitationDecisionResult.parse({ status: "unavailable" });
				const decision = command.input.decision as "accept" | "decline";

				return C.invitationDecisionResult.parse(
					decision === "accept"
						? {
								status: "accepted",
								relationship: {
									id: nextId(),
									pair: pair(EASTSIDE, AUSTIN),
									revision: "1",
									acceptedAt: new Date().toISOString(),
									endedAt: null,
								},
							}
						: { status: "declined", invitationId: command.input.invitationId },
				);
			}
			case "privacy.getSharing": {
				const q = input as { plant: { id: string }; organization: { id: string } };
				const row = active.find((r) => r.relationship.pair.organization.id === q.organization.id);
				if (!row) return C.sharingResult.parse({ status: "unavailable" });
				const base = {
					plant: PLANT,
					organization: row.relationship.pair.organization,
					organizationDisplayName: row.name,
					activeAffiliation: true,
				};
				if (!entitled) return C.sharingResult.parse({ view: "plant_member", ...base });
				const c = consentOf(row.relationship.id);
				return C.sharingResult.parse({
					view: "plant_administration",
					...base,
					consentRevision: String(c.revision),
					choices: c.choices,
				});
			}
			case "privacy.setSharing": {
				const index = active.findIndex((r) => r.relationship.id === command.input.relationshipId);
				const row = active[index];
				if (refuse || !row) throw new Refusal(refuse ? "stale_revision" : "unavailable");
				const c = consentOf(row.relationship.id);
				if (String(command.input.expectedConsentRevision) !== String(c.revision)) throw new Refusal("stale_revision");
				c.choices = { ...c.choices, [command.input.category as string]: command.input.enabled as boolean };
				c.revision += 1;
				active[index] = {
					...row,
					relationship: C.relationshipProjection.parse({
						...row.relationship,
						revision: String(Number(row.relationship.revision) + 1),
					}),
				};
				return C.mutationResult.parse({ status: "committed" });
			}
			case "residency.readSharing":
				return C.residencySharingResult.parse(
					residency.status === "ended"
						? { status: "ended", linkId: RESIDENT_LINK }
						: {
								status: "active",
								linkId: RESIDENT_LINK,
								organization: AUSTIN,
								consentRevision: String(residency.revision),
								choices: residency.choices,
							},
				);
			case "residency.setSharing":
				if (refuse) return C.mutationResult.parse({ status: "unavailable" });
				if ((input as { expectedRevision: string }).expectedRevision !== String(residency.revision + 10))
					throw new Refusal("stale_revision");
				residency = {
					...residency,
					revision: residency.revision + 1,
					choices: command.input.choices as typeof residency.choices,
				};
				return C.mutationResult.parse({
					status: "committed",
				});
			case "residency.leave":
				if (refuse) return C.mutationResult.parse({ status: "unavailable" });
				if ((input as { expectedRevision: string }).expectedRevision !== String(residency.revision + 10))
					throw new Refusal("stale_revision");
				residency = { ...residency, status: "ended" };
				return C.mutationResult.parse({
					status: "committed",
				});
			case "pipelineSharing.readConsent":
				return C.pipelineConsentResult.parse({
					status: "available",
					relationshipId: uuid(33),
					revision: String(pipeline.revision),
					sharePipelineTotals: pipeline.share,
					minimumContributors: 2,
				});
			case "pipelineSharing.setConsent":
				if (refuse) return C.mutationResult.parse({ status: "unavailable" });
				pipeline = { revision: pipeline.revision + 1, share: command.input.sharePipelineTotals as boolean };
				return C.mutationResult.parse({ status: "committed" });
			default:
				throw new Error(`The preview has no sample reply for ${operation}.`);
		}
	}

	const load = async () => {
		const history = await read(null);
		return { history, pending, sharing: {} };
	};
	const readResidency = async (linkId: string) => ({
		sharing: (await run("residency.readSharing", C.residencySharingRequest.parse({ linkId }))) as z.infer<
			typeof C.residencySharingResult
		>,
		linkRevision: String(residency.revision + 10),
	});
	const readSharing = async (relationshipId: string, request: unknown) => ({
		sharing: (await run("privacy.getSharing", C.readSharingRequest.parse(request))) as z.infer<typeof C.sharingResult>,
		relationshipRevision: active.find((r) => r.relationship.id === relationshipId)?.relationship.revision ?? "0",
	});
	let disclosureFails = scenario === "refused";
	const readDisclosure = async (p: RelationshipPair) => {
		if (disclosureFails) {
			disclosureFails = false;
			throw new TypeError("Failed to fetch");
		}
		return sampleDisclosure(p);
	};
	const end = async (command: z.infer<typeof C.endRelationshipRequest>) => {
		const r = (await run("associations.end", command)) as z.infer<typeof C.mutationResult>;
		return r.status === "committed" ? read(null) : null;
	};
	const saveSharing = async (command: z.infer<typeof C.setSharingRequest>) => {
		const r = (await run("privacy.setSharing", command)) as z.infer<typeof C.mutationResult>;
		return r.status === "committed" ? readSharing(command.input.relationshipId, command.input) : null;
	};
	const saveResidency = async (command: z.infer<typeof C.setResidencySharingRequest>) => {
		const r = (await run("residency.setSharing", command)) as z.infer<typeof C.mutationResult>;
		return r.status === "committed" ? readResidency(command.input.linkId) : null;
	};
	const readConsent = async (relationshipId: string) =>
		(await run("pipelineSharing.readConsent", C.pipelineConsentRequest.parse({ relationshipId }))) as z.infer<
			typeof C.pipelineConsentResult
		>;
	const saveConsent = async (command: z.infer<typeof C.setPipelineConsentRequest>) => {
		const r = (await run("pipelineSharing.setConsent", command)) as z.infer<typeof C.mutationResult>;
		return r.status === "committed" ? readConsent(command.input.relationshipId) : null;
	};
	return {
		load,
		read,
		run,
		end,
		readResidency,
		saveResidency,
		readConsent,
		saveConsent,
		sharing: { read: readSharing, save: saveSharing },
		readDisclosure,
		residencyLink: RESIDENT_LINK,
	};
}

export const INVITATION: Invitation = C.invitationResult.parse({
	status: "pending",
	invitationId: uuid(60),
	pair: pair(EASTSIDE, AUSTIN),
	revision: "1",
	expiresAt: "2026-11-14T20:00:00Z",
	inviterDescription: "Ana Ruiz, Owner of Eastside Commons",
});

export const NOTICES = [
	{ kind: "relationship_approved", organization: "Austin Sending Network", at: "2026-10-17T15:10:00Z" },
	{ kind: "sharing_changed", organization: "Grace Fellowship", at: "2026-10-16T13:00:00Z" },
	{ kind: "relationship_ended", organization: "Hill Country Network", at: "2026-10-12T19:30:00Z" },
] as const;

export const NAMES_FOR_PREVIEW = {
	plant: knownName(PLANT.id),
	network: knownName(AUSTIN.id),
	church: knownName(GRACE.id),
};
export const AGGREGATE = {
	allowed: C.pipelineAggregateAccessResult.parse({ allowed: true, minimumContributors: 2 }),
	withheld: C.pipelineAggregateAccessResult.parse({ allowed: false, minimumContributors: 2 }),
};
