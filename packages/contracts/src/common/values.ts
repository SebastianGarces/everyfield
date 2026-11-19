import { z } from "zod";

export const accountId = z.uuid().brand<"AccountId">();
export const tenantId = z.uuid().brand<"TenantId">();
export const personId = z.uuid().brand<"PersonId">();
export const recordId = z.uuid().brand<"RecordId">();
export const operationId = z.uuid().brand<"OperationId">();
export const eventId = z.uuid().brand<"EventId">();
export const sessionId = z.string().min(1).max(256).brand<"SessionId">();
export const requestKey = z.string().min(1).max(200).brand<"RequestKey">();
declare const storedProviderKey: unique symbol;
export type ProviderKey = string & { readonly [storedProviderKey]: true };
export const sha256Text = z.string().regex(/^[a-f0-9]{64}$/);
export const digest = sha256Text.brand<"Digest">();
export const revision = z
	.string()
	.regex(/^(0|[1-9]\d*)$/)
	.refine((v) => BigInt(v) <= 9223372036854775807n)
	.brand<"Revision">();
export const role = z.enum(["owner", "admin", "member"]);
export const organizationKind = z.enum(["sending_church", "sending_network"]);
export const owner = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("account"), id: accountId }),
		z.strictObject({ kind: z.literal("plant"), id: tenantId }),
		z.strictObject({ kind: z.literal("organization"), id: tenantId, organizationKind }),
		z.strictObject({
			kind: z.literal("global"),
			id: tenantId.refine((v) => v === "00000000-0000-0000-0000-000000000000"),
		}),
	])
	.refine((v) => v.kind === "global" || v.id !== "00000000-0000-0000-0000-000000000000");
export type Owner = z.infer<typeof owner>;
export type Revision = z.infer<typeof revision>;
export function sameOwner(a: Owner, b: Owner): boolean {
	return (
		a.kind === b.kind &&
		a.id === b.id &&
		(a.kind !== "organization" || (b.kind === "organization" && a.organizationKind === b.organizationKind))
	);
}

export const correlationId = z.uuid().brand<"CorrelationId">();
export type Reply<T, E> = { status: "ok"; value: T } | { status: "refused"; error: E };
export type RetryEligibility = "never" | "refresh" | "same_request" | "reconcile";
export function defineSafeError<
	const Code extends string,
	Details extends z.ZodRawShape,
	const Retry extends RetryEligibility,
>(code: string extends Code ? never : Code, details: Details, retry: Retry) {
	return z.strictObject({
		code: z.literal(code),
		details: z.strictObject(details),
		correlationId,
		retry: z.literal(retry),
	});
}
export const safeError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", {}, "never"),
	defineSafeError("access_denied", {}, "never"),
	defineSafeError("unavailable", {}, "never"),
	defineSafeError("invalid_subject", { accountId: accountId.optional() }, "never"),
	defineSafeError("conflict", {}, "refresh"),
	defineSafeError("temporary", {}, "same_request"),
	defineSafeError("unknown", {}, "reconcile"),
]);
