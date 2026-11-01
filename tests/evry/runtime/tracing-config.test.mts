import test from "node:test";
import assert from "node:assert/strict";
import { flushTraces, registerTracing } from "../../../packages/evry/src/runtime/trace.ts";

// The configurations tracing refuses. Nothing here ever registers, so every case starts from the same empty process.

const keys = { LANGFUSE_PUBLIC_KEY: "pk-lf-config", LANGFUSE_SECRET_KEY: "sk-lf-config" };

/** Runs `body` and returns its result with every line it wrote to the console, parsed. */
async function logged<T>(body: () => T | Promise<T>) {
	const lines: Record<string, unknown>[] = [];
	const { log, error } = console;
	console.log = console.error = (text: string) => void lines.push(JSON.parse(text));
	try {
		return { result: await body(), lines };
	} finally {
		Object.assign(console, { log, error });
	}
}
/** A registered provider is the only thing a flush reports on, so a silent flush means nothing was registered. */
const registered = async () => (await logged(flushTraces)).lines.length > 0;

test("INV-tracing: missing Langfuse keys write one tracing_disabled line with the SDK's default host and register nothing", async () => {
	for (const env of [{}, { LANGFUSE_PUBLIC_KEY: "pk-lf-config" }, { LANGFUSE_SECRET_KEY: "sk-lf-config" }]) {
		const { result, lines } = await logged(() => registerTracing(env));
		assert.equal(result, false);
		assert.deepEqual(lines, [
			{
				component: "evry",
				event: "tracing_disabled",
				reason: "missing_keys",
				baseUrlHost: "cloud.langfuse.com",
				environment: null,
				environmentValid: true,
			},
		]);
	}
	assert.equal(await registered(), false);
});

test("INV-tracing: an environment name Langfuse rejects is refused: uppercase, a langfuse prefix and the empty string", async () => {
	for (const environment of ["Production", "langfuse-preview", ""]) {
		const env = {
			...keys,
			LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
			LANGFUSE_TRACING_ENVIRONMENT: environment,
		};
		const { result, lines } = await logged(() => registerTracing(env));
		assert.equal(result, false, environment);
		assert.deepEqual(lines, [
			{
				component: "evry",
				event: "tracing_disabled",
				reason: "invalid_environment",
				baseUrlHost: "us.cloud.langfuse.com",
				environment,
				environmentValid: false,
			},
		]);
	}
	assert.equal(await registered(), false);
});

test("INV-tracing: a base URL that is empty, blank or not an absolute http(s) URL is refused", async () => {
	for (const baseUrl of [
		"",
		"   ",
		"us.cloud.langfuse.com",
		"ftp://us.cloud.langfuse.com",
		" https://us.cloud.langfuse.com",
	]) {
		const env = { ...keys, LANGFUSE_BASE_URL: baseUrl, LANGFUSE_TRACING_ENVIRONMENT: "preview" };
		const { result, lines } = await logged(() => registerTracing(env));
		assert.equal(result, false, JSON.stringify(baseUrl));
		assert.deepEqual(lines, [
			{
				component: "evry",
				event: "tracing_disabled",
				reason: "invalid_base_url",
				baseUrlHost: null,
				environment: "preview",
				environmentValid: true,
			},
		]);
	}
	assert.equal(await registered(), false);
});

test("INV-privacy: a refusal line shows the base URL's host and never its user info, query or the keys", async () => {
	const env = {
		LANGFUSE_PUBLIC_KEY: "pk-lf-refused-4c1d",
		LANGFUSE_SECRET_KEY: "sk-lf-refused-8e2b",
		LANGFUSE_BASE_URL: "https://user-r1:pass-r2@us.cloud.langfuse.com/?token=tok-r3",
		LANGFUSE_TRACING_ENVIRONMENT: "Preview",
	};
	const { lines } = await logged(() => registerTracing(env));
	assert.deepEqual(lines, [
		{
			component: "evry",
			event: "tracing_disabled",
			reason: "invalid_environment",
			baseUrlHost: "us.cloud.langfuse.com",
			environment: "Preview",
			environmentValid: false,
		},
	]);
	const text = JSON.stringify(lines);
	for (const secret of ["pk-lf-refused-4c1d", "sk-lf-refused-8e2b", "user-r1", "pass-r2", "tok-r3"])
		assert.ok(!text.includes(secret), secret);
});

test("INV-tracing: with nothing registered a flush resolves and writes nothing", async () => {
	const { result, lines } = await logged(() => flushTraces());
	assert.equal(result, undefined);
	assert.deepEqual(lines, []);
});
