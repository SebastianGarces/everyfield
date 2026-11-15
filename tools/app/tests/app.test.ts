import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

const FORM = `<!doctype html><html><head><title>Form</title><style>select, label { cursor: pointer }</style></head><body><main>
<label>Date <input type="date"></label>
<label>Start time <input type="time" value="18:30"></label>
<label>Code <input oninput="this.value = ''"></label>
<label>Kind <select><option>Vision</option><option>Team</option></select></label>
<label><input type="checkbox"> Remind me</label>
<label>Photo <input type="file"></label>
<button disabled onclick="document.title = 'ran'">Disabled save</button>
<button aria-disabled="true" onclick="if (this.getAttribute('aria-disabled') !== 'true') document.title = 'ran'">Aria disabled save</button>
<button>Noop</button>
<span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0)">Secret saved</span>
<p style="opacity: 0">Faded saved</p>
<p>Shown saved</p>
<div role="radiogroup" aria-label="Whose tasks" onclick="for (const r of this.children) r.setAttribute('aria-checked', String(r === event.target))">
<div role="radio" aria-checked="true" tabindex="0">Mine</div><div role="radio" aria-checked="false" tabindex="-1">All</div>
</div>
</main></body></html>`;

const SERVER = `
import { createServer } from "node:http";
const server = createServer((request, response) => {
	response.setHeader("content-type", "text/html");
	if (request.url === "/form") return response.end(process.env.FORM);
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
		env: { ...process.env, PAGE, FORM },
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
	for (const suffix of ["config", "target"])
		rmSync(join(homedir(), ".agent-browser", `${session}.${suffix}`), { force: true });
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
		out: 'no clickable named "Setings". Nearest: link "Settings" (eN), link "People" (eN), textbox "Email" (eN)',
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
		out: 'clicked switch "Share check-ins" · ~ eN switch "Share check-ins" [checked=true] · live "Saved"',
	});
	assert.deepEqual(app("snapshot"), {
		code: 0,
		out: '/ "Fixture" · main · 5 interactive · 1 changed since your last snapshot\n~ eN switch "Share check-ins" [checked=true]\nlive: "Saved"',
	});
	assert.deepEqual(app("snapshot"), {
		code: 0,
		out: '/ "Fixture" · main · 5 interactive · unchanged since your last snapshot\nlive: "Saved"',
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
			'2 ok clicked switch "Share check-ins" · ~ eN switch "Share check-ins" [checked=true] · live "Saved"',
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
				out: 'ok text "server better-auth.session_token=fixture-token" (visible)',
			});
			assert.deepEqual(app("expect", "--text", "client none"), { code: 0, out: 'ok text "client none" (visible)' });
		} finally {
			removeTemp(fixtures);
		}
	},
);

test("INV-app: fill reads the value back, names the kind, and fails when the field does not hold it", { skip }, () => {
	app("goto", "/form", "--url", origin);
	assert.deepEqual(app("fill", "Date", "2026-12-03"), {
		code: 0,
		out: 'filled date "Date" = "2026-12-03" · no change in interactive elements',
	});
	assert.deepEqual(
		app("fill", "Start time", "19:15").out,
		'filled time "Start time" = "19:15" · no change in interactive elements',
	);
	assert.deepEqual(app("fill", "Kind", "Team"), {
		code: 0,
		out: 'filled select "Kind" = "Team" · ~ eN option "Vision" · ~ eN option "Team" [selected]',
	});
	assert.deepEqual(app("fill", "Remind me", "on"), {
		code: 0,
		out: 'filled checkbox "Remind me" = "true" · ~ eN checkbox "Remind me" [checked=true]',
	});
	assert.deepEqual(app("fill", "Code", "abc"), {
		code: 1,
		out: 'FAIL textbox "Code" holds "" after fill (wanted "abc")',
	});
	assert.deepEqual(app("fill", "Month", "12"), {
		code: 3,
		out: '"Month" is one segment of a date or time field; fill the whole field: fill "Date" <YYYY-MM-DD> · fill "Start time" <HH:MM (24 h)>',
	});
});

test("INV-app: an action reports new live status text, the proof of a save", { skip }, () => {
	app("goto", "/", "--url", origin);
	assert.deepEqual(app("click", "Share check-ins"), {
		code: 0,
		out: 'clicked switch "Share check-ins" · ~ eN switch "Share check-ins" [checked=true] · live "Saved"',
	});
});

test("INV-app: snapshot diffs by role and name, so a reload that renumbers refs is unchanged", { skip }, () => {
	app("goto", "/", "--url", origin);
	app("snapshot");
	assert.equal(app("raw", "--", "reload").code, 0);
	assert.deepEqual(app("snapshot"), {
		code: 0,
		out: '/ "Fixture" · main · 5 interactive · unchanged since your last snapshot',
	});
});

test("INV-app: a click whose name belongs to another role or sits behind a dialog says so", { skip }, () => {
	app("goto", "/", "--url", origin);
	assert.deepEqual(app("click", "Email"), {
		code: 3,
		out: 'no clickable named "Email"; found textbox "Email" (eN): add --role textbox',
	});
	app("click", "Remind me later");
	assert.deepEqual(app("click", "Archived"), {
		code: 3,
		out: 'no clickable named "Archived" (a dialog is open; only its elements are reachable). Nearest: button "Cancel" (eN)',
	});
});

test(
	"INV-app: after the browser closes on its own, the next command reopens the last page as the last persona",
	{ skip },
	() => {
		const fixtures = mkdtempSync(join(tmpdir(), "app-cookie-"));
		try {
			const file = join(fixtures, "people.json");
			writeFileSync(file, JSON.stringify({ owner: { cookie: "better-auth.session_token=fixture-token" } }));
			app("login", "owner", "--cookie-file", file, "--goto", "/cookie", "--url", origin);
			spawnSync("agent-browser", ["--session", session, "--idle-timeout", "10m", "close"]);
			assert.match(
				app("status").out,
				/session app-test-\d+ closed \(was as owner at \/cookie; the next command reopens it\)/,
			);
			assert.deepEqual(app("expect", "--text", "server better-auth.session_token=fixture-token"), {
				code: 0,
				out: 'the browser had closed (idle timeout or crash): reopened as owner at /cookie\nok text "server better-auth.session_token=fixture-token" (visible)',
			});
		} finally {
			removeTemp(fixtures);
		}
	},
);

test("INV-app: --help prints the guide and exits 0", () => {
	const help = spawnSync(APP, ["--help"], { encoding: "utf8" });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /^app: drive this worktree's Everyfield/);
});

test("INV-app: fill refuses a file that does not exist and reads back the uploaded name and size", { skip }, () => {
	const fixtures = mkdtempSync(join(tmpdir(), "app-cookie-"));
	try {
		const photo = join(fixtures, "photo.txt");
		writeFileSync(photo, "hello");
		app("goto", "/form", "--url", origin);
		assert.deepEqual(app("fill", "Photo", join(fixtures, "missing.png")), {
			code: 2,
			out: `no readable file at ${join(fixtures, "missing.png")}`,
		});
		assert.deepEqual(app("fill", "Photo", photo), {
			code: 0,
			out: 'filled file "Photo" = "photo.txt (5 B)" · no change in interactive elements',
		});
	} finally {
		removeTemp(fixtures);
	}
});

test("INV-app: a click on a disabled control fails, and a click that changes nothing says so", { skip }, () => {
	app("goto", "/form", "--url", origin);
	assert.deepEqual(app("click", "Disabled save"), {
		code: 1,
		out: 'FAIL button "Disabled save" is disabled; the click would do nothing',
	});
	assert.deepEqual(app("click", "Aria disabled save"), {
		code: 1,
		out: 'FAIL button "Aria disabled save" is disabled; the click would do nothing',
	});
	assert.deepEqual(app("expect", "--title", "Form"), { code: 0, out: 'ok title "Form"' });
	assert.deepEqual(app("click", "Noop"), {
		code: 0,
		out: 'clicked button "Noop" · no change seen: no navigation, no element or live-text change',
	});
});

test(
	"INV-app: expect --text passes only on text a sighted person can see, unless asked for screen-reader text",
	{ skip },
	() => {
		app("goto", "/form", "--url", origin);
		assert.deepEqual(app("expect", "--text", "Shown saved"), { code: 0, out: 'ok text "Shown saved" (visible)' });
		assert.deepEqual(app("expect", "--text", "Secret saved", "--timeout", "300"), {
			code: 1,
			out: 'FAIL text "Secret saved" is on the page but not visible (hidden, clipped, transparent or covered) after 0.3 s; --screen-reader asserts text for assistive technology',
		});
		assert.deepEqual(app("expect", "--text", "Faded saved", "--timeout", "300").code, 1);
		assert.deepEqual(app("expect", "--text", "Secret saved", "--screen-reader"), {
			code: 0,
			out: 'ok text "Secret saved" (screen-reader text, not visible)',
		});
	},
);

test(
	"INV-app: fill finds a radio by its own text and a missing select option is a could-not-act exit 3",
	{ skip },
	() => {
		app("goto", "/form", "--url", origin);
		assert.deepEqual(app("fill", "All", "on"), {
			code: 0,
			out: 'filled radio "All" = "true" · ~ eN radio "Mine" [checked=false] · ~ eN radio "All" [checked=true]',
		});
		assert.equal(app("fill", "Kind", "Kiwi").code, 3);
	},
);
