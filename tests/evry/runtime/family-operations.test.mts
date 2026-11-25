import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { READ_DOMAINS, type ReadAdapter } from "../../../packages/evry/src/index.ts";
import { REVIEWED_WRITES } from "../../../packages/evry/src/proposals/review.ts";
import type { Actor } from "../../support/fixture.mts";
import { caseWorld, propose, type Call, type CaseWorld } from "./case-world.mts";
import { CATALOG, FAMILIES, MATRICES, problems, SHIPPED, type Family } from "./family-operations/matches.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("familyops");
});
after(() => w?.close());

test("INV-family-operations: every operation of every family matrix is matched to a real test, its catalog exclusion or a cited decision", () => {
	assert.equal(MATRICES.size, 18);
	assert.deepEqual(problems(FAMILIES), []);
});

test("INV-family-operations: an unmatched, extra, unproved, wrongly excluded or uncited operation is refused", () => {
	const family = "EVRY-FAMILY-PLANT";
	const matrices = new Map([[family, ["people.addNote", "auth.signIn", "evry.submitTurn", "dashboard.resolveHome"]]]);
	const good: Family = {
		family,
		tested: [
			{
				file: "tests/evry/runtime/cases-people.test.mts",
				test: "AC:INH-NOTES-05",
				operations: ["people.addNote", "evry.submitTurn"],
				through: { "evry.submitTurn": "approveProposal" },
			},
		],
		excluded: [
			{ rule: "REQ-EVR-020", authority: CATALOG.get("auth.signIn")!.authority[0]!.actors, operations: ["auth.signIn"] },
		],
		withheld: [{ decision: "D-1435", operations: ["dashboard.resolveHome"] }],
	};
	const found = (change: (f: Family) => void) => {
		const broken = structuredClone(good);
		change(broken);
		return problems([broken], matrices).map((p) => p.replace(`${family} `, ""));
	};
	assert.deepEqual(
		found(() => {}),
		[],
	);
	const file = "tests/evry/runtime/cases-people.test.mts";
	for (const [change, problem] of [
		[(f) => f.withheld.pop(), "dashboard.resolveHome is not matched"],
		[(f) => f.tested[0]!.operations.push("people.getPerson"), "people.getPerson is not in the matrix"],
		[(f) => f.excluded[0]!.operations.push("people.addNote"), "people.addNote is matched twice"],
		[(f) => (f.tested[0]!.test = "AC:NO-SUCH-CASE"), `${file} "AC:NO-SUCH-CASE" names 0 tests`],
		[(f) => (f.tested[0]!.file = "tests/evry/gone.test.mts"), `tests/evry/gone.test.mts "AC:INH-NOTES-05" names 0 tests`],
		[(f) => (f.tested[0]!.test = "AC:INH-EDGES-01"), `people.addNote: "AC:INH-EDGES-01" never names people.addNote`],
		[
			(f) => (f.tested[0]!.through!["people.addNote"] = "people.notShipped"),
			"people.addNote is a model tool that people.notShipped does not serve",
		],
		[(f) => (f.excluded[0]!.rule = "REQ-EVR-999"), "REQ-EVR-999 is no catalog rule"],
		[
			(f) => (f.excluded[0]!.authority = ["plant_owner"]),
			"auth.signIn is for public_or_sealed_expiring_proof, not plant_owner",
		],
		[
			(f) => {
				f.excluded[0]!.operations.push("people.addNote");
				f.tested[0]!.operations.shift();
			},
			"people.addNote is a model tool and cannot be excluded",
		],
		[
			(f) => {
				f.excluded[0]!.operations.push("evry.submitTurn");
				f.tested[0]!.operations.pop();
			},
			"evry.submitTurn is Evry's own protocol and cannot be excluded",
		],
		[(f) => (f.withheld[0]!.decision = "nobody asked"), `"nobody asked" cites no decision`],
		[(f) => f.withheld[0]!.operations.push("people.addNote"), "people.addNote is shipped and cannot be withheld"],
	] as [(f: Family) => unknown, string][])
		assert.ok(found(change).includes(problem), `${problem}\n${found(change).join("\n")}`);
});

async function available(owner: Actor, operations: string[]) {
	const out: string[] = [];
	for (let i = 0; i < operations.length; i += 6) {
		const some = operations.slice(i, i + 6);
		const calls = some.flatMap((operation): Call[] => [
			{ tool: `${domainOf(operation)}_read`, input: { operation, input: {} } },
			{ tool: "compose_reads", input: { reads: [{ operation, input: {} }] } },
			propose(operation, {}),
		]);
		const asked = await w.quiet(() =>
			w.ask(owner, "Do it", [() => calls], { onError: "go_on" }),
		);
		const names = [...asked.offered, ...asked.tools];
		for (const operation of some) if (names.includes(operation)) out.push(`${operation} is offered`);
		assert.equal(asked.replies.length, calls.length, JSON.stringify(asked.replies).slice(0, 600));
		asked.replies.forEach((reply, n) => {
			if (reply.error !== (calls[n]!.tool === "compose_reads" ? "not_a_read" : "not_offered"))
				out.push(`${some[Math.floor(n / 3)]} is accepted by ${calls[n]!.tool}: ${JSON.stringify(reply).slice(0, 200)}`);
		});
		for (const { operation } of [...asked.cards, ...asked.proposals]) out.push(`${operation} is answered`);
	}
	return out;
}
const domainOf = (operation: string) => {
	const prefix = operation.split(".")[0]!;
	return prefix in READ_DOMAINS ? prefix : "people";
};

test("INV-family-operations: no excluded or withheld operation is offered to an Owner, read or prepared, and offering one is caught", async () => {
	const { P } = await w.church();
	const owner = await w.seated(P, "owner");
	const operations = [
		...new Set(FAMILIES.flatMap((f) => [...f.excluded, ...f.withheld]).flatMap((x) => x.operations)),
	].sort();
	assert.ok(operations.length > 130, String(operations.length));
	assert.deepEqual(
		operations.filter((o) => SHIPPED.has(o)),
		[],
	);
	assert.deepEqual(await available(owner, operations), []);

	const planted = "tasks.ensureObligation";
	const people = READ_DOMAINS.people as unknown as ReadAdapter<unknown>[];
	people.push({ ...people[0]!, operation: planted });
	try {
		assert.ok((await available(owner, [planted])).includes(`${planted} is offered`), "a planted read is caught");
	} finally {
		people.pop();
	}
	const writes = REVIEWED_WRITES as Record<string, unknown>;
	writes[planted] = { ...REVIEWED_WRITES["people.addNote"], operation: planted };
	try {
		assert.ok((await available(owner, [planted])).includes(`${planted} is offered`), "a planted review is caught");
	} finally {
		delete writes[planted];
	}
	assert.deepEqual(await available(owner, [planted]), []);
});
