import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { QA_LOGINS } from "../qa/qa-guard.ts";
import { IMAGE } from "../../scripts/throwaway-postgres.ts";
import {
	AppError,
	appDir,
	EXIT,
	firstLine,
	readJson,
	readLocalApp,
	removeAppDir,
	run,
	sleepSync,
	writeLocalApp,
	writePrivate,
	type LocalApp,
	type Ports,
	type Repo,
} from "./state.ts";

export type Persona = keyof typeof QA_LOGINS;

export const PERSONAS: Record<Persona, string> = {
	owner: "Daniel Reyes, Owner of Harvest Point (QA): every planter screen, Settings, seats, sharing",
	admin: "Lena Park, Admin of Harvest Point (QA): planter screens, Settings without ownership transfer",
	member: "Ruth Allen, Member of Harvest Point (QA): read-mostly planter screens, own tasks",
	member2: "Owen Price, second Member of Harvest Point (QA): a seat the Owner may remove",
	signup: "Hannah Cole, verified sign-up with no church yet: onboarding",
	riverside: "Rachel Moss, Owner of Riverside (QA): a second church; Ana Lee is in both",
	network: "Marcus Bell, Admin of Harvest Network (QA): /network oversight",
	sending: "Grace Moreno, director of Grace Church (QA): sending-church oversight, wiki copies",
	triage: "Tess Morgan, seatless feedback triager: /feedback/triage",
	graceOwner: "Dana Brooks, Owner of Grace Austin (QA): /organization/pipeline, programs, reviews",
	graceAdmin: "Luis Ortega, Admin of Grace Austin (QA): pipeline and programs",
	graceDirector: "Ana Ruiz, residency director at Grace Austin (QA): residency program, notes",
	graceStaff: "Dee Walker, Member at Grace Austin (QA) responsible for one pipeline person",
	graceMember: "Ben Carter, Member at Grace Austin (QA) with no pipeline duty",
	resident: "Casey Lee, linked resident with no seat: /my-residency",
	hillOwner: "Ruth Calder, Owner of Hill Country Network (QA): network side of the multiplication example",
};

export function personaKey(raw: string): Persona {
	const key = (Object.keys(PERSONAS) as Persona[]).find((name) => name.toLowerCase() === raw.toLowerCase());
	if (!key) throw new AppError(EXIT.usage, `unknown persona ${raw}. Known: ${Object.keys(PERSONAS).join(", ")}`);
	return key;
}

type Secrets = {
	pgPassword: string;
	rolePassword: string;
	identitySecret: string;
	mailKey: string;
	addressKey: string;
	optOutKey: string;
	cronSecret: string;
	bucketSecret: string;
};
type Cookies = Partial<Record<Persona, { name: string; value: string }>>;

const secretsPath = (repo: Repo) => join(appDir(repo), "secrets.json");
const cookiesPath = (repo: Repo) => join(appDir(repo), "cookies.json");
const setupLog = (repo: Repo) => join(appDir(repo), "setup.log");
const appLog = (repo: Repo) => join(appDir(repo), "app.log");
const readyMark = (repo: Repo) => join(appDir(repo), "ready");
const dbUrl = (user: string, password: string, port: number) =>
	`postgres://${user}:${password}@127.0.0.1:${port}/everyfield_ci`;

const startOf = (pid: number) => run("ps", ["-o", "lstart=", "-p", String(pid)]).stdout.trim();

function ours(pid: number | undefined, start: string | undefined, marker: string): boolean {
	if (!pid || !start) return false;
	const seen = run("ps", ["-o", "lstart=,command=", "-p", String(pid)]).stdout.trim();
	return seen.startsWith(start) && seen.includes(marker);
}

const serving = (app: LocalApp) => ours(app.pid, app.pidStart, "tools/app/main.ts _serve");
const starting = (app: LocalApp) => ours(app.upPid, app.upStart, "tools/app/main.ts");

export function staleNote(repo: Repo): string | null {
	const app = readLocalApp(repo);
	if (!app || app.mode !== "prod" || !serving(app) || app.fingerprint === fingerprint(repo.root)) return null;
	return `! the app serves ${app.head}, but the worktree changed since: app up restarts it on this code`;
}

function watchUp(repo: Repo, container: string) {
	const child = spawn(
		"sh",
		[
			"-c",
			'while kill -0 "$1" 2>/dev/null; do sleep 1; done; [ -f "$2" ] || docker rm -f -v "$3" >/dev/null 2>&1',
			"watch-up",
			String(process.pid),
			readyMark(repo),
			container,
		],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
}

function freePort(): Promise<number> {
	return new Promise((done, failed) => {
		const server = createServer();
		server.once("error", failed);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => done(port));
		});
	});
}

function tsxLoader(root: string): string {
	for (const pkg of ["packages/db", "packages/domain"]) {
		const path = join(root, pkg, "node_modules/tsx/dist/esm/index.mjs");
		if (existsSync(path)) return "file://" + realpathSync(path);
	}
	throw new AppError(EXIT.noTarget, `no tsx under ${root}/packages/db. Run corepack pnpm install --offline first`);
}

function fingerprint(root: string): string {
	return createHash("sha256")
		.update(
			[
				run("git", ["-C", root, "rev-parse", "HEAD"]).stdout,
				run("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"]).stdout,
				run("git", ["-C", root, "diff", "HEAD"]).stdout,
			].join("\0"),
		)
		.digest("hex");
}

function log(repo: Repo, label: string, result: ReturnType<typeof run>) {
	writeFileSync(setupLog(repo), `\n### ${label} (exit ${result.status})\n${result.stdout}${result.stderr}`, {
		flag: "a",
	});
}

function appEnv(app: LocalApp, secrets: Secrets, repo: Repo): Record<string, string> {
	const runtime = dbUrl("evf_qa_runtime", secrets.rolePassword, app.ports.pg);
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		TMPDIR: process.env.TMPDIR ?? "/tmp",
		NEXT_TELEMETRY_DISABLED: "1",
		DATABASE_URL: runtime,
		DATABASE_URL_UNPOOLED: runtime,
		IDENTITY_DATABASE_URL: runtime,
		IDENTITY_AUTH_DATABASE_URL: dbUrl("evf_qa_auth", secrets.rolePassword, app.ports.pg),
		IDENTITY_ORIGIN: app.origin,
		IDENTITY_SECRET: secrets.identitySecret,
		IDENTITY_MAIL_KEY: secrets.mailKey,
		IDENTITY_ADDRESS_KEY: secrets.addressKey,
		IDENTITY_MAIL_FROM: `app-${repo.name}@example.test`,
		NOTIFICATION_OPT_OUT_KEYS: secrets.optOutKey,
		EVERYFIELD_DEV_OUTBOX: join(appDir(repo), "outbox"),
		EVRY_SCRIPTED_MODEL: "1",
		CRON_SECRET: secrets.cronSecret,
		AWS_BUCKET_NAME: `app-${repo.name}`,
		AWS_ACCESS_KEY_ID: `app-${repo.name}`,
		AWS_SECRET_ACCESS_KEY: secrets.bucketSecret,
		AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${app.ports.bucket}`,
		AWS_REGION: "auto",
		...(app.mode === "prod" ? { NODE_ENV: "production" } : {}),
	};
}

export async function up(repo: Repo, options: { mode: string; timeoutSeconds: number }): Promise<string> {
	if (options.mode !== "dev" && options.mode !== "prod") throw new AppError(EXIT.usage, "--mode is dev or prod");
	const existing = readLocalApp(repo);
	let restarted = "";
	if (existing && starting(existing) && !existing.pid)
		throw new AppError(EXIT.noTarget, `another app up is starting this worktree's app (phase ${existing.phase})`);
	if (existing && serving(existing)) {
		const fresh = existing.mode === "dev" || existing.fingerprint === fingerprint(repo.root);
		if (fresh && existing.mode === options.mode)
			return `already up ${existing.origin} ${existing.mode} ${existing.head} on this code`;
		restarted = fresh
			? ` (restarted in ${options.mode} mode)`
			: ` (restarted: the code changed since ${existing.head})`;
	}
	if (existing) down(repo);
	const web = join(repo.root, "apps/web");
	if (!existsSync(join(web, "node_modules/next/dist/bin/next")))
		throw new AppError(EXIT.noTarget, "apps/web has no node_modules. Run corepack pnpm install --offline first");
	const envFiles = readdirSync(web).filter((name) => name.startsWith(".env") && name !== ".env.example");
	if (envFiles.length)
		throw new AppError(
			EXIT.noTarget,
			`apps/web holds ${envFiles.join(", ")}, which Next would load over the app's own settings. Move it out of apps/web unread, then rerun`,
		);
	const started = Date.now();
	removeAppDir(repo);
	mkdirSync(join(appDir(repo), "outbox"), { recursive: true, mode: 0o700 });
	const hex = (bytes: number) => randomBytes(bytes).toString("hex");
	const secrets: Secrets = {
		pgPassword: hex(18),
		rolePassword: hex(18),
		identitySecret: hex(32),
		mailKey: hex(32),
		addressKey: hex(32),
		optOutKey: randomBytes(32).toString("base64"),
		cronSecret: hex(24),
		bucketSecret: hex(16),
	};
	writePrivate(secretsPath(repo), secrets);
	const ports: Ports = { app: await freePort(), pg: await freePort(), bucket: await freePort() };
	const container = `evf-app-${createHash("sha256").update(repo.root).digest("hex").slice(0, 12)}`;
	const app: LocalApp = {
		worktree: repo.root,
		origin: `http://127.0.0.1:${ports.app}`,
		mode: options.mode,
		head: run("git", ["-C", repo.root, "rev-parse", "--short=9", "HEAD"]).stdout.trim(),
		ports,
		container,
		image: IMAGE,
		phase: "database",
		startedAt: new Date().toISOString(),
		upPid: process.pid,
		upStart: startOf(process.pid),
		fingerprint: fingerprint(repo.root),
	};
	writeLocalApp(repo, app);
	watchUp(repo, container);
	const phase = (name: string) => {
		app.phase = name;
		writeLocalApp(repo, app);
	};
	const fail = (message: string): never => {
		const kept = join(repo.common, "evf-app", `${repo.name}-failed.log`);
		for (const file of [setupLog(repo), appLog(repo)])
			if (existsSync(file)) writeFileSync(kept, readFileSync(file), { flag: "a" });
		const at = app.phase;
		down(repo);
		throw new AppError(EXIT.noTarget, `up failed at ${at}: ${message}. Log: ${kept}`);
	};

	run("docker", ["rm", "-f", "-v", container]);
	const docker = run("docker", [
		...["run", "-d", "--rm", "--name", container, "--label", `everyfield.app.worktree=${repo.name}`],
		...["-e", "POSTGRES_USER=ci", "-e", `POSTGRES_PASSWORD=${secrets.pgPassword}`, "-e", "POSTGRES_DB=everyfield_ci"],
		...["-p", `127.0.0.1:${ports.pg}:5432`, "--shm-size=256m", IMAGE],
		...["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_connections=200"],
	]);
	if (docker.status !== 0) fail(`docker run: ${firstLine(docker.stderr || docker.stdout)}`);
	const ready = Date.now() + 60_000;
	while (
		run("docker", ["exec", container, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "ci", "-d", "everyfield_ci"])
			.status !== 0
	) {
		if (Date.now() > ready) fail("the database was not ready within 60 s");
		sleepSync(300);
	}
	phase("migrate");
	const ownerUrl = dbUrl("ci", secrets.pgPassword, ports.pg);
	const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp" };
	const migrated = run("corepack", ["pnpm", "db:migrate"], {
		cwd: repo.root,
		env: {
			...baseEnv,
			DATABASE_URL: ownerUrl,
			DATABASE_URL_UNPOOLED: ownerUrl,
			CI: "true",
			EARLY_ACCESS_TEST_DATABASE: "1",
		},
	});
	log(repo, "db:migrate", migrated);
	if (migrated.status !== 0) fail("pnpm db:migrate failed");

	phase("seed");
	const tsx = tsxLoader(repo.root);
	const seeded = run(process.execPath, ["--conditions=react-server", "--import", tsx, "tools/qa/qa-seed.ts"], {
		cwd: repo.root,
		env: {
			...baseEnv,
			DATABASE_URL: ownerUrl,
			QA_ROLE_PASSWORD: secrets.rolePassword,
			IDENTITY_MAIL_KEY: secrets.mailKey,
			IDENTITY_ADDRESS_KEY: secrets.addressKey,
		},
	});
	log(repo, "qa-seed", seeded);
	if (seeded.status !== 0 || !/QA seed wrote/.test(seeded.stdout)) fail("the QA seed failed");

	phase("signin");
	const signed = signIn(repo, app, secrets, Object.keys(PERSONAS) as Persona[]);
	if (!signed.length) fail("no persona could sign in");

	if (app.mode === "prod") {
		phase("build");
		const print = fingerprint(repo.root);
		const built = readJson<{ fingerprint: string }>(join(repo.common, "evf-app", `${repo.name}-build.json`));
		if (built?.fingerprint !== print || !existsSync(join(web, ".next/BUILD_ID"))) {
			const build = run(process.execPath, [join(web, "node_modules/next/dist/bin/next"), "build"], {
				cwd: web,
				env: { ...appEnv(app, secrets, repo), NODE_ENV: "production" },
			});
			log(repo, "next build", build);
			if (build.status !== 0) fail("next build failed");
			writePrivate(join(repo.common, "evf-app", `${repo.name}-build.json`), { fingerprint: print });
		}
	}

	phase("start");
	const out = openSync(appLog(repo), "a");
	const supervisor = spawn(
		process.execPath,
		["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./main.ts", import.meta.url)), "_serve"],
		{ cwd: repo.root, detached: true, stdio: ["ignore", out, out], env: baseEnv },
	);
	supervisor.unref();
	app.pid = supervisor.pid;
	app.pidStart = supervisor.pid ? startOf(supervisor.pid) : undefined;
	writeLocalApp(repo, app);
	const deadline = Date.now() + options.timeoutSeconds * 1000;
	for (;;) {
		if (!serving(app)) fail(`the app process exited; see ${appLog(repo)}`);
		try {
			const response = await fetch(app.origin + "/access", {
				redirect: "manual",
				signal: AbortSignal.timeout(120_000),
			});
			if (response.status === 200) break;
		} catch {}
		if (Date.now() > deadline) fail(`the app did not serve /access within ${options.timeoutSeconds} s`);
		sleepSync(1000);
	}
	app.readyMs = Date.now() - started;
	writeFileSync(readyMark(repo), app.startedAt);
	phase("ready");
	return `up ${app.origin} ${app.mode} ${app.head} · QA seed, ${signed.length} personas · ${Math.round(app.readyMs / 1000)} s${restarted}`;
}

function signIn(repo: Repo, app: LocalApp, secrets: Secrets, personas: Persona[]): Persona[] {
	const out = join(appDir(repo), `signin-${process.pid}.json`);
	const input = {
		origin: app.origin,
		secret: secrets.identitySecret,
		runtimeUrl: dbUrl("evf_qa_runtime", secrets.rolePassword, app.ports.pg),
		authUrl: dbUrl("evf_qa_auth", secrets.rolePassword, app.ports.pg),
		out,
		personas,
	};
	const result = run(
		process.execPath,
		[
			"--conditions=react-server",
			"--import",
			tsxLoader(repo.root),
			fileURLToPath(new URL("./signin.ts", import.meta.url)),
			JSON.stringify(input),
		],
		{ cwd: repo.root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
	);
	log(repo, `sign-in ${personas.join(",")}`, result);
	const fresh = readJson<Cookies>(out) ?? {};
	rmSync(out, { force: true });
	writePrivate(cookiesPath(repo), { ...(readJson<Cookies>(cookiesPath(repo)) ?? {}), ...fresh });
	return Object.keys(fresh) as Persona[];
}

export function cookieFor(repo: Repo, persona: Persona, fresh: boolean): { name: string; value: string } {
	const app = readLocalApp(repo);
	if (!app || !serving(app))
		throw new AppError(EXIT.noTarget, "no local app is up for this worktree: run app up, or pass --cookie-file");
	const saved = readJson<Cookies>(cookiesPath(repo))?.[persona];
	if (saved && !fresh) return saved;
	const secrets = readJson<Secrets>(secretsPath(repo));
	if (!secrets) throw new AppError(EXIT.noTarget, "the local app lost its settings: run app down, then app up");
	if (!signIn(repo, app, secrets, [persona]).includes(persona))
		throw new AppError(EXIT.noTarget, `${persona} could not sign in; see ${setupLog(repo)}`);
	return readJson<Cookies>(cookiesPath(repo))![persona]!;
}

export function down(repo: Repo): string {
	const app = readLocalApp(repo);
	if (!app) return "no local app was up";
	const signal = (name: NodeJS.Signals) => {
		try {
			process.kill(-app.pid!, name);
		} catch {
			try {
				process.kill(app.pid!, name);
			} catch {}
		}
	};
	const ownServer = serving(app);
	if (ownServer) signal("SIGTERM");
	run("docker", ["rm", "-f", "-v", app.container]);
	const until = Date.now() + 10_000;
	while (ownServer && serving(app) && Date.now() < until) sleepSync(300);
	if (ownServer && serving(app)) signal("SIGKILL");
	removeAppDir(repo);
	return `down ${app.origin}`;
}

export async function status(repo: Repo): Promise<string> {
	const app = readLocalApp(repo);
	if (!app) return "no local app (app up starts one)";
	const running = serving(app);
	if (!running && !app.pid && starting(app)) return `${app.origin} ${app.mode} ${app.head} · starting (${app.phase})`;
	let http = "-";
	if (running)
		try {
			http = String(
				(await fetch(app.origin + "/access", { redirect: "manual", signal: AbortSignal.timeout(5000) })).status,
			);
		} catch {
			http = "no answer";
		}
	const stale = running && app.mode === "prod" && app.fingerprint !== fingerprint(repo.root);
	return `${app.origin} ${app.mode} ${app.head} · ${running ? `up (${app.phase}) http ${http}${stale ? " · stale: the worktree changed since, app up restarts it" : ""}` : `down (stopped at ${app.phase}; app down cleans up)`}`;
}

export function personas(): string {
	return (Object.entries(PERSONAS) as [Persona, string][]).map(([key, text]) => `${key.padEnd(14)}${text}`).join("\n");
}

function fakeBucket(origin: string): Server {
	const objects = new Map<string, Buffer>();
	const cors = {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET,PUT,HEAD,DELETE,OPTIONS",
		"access-control-allow-headers": "*",
		"access-control-expose-headers": "etag",
	};
	return createServer(async (request, response) => {
		for (const [key, value] of Object.entries(cors)) response.setHeader(key, value);
		const key = new URL(request.url ?? "/", "http://bucket").pathname;
		if (request.method === "OPTIONS") return response.end();
		if (request.method === "PUT") {
			if (request.headers["if-none-match"] === "*" && objects.has(key)) {
				response.statusCode = 412;
				return response.end();
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			objects.set(key, Buffer.concat(chunks));
			response.setHeader("etag", '"app"');
			return response.end();
		}
		if (request.method === "DELETE") {
			objects.delete(key);
			response.statusCode = 204;
			return response.end();
		}
		const stored = objects.get(key);
		if ((request.method === "GET" || request.method === "HEAD") && stored) {
			response.setHeader("content-length", stored.length);
			return response.end(request.method === "GET" ? stored : undefined);
		}
		response.setHeader("content-type", "application/xml");
		if (request.url?.includes("acl"))
			return response.end(
				'<?xml version="1.0" encoding="UTF-8"?><AccessControlPolicy><Owner><ID>app</ID></Owner><AccessControlList>' +
					'<Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>app</ID>' +
					"</Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>",
			);
		response.statusCode = 404;
		response.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code></Error>');
	});
}

export async function serve(repo: Repo): Promise<void> {
	const app = readLocalApp(repo);
	const secrets = readJson<Secrets>(secretsPath(repo));
	if (!app || !secrets) throw new AppError(EXIT.noTarget, "no local app state to serve");
	const bucket = fakeBucket(app.origin);
	await new Promise<void>((done) => bucket.listen(app.ports.bucket, "127.0.0.1", done));
	const web = join(repo.root, "apps/web");
	const next = join(web, "node_modules/next/dist/bin/next");
	const child = spawn(
		process.execPath,
		[next, app.mode === "prod" ? "start" : "dev", "-H", "127.0.0.1", "-p", String(app.ports.app)],
		{ cwd: web, env: appEnv(app, secrets, repo), stdio: "inherit" },
	);
	const stop = () => {
		child.kill("SIGTERM");
		bucket.close();
	};
	child.on("exit", (code) => {
		bucket.close();
		process.exit(code ?? 1);
	});
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
