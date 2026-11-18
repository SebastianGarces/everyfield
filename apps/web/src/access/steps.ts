import { validateAccessRequest, type AccessRequestKind, type AccessRequestResult, type FieldErrors } from "./contract";

export const WHO = ["planter", "church", "network"] as const;
export type Who = (typeof WHO)[number];
export const isWho = (v: unknown): v is Who => typeof v === "string" && (WHO as readonly string[]).includes(v);
export const kindOf = (who: Who): AccessRequestKind => (who === "planter" ? "planter" : "network");

export const FIELD_STEPS: Record<AccessRequestKind, readonly (readonly string[])[]> = {
	planter: [
		["name", "email"],
		["plant_name", "city"],
		["phase", "sending"],
	],
	network: [
		["name", "email"],
		["organization", "role"],
		["plants", "message"],
	],
};
export const STEP_COUNT = 4;
export const LAST_STEP = STEP_COUNT - 1;
export const FIELD_NAMES: readonly string[] = [...new Set(Object.values(FIELD_STEPS).flat(2))];
export const WHO_FIELD = "who";

export type Notice = "rate_limited_email" | "rate_limited_ip" | "unavailable" | "offline";
export type FormState = {
	step: number;
	who?: Who;
	values: Record<string, string>;
	errors: FieldErrors;
	status: "editing" | "received" | Notice;
	invalid?: true;
};

export const START: FormState = { step: 0, values: {}, errors: {}, status: "editing" };

const stepFields = (s: Pick<FormState, "who" | "step">): readonly string[] =>
	s.who && s.step > 0 ? (FIELD_STEPS[kindOf(s.who)][s.step - 1] ?? []) : [];

export const requestFields = (who: Who, values: Record<string, string>): Record<string, string> =>
	Object.fromEntries(FIELD_STEPS[kindOf(who)].flat().map((f) => [f, values[f] ?? ""]));

const only = (errors: FieldErrors, names: readonly string[]): FieldErrors =>
	Object.fromEntries(names.flatMap((n) => (errors[n] ? [[n, errors[n]]] : [])));

export function next(s: FormState, values: Record<string, string>): FormState {
	const base = { ...s, values, status: "editing" as const, invalid: undefined };
	if (!s.who) return { ...base, step: 0, errors: { [WHO_FIELD]: "required" } };
	if (s.step === 0) return { ...base, step: 1, errors: {} };
	const v = validateAccessRequest(kindOf(s.who), values);
	const errors = v.ok ? {} : only(v.fieldErrors, stepFields(s));
	if (Object.keys(errors).length) return { ...base, errors };
	return { ...base, errors: {}, step: Math.min(s.step + 1, LAST_STEP) };
}

export function back(s: FormState, values: Record<string, string>): FormState {
	const step = s.status === "editing" ? Math.max(0, s.step - 1) : s.step;
	return { ...s, values, step, errors: {}, status: "editing", invalid: undefined };
}

export function withErrors(
	s: FormState,
	values: Record<string, string>,
	errors: FieldErrors,
	invalid?: true,
): FormState {
	const steps = s.who ? FIELD_STEPS[kindOf(s.who)] : [];
	const i = steps.findIndex((names) => names.some((n) => errors[n]));
	return { ...s, values, errors, status: "editing", invalid, step: i < 0 ? s.step : i + 1 };
}

export function afterReply(s: FormState, values: Record<string, string>, r: AccessRequestResult): FormState {
	const base = { ...s, values, errors: {}, invalid: undefined };
	switch (r.status) {
		case "received":
			return { ...base, status: "received" };
		case "invalid":
			return withErrors(s, values, r.fieldErrors, true);
		case "rate_limited":
			return { ...base, status: r.reason === "email" ? "rate_limited_email" : "rate_limited_ip" };
		case "unavailable":
			return { ...base, status: "unavailable" };
	}
}
