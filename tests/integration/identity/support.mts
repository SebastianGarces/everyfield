import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { testDatabase } from "../../support/test-database.mts";
import { authorizeAccountMail, createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import { claimDue } from "../../../packages/domain/src/jobs/queue.ts";

export async function fixture() {
	const t = await testDatabase({ prefix: "wp005", roles: { runtime: ["runtime"], auth: ["auth"] }, max: 8 });
	const { admin: db } = t,
		{ runtime, auth: authDb } = t.pools;
	const admissionDb = t.connect("runtime", { max: 3 });
	const deliveryRequests: Array<() => Promise<void>> = [];
	const effects: Array<{ to: string; text: string; key: string }> = [],
		diagnostics: unknown[] = [];
	let mailFault = false,
		ip: string | null = "127.0.0.1",
		providerFault = false;
	const addressKey = randomBytes(32),
		encryptionKey = randomBytes(32),
		secret = randomBytes(32).toString("hex");
	const mail = createMailService({
		db: runtime,
		encryptionKey,
		addressKey,
		from: "security@example.test",
		authorize: (tx, mail) =>
			authorizeAccountMail(tx, mail, (email) => createHmac("sha256", addressKey).update(email).digest("hex")),
		transport: {
			async send(payload, key) {
				if (providerFault) return { kind: "unknown" };
				effects.push({ to: payload.to, text: payload.text, key });
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw Error("server_failed");
	const origin = `http://127.0.0.1:${address.port}`;
	const service = createIdentityService({
		db: runtime,
		authDb,
		admissionDb,
		scheduleDelivery: (work) => deliveryRequests.push(work),
		origin,
		secret,
		trustedIp: () => ip,
		enqueueMail: async (tx, m) => {
			if (mailFault) throw Error("synthetic_mail_outage");
			return mail.enqueue(tx, {
				owner: { kind: "account", id: m.accountId },
				purpose: m.purpose,
				logicalKey: m.logicalKey,
				recipient: m.accountId,
				address: m.address,
				content: { subject: m.subject, text: m.text },
				operation: null,
				notice: null,
				eligibleAt: new Date().toISOString(),
			});
		},
		diagnostic: (v) => diagnostics.push(v),
	});
	server.on("request", async (req, res) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers))
				if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
			const response = await service.handle(
				new Request(origin + req.url, {
					method: req.method,
					headers,
					...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
				}),
			);
			res.statusCode = response.status;
			response.headers.forEach((v, k) => {
				if (k !== "set-cookie") res.setHeader(k, v);
			});
			if (response.headers.getSetCookie().length) res.setHeader("set-cookie", response.headers.getSetCookie());
			res.end(Buffer.from(await response.arrayBuffer()));
		} catch {
			res.statusCode = 500;
			res.end("fixture_failed");
		}
	});
	const req = (path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) =>
		fetch(origin + "/api/auth/" + path, {
			method: body === undefined ? "GET" : "POST",
			headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	async function runDeliveryRequests() {
		while (deliveryRequests.length) await deliveryRequests.shift()?.();
	}
	async function dispatch() {
		await runDeliveryRequests();
		const claims = await claimDue(runtime, ["mail"], 25);
		for (const claim of claims) await mail.dispatch(claim);
	}
	async function close() {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
		await t.close();
	}
	const runtimeSettingsUrl = t.logins.runtime.url,
		authSettingsUrl = t.logins.auth.url;
	const previewSettings = {
		IDENTITY_DATABASE_URL: runtimeSettingsUrl.href,
		IDENTITY_AUTH_DATABASE_URL: authSettingsUrl.href,
		IDENTITY_SECRET: secret,
		IDENTITY_MAIL_KEY: encryptionKey.toString("hex"),
		IDENTITY_ADDRESS_KEY: addressKey.toString("hex"),
		IDENTITY_MAIL_FROM: "security@example.test",
	};
	return {
		previewSettings,
		db,
		runtime,
		authDb,
		req,
		origin,
		dispatch,
		runDeliveryRequests,
		pendingDeliveryCount: () => deliveryRequests.length,
		effects,
		diagnostics,
		service,
		mail,
		close,
		setMailFault(v: boolean) {
			mailFault = v;
		},
		setIp(v: string | null) {
			ip = v;
		},
		setProviderFault(v: boolean) {
			providerFault = v;
		},
	};
}
export const password = "Fixture-old-pass-1";
export function cookie(response: Response) {
	return response.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
}
export async function register(f: Awaited<ReturnType<typeof fixture>>, email: string, kind = "discovery") {
	return f.req("register", { kind, name: "Synthetic", email, password, requestKey: randomUUID() });
}
export async function signIn(f: Awaited<ReturnType<typeof fixture>>, email: string, secret = password) {
	return f.req("sign-in/email", { email, password: secret });
}
