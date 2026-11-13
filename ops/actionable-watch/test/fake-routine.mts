// A local HTTPS stand-in for the routine's webhook, for tests only. It never talks to the real routine.
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Seen = {
	method: string;
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
};
/** A status code, "hang" (never answer) or "reset" (drop the connection after reading the request). */
export type Reply = number | "hang" | "reset";

export type FakeRoutine = {
	origin: string;
	ca: string;
	caPath: string;
	seen: Seen[];
	/** replies are used in order; the last one repeats */
	replies: Reply[];
	close(): Promise<void>;
};

let cert: Promise<{ key: string; cert: string; caPath: string }> | undefined;

function selfSigned() {
	cert ??= (async () => {
		const dir = await mkdtemp(join(tmpdir(), "actionable-watch-cert-"));
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=IP:127.0.0.1,DNS:localhost",
				"-keyout",
				join(dir, "key.pem"),
				"-out",
				join(dir, "cert.pem"),
			],
			{ stdio: "ignore" },
		);
		return {
			key: await readFile(join(dir, "key.pem"), "utf8"),
			cert: await readFile(join(dir, "cert.pem"), "utf8"),
			caPath: join(dir, "cert.pem"),
		};
	})();
	return cert;
}

export async function fakeRoutine(replies: Reply[] = [200]): Promise<FakeRoutine> {
	const tls = await selfSigned();
	const seen: Seen[] = [];
	const state = { replies };
	let i = 0;
	const server: Server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
			const reply = state.replies[Math.min(i++, state.replies.length - 1)]!;
			if (reply === "hang") return;
			if (reply === "reset") return void req.socket.destroy();
			res.writeHead(reply, { "content-type": "text/plain" }).end("ok");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `https://127.0.0.1:${port}`,
		ca: tls.cert,
		caPath: tls.caPath,
		seen,
		get replies() {
			return state.replies;
		},
		set replies(r: Reply[]) {
			state.replies = r;
			i = 0;
		},
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}

/** Writes `webhook.json` the way the README tells Sebastian to: owned by the user, mode 0600. */
export async function writeConfig(dir: string, config: unknown, mode = 0o600): Promise<string> {
	const path = join(dir, "webhook.json");
	await writeFile(path, typeof config === "string" ? config : JSON.stringify(config), { mode });
	await chmod(path, mode);
	return path;
}
