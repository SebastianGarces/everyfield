import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { READ_DOMAINS, SELECT_RETURNED_ROWS, readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import type { EvryActor } from "../../../packages/evry/src/context/actor.ts";
import { REVIEWED_WRITES } from "../../../packages/evry/src/proposals/store.ts";

const read = (path: string) =>
	JSON.parse(readFileSync(new URL(`../../../docs/catalog/${path}`, import.meta.url), "utf8"));
const operations = new Map<string, Record<string, unknown>>(
	(read("operations.json").operations ?? read("operations.json")).map((o: Record<string, unknown>) => [o.id, o]),
);
const generated = new Set<string>(read("evry-tools.json").operation_ids);

test("AC:INH-REGRESSION-CAPABILITIES INV-catalog: every installed model tool is a flagged, generated, read-only operation", () => {
	const installed = [
		...Object.values(READ_DOMAINS).flatMap((adapters) => adapters.map((a) => a.operation)),
		SELECT_RETURNED_ROWS,
	];
	assert.deepEqual(installed, [
		"people.listPeople",
		"people.getPerson",
		"people.getPersonPhoto",
		"people.checkForDuplicates",
		"people.listDuplicatePairs",
		"people.exportPeople",
		"people.generateCsvTemplate",
		"people.getActivities",
		"people.getHousehold",
		"people.getHouseholdMembers",
		"people.getImportReceipt",
		"people.getPersonSkills",
		"people.getPersonTags",
		"people.getPipelineData",
		"people.listHouseholds",
		"people.listTags",
		"people.previewImport",
		"communication.list",
		"notifications.feed",
		"notifications.preferences.get",
		"notifications.previewPlanterDigest",
		"notifications.previewOversightDigest",
		"teams.list",
		"teams.get",
		"teams.searchMembers",
		"teams.staffingSummary",
		"teams.personTeamCounts",
		"teams.staffingFacts",
		"teams.health",
		"teams.aggregateHealth",
		"teams.trainingMatrix",
		"teams.readRequiredTrainingParticipants",
		"teams.previewRequiredTrainingParticipants",
		"teams.listTraining",
		"teams.personTraining",
		"teams.trainingHistory",
		"teams.personAssignments",
		"teams.membershipHistory",
		"teams.history",
		"teams.listRoles",
		"teams.leaderCandidates",
		"teams.orgChart",
		"teams.exportOrgChart",
		"teams.listImportTemplates",
		"teams.previewTemplateImport",
		"teams.listResponsibilities",
		"teams.previewResponsibilities",
		"teams.listMeetings",
		"evry.selectReturnedRows",
	]);
	for (const id of installed) {
		const op = operations.get(id);
		assert.ok(op, id);
		assert.deepEqual([op.model_tool, op.kind, op.durable_write, generated.has(id)], [true, "query", false, true], id);
	}
	// A reviewed write is a flagged durable command the model may only propose; a person approves it.
	for (const id of Object.keys(REVIEWED_WRITES)) {
		const op = operations.get(id);
		assert.ok(op, id);
		assert.deepEqual(
			[op.model_tool, op.kind, op.durable_write, op.evry_review, generated.has(id)],
			[true, "command", true, true, true],
			id,
		);
	}
	// Every model-tool operation of the teams packages (WP-069 reads, WP-070 reviewed writes) is installed.
	const teams = [...operations.values()].filter(
		(op) =>
			op.model_tool === true && ((op.evry_packages as string[]) ?? []).some((p) => p === "WP-069" || p === "WP-070"),
	);
	assert.deepEqual(
		teams.map((op) => op.id).sort(),
		[
			...installed.filter((id) => id.startsWith("teams.")),
			...Object.keys(REVIEWED_WRITES).filter((id) => id.startsWith("teams.")),
		].sort(),
	);
	// Runtime operations that are not model tools stay out of the model's reach.
	for (const id of [
		"evry.submitTurn",
		"evry.cancelTurn",
		"evry.selectQualifiedModel",
		"access.checkOperation",
		"evry.approveProposal",
		"evry.executeProposal",
	])
		assert.equal(operations.get(id)?.model_tool, false, id);
});

test("INV-member-capabilities: a Member who may change only their own notifications is still told an Owner or Admin changes records", async () => {
	const { describeCatalog } = await import("../../../packages/evry/src/context/compile.ts");
	const catalog = (writes: string[]) =>
		({
			context: "plant",
			domains: [{ domain: "people", operations: [{ operation: "people.listPeople", description: "List people" }] }],
			selection: [SELECT_RETURNED_ROWS],
			reviewedWrites: writes.map((operation) => ({ operation, description: operation })),
		}) as unknown as Parameters<typeof describeCatalog>[0];
	const member = describeCatalog(catalog(["notifications.markSelectedRead", "notifications.setPreferences"]));
	assert.match(member, /an Owner or Admin of this church has to make them/);
	assert.match(member, /your own notifications/);
	assert.match(describeCatalog(catalog([])), /an Owner or Admin of this church has to make them/);
	assert.doesNotMatch(describeCatalog(catalog(["people.updatePerson"])), /Owner or Admin/);
});

test("INV-organization-catalog: only an organization Owner or Admin gets the two oversight digest tools, and nothing else", () => {
	const id = "00000000-0000-4000-8000-0000000000a1";
	const actor = (owner: EvryActor["owner"], contextKind: EvryActor["contextKind"], role: EvryActor["role"]) =>
		({
			accountId: id,
			session: id,
			owner,
			contextKind,
			role,
			seatId: role ? id : null,
			selfPersonId: null,
		}) as EvryActor;
	const organization = { kind: "organization", id, organizationKind: "sending_church" } as EvryActor["owner"];
	const tools = (a: EvryActor) => {
		const c = readCatalog(a);
		return [
			...c.domains.flatMap((d) => d.operations.map((o) => o.operation)),
			...c.reviewedWrites.map((w) => w.operation),
		];
	};
	const oversight = ["notifications.previewOversightDigest", "notifications.oversightDigestCadence.set"];
	for (const role of ["owner", "admin"] as const)
		assert.deepEqual(tools(actor(organization, "sending_church", role)), oversight, role);
	assert.deepEqual(tools(actor(organization, "sending_church", "member")), []);
	assert.deepEqual(tools(actor({ kind: "account", id } as EvryActor["owner"], "account", null)), []);
	const plantOwner = tools(actor({ kind: "plant", id } as EvryActor["owner"], "plant", "owner"));
	assert.ok(plantOwner.includes("notifications.previewPlanterDigest"));
	for (const op of oversight) assert.equal(plantOwner.includes(op), false, op);
});
