// The scripted stand-in model (local previews and tests) picks its page size from whole words: "every" or "all" ask
// for 100, "N at a time" asks for N, and anything else asks for the 24-row page. A word that only contains "all", such
// as "call", must not select the 100-row page. No database: the model is called the way the runtime calls it.
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
	// "everyone" is a whole word; the 24-row page is the default.
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

test("INV-scripted-model: a seat whose propose tool offers only notification changes is told an Owner or Admin sends email, and nothing is proposed", async () => {
	const reply = (text: string, operations: string[]) =>
		scriptedModel().doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text }] }],
			tools: [
				{ type: "function", name: "communication_read", inputSchema: {} },
				{
					type: "function",
					name: "propose_change",
					inputSchema: { type: "object", properties: { operation: { type: "string", enum: operations } } },
				},
			],
		} as never);
	const member = ["notifications.markSelectedRead", "notifications.setPreferences"];
	const send = await reply("send the welcome email again to everyone", member);
	assert.deepEqual(send.content, [
		{
			type: "text",
			text: "Sending or changing email needs an Owner or Admin of this church. Ask one of them to do it.",
		},
	]);
	const draft = await reply("draft an email to the launch team", member);
	assert.equal(
		draft.content.some((c) => c.type === "tool-call" && c.toolName === "propose_change"),
		false,
	);
	// An Owner's propose tool offers the email writes, so the same ask reads the email first.
	const owner = await reply("send the welcome email again to everyone", [...member, "communication.retryProvenFailed"]);
	const call = owner.content.find((c) => c.type === "tool-call");
	assert.ok(call && call.type === "tool-call");
	assert.deepEqual(JSON.parse(call.input), { operation: "communication.get", input: { subject: "welcome email" } });
});
