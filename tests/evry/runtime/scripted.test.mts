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

/** One scripted step with these tools offered, after this system prompt. */
async function step(
	text: string,
	tools: string[],
	system = "Current time (trusted server clock): 2026-11-11T15:00:00.000Z. ",
) {
	const reply = await scriptedModel().doGenerate({
		prompt: [
			{ role: "system", content: system },
			{ role: "user", content: [{ type: "text", text }] },
		],
		tools: tools.map((name) => ({ type: "function", name, inputSchema: {} })),
	} as never);
	return reply.content.map((c) =>
		c.type === "tool-call" ? { tool: c.toolName, ...JSON.parse(c.input) } : c.type === "text" ? c.text : c.type,
	);
}

test("INV-scripted-model: a task titled with prayer is task data, read from the Tasks tools", async () => {
	const classify = await scriptedModel().doGenerate({
		prompt: [{ role: "user", content: [{ type: "text", text: 'Find the task titled "Pray for the launch"' }] }],
		responseFormat: { type: "json" },
	} as never);
	assert.deepEqual(classify.content, [{ type: "text", text: '{"kind":"application"}' }]);
	const [first] = await step('Find the task titled "Pray for the launch"', ["tasks_read", "people_read"]);
	assert.deepEqual(first, {
		tool: "tasks_read",
		operation: "tasks.list",
		input: {
			search: "Pray for the launch",
			statuses: ["not_started", "in_progress", "blocked", "complete", "no_longer_needed"],
		},
	});
});

test("INV-scripted-model: a weekly reminder is one tasks.create review due on the church's next Monday", async () => {
	const [first] = await step("remind me every monday to review the pipeline", ["tasks_read", "propose_change"]);
	assert.deepEqual(first, {
		tool: "propose_change",
		operation: "tasks.create",
		input: {
			title: "Review the pipeline",
			due: { kind: "local_date", date: "2026-11-16" },
			assigneeIds: ["me"],
			recurrence: { frequency: "weekly" },
		},
	});
});

test("INV-scripted-model: a context with no task tools says it can't read tasks", async () => {
	assert.deepEqual(await step("whats overdue", []), [
		"I can't read tasks or follow-ups in this context. Switch to a church to ask about its tasks.",
	]);
});
