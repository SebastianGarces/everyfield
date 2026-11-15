import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../../../bin/app", import.meta.url));
const installed = spawnSync("agent-browser", ["--version"], { encoding: "utf8" }).status === 0;
const skip = installed ? false : "agent-browser is not installed (CI's tooling job installs it)";

const PAGE = `<!doctype html><html><head><title>Fixture</title><style>
button, a, [role="switch"] { cursor: pointer } .plain { cursor: auto } button:disabled { cursor: not-allowed }
</style></head><body>
<nav><a href="/settings">Settings</a><a href="/people">People</a></nav>
<main><h1>Fixture</h1><label>Email <input name="email"></label>
<button role="switch" aria-checked="false" onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true')); document.getElementById('status').textContent = 'Saved'">Share check-ins</button>
<button class="plain" onclick="document.getElementById('confirm').showModal()">Remind me later</button>
<button disabled>Archived</button>
<p role="status" id="status"></p>
<dialog id="confirm"><p>Delete person?</p><button onclick="this.closest('dialog').close()">Cancel</button></dialog>
</main></body></html>`;

const SERVER = `
import { createServer } from "node:http";
const server = createServer((request, response) => {
	response.setHeader("content-type", "text/html");
	if (request.url !== "/cookie") return response.end(process.env.PAGE);
	response.end(\`<!doctype html><title>Cookie</title><p>server \${request.headers.cookie ?? "none"}</p><p id="client"></p><script>document.getElementById("client").textContent = "client " + (document.cookie || "none")</script>\`);
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

let server: ChildProcess | undefined;
let origin = "";
let repo = "";
const session = `app-test-${process.pid}`;

before(async () => {
	const child = spawn(process.execPath, ["--input-type=module", "-e", SERVER], {
		env: { ...process.env, PAGE },
		stdio: ["ignore", "pipe", "inherit"],
	});
	server = child;
	const [port] = (await once(child.stdout!, "data")) as [Buffer];
	origin = `http://127.0.0.1:${port.toString().trim()}`;
	repo = mkdtempSync(join(tmpdir(), "app-test-"));
	spawnSync("git", ["init", "-q", repo]);
});

after(() => {
	if (installed) app("close");
	server?.kill();
	removeTemp(repo);
});

function removeTemp(path: string) {
	if (dirname(path) !== tmpdir() || !/^app-(test|shots|cookie)-/.test(path.slice(tmpdir().length + 1)))
		throw new Error(`refused to delete ${path}`);
	rmSync(path, { recursive: true, force: true });
}

function app(...args: string[]): { code: number; out: string } {
	return appWith(undefined, ...args);
}

function appWith(input: string | undefined, ...args: string[]): { code: number; out: string } {
	const child = spawnSync(APP, ["--session", session, ...args], { cwd: repo, encoding: "utf8", input });
	return { code: child.status ?? -1, out: `${child.stdout}${child.stderr}`.replace(/\be\d+\b/g, "eN").trimEnd() };
}

test("INV-app: a misspelled click names the nearest accessible names and exits 3", { skip }, () => {
	assert.deepEqual(app("goto", "/", "--url", origin), { code: 0, out: '/ "Fixture" · 7 interactive' });
	assert.deepEqual(app("click", "Setings"), {
		code: 3,
		out: 'no clickable named "Setings". Nearest: link "Settings" (eN), link "People" (eN), button "Archived" (eN)',
	});
});

test("INV-app: snapshot lists main's interactive elements once, then only what changed", { skip }, () => {
	app("goto", "/", "--url", origin);
	assert.deepEqual(app("snapshot"), {
		code: 0,
		out: [
			'/ "Fixture" · main · 5 interactive',
			'eN heading "Fixture" [level=1]',
			'eN textbox "Email"',
			'eN switch "Share check-ins" [checked=false]',
			'eN button "Remind me later"',
			'eN button "Archived" [disabled]',
		].join("\n"),
	});
	assert.deepEqual(app("click", "Share check-ins"), {
		code: 0,
		out: 'clicked switch "Share check-ins" · ~ eN switch "Share check-ins" [checked=true]',
	});
	assert.deepEqual(app("snapshot"), {
		code: 0,
		out: '/ "Fixture" · main · 5 interactive · 1 changed since your last snapshot\n~ eN switch "Share check-ins" [checked=true]',
	});
	assert.deepEqual(app("snapshot"), {
		code: 0,
		out: '/ "Fixture" · main · 5 interactive · unchanged since your last snapshot',
	});
});

test("INV-app: cursor-audit names the one clickable without a pointer and passes the disabled one", { skip }, () => {
	app("goto", "/", "--url", origin);
	assert.deepEqual(app("cursor-audit"), {
		code: 1,
		out: '5 clickable, 1 wrong: button "Remind me later" cursor=auto want pointer',
	});
	assert.deepEqual(app("cursor-audit", "--scope", "nav"), { code: 0, out: "2 clickable, 0 wrong" });
});

test(
	"INV-app: shot writes 390 and 1440 px PNGs outside the repository and refuses a folder inside one",
	{ skip },
	() => {
		app("goto", "/", "--url", origin);
		const out = mkdtempSync(join(tmpdir(), "app-shots-"));
		try {
			assert.deepEqual(app("shot", "home", "--out", out), {
				code: 0,
				out: `${join(out, "home-390.png")} 390x844\n${join(out, "home-1440.png")} 1440x900`,
			});
			assert.deepEqual(readdirSync(out).sort(), ["home-1440.png", "home-390.png"]);
			const inside = join(repo, "shots");
			assert.deepEqual(app("shot", "home", "--out", inside), {
				code: 2,
				out: `${inside} is inside a git work tree; evidence stays outside the repository`,
			});
		} finally {
			removeTemp(out);
		}
	},
);

test("INV-app: do stops at the first failing expect with exit 1 and names the step", { skip }, () => {
	const steps = ["goto /", 'click "Share check-ins"', 'expect --text "Nope" --timeout 300', "shot never"].join("\n");
	assert.deepEqual(appWith(steps, "--url", origin, "do"), {
		code: 1,
		out: [
			'1 ok / "Fixture" · 7 interactive',
			'2 ok clicked switch "Share check-ins" · ~ eN switch "Share check-ins" [checked=true]',
			'3 FAIL text "Nope" not found within 0.3 s. Closest on page: "Saved"',
			'stopped at step 3 of 4: expect --text "Nope" --timeout 300',
		].join("\n"),
	});
});

test(
	"INV-app: login --cookie-file sets an httpOnly cookie the server receives and page script cannot read",
	{ skip },
	() => {
		const fixtures = mkdtempSync(join(tmpdir(), "app-cookie-"));
		try {
			const file = join(fixtures, "people.json");
			writeFileSync(file, JSON.stringify({ owner: { cookie: "better-auth.session_token=fixture-token" } }));
			assert.deepEqual(app("login", "owner", "--cookie-file", file, "--goto", "/cookie", "--url", origin), {
				code: 0,
				out: 'signed in owner → /cookie "Cookie" · 0 interactive',
			});
			assert.deepEqual(app("expect", "--text", "server better-auth.session_token=fixture-token"), {
				code: 0,
				out: 'ok text "server better-auth.session_token=fixture-token"',
			});
			assert.deepEqual(app("expect", "--text", "client none"), { code: 0, out: 'ok text "client none"' });
		} finally {
			removeTemp(fixtures);
		}
	},
);
