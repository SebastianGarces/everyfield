import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

export const PAID = { EVRY_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-test-not-a-key" };
export const KEYED = { ...PAID, EVF_WIKI_EMBEDDINGS: "openai" };
export const PRODUCTION = { ...KEYED, VERCEL_ENV: "production" };
export const CHAT = { model: "gpt-6-luna", endpoint: "https://api.openai.com/v1/responses", sdk: "@ai-sdk/openai" };
export const EMBEDDING = {
	model: "text-embedding-3-small",
	endpoint: "https://api.openai.com/v1/embeddings",
	sdk: "fetch",
};
export const RECORD = {
	verifiedOn: "2026-10-12",
	programSharing: "off",
	zeroDataRetention: "verified",
	region: "us",
	cache: "in-memory",
	paths: [CHAT, EMBEDDING],
};
export const recorded = (record: unknown) => ({ ...PRODUCTION, AI_PROVIDER_RECORD: JSON.stringify(record) });
const without = (key: keyof typeof RECORD) => Object.fromEntries(Object.entries(RECORD).filter(([k]) => k !== key));
const chat = (change: Partial<typeof CHAT>) => ({ ...RECORD, paths: [{ ...CHAT, ...change }, EMBEDDING] });

export const UNVERIFIED: [name: string, record: unknown][] = [
	...(Object.keys(RECORD) as (keyof typeof RECORD)[]).map((key): [string, unknown] => [`no ${key}`, without(key)]),
	["sharing left on", { ...RECORD, programSharing: "on" }],
	["sharing true", { ...RECORD, programSharing: true }],
	["zero data retention claimed", { ...RECORD, zeroDataRetention: "claimed" }],
	["zero data retention false", { ...RECORD, zeroDataRetention: false }],
	["a store: false request as the record", { store: false }],
	["a store: false request in place of zero data retention", { ...without("zeroDataRetention"), store: false }],
	["a claimed enrollment", { enrolled: true, credits: true }],
	["a claimed enrollment beside the record", { ...RECORD, enrolled: true }],
	["another region", { ...RECORD, region: "unverified" }],
	["another cache", { ...RECORD, cache: "unverified" }],
	["no path", { ...RECORD, paths: [] }],
	["another model", chat({ model: "gpt-6-sol" })],
	["another endpoint", chat({ endpoint: "https://proxy.example.test/v1/responses" })],
	["another SDK path", chat({ sdk: "fetch" })],
	["a path with no model", { ...RECORD, paths: [{ endpoint: CHAT.endpoint, sdk: CHAT.sdk }] }],
	["a path with no endpoint", { ...RECORD, paths: [{ model: CHAT.model, sdk: CHAT.sdk }] }],
	["a path with no SDK", { ...RECORD, paths: [{ model: CHAT.model, endpoint: CHAT.endpoint }] }],
	["the embedding path only", { ...RECORD, paths: [EMBEDDING] }],
	["a date after today", { ...RECORD, verifiedOn: "2099-01-01" }],
	["a date that is not a day", { ...RECORD, verifiedOn: "2026-02-30" }],
	["a date that is not a date", { ...RECORD, verifiedOn: "yesterday" }],
	["a project identifier", { ...RECORD, paths: [CHAT, EMBEDDING, { ...CHAT, model: "proj_abc123" }] }],
	["an organization identifier", { ...RECORD, paths: [CHAT, EMBEDDING, { ...CHAT, sdk: "org-abc123" }] }],
	["a key", { ...RECORD, paths: [CHAT, EMBEDDING, { ...CHAT, sdk: "sk-abc123" }] }],
	["an account field", { ...RECORD, account: "acme" }],
	["a user-approved retention", { ...RECORD, userApprovedRetentionDays: 30 }],
	["a list", [RECORD]],
	["a bare claim", "verified"],
	["true", true],
	["null", null],
];

export async function withEnv<T>(env: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
	const keys = ["VERCEL_ENV", "AI_PROVIDER_RECORD", "EVRY_SCRIPTED_MODEL", ...Object.keys(KEYED)];
	const held = keys.map((key) => [key, process.env[key]] as const);
	const put = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	for (const key of keys) put(key, env[key]);
	try {
		return await body();
	} finally {
		for (const [key, value] of held) put(key, value);
	}
}

export type Sent = { url: string; body: Record<string, unknown> };
export async function withProvider<T>(answer: (sent: Sent) => Response | Promise<Response>, body: () => Promise<T>) {
	const sent: Sent[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const call = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
		sent.push(call);
		return answer(call);
	};
	try {
		return { value: await body(), sent };
	} finally {
		globalThis.fetch = real;
	}
}
export const neverCalled = () => assert.fail("the provider is never called here");

const USAGE = { input_tokens: 10, output_tokens: 5 };
export const classified = () =>
	Response.json({
		id: "resp_c",
		created_at: 1,
		model: PAID.EVRY_MODEL,
		output: [
			{
				type: "message",
				role: "assistant",
				id: "msg_c",
				content: [{ type: "output_text", text: '{"kind":"application"}', annotations: [] }],
			},
		],
		usage: USAGE,
	});
type Step = { tool: string; input: unknown }[] | string;
export function streamed(step: Step, n: number) {
	const reasoning = { type: "reasoning", id: `rs_${n}`, encrypted_content: `SEALED-${n}`, summary: [] };
	const items =
		typeof step === "string"
			? [{ type: "message", id: `msg_${n}` }]
			: step.map((call, i) => ({
					type: "function_call",
					id: `fc_${n}_${i}`,
					call_id: `call_${n}_${i}`,
					name: call.tool,
					arguments: JSON.stringify(call.input),
					status: "completed",
				}));
	const events = [
		{ type: "response.created", response: { id: `resp_${n}`, created_at: 1, model: PAID.EVRY_MODEL } },
		{ type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: null } },
		{ type: "response.output_item.done", output_index: 0, item: reasoning },
		...items.flatMap((item, i) => [
			{ type: "response.output_item.added", output_index: i + 1, item: { ...item, arguments: "" } },
			...(typeof step === "string"
				? [{ type: "response.output_text.delta", item_id: item.id, output_index: 1, delta: step }]
				: []),
			{ type: "response.output_item.done", output_index: i + 1, item },
		]),
		{ type: "response.completed", response: { usage: USAGE } },
	];
	return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

export async function traceSink() {
	const bodies: string[] = [];
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (c: Buffer) => chunks.push(c));
		request.on("end", () => {
			const raw = Buffer.concat(chunks);
			bodies.push(String(request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw));
			response.writeHead(200, { "content-type": "application/json" }).end("{}");
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		env: {
			LANGFUSE_PUBLIC_KEY: "pk-lf-test",
			LANGFUSE_SECRET_KEY: "sk-lf-test",
			LANGFUSE_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		},
		take: () => bodies.splice(0).join("\n"),
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}
