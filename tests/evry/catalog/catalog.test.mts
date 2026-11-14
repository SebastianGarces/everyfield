import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	MEMBER_PHASES,
	READ_DOMAINS,
	readCatalog,
	SELECT_RETURNED_ROWS,
} from "../../../packages/evry/src/catalog/catalog.ts";
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
		"phases.readCatalog",
		"phases.readHistory",
		"phases.readReadiness",
		"signals.listDefinitions",
		"signals.getHistory",
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

/** An actor in one exact context. Availability reads only the context and the role, never the database. */
const as = (contextKind: EvryActor["contextKind"], role: EvryActor["role"]): EvryActor => ({
	authority: null as never,
	accountId: "5b6d1f0e-0000-4000-8000-000000000f01",
	session: "5b6d1f0e-0000-4000-8000-000000000f21",
	owner:
		contextKind === "account" || contextKind === "plant"
			? { kind: contextKind, id: "5b6d1f0e-0000-4000-8000-000000000001" }
			: { kind: "organization", id: "5b6d1f0e-0000-4000-8000-000000000003", organizationKind: contextKind },
	contextKind,
	role,
	seatId: role ? "5b6d1f0e-0000-4000-8000-000000000f31" : null,
	selfPersonId: null,
});
const PHASE_TOOLS = {
	phases: ["phases.readCatalog", "phases.readHistory", "phases.readReadiness"],
	signals: ["signals.listDefinitions", "signals.getHistory"],
	writes: ["phases.declare", "phases.transition", "signals.attest", "signals.correct", "signals.reaffirm"],
};

test("INV-catalog: the phase and signal tools follow the context: Owner and Admin get them, a Member, an organization seat and an account get none", () => {
	const phaseTools = (actor: EvryActor) => {
		const catalog = readCatalog(actor);
		const ops = (domain: string) =>
			catalog.domains.find((d) => d.domain === domain)?.operations.map((o) => o.operation) ?? [];
		return {
			phases: ops("phases"),
			signals: ops("signals"),
			writes: catalog.reviewedWrites.map((w) => w.operation).filter((o) => /^(phases|signals)\./.test(o)),
			withheld: catalog.withheld,
		};
	};
	for (const role of ["owner", "admin"] as const)
		assert.deepEqual(phaseTools(as("plant", role)), { ...PHASE_TOOLS, withheld: [] }, role);
	// A Member's seat leaves the phase journey out, and the catalog says so in the /intelligence page's own words.
	assert.deepEqual(phaseTools(as("plant", "member")), {
		phases: [],
		signals: [],
		writes: [],
		withheld: [MEMBER_PHASES],
	});
	// Organization seats keep no tools at all until T-311 or T-331 gives them their own (D-1116); an account has none.
	for (const actor of [as("sending_church", "owner"), as("sending_network", "admin"), as("account", null)]) {
		const catalog = readCatalog(actor);
		assert.deepEqual([catalog.domains, catalog.reviewedWrites, catalog.withheld], [[], [], []], actor.contextKind);
	}
});
