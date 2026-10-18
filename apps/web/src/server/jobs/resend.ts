import "server-only";
import { z } from "zod";
import type { MailTransport, TransportOutcome } from "./mail.ts";
const accepted = z.object({ id: z.string().min(1).max(128) });
export function createResendTransport(apiKey: string, request: typeof fetch = fetch): MailTransport {
	if (!apiKey.trim()) throw Error("mail_provider_unconfigured");
	async function call(path: string, init: RequestInit): Promise<Response> {
		return request(`https://api.resend.com${path}`, {
			...init,
			redirect: "error",
			headers: { ...init.headers, Authorization: `Bearer ${apiKey}` },
		});
	}
	return {
		async send(payload, key, signal): Promise<TransportOutcome> {
			try {
				const response = await call("/emails", {
					method: "POST",
					signal,
					headers: { "Content-Type": "application/json", "Idempotency-Key": key },
					body: JSON.stringify(payload),
				});
				if (response.ok) {
					const result = accepted.safeParse(await response.json());
					return result.success ? { kind: "accepted", id: result.data.id } : { kind: "unknown" };
				}
				if (response.status === 429) {
					const value = response.headers.get("retry-after");
					const seconds = value
						? /^\d+$/.test(value)
							? Number(value)
							: Math.max(0, (Date.parse(value) - Date.now()) / 1000)
						: NaN;
					return {
						kind: "refused",
						retryable: true,
						retryAfterSeconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined,
					};
				}
				// Timeouts, conflicts and server faults cannot establish nonacceptance.
				if ([400, 401, 403, 422].includes(response.status)) return { kind: "refused", retryable: false };
				return { kind: "unknown" };
			} catch {
				return { kind: "unknown" };
			}
		},
		async lookup(id, signal) {
			try {
				const response = await call(`/emails/${encodeURIComponent(id)}`, { method: "GET", signal });
				if (!response.ok) return { kind: "unknown" };
				const parsed = accepted.safeParse(await response.json());
				return parsed.success && parsed.data.id === id ? { kind: "accepted", id } : { kind: "unknown" };
			} catch {
				return { kind: "unknown" };
			}
		},
	};
}
