import test from "node:test";
import assert from "node:assert/strict";
import { scriptedModel } from "../../../packages/evry/src/runtime/scripted.ts";

async function firstRead(text: string) {
	const reply = await scriptedModel().doGenerate({
		prompt: [{ role: "user", content: [{ type: "text", text }] }],
		tools: [{ type: "function", name: "people_read", inputSchema: {} }],
	} as never);
	const call = reply.content.find((c) => c.type === "tool-call");
	assert.ok(call && call.type === "tool-call", `no tool call for ${JSON.stringify(text)}`);
	return { tool: call.toolName, ...JSON.parse(call.input) };
}

test("INV-scripted-model: the scripted model asks people.listPeople for the page size the words ask for", async () => {
	const page = (input: unknown) => ({ tool: "people_read", operation: "people.listPeople", input });
	assert.deepEqual(await firstRead("Which people should I call?"), page({ limit: 24 }));
	assert.deepEqual(await firstRead("Show me all people"), page({ limit: 100 }));
	assert.deepEqual(await firstRead("Show me every person and their members"), page({ limit: 100 }));
	assert.deepEqual(await firstRead("Show me people 10 at a time"), page({ limit: 10 }));
	assert.deepEqual(await firstRead("List everyone"), page({ limit: 24 }));
});

test("INV-scripted-model: the people words match whole words only", async () => {
	const reply = await scriptedModel().doGenerate({
		prompt: [{ role: "user", content: [{ type: "text", text: "Tell me about Peoplesoft" }] }],
		tools: [{ type: "function", name: "people_read", inputSchema: {} }],
	} as never);
	assert.equal(
		reply.content.some((c) => c.type === "tool-call"),
		false,
	);
});
