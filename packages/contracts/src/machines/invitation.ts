import { machine } from "./machine.ts";

export const invitationPurposes = [
	"seat",
	"plant_church",
	"plant_network",
	"church_network",
	"discovery_church",
	"discovery_network",
	"residency_link",
] as const;

export type InvitationSubject = {
	readonly purpose: (typeof invitationPurposes)[number];
	readonly tenant: "plant" | "organization" | "account";
	readonly fresh: boolean;
};

const relationship = (s: InvitationSubject) => s.purpose !== "seat" && s.purpose !== "residency_link";

export const invitationMachine = machine({
	id: "invitation",
	table: "invitation",
	column: "state",
	states: ["pending", "accepted", "declined", "expired", "revoked"],
	events: [
		"seats.invite",
		"residency.invite",
		"associations.invite",
		"seats.resendInvitation",
		"seats.revokeInvitation",
		"seats.acceptInvitation",
		"residency.respondInvitation",
		"pipeline.removePerson",
		"associations.resendInvitation",
		"associations.revokeInvitation",
		"associations.acceptInvitation",
		"associations.respondInvitation",
		"associations.declineInvitation",
	],
	refusal: "invitation_unavailable",
	refusalCodes: [
		{ event: "residency.respondInvitation", from: "accepted", code: "already_linked" },
		{ event: "associations.resendInvitation", code: "unavailable" },
		{ event: "associations.revokeInvitation", code: "unavailable" },
		{ event: "associations.acceptInvitation", code: "unavailable" },
		{ event: "associations.respondInvitation", code: "unavailable" },
		{ event: "associations.declineInvitation", code: "unavailable" },
	],
	initial: [
		{ event: "seats.invite", to: "pending", when: "seat" },
		{ event: "residency.invite", to: "pending", when: "residency" },
		{ event: "associations.invite", to: "pending", when: "relationship" },
	],
	guards: {
		seat: (s: InvitationSubject) => s.purpose === "seat",
		residency: (s: InvitationSubject) => s.purpose === "residency_link",
		seatOrResidency: (s: InvitationSubject) => !relationship(s),
		relationship,
		workspace: (s: InvitationSubject) => s.tenant !== "account",
		organization: (s: InvitationSubject) => s.tenant === "organization",
		withinThirtyDays: (s: InvitationSubject) => s.fresh,
	},
	facts: ["withinThirtyDays"],
	subjects: {
		seat: { purpose: "seat", tenant: "plant", fresh: true },
		staleSeat: { purpose: "seat", tenant: "plant", fresh: false },
		organizationSeat: { purpose: "seat", tenant: "organization", fresh: true },
		staleOrganizationSeat: { purpose: "seat", tenant: "organization", fresh: false },
		residency: { purpose: "residency_link", tenant: "organization", fresh: true },
		staleResidency: { purpose: "residency_link", tenant: "organization", fresh: false },
		plantRelationship: { purpose: "plant_church", tenant: "plant", fresh: true },
		stalePlantRelationship: { purpose: "plant_church", tenant: "plant", fresh: false },
		churchRelationship: { purpose: "church_network", tenant: "organization", fresh: true },
		staleChurchRelationship: { purpose: "church_network", tenant: "organization", fresh: false },
		discoveryRelationship: { purpose: "discovery_church", tenant: "account", fresh: true },
		staleDiscoveryRelationship: { purpose: "discovery_church", tenant: "account", fresh: false },
	},
	edges: [
		{ event: "seats.revokeInvitation", from: "pending", to: "revoked", when: ["seatOrResidency", "withinThirtyDays"] },
		{ event: "seats.acceptInvitation", from: "pending", to: "accepted", when: ["seat", "withinThirtyDays"] },
		{
			event: "residency.respondInvitation",
			from: "pending",
			to: ["accepted", "declined"],
			when: ["residency", "withinThirtyDays"],
		},
		{
			event: "associations.revokeInvitation",
			from: "pending",
			to: "revoked",
			when: ["relationship", "withinThirtyDays"],
		},
		{
			event: "associations.acceptInvitation",
			from: "pending",
			to: "accepted",
			when: ["relationship", "withinThirtyDays"],
		},
		{
			event: "associations.respondInvitation",
			from: "pending",
			to: ["accepted", "declined"],
			when: ["relationship", "withinThirtyDays"],
		},
		{
			event: "associations.declineInvitation",
			from: "pending",
			to: "declined",
			when: ["relationship", "withinThirtyDays"],
		},
		{
			event: "seats.invite",
			from: "pending",
			to: "expired",
			sweep: true,
			when: "workspace",
			unless: "withinThirtyDays",
		},
		{
			event: "residency.invite",
			from: "pending",
			to: "expired",
			sweep: true,
			when: "organization",
			unless: "withinThirtyDays",
		},
		{
			event: "associations.invite",
			from: "pending",
			to: "expired",
			sweep: true,
			when: "relationship",
			unless: "withinThirtyDays",
		},
		{ event: "pipeline.removePerson", from: "pending", to: "revoked", sweep: true, when: "residency" },
	],
	stays: [
		{ event: "seats.resendInvitation", in: ["pending"], when: ["seatOrResidency", "withinThirtyDays"] },
		{ event: "associations.resendInvitation", in: ["pending"], when: ["relationship", "withinThirtyDays"] },
	],
	unchangedIsNoop: [],
	notes: [
		"`withinThirtyDays`: a seat or residency invitation was created, and a relationship invitation was last sent, less than 720 hours before the database clock. Resending a relationship invitation restarts its 30 days. Nothing expires an invitation on a timer: an invite to the same address in the same tenant sweeps the older stale ones.",
	],
	proof: "tests/integration/identity/invitation-machine.test.mts",
});
