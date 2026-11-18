import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ROOT = new URL("../../../packages/contracts/", import.meta.url);
const entries: Record<string, string> = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")).exports;
const ACTOR_KEYS = new Set([
	"actor",
	"actorId",
	"actorAccountId",
	"session",
	"sessionId",
	"sessionToken",
	"createdBy",
	"viewerId",
	"userId",
]);
const SECRET_KEY = /password|proof|token/i;
const DURABLE_SECRET_KEY = /password|proof/i;
const RESULT_NAME = /(?:Result|Results|View|Page)$/;
const TYPED = "  Pa\u0301ss word Ab  ";

type Schema = {
	def: { type: string } & Record<string, unknown>;
	safeParse(value: unknown): { success: boolean; data?: unknown };
};
type Node = { path: string; key: string; schema: Schema };

const isSchema = (value: unknown): value is Schema =>
	typeof value === "object" && value !== null && "_zod" in value && "def" in value;
const WRAPPED = ["innerType", "in", "out", "element", "left", "right", "valueType", "rest"];

function* walk(schema: Schema, path: string, key = "", inside = new Set<Schema>()): Generator<Node> {
	if (inside.has(schema)) return;
	yield { path, key, schema };
	const def = schema.def;
	const within = new Set(inside).add(schema);
	if (def.type === "object") {
		for (const [name, child] of Object.entries(def.shape as Record<string, Schema>))
			yield* walk(child, `${path}.${name}`, name, within);
		return;
	}
	const children =
		def.type === "lazy"
			? [(def.getter as () => Schema)()]
			: [
					...WRAPPED.map((name) => def[name]),
					...((def.options as unknown[]) ?? []),
					...((def.items as unknown[]) ?? []),
				];
	for (const child of children.filter(isSchema)) yield* walk(child, path, key, within);
}
const paths = (nodes: Iterable<Node>) => [...new Set([...nodes].map(({ path }) => path))];
function* keyed(schemas: { name: string; schema: Schema }[], key: (name: string) => boolean) {
	for (const { name, schema } of schemas) for (const node of walk(schema, name)) if (key(node.key)) yield node;
}

const exported: { name: string; schema: Schema }[] = [];
for (const [entry, file] of Object.entries(entries))
	for (const [name, value] of Object.entries(await import(new URL(file, ROOT).href)))
		if (isSchema(value)) exported.push({ name: `${entry.slice(2)} ${name}`, schema: value });
const requests = exported.filter(({ name }) => name.endsWith("Request"));

test("INV-actor: request schemas declare no actor or session key and pass no unknown key through", () => {
	assert.ok(requests.length >= 400, `only ${requests.length} request schemas found`);
	assert.deepEqual(paths(keyed(requests, (key) => ACTOR_KEYS.has(key))), []);
	const open = [...keyed(requests, () => true)].filter(({ schema }) => {
		const catchall = schema.def.catchall;
		return schema.def.type === "object" && isSchema(catchall) && catchall.def.type !== "never";
	});
	assert.deepEqual(paths(open), []);
});

test("INV-secrets: a password, proof or token field keeps exactly what was typed or refuses it, and no result carries a password or proof", () => {
	const secrets = [...keyed(exported, (key) => SECRET_KEY.test(key))];
	for (const path of ["identity signInRequest.password", "identity recoverPasswordRequest.proof"])
		assert.ok(paths(secrets).includes(path), `${path} not checked`);
	const changed = secrets.filter(({ schema }) => {
		const parsed = schema.safeParse(TYPED);
		return parsed.success && parsed.data !== TYPED;
	});
	assert.deepEqual(paths(changed), []);
	const results = exported.filter(({ name }) => RESULT_NAME.test(name));
	assert.deepEqual(paths(keyed(results, (key) => DURABLE_SECRET_KEY.test(key))), []);
});
