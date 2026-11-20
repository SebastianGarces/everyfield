import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { showSurface, type FeatureMap } from "../../ci/feature-maps.ts";

const installed = spawnSync("agent-browser", ["--version"], { encoding: "utf8" }).status === 0;
const skip = installed ? false : "agent-browser is not installed (CI's tooling job installs it)";
const session = `feature-map-text-${process.pid}`;

const PAGE = `<!doctype html><html><head><title>Access</title></head><body><main>
<h1><svg width="8" height="8"><path d="M0 0h8v8z"/></svg>Request access</h1>
<p style="visibility: hidden">Choose the one that describes you.</p>
<p style="display: none">Enter an email address.</p>
<p>Your request is
  in.</p>
</main></body></html>`;

const SERVER = `
import { createServer } from "node:http";
const server = createServer((request, response) => {
	if (request.url === "/api") {
		response.setHeader("content-type", "application/json");
		return response.end(JSON.stringify({ status: "unauthorized", retries: 3 }));
	}
	response.setHeader("content-type", "text/html");
	response.end(process.env.PAGE);
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

let server: ChildProcess | undefined;
let origin = "";

before(async () => {
	const child = spawn(process.execPath, ["--input-type=module", "-e", SERVER], {
		env: { ...process.env, PAGE },
		stdio: ["ignore", "pipe", "inherit"],
	});
	server = child;
	const [port] = (await once(child.stdout!, "data")) as [Buffer];
	origin = `http://127.0.0.1:${port.toString().trim()}`;
});

after(() => {
	if (installed) spawnSync("agent-browser", ["--session", session, "close"]);
	server?.kill();
	for (const suffix of ["config", "target"])
		rmSync(join(homedir(), ".agent-browser", `${session}.${suffix}`), { force: true });
});

type Surface = FeatureMap["surfaces"][number];

function printedState(open: string, text: string): string {
	const surface = {
		id: "access.request",
		says: "A visitor asks for access.",
		routes: ["/access"],
		reach: [],
		personas: { visitor: "none" },
		behaviors: [],
		states: [{ id: "checked", reach: { persona: "visitor", open, seed: "qa" }, expect: [{ text }] }],
	} as unknown as Surface;
	const shown = showSurface(surface);
	return shown.slice(shown.indexOf("```bash\n") + 8, shown.lastIndexOf("\n```"));
}

function runs(open: string, text: string): boolean {
	const script = `agent-browser() { command agent-browser --session ${session} "$@"; }\n${printedState(open, text)}`;
	const child = spawnSync("bash", ["-e", "-c", script], {
		encoding: "utf8",
		env: { ...process.env, ORIGIN: origin, AGENT_BROWSER_DEFAULT_TIMEOUT: "1500" },
	});
	return child.status === 0;
}

test(
	"INV-feature-maps: an exact text check passes on an element's whole visible text and fails on hidden text",
	{ skip },
	() => {
		assert.deepEqual(
			{
				heading: runs("/access", "Request access"),
				wrapped: runs("/access", "Your request is in."),
				part: runs("/access", "Request"),
				invisible: runs("/access", "Choose the one that describes you."),
				undisplayed: runs("/access", "Enter an email address."),
			},
			{ heading: true, wrapped: true, part: false, invisible: false, undisplayed: false },
		);
	},
);

test("INV-feature-maps: an exact text check on a bare JSON response matches a value, not a key", { skip }, () => {
	assert.deepEqual(
		{ value: runs("/api", "unauthorized"), number: runs("/api", "3"), key: runs("/api", "status") },
		{ value: true, number: true, key: false },
	);
});
