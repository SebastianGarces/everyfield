import { validateAccessRequest, type AccessRequestKind, type AccessRequestResult, type FieldErrors } from "./contract";

// The step form's path and its moves. The browser (with JavaScript) and the no-JavaScript server action both use
// these functions, so the two paths cannot drift. Only the final send reaches the server's request operation.

/** Who is asking. A church and a network send the same "network" request; the choice changes labels only. */
export const WHO = ["planter", "church", "network"] as const;
export type Who = (typeof WHO)[number];
export const isWho = (v: unknown): v is Who => typeof v === "string" && (WHO as readonly string[]).includes(v);
export const kindOf = (who: Who): AccessRequestKind => (who === "planter" ? "planter" : "network");

/** The steps after "who are you": one or two fields each. Step 0 is the choice. */
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
/** The error key for the step 0 choice. */
export const WHO_FIELD = "who";

export type Notice = "rate_limited_email" | "rate_limited_ip" | "unavailable" | "offline";
export type FormState = {
	step: number;
	who?: Who;
	/** Every answer so far, by field name. The no-JavaScript page renders them back into the form. */
	values: Record<string, string>;
	errors: FieldErrors;
	status: "editing" | "received" | Notice;
	/** The server rejected fields that passed in the browser; the form went back to the first one. */
	invalid?: true;
};

export const START: FormState = { step: 0, values: {}, errors: {}, status: "editing" };

export const stepFields = (s: Pick<FormState, "who" | "step">): readonly string[] =>
	s.who && s.step > 0 ? (FIELD_STEPS[kindOf(s.who)][s.step - 1] ?? []) : [];

/** The answers one request kind sends: its own fields only. */
export const requestFields = (who: Who, values: Record<string, string>): Record<string, string> =>
	Object.fromEntries(FIELD_STEPS[kindOf(who)].flat().map((f) => [f, values[f] ?? ""]));

const only = (errors: FieldErrors, names: readonly string[]): FieldErrors =>
	Object.fromEntries(names.flatMap((n) => (errors[n] ? [[n, errors[n]]] : [])));

/** Continue: checks this step's fields only, then moves on. */
export function next(s: FormState, values: Record<string, string>): FormState {
	const base = { ...s, values, status: "editing" as const, invalid: undefined };
	if (!s.who) return { ...base, step: 0, errors: { [WHO_FIELD]: "required" } };
	if (s.step === 0) return { ...base, step: 1, errors: {} };
	const v = validateAccessRequest(kindOf(s.who), values);
	const errors = v.ok ? {} : only(v.fieldErrors, stepFields(s));
	if (Object.keys(errors).length) return { ...base, errors };
	return { ...base, errors: {}, step: Math.min(s.step + 1, LAST_STEP) };
}

/** Back: one step back, or from a failed send back to the last step's fields. Never checks fields. */
export function back(s: FormState, values: Record<string, string>): FormState {
	const step = s.status === "editing" ? Math.max(0, s.step - 1) : s.step;
	return { ...s, values, step, errors: {}, status: "editing", invalid: undefined };
}

/** Field errors before or after a send: go to the first step with an error. */
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

/** The state after the server answers a send. */
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
