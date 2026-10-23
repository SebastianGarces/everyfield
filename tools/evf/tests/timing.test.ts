import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runSet, summarize, type ProbeKind, type ProbeRound, type TimingSet } from "../timing.ts";

// A fixture timing set on a fake clock: sample i runs at T(i). Each plan row sets what surrounds that sample: its
// duration, a slow probe round trip inside its window, the 1-minute load at its end, an interference the set reports,
// or a probe that gives no answer after it.
const T = (i: number) => 1_000_000 + i * 10_000;
type Plan = {
	ms: number;
	read?: number;
	write?: number;
	load?: number;
	interference?: string;
	unsettled?: ProbeKind[];
};

function fixture(declared: number, plan: Record<number, Plan>) {
	const rounds: ProbeRound[] = [{ k: "read", s: T(1) - 301, e: T(1) - 1 }]; // 300 ms, ends before sample 1 starts
	for (const [i, p] of Object.entries(plan)) {
		if (p.read) rounds.push({ k: "read", s: T(Number(i)) + 50, e: T(Number(i)) + 50 + p.read });
		if (p.write) rounds.push({ k: "write", s: T(Number(i)) + 50, e: T(Number(i)) + 50 + p.write });
	}
	const seen: Array<[number, number | undefined]> = [];
	const set: TimingSet = {
		name: "fixture save",
		budgetMs: 1000,
		samples: declared,
		write: true,
		sample: ({ index, replacementFor }) => {
			seen.push([index, replacementFor]);
			const p = plan[index];
			return { startedAt: T(index), endedAt: T(index) + p.ms, interference: p.interference };
		},
	};
	let loads = 0;
	const deps = {
		ctx: {
			url: "https://fixture.localhost",
			databaseUrl: "postgres://fixture",
			env: {},
			require: createRequire(import.meta.url),
			out: "",
		},
		probe: {
			rounds: () => rounds,
			settle: async (t: number) => plan[Math.round((t - 1_000_000) / 10_000)]?.unsettled ?? [],
		},
		// Two reads per sample, before and after it; the planned load is the one at its end.
		load: () => (loads++ % 2 ? (plan[Math.floor(loads / 2)]?.load ?? 3) : 3),
		limit: 24,
	};
	return { set, deps, seen };
}

const PLAN: Record<number, Plan> = {
	1: { ms: 400 },
	2: { ms: 450, read: 200 },
	3: { ms: 420, load: 30 },
	4: { ms: 480, write: 180 },
	5: { ms: 430, interference: "a parallel save for the same plant" },
	6: { ms: 1200 },
	7: { ms: 440, read: 160 },
	8: { ms: 500 },
	9: { ms: 470, unsettled: ["read"] },
	10: { ms: 600 },
	11: { ms: 700 },
	12: { ms: 650 },
};

test("OPS-52-P1: every non-qualifying sample gets one labeled replacement; a qualifying miss fails the set", async () => {
	const { set, deps, seen } = fixture(6, PLAN);
	const result = await runSet(set, deps);
	assert.deepEqual(
		result.samples.map((s) => [s.index, s.replacementFor ?? null, s.ms, s.label]),
		[
			[1, null, 400, "qualifying"],
			[2, null, 450, "database spike"],
			[3, null, 420, "load"],
			[4, null, 480, "database write stall"],
			[5, null, 430, "self-interference"],
			[6, null, 1200, "qualifying"],
			[7, 2, 440, "database spike"],
			[8, 3, 500, "qualifying"],
			[9, 4, 470, "database spike"],
			[10, 5, 600, "qualifying"],
			[11, 7, 700, "qualifying"],
			[12, 9, 650, "qualifying"],
		],
	);
	assert.deepEqual(seen.slice(6), [
		[7, 2],
		[8, 3],
		[9, 4],
		[10, 5],
		[11, 7],
		[12, 9],
	]);
	assert.deepEqual(
		result.samples.filter((s) => s.detail).map((s) => [s.index, s.detail]),
		[
			[2, "SELECT 1 probe round trip 200 ms, limit 150 ms"],
			[3, "1-minute load 30.0, limit 24"],
			[4, "write probe round trip 180 ms, limit 150 ms"],
			[5, "a parallel save for the same plant"],
			[7, "SELECT 1 probe round trip 160 ms, limit 150 ms"],
			[9, "SELECT 1 probe gave no answer within 2000 ms after the sample"],
		],
	);
	assert.deepEqual(summarize(set, result), {
		verdict: "fail",
		reason: "1 qualifying sample(s) at or above 1000 ms: 6",
		qualifying: 6,
		misses: [6],
		nonQualifying: { "database spike": 3, load: 1, "database write stall": 1, "self-interference": 1 },
		range: [400, 1200],
	});
});

test("OPS-52-P1: the set passes when every declared sample qualifies under budget, and is not measured when noise wins", async () => {
	const passing = fixture(6, { ...PLAN, 6: { ms: 900 } });
	const passed = summarize(passing.set, await runSet(passing.set, passing.deps));
	assert.equal(passed.verdict, "pass");
	assert.equal(passed.reason, "6 of 6 qualifying samples under 1000 ms");
	assert.deepEqual(passed.range, [400, 900]);

	// Two declared samples; every sample runs at load 40. The third non-qualifying sample stops the run.
	const noisy = fixture(2, Object.fromEntries([1, 2, 3, 4].map((i) => [i, { ms: 300, load: 40 }])));
	const result = await runSet(noisy.set, noisy.deps);
	assert.deepEqual(
		result.samples.map((s) => [s.index, s.replacementFor ?? null, s.label]),
		[
			[1, null, "load"],
			[2, null, "load"],
			[3, 1, "load"],
		],
	);
	assert.deepEqual(summarize(noisy.set, result), {
		verdict: "fail",
		reason: "more than 2 non-qualifying samples; the set is not measured",
		qualifying: 0,
		misses: [],
		nonQualifying: { load: 3 },
	});
});
