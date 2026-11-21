import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

type Calls = { read: number[]; observe: number[] };
const calls: Calls = ((globalThis as { __streamCursorCalls?: Calls }).__streamCursorCalls = { read: [], observe: [] });

const httpUrl = new URL("../../../apps/web/src/server/evry/http.ts", import.meta.url);
const streamPathFakes: Record<string, string> = {
	flushTraces: "() => {}",
	projectError: "(error) => ({ message: String(error) })",
	readConversation: "async (_db, _actor, _id, after) => { globalThis.__streamCursorCalls.read.push(after); }",
	observeRun: "async function* (_db, _actor, _id, after) { globalThis.__streamCursorCalls.observe.push(after); }",
	after: "() => {}",
	requestDatabase: "() => ({})",
	requestActor: "async () => ({})",
	errorResponse: "(error) => new Response(String(error), { status: 500 })",
};
const imports = new Map<string, Set<string>>();
for (const [, clause = "", specifier] of readFileSync(httpUrl, "utf8").matchAll(
	/^import\s+(?!type\s)(?:([\w$*\s{},]+?)\s+from\s+)?["']([^"']+)["']/gm,
)) {
	const names = imports.get(specifier!) ?? imports.set(specifier!, new Set()).get(specifier!)!;
	for (const part of clause.match(/\{([^}]*)\}/)?.[1]?.split(",") ?? []) {
		const name = part.trim().split(/\s+as\s+/)[0]!;
		if (name && !name.startsWith("type ")) names.add(name);
	}
	if (/^\s*[\w$]+\s*(,|$)/.test(clause)) names.add("default");
}
const stubs = new Map(
	[...imports].map(([specifier, names]) => {
		const exports = [...names].map((name) =>
			name === "default"
				? "export default () => {};"
				: `export const ${name} = ${streamPathFakes[name] ?? "() => {}"};`,
		);
		return [specifier, `data:text/javascript,${encodeURIComponent(exports.join("\n"))}`];
	}),
);
registerHooks({
	resolve: (specifier, context, next) =>
		context.parentURL === httpUrl.href && stubs.has(specifier)
			? { url: stubs.get(specifier)!, shortCircuit: true }
			: next(specifier, context),
});

const { conversationStreamGet } = (await import(httpUrl.href)) as {
	conversationStreamGet: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
};

async function cursorFor(after: string) {
	calls.read.length = 0;
	calls.observe.length = 0;
	const response = await conversationStreamGet(
		new Request(`https://x.test/api/evry/conversations/c1/stream?after=${after}`),
		{
			params: Promise.resolve({ id: "c1" }),
		},
	);
	assert.equal(response.status, 200);
	assert.match(await response.text(), /event: idle/);
	return { read: [...calls.read], observe: [...calls.observe] };
}

test("BUG-PR551: a malformed ?after= reads from cursor 0", async () => {
	for (const after of ["abc", "-1", "1.5", "", "1e400"])
		assert.deepEqual(await cursorFor(after), { read: [0], observe: [0] }, `after=${after}`);
});

test("BUG-PR551: a valid ?after= is passed through", async () => {
	assert.deepEqual(await cursorFor("7"), { read: [7], observe: [7] });
	assert.deepEqual(await cursorFor("0"), { read: [0], observe: [0] });
});
