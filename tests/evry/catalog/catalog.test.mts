import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { READ_DOMAINS, SELECT_RETURNED_ROWS } from "../../../packages/evry/src/catalog/catalog.ts";
import { allowedWrites, REVIEWED_WRITES } from "../../../packages/evry/src/proposals/store.ts";
import { readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import type { EvryActor } from "../../../packages/evry/src/context/actor.ts";

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
		"meetings.list",
		"meetings.get",
		"meetings.hasHistory",
		"meetings.readAgenda",
		"meetings.listKit",
		"meetings.listGuests",
		"meetings.listCards",
		"meetings.cardBreakdown",
		"meetings.invitationAttribution",
		"meetings.communicationContext",
		"meetings.listCompletedPreLaunchPractices",
		"meetings.getOwnRsvp",
		"meetings.listAttendance",
		"meetings.attendanceSummary",
		"meetings.getEvaluation",
		"meetings.evaluationHistory",
		"meetings.evaluationTrend",
		"meetings.compareEvaluation",
		"meetings.attendanceTrend",
		"meetings.summaryStats",
		"meetings.linkedTaskProgress",
		"meetings.readAnalytics",
		"meetings.previewRosterImport",
		"venues.list",
		"venues.get",
		"venues.history",
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

const operationsOf = (catalog: ReturnType<typeof readCatalog>) => [
	...catalog.domains.flatMap((d) => d.operations.map((o) => o.operation)),
	...catalog.reviewedWrites.map((w) => w.operation),
];
const actorAs = (owner: EvryActor["owner"], role: EvryActor["role"]) => ({ owner, role }) as unknown as EvryActor;
const plant = { kind: "plant", id: "00000000-0000-4000-8000-000000000001" } as EvryActor["owner"];

test("Meetings tools follow the native floor: an organization seat and an account context see none", () => {
	const meetings = (actor: EvryActor) =>
		operationsOf(readCatalog(actor)).filter((op) => /^(meetings|venues)\./.test(op));
	// Every WP-065 model-tool read and every WP-066 model-tool write is installed, and nothing beyond them.
	const flagged = (pkg: string, kind: string) =>
		[...operations.values()]
			.filter((o) => (o.evry_packages as string[]).includes(pkg) && o.model_tool === true && o.kind === kind)
			.map((o) => String(o.id))
			.sort();
	const owner = meetings(actorAs(plant, "owner"));
	assert.deepEqual(
		owner.filter((op) => operations.get(op)?.kind === "query").sort(),
		flagged("WP-065", "query"),
	);
	assert.deepEqual(
		owner.filter((op) => operations.get(op)?.kind === "command").sort(),
		flagged("WP-066", "command"),
	);
	assert.deepEqual(meetings(actorAs({ kind: "organization", id: plant.id, organizationKind: "sending_church" } as never, "owner")), []);
	assert.deepEqual(meetings(actorAs({ kind: "account", id: plant.id } as never, null)), []);
	// The public RSVP token reads and commands and notification planning stay native.
	for (const op of [
		"meeting.describeRsvpToken",
		"meeting.answerRsvpToken",
		"meetings.readTokenRsvp",
		"meetings.resolveTokenRsvp",
		"meetings.planNotifications",
		"meetings.syncNotifications",
	])
		assert.equal(owner.includes(op), false, op);
});

test("A Member reads meetings and proposes only what the native floor lets a Member do: never a delete", () => {
	const member = actorAs(plant, "member");
	const ops = operationsOf(readCatalog(member));
	assert.ok(ops.includes("meetings.list"));
	assert.ok(ops.includes("meetings.listGuests"));
	assert.equal(ops.includes("meetings.attendanceTrend"), false, "reports are Owner or Admin");
	assert.deepEqual(
		allowedWrites(member)
			.map((w) => w.operation)
			.filter((op) => /^(meetings|venues)\./.test(op))
			.sort(),
		[
			"meetings.captureAttendanceBatch",
			"meetings.checkIn",
			"meetings.clearAttendance",
			"meetings.finalizeAttendance",
			"meetings.reconcileAttendance",
			"meetings.saveOwnRsvp",
			"meetings.schedule",
			"meetings.setAttendance",
		],
	);
});
