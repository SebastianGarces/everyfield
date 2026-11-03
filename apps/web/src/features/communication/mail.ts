import "server-only";

import { z } from "zod";

import type { DeliveryTransport } from "@everyfield/domain/communication";
import { cancelCaptured, captureAllowed, captureSilent, moveCaptured, record } from "./capture.ts";
import { settleCaptured } from "./settle.ts";

// Provider adapter for the Messages screens. A handoff is one batch call under the domain's idempotency key; a held
// (scheduled) handoff carries its send time. Cancel and time change address each email by the id the email service
// returned at handoff. A missing id or answer is unknown, never a fabricated acceptance.

const env = z.object({
	IDENTITY_MAIL_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_ADDRESS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_MAIL_FROM: z.email(),
	IDENTITY_ORIGIN: z.url(),
	RESEND_API_KEY: z.string().trim().min(1).optional(),
});

const batchBody = z.object({
	data: z.array(z.object({ id: z.string().min(1).max(128).optional() })).max(100),
});

const refusedStatus = new Set([400, 401, 403, 422]);

const reservedExact = new Set(["example.com", "example.net", "example.org", "example", "invalid", "localhost", "test"]);
const reservedSuffix = [".example", ".invalid", ".localhost", ".test"];

const domainListBody = z.object({
	has_more: z.boolean().optional(),
	data: z.array(z.object({ name: z.string().min(1).max(253), status: z.string() })).max(100),
});

type DomainList = { verified: Set<string> } | { failed: true } | { refused: true };

let domainList: Promise<void> | null = null;
let domainListAt = 0;

function fromDomain(from: string): string {
	const at = from.lastIndexOf("@");
	return (at === -1 ? from : from.slice(at + 1)).trim().toLowerCase().replace(/\.$/, "");
}

function reservedDomain(domain: string): boolean {
	if (reservedExact.has(domain)) return true;
	return reservedSuffix.some((suffix) => domain.endsWith(suffix));
}

function resendTestDomain(domain: string): boolean {
	return domain === "resend.dev" || domain.endsWith(".resend.dev");
}

async function loadDomains(apiKey: string): Promise<DomainList> {
	try {
		const response = await fetch("https://api.resend.com/domains", {
			method: "GET",
			redirect: "error",
			signal: AbortSignal.timeout(2_500),
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		});
		if (response.status === 401) return { refused: true };
		if (!response.ok) {
			await response.body?.cancel();
			return { failed: true };
		}
		const parsed = domainListBody.safeParse(await response.json());
		if (!parsed.success || parsed.data.has_more === true) return { failed: true };
		return {
			verified: new Set(
				parsed.data.data.filter((row) => row.status === "verified").map((row) => row.name.toLowerCase()),
			),
		};
	} catch {
		return { failed: true };
	}
}

let settledList: DomainList | null = null;

function refreshDomains(apiKey: string): void {
	if (domainList) return;
	if (settledList && Date.now() - domainListAt < 15_000) return;
	const pending = loadDomains(apiKey).then((result) => {
		domainList = null;
		if (!("failed" in result)) {
			settledList = result;
			domainListAt = Date.now();
		}
	});
	domainList = pending;
}

/** Start the domain read before the send statements. A known refusal then skips the batch POST. */
export function anticipateProvider(ready: MailReady): void {
	if (ready.apiKey === null) return;
	const domain = fromDomain(ready.keys.from);
	if (reservedDomain(domain) || resendTestDomain(domain)) return;
	refreshDomains(ready.apiKey);
}

function knownRefusal(ready: MailReady): boolean {
	if (ready.apiKey === null) return false;
	const domain = fromDomain(ready.keys.from);
	if (reservedDomain(domain)) return true;
	if (resendTestDomain(domain)) return false;
	const list = settledList;
	if (!list || Date.now() - domainListAt > 15_000) return false;
	if ("refused" in list) return true;
	if ("failed" in list) return false;
	return !list.verified.has(domain);
}

export type MailReady = {
	keys: { encryptionKey: Uint8Array; addressKey: Uint8Array; from: string; origin: string };
	/** The provider key, or null when a development or preview server records sends and delivers none. */
	apiKey: string | null;
};

type Outgoing = { to: string; subject: string; html: string; text: string };
type Batch = { outcome: "ids"; ids: (string | null)[] } | { outcome: "unknown" } | { outcome: "refused" };

/** The deployment's app origin, or null when it is not configured. */
export function appOrigin(): string | null {
	const parsed = z.url().safeParse(process.env.IDENTITY_ORIGIN);
	return parsed.success ? new URL(parsed.data).origin : null;
}

/** Null when the server has no mail keys, or no provider key outside a capture environment. The caller sends nothing then. */
export function mailReady(): MailReady | null {
	const parsed = env.safeParse({
		IDENTITY_MAIL_KEY: process.env.IDENTITY_MAIL_KEY,
		IDENTITY_ADDRESS_KEY: process.env.IDENTITY_ADDRESS_KEY,
		IDENTITY_MAIL_FROM: process.env.IDENTITY_MAIL_FROM,
		IDENTITY_ORIGIN: process.env.IDENTITY_ORIGIN,
		RESEND_API_KEY: process.env.RESEND_API_KEY?.trim() || undefined,
	});
	if (!parsed.success) return null;
	const apiKey = parsed.data.RESEND_API_KEY ?? null;
	if (apiKey === null && !captureAllowed(process.env)) return null;
	const encryptionKey = Buffer.from(parsed.data.IDENTITY_MAIL_KEY, "hex");
	const addressKey = Buffer.from(parsed.data.IDENTITY_ADDRESS_KEY, "hex");
	if (encryptionKey.equals(addressKey)) return null;
	return {
		keys: { encryptionKey, addressKey, from: parsed.data.IDENTITY_MAIL_FROM, origin: parsed.data.IDENTITY_ORIGIN },
		apiKey,
	};
}

/** `last_event` words that mean the email already left the email service. */
const wentOut = new Set(["sent", "delivered", "delivery_delayed", "opened", "clicked", "bounced", "complained"]);

const emailBody = z.object({
	id: z.string().min(1).max(128),
	last_event: z.string().nullable().optional(),
	scheduled_at: z.string().nullable().optional(),
});

/**
 * Requests in flight at once for a per-recipient cancel or time change. Resend limits each team's request rate, so a
 * recipient whose call is refused for rate stays open and the next Check again asks for it.
 */
const PROVIDER_CALLS = 8;

async function eachLimited<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const lane = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(PROVIDER_CALLS, items.length) }, lane));
	return results;
}

/** Resend writes `2026-08-05 11:52:01.858+00`; the ISO form parses the same instant. */
const instantOf = (text: string) => Date.parse(text.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));

export function deliveryTransport(
	ready: MailReady,
	request: typeof fetch = fetch,
	/** Dev capture only: marks captured messages sent, as the provider callback would. */
	settle: (ids: readonly string[]) => void = settleCaptured,
): DeliveryTransport {
	const call = (path: string, init: RequestInit & { signal: AbortSignal }) =>
		request(`https://api.resend.com${path}`, {
			...init,
			redirect: "error",
			headers: { ...init.headers, Authorization: `Bearer ${ready.apiKey}`, "Content-Type": "application/json" },
		});

	/** What the email service says about one email after a cancel or move it did not confirm. */
	async function inspect(
		id: string,
		movedTo: string | null,
		signal: AbortSignal,
	): Promise<"done" | "sent" | "unknown"> {
		const response = await call(`/emails/${encodeURIComponent(id)}`, { method: "GET", signal });
		if (!response.ok) {
			await response.body?.cancel();
			return "unknown";
		}
		const parsed = emailBody.safeParse(await response.json());
		if (!parsed.success || parsed.data.id !== id) return "unknown";
		const event = parsed.data.last_event ?? "";
		if (wentOut.has(event)) return "sent";
		if (movedTo === null) return event === "canceled" ? "done" : "unknown";
		const held = parsed.data.scheduled_at;
		return event === "scheduled" && held && instantOf(held) === Date.parse(movedTo) ? "done" : "unknown";
	}

	/** One cancel or move by the email's own id. A refusal is checked against the email's current state. */
	async function change(id: string, movedTo: string | null, signal: AbortSignal): Promise<"done" | "sent" | "unknown"> {
		if (ready.apiKey === null) {
			if (await captureSilent()) return "unknown";
			return movedTo === null ? cancelCaptured(id) : moveCaptured(id, movedTo);
		}
		try {
			const path = `/emails/${encodeURIComponent(id)}`;
			const response = await call(
				movedTo === null ? `${path}/cancel` : path,
				movedTo === null
					? { method: "POST", signal }
					: { method: "PATCH", signal, body: JSON.stringify({ scheduled_at: movedTo }) },
			);
			if (response.ok) {
				const parsed = emailBody.pick({ id: true }).safeParse(await response.json().catch(() => null));
				if (parsed.success && parsed.data.id === id) return "done";
			} else await response.body?.cancel();
			return await inspect(id, movedTo, signal);
		} catch {
			return "unknown";
		}
	}

	async function post(
		key: string,
		messages: readonly Outgoing[],
		scheduledAt: string | null,
		signal: AbortSignal,
	): Promise<Batch> {
		if (key.length < 1 || key.length > 256) return { outcome: "refused" };
		if (ready.apiKey === null) {
			if (await captureSilent()) return { outcome: "unknown" };
			const ids = await Promise.all(
				messages.map((message) => record({ from: ready.keys.from, ...message }, scheduledAt)),
			);
			// A held capture is not sent yet, so no sent callback follows it.
			if (scheduledAt === null) settle(ids);
			return { outcome: "ids", ids };
		}
		// Reserved and unverified from-addresses are a confirmed provider refusal. Do not wait for that POST.
		if (knownRefusal(ready)) return { outcome: "refused" };
		const response = await call("/emails/batch", {
			method: "POST",
			signal,
			headers: { "Idempotency-Key": key },
			body: JSON.stringify(
				messages.map((message) => ({
					from: ready.keys.from,
					to: [message.to],
					subject: message.subject,
					html: message.html,
					text: message.text,
					...(scheduledAt === null ? {} : { scheduled_at: scheduledAt }),
				})),
			),
		});
		if (response.ok) {
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				return { outcome: "unknown" };
			}
			const parsed = batchBody.safeParse(body);
			if (!parsed.success) return { outcome: "unknown" };
			return { outcome: "ids", ids: messages.map((_, index) => parsed.data.data[index]?.id ?? null) };
		}
		await response.body?.cancel();
		if (refusedStatus.has(response.status)) return { outcome: "refused" };
		return { outcome: "unknown" };
	}

	return {
		send(batch, signal) {
			return post(batch.key, batch.messages, batch.scheduledAt, signal);
		},
		// A batch handoff has no lookup by its idempotency key, so an earlier unknown stays unknown.
		async lookup() {
			return { outcome: "unknown" };
		},
		cancel(providerIds, signal) {
			return eachLimited(providerIds, async (id) => {
				const outcome = await change(id, null, signal);
				return { outcome: outcome === "done" ? ("cancelled" as const) : outcome };
			});
		},
		reschedule(providerIds, at, signal) {
			return eachLimited(providerIds, async (id) => {
				const outcome = await change(id, at, signal);
				return { outcome: outcome === "done" ? ("moved" as const) : outcome };
			});
		},
	};
}
