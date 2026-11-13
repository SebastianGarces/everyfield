// A recorded email service for the communication tests: the real Messages adapter (deliveryTransport in
// apps/web/src/features/communication/mail.ts) talks HTTP to this fake of the Resend email routes, which records
// every request. Behaviors per email id let a test refuse, drop or answer a cancel or time change, or say that an
// email already went out.
import { deliveryTransport } from "../../../apps/web/src/features/communication/mail.ts";

export type Recorded = { method: string; path: string; idempotencyKey: string | null; body: unknown };
type Held = { id: string; to: string; scheduledAt: string | null; lastEvent: string };
/** `fail`: the change call answers 500 and the email stays as it was. `drop`: the call throws, as a timeout would. */
type Fault = "fail" | "drop";

/** `env` is what the adapter's recipient rule reads. A test that sends to any address passes a production one. */
export function resendRecorder(
	env: Readonly<Record<string, string | undefined>> = process.env,
	settle: (ids: readonly string[]) => void = () => {
		throw new Error("a provider transport never settles captures");
	},
) {
	const requests: Recorded[] = [];
	const emails = new Map<string, Held>();
	const faults = new Map<string, Fault>();
	let batch: "accept" | "refuse" | "error" | ((index: number) => boolean) = "accept";
	let next = 0;

	const json = (status: number, body: unknown) => Response.json(body, { status });

	async function fetchFake(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		const headers = new Headers(init.headers);
		const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
		requests.push({ method, path: url.pathname, idempotencyKey: headers.get("Idempotency-Key"), body });
		if (url.pathname === "/emails/batch" && method === "POST") {
			if (batch === "refuse") return json(422, { message: "invalid" });
			if (batch === "error") return json(500, { message: "unavailable" });
			const accepts = batch;
			const data = (body as { to: string[]; scheduled_at?: string }[]).map((entry, index) => {
				if (typeof accepts === "function" && !accepts(index)) return {};
				const id = `re-${++next}`;
				emails.set(id, {
					id,
					to: entry.to[0]!,
					scheduledAt: entry.scheduled_at ?? null,
					lastEvent: entry.scheduled_at ? "scheduled" : "sent",
				});
				return { id };
			});
			return json(200, { data });
		}
		if (url.pathname === "/emails" && method === "POST") {
			const entry = body as { to: string };
			const id = `re-${++next}`;
			emails.set(id, { id, to: entry.to, scheduledAt: null, lastEvent: "sent" });
			return json(200, { id });
		}
		const match = url.pathname.match(/^\/emails\/([^/]+)(\/cancel)?$/);
		const email = match ? emails.get(decodeURIComponent(match[1]!)) : undefined;
		if (!match || !email) return json(404, { message: "not found" });
		if (method === "GET")
			return json(200, {
				object: "email",
				id: email.id,
				last_event: email.lastEvent,
				scheduled_at: email.scheduledAt?.replace("T", " ").replace("Z", "+00") ?? null,
			});
		const fault = faults.get(email.id);
		if (fault === "drop") throw new Error("timeout");
		if (fault === "fail") return json(500, { message: "unavailable" });
		if (email.lastEvent !== "scheduled") return json(422, { message: "This email cannot be changed" });
		if (match[2] && method === "POST") email.lastEvent = "canceled";
		else if (method === "PATCH") email.scheduledAt = (body as { scheduled_at: string }).scheduled_at;
		else return json(405, { message: "method" });
		return json(200, { object: "email", id: email.id });
	}

	const transport = deliveryTransport(
		{
			keys: {
				encryptionKey: Buffer.alloc(32, 7),
				addressKey: Buffer.alloc(32, 9),
				from: "church@resend.dev",
				origin: "https://app.example.test",
			},
			apiKey: "re_test_key",
		},
		fetchFake as typeof fetch,
		settle,
		env,
	);

	return {
		transport,
		/** The fake Resend API itself, for transports other than the Messages adapter. */
		fetch: fetchFake as typeof fetch,
		requests,
		emails,
		/** What the next batch call does: accept every message, refuse (422), fail (500) or accept by position. */
		batch(mode: typeof batch) {
			batch = mode;
		},
		fault(id: string, kind: Fault | null) {
			if (kind) faults.set(id, kind);
			else faults.delete(id);
		},
		/** The email service sent this email: it can no longer be cancelled or moved. */
		wentOut(id: string) {
			emails.get(id)!.lastEvent = "delivered";
		},
		take() {
			return requests.splice(0, requests.length);
		},
	};
}
