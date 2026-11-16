import { z } from "zod";

const ACCESS_KINDS = ["planter", "network"] as const;
export type AccessRequestKind = (typeof ACCESS_KINDS)[number];

export const PHASES = [
	"0 · Discovery",
	"1 · Core group",
	"2 · Launch team",
	"3 · Training",
	"4 · Pre-launch",
	"5 · Launch Sunday",
	"6 · Post-launch",
] as const;

export const HONEYPOT = "website";

export const FIELD_MAX = {
	name: 120,
	email: 254,
	plant_name: 160,
	city: 160,
	sending: 160,
	organization: 160,
	role: 160,
	plants: 4,
	message: 2000,
} as const;

const text = (max: number) => z.string().trim().min(1, "required").max(max, "too_long");
const name = text(FIELD_MAX.name);
const email = text(FIELD_MAX.email)
	.pipe(z.email("email"))
	.transform((s) => s.toLowerCase());
const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, "too_long")
		.transform((s) => (s === "" ? undefined : s))
		.optional();
const honeypot = z.string().max(500).optional();

const planterSchema = z.object({
	name,
	email,
	plant_name: text(FIELD_MAX.plant_name),
	city: text(FIELD_MAX.city),
	phase: z.enum(PHASES, "required"),
	sending: optionalText(FIELD_MAX.sending),
	[HONEYPOT]: honeypot,
});

const networkSchema = z.object({
	name,
	email,
	organization: text(FIELD_MAX.organization),
	role: text(FIELD_MAX.role),
	plants: z
		.string()
		.trim()
		.regex(/^\d{0,4}$/, "number")
		.transform((s) => (s === "" ? undefined : Number(s)))
		.optional(),
	message: optionalText(FIELD_MAX.message),
	[HONEYPOT]: honeypot,
});

const SCHEMAS = { planter: planterSchema, network: networkSchema } as const;

export type AccessRequestFields<K extends AccessRequestKind = AccessRequestKind> = {
	[F in keyof z.input<(typeof SCHEMAS)[K]>]?: string;
};
export type AccessRequest =
	{ kind: "planter"; data: z.output<typeof planterSchema> } | { kind: "network"; data: z.output<typeof networkSchema> };

export type FieldErrorCode = "required" | "email" | "number" | "too_long";
export type FieldErrors = Partial<Record<string, FieldErrorCode>>;

export type AccessRequestResult =
	| { status: "received" }
	| { status: "invalid"; fieldErrors: FieldErrors }
	| { status: "rate_limited"; reason: "email" | "ip" }
	| { status: "unavailable" };

const CODES: readonly string[] = ["required", "email", "number", "too_long"] satisfies FieldErrorCode[];
const isCode = (s: string): s is FieldErrorCode => CODES.includes(s);

export type Validation = { ok: true; request: AccessRequest } | { ok: false; fieldErrors: FieldErrors };

export function validateAccessRequest(kind: AccessRequestKind, fields: Record<string, unknown>): Validation {
	if (kind === "planter") {
		const r = planterSchema.safeParse(fields);
		return r.success
			? { ok: true, request: { kind, data: r.data } }
			: { ok: false, fieldErrors: toFieldErrors(r.error) };
	}
	const r = networkSchema.safeParse(fields);
	return r.success ? { ok: true, request: { kind, data: r.data } } : { ok: false, fieldErrors: toFieldErrors(r.error) };
}

function toFieldErrors(error: z.ZodError): FieldErrors {
	const fieldErrors: FieldErrors = {};
	for (const issue of error.issues) {
		const key = String(issue.path[0] ?? "");
		if (!key || fieldErrors[key]) continue;
		fieldErrors[key] = isCode(issue.message) ? issue.message : "required";
	}
	return fieldErrors;
}

export const isAccessKind = (k: unknown): k is AccessRequestKind =>
	typeof k === "string" && (ACCESS_KINDS as readonly string[]).includes(k);
