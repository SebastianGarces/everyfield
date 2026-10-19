import * as C from "@everyfield/contracts/organizations";
import type { InviteTarget } from "../InviteDialog";
import type { PendingInvitation } from "../InvitationResponse";
import type { History, Invitation, NameOf, OperationName, Relationship, RelationshipPair, Run } from "../port";

// Invented sample data for /design/organizations. Every reply goes through the contract parser, so a fixture that
// the real API could not return fails here first. WP-007/api replaces `run` with the real operations.

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

export const SCENARIOS = ["connected", "none", "load-failed", "offline-once", "refused"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const SCENARIO_LABEL: Record<Scenario, string> = {
	connected: "Normal",
	none: "Nothing yet",
	"load-failed": "Load fails once",
	"offline-once": "Reply lost once",
	refused: "Server refuses",
};

/** The controls each flow uses, so the preview never shows a switch that changes nothing. */
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
export const nameOf: NameOf = (endpoint) => NAMES[endpoint.id] ?? "Unnamed";

const pair = (
	subject: typeof PLANT | typeof EASTSIDE,
	organization: typeof AUSTIN | typeof GRACE | typeof HILL | typeof CEDAR | typeof RIVERBEND,
) => C.relationshipPair.parse({ kind: "plant", subject, organization });
const CHURCH_PAIR = C.relationshipPair.parse({ kind: "sending_church", subject: GRACE, organization: AUSTIN });

const hex = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
let counter = 100;
const nextId = () => uuid(counter++);
const receipt = (requestKey: string, owner: unknown, operation: OperationName) => ({
	id: nextId(),
	request: { owner, actorId: DANIEL, operation, requestKey, digest: hex(), origin: { kind: "native" } },
	completedAt: new Date().toISOString(),
	outcome: "changed",
	subjects: [],
	eventIds: [],
	effectIds: [],
});
const READS = new Set<OperationName>([
	"associations.getHistory",
	"residency.readSharing",
	"pipelineSharing.readConsent",
]);
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const item = (
	p: RelationshipPair,
	event: "approved" | "ended",
	at: string,
	actor: string | null,
	reason: string | null,
	recordedAt = at,
) => ({ id: nextId(), pair: p, event, at, actor, reason, recordedAt });

/** Invite targets for the plant: one never connected (all on), one connected before (earlier choices). */
export const PLANT_TARGETS: InviteTarget[] = [
	{
		pair: pair(PLANT, CEDAR),
		name: NAMES[CEDAR.id]!,
		disclosure: C.sharingDisclosure.parse({
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
		}),
	},
	{
		pair: pair(PLANT, HILL),
		name: NAMES[HILL.id]!,
		disclosure: C.sharingDisclosure.parse({
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
		}),
	},
];

/** A stateful sample backend for one preview visit. `side` picks whose connections are listed. */
export function createBackend(side: "subject" | "organization", viewer: Viewer, scenario: Scenario) {
	const entitled = viewer === "owner";
	// Every read in the first second fails, so the error shows even when development mode loads twice.
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
			active.push({ relationship: grace, name: NAMES[GRACE.id]! }, { relationship: austin, name: NAMES[AUSTIN.id]! });
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
				{ relationship: eastside, name: NAMES[EASTSIDE.id]! },
				{ relationship: harvest, name: NAMES[PLANT.id]! },
				{ relationship: grace, name: NAMES[GRACE.id]! },
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
		await wait(350);
		if (Date.now() < failUntil) throw new TypeError("Failed to fetch");
		const start = after === null ? 0 : events.findIndex((e) => e.id === after) + 1;
		const page = events.slice(start, start + PAGE);
		const more = start + PAGE < events.length;
		return C.relationshipHistoryResult.parse({
			status: "available",
			scope,
			activeRelationships: active.map((r) => r.relationship),
			items: page.map((e) => historyItem(e)),
			next: more ? page[page.length - 1]!.id : null,
			completeness: side === "subject" && !more && events.length > 0 ? "partial" : "complete",
		}) as History;
	}

	const pending: Invitation[] =
		scenario === "connected" && side === "subject"
			? [
					C.invitationResult.parse({
						status: "pending",
						invitationId: uuid(50),
						pair: pair(PLANT, RIVERBEND),
						revision: "1",
						expiresAt: days(19),
						inviterDescription: "Daniel Reyes, Owner of Harvest Point Church",
						receipt: receipt("seed", PLANT, "associations.invite"),
					}),
				]
			: [];

	let residency = {
		status: "active" as "active" | "ended",
		revision: 3,
		choices: { shareFoundations: true, shareMilestones: false },
	};
	let pipeline = { revision: 2, share: false };

	// Commands are idempotent by request key, as the API is: a repeated key returns the first result and changes
	// nothing. "Reply lost once" commits the first command of each kind and then drops its reply.
	const replies = new Map<string, unknown>();
	const run = (async (operation: OperationName, input: unknown) => {
		await wait(450);
		if (READS.has(operation)) return answer(operation, input);
		const key = `${operation}:${(input as { requestKey: string }).requestKey}`;
		if (!replies.has(key)) replies.set(key, answer(operation, input));
		if (scenario === "offline-once" && !dropped.has(operation)) {
			dropped.add(operation);
			throw new TypeError("Failed to fetch");
		}
		return replies.get(key);
	}) as Run;

	function answer(operation: OperationName, input: unknown) {
		const refuse = scenario === "refused";
		const command = input as { requestKey: string; input: Record<string, unknown> };
		switch (operation) {
			case "associations.invite": {
				const p = command.input.pair as RelationshipPair;
				return C.invitationResult.parse({
					status: "pending",
					invitationId: nextId(),
					pair: p,
					revision: "1",
					expiresAt: days(30),
					inviterDescription: "Daniel Reyes, Owner of Harvest Point Church",
					receipt: receipt(command.requestKey, PLANT, operation),
				});
			}
			case "associations.resendInvitation": {
				const original = pending.find((i) => i.invitationId === command.input.invitationId) ?? pending[0]!;
				return C.invitationResult.parse({
					...original,
					revision: String(Number(original.revision) + 1),
					expiresAt: days(30),
					receipt: receipt(command.requestKey, PLANT, operation),
				});
			}
			case "associations.revokeInvitation":
				return C.mutationResult.parse(
					refuse
						? { status: "unavailable" }
						: { status: "committed", receipt: receipt(command.requestKey, PLANT, operation) },
				);
			case "associations.end": {
				const index = active.findIndex((r) => r.relationship.id === command.input.relationshipId);
				// An end for a link that is no longer active is refused, so a retry with a new key would show it.
				if (refuse || index < 0) return C.mutationResult.parse({ status: "unavailable" });
				const [row] = active.splice(index, 1);
				events.unshift(
					item(
						row!.relationship.pair,
						"ended",
						new Date().toISOString(),
						DANIEL,
						(command.input.reason as string | null) ?? null,
					),
				);
				return C.mutationResult.parse({
					status: "committed",
					receipt: receipt(command.requestKey, side === "subject" ? PLANT : AUSTIN, operation),
				});
			}
			case "associations.respondInvitation": {
				if (refuse) return C.invitationDecisionResult.parse({ status: "unavailable" });
				const decision = command.input.decision as "accept" | "decline";
				const r = receipt(command.requestKey, AUSTIN, operation);
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
								receipt: r,
							}
						: { status: "declined", invitationId: command.input.invitationId, receipt: r },
				);
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
				residency = {
					...residency,
					revision: residency.revision + 1,
					choices: command.input.choices as typeof residency.choices,
				};
				return C.mutationResult.parse({
					status: "committed",
					receipt: receipt(command.requestKey, { kind: "account", id: DANIEL }, operation),
				});
			case "residency.leave":
				if (refuse) return C.mutationResult.parse({ status: "unavailable" });
				residency = { ...residency, status: "ended" };
				return C.mutationResult.parse({
					status: "committed",
					receipt: receipt(command.requestKey, { kind: "account", id: DANIEL }, operation),
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
				return C.mutationResult.parse({ status: "committed", receipt: receipt(command.requestKey, GRACE, operation) });
			default:
				throw new Error(`The preview has no sample reply for ${operation}.`);
		}
	}

	return { read, run, pending, residencyLink: RESIDENT_LINK };
}

/** The request the recipient opened from the emailed link (WP-008 owns the link landing). */
export const INVITATION: PendingInvitation = C.invitationResult.omit({ receipt: true }).parse({
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

export const NAMES_FOR_PREVIEW = { plant: NAMES[PLANT.id]!, network: NAMES[AUSTIN.id]!, church: NAMES[GRACE.id]! };
export const AGGREGATE = {
	allowed: C.pipelineAggregateAccessResult.parse({ allowed: true, minimumContributors: 2 }),
	withheld: C.pipelineAggregateAccessResult.parse({ allowed: false, minimumContributors: 2 }),
};
