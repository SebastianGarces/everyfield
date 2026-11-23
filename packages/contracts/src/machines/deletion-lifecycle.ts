import { machine } from "./machine.ts";

export type DeletionWitness = {
	readonly kind: "account" | "plant";
	readonly copy?: boolean;
	readonly beforeDeadline?: boolean;
	readonly cleaned?: boolean;
};

const request = ["account.requestDeletion", "churches.requestWorkspaceDeletion"] as const;
const cancel = ["account.cancelDeletion", "churches.cancelWorkspaceDeletion"] as const;
const restore = "maintenance.restoreWithCurrentManifest";

export const deletionMachine = machine({
	id: "deletion-lifecycle",
	table: "lifecycle_witness",
	column: "state",
	states: ["pending_deletion", "purging", "purged", "cancelled"],
	events: [...request, ...cancel, "lifecycle.purge", restore],
	refusal: "deadline_passed",
	refusalCodes: [
		{ event: "account.requestDeletion", code: "unavailable" },
		{ event: "churches.requestWorkspaceDeletion", code: "unavailable" },
		{ event: "churches.cancelWorkspaceDeletion", from: ["purging", "purged"], code: "unavailable" },
	],
	initial: [
		{ event: "account.requestDeletion", to: "pending_deletion", when: "account" },
		{ event: "churches.requestWorkspaceDeletion", to: "pending_deletion", when: "plant" },
		{ event: restore, to: ["pending_deletion", "cancelled", "purging"], when: ["copy", "accountOrPlant"] },
	],
	guards: {
		account: (w: DeletionWitness) => w.kind === "account",
		plant: (w: DeletionWitness) => w.kind === "plant",
		accountOrPlant: (w: DeletionWitness) => w.kind === "account" || w.kind === "plant",
		copy: (w: DeletionWitness) => w.copy === true,
		beforeDeadline: (w: DeletionWitness) => w.beforeDeadline === true,
		cleaned: (w: DeletionWitness) => w.cleaned === true,
	},
	facts: ["beforeDeadline", "cleaned"],
	subjects: {
		account: { kind: "account", beforeDeadline: true },
		dueAccount: { kind: "account", beforeDeadline: false, cleaned: true },
		uncleanedAccount: { kind: "account", beforeDeadline: false, cleaned: false },
		plant: { kind: "plant", beforeDeadline: true },
		duePlant: { kind: "plant", beforeDeadline: false, cleaned: true },
		uncleanedPlant: { kind: "plant", beforeDeadline: false, cleaned: false },
	},
	edges: [
		{ event: "account.requestDeletion", from: "cancelled", to: "pending_deletion", when: "account" },
		{ event: "churches.requestWorkspaceDeletion", from: "cancelled", to: "pending_deletion", when: "plant" },
		{ event: "account.cancelDeletion", from: "pending_deletion", to: "cancelled", when: ["account", "beforeDeadline"] },
		{
			event: "churches.cancelWorkspaceDeletion",
			from: "pending_deletion",
			to: "cancelled",
			when: ["plant", "beforeDeadline"],
		},
		{
			event: "lifecycle.purge",
			from: ["pending_deletion", "purging"],
			to: "purging",
			when: "accountOrPlant",
			unless: "beforeDeadline",
		},
		{
			event: "lifecycle.purge",
			from: "purging",
			to: "purged",
			when: ["accountOrPlant", "cleaned"],
			unless: "beforeDeadline",
			sql: "settings_purge_subject",
		},
		{ event: restore, from: "purging", to: ["purging", "purged"], when: ["copy", "accountOrPlant"] },
	],
	stays: [
		{ event: "account.cancelDeletion", in: ["cancelled"], when: "account" },
		{ event: "churches.cancelWorkspaceDeletion", in: ["cancelled"], when: "plant" },
		{ event: "lifecycle.purge", in: ["purged"], when: "accountOrPlant" },
	],
	unchangedIsNoop: [],
	decided: [...cancel, "lifecycle.purge"],
	notes: [
		"`copy` is a witness inside a restore target. The proof restores every live witness once and requests deletion of a restored account and church that have no witness.",
		"A request from a closed account or church is refused by the write gate (`unavailable`) before the witness check.",
	],
	proof: "tests/integration/settings/deletion-machine.test.mts",
});
