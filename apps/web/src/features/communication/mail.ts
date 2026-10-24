import "server-only";

import { z } from "zod";

// Provider adapter for the Messages screens. The domain asks with its idempotency key, not a provider email id.
// Cancel, reschedule and lookup therefore stay unknown: calling those provider routes with the wrong id could
// change a different email. A missing id is unknown, never a fabricated acceptance.

const env = z.object({
	IDENTITY_MAIL_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_ADDRESS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_MAIL_FROM: z.email(),
	RESEND_API_KEY: z.string().trim().min(1),
});

const batchBody = z.object({
	data: z.array(z.object({ id: z.string().min(1).max(128).optional() })).max(100),
});

const refusedStatus = new Set([400, 401, 403, 422]);

export type MailReady = {
	keys: { encryptionKey: Uint8Array; addressKey: Uint8Array; from: string };
	apiKey: string;
};

type Outgoing = { to: string; subject: string; html: string; text: string };
type Batch = { outcome: "ids"; ids: (string | null)[] } | { outcome: "unknown" } | { outcome: "refused" };

/** Null when the server has no mail keys or provider key. The caller sends nothing in that case. */
export function mailReady(): MailReady | null {
	const parsed = env.safeParse({
		IDENTITY_MAIL_KEY: process.env.IDENTITY_MAIL_KEY,
		IDENTITY_ADDRESS_KEY: process.env.IDENTITY_ADDRESS_KEY,
		IDENTITY_MAIL_FROM: process.env.IDENTITY_MAIL_FROM,
		RESEND_API_KEY: process.env.RESEND_API_KEY,
	});
	if (!parsed.success) return null;
	const encryptionKey = Buffer.from(parsed.data.IDENTITY_MAIL_KEY, "hex");
	const addressKey = Buffer.from(parsed.data.IDENTITY_ADDRESS_KEY, "hex");
	if (encryptionKey.equals(addressKey)) return null;
	return {
		keys: { encryptionKey, addressKey, from: parsed.data.IDENTITY_MAIL_FROM },
		apiKey: parsed.data.RESEND_API_KEY,
	};
}

export function deliveryTransport(ready: MailReady, request: typeof fetch = fetch) {
	async function post(key: string, messages: readonly Outgoing[], signal: AbortSignal): Promise<Batch> {
		if (key.length < 1 || key.length > 256) return { outcome: "refused" };
		const response = await request("https://api.resend.com/emails/batch", {
			method: "POST",
			redirect: "error",
			signal,
			headers: {
				Authorization: `Bearer ${ready.apiKey}`,
				"Content-Type": "application/json",
				"Idempotency-Key": key,
			},
			body: JSON.stringify(
				messages.map((message) => ({
					from: ready.keys.from,
					to: [message.to],
					subject: message.subject,
					html: message.html,
					text: message.text,
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
		send(batch: { key: string; messages: readonly Outgoing[] }, signal: AbortSignal) {
			return post(batch.key, batch.messages, signal);
		},
		async lookup(): Promise<Exclude<Batch, { outcome: "refused" }>> {
			return { outcome: "unknown" };
		},
		async cancel() {
			return { outcome: "unknown" as const };
		},
		async reschedule() {
			return { outcome: "unknown" as const };
		},
	};
}
