import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { censusPhases, withinLimit } from "../limit.mjs";

const directory = process.env.CENSUS_FIXTURE;
const limit = Number(process.env.CENSUS_LIMIT);
const files = ["census-passing.mjs", process.env.CENSUS_SUITE].map((name) =>
	fileURLToPath(new URL(name, import.meta.url)),
);
const { NODE_TEST_CONTEXT, ...env } = process.env;

test("the census", async (t) => {
	const phases = censusPhases({ directory, cwd: directory, env, files });
	const value = await withinLimit(t, limit, phases, async () => {
		const requests = await phases.run("requests", ["-e", "console.log('proved')"], []);
		if (requests.exit !== 0) throw Error("requests failed");
		const behaviors = await phases.run(
			"behaviors",
			["--test", "--test-concurrency=2", ...phases.reporters, ...files],
			[],
		);
		if (behaviors.exit !== 0) throw Error("behaviors failed: " + behaviors.evidence);
		return "passed";
	});
	console.log("the census " + value);
});
