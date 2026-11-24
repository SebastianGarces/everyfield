import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { compileContext, LAUNCH_RULES } from "../../../../packages/evry/src/context/compile.ts";
import { READ_DOMAINS, readCatalog } from "../../../../packages/evry/src/catalog/catalog.ts";
import { invokeRead } from "../../../../packages/evry/src/catalog/invoke.ts";
import type { ReadAdapter } from "../../../../packages/evry/src/catalog/types.ts";
import { actor, admin, db, setup, sql, teardown } from "../../runtime/support.mts";

before(setup);
after(teardown);

const READS = ["launch.readCountdown", "launch.readWorkspace", "launch.readJournal", "launch.readDebrief"];
const read = async (operation: string) => {
	const adapter = Object.values(READ_DOMAINS)
		.flat()
		.find((a) => a.operation === operation);
	return invokeRead(db, await actor("owner"), adapter as unknown as ReadAdapter<unknown>, {});
};

test("INV-launch-unloaded: every Launch read whose plan read throws says the plan couldn't be loaded, never an empty plan or a count of 0", async () => {
	for (const operation of READS) assert.equal((await read(operation)).facts?.loaded, true, operation);
	await admin.execute(sql`ALTER TABLE launch_milestone RENAME TO launch_milestone_gone`);
	try {
		for (const operation of READS) {
			const { facts, total, completeness, exclusions, rows } = await read(operation);
			assert.deepEqual(
				{ facts, total, completeness, exclusions, rows },
				{
					facts: { loaded: false },
					total: null,
					completeness: "partial",
					exclusions: ["the Launch plan, which couldn't be loaded"],
					rows: [],
				},
				operation,
			);
		}
	} finally {
		await admin.execute(sql`ALTER TABLE launch_milestone_gone RENAME TO launch_milestone`);
	}
});

test("INV-launch-unloaded: a context that offers the Launch reads tells the model to say the plan couldn't be loaded", async () => {
	for (const who of ["owner", "member"] as const) {
		const seat = await actor(who);
		const catalog = readCatalog(seat);
		const offered = catalog.domains.flatMap((d) => d.operations.map((o) => o.operation));
		assert.ok(offered.includes("launch.readCountdown"), who);
		const { system } = compileContext({
			actor: seat,
			catalog,
			history: [],
			text: "How many days until Launch Sunday?",
			references: [],
			now: new Date("2026-11-02T12:00:00Z"),
		});
		assert.ok(
			system.includes(`When a launch read says the plan couldn't be loaded, reply: ${LAUNCH_RULES.unloaded}`),
			who,
		);
	}
});
