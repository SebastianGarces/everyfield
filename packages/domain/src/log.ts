type Value = string | number | boolean | null;
export type LogWord<V> = V extends string ? (Record<never, never> extends Record<V, true> ? never : V) : V;
export type LogFields<F> = { readonly [K in keyof F]: LogWord<F[K]> | Checked };

declare const checked: unique symbol;
type Checked = string & { readonly [checked]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD = /^[a-z][a-z0-9_-]{0,63}$/;
const HOST =
	/^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{1,31})$/;

export const asLogId = (value: string): Checked => (UUID.test(value) ? value : "not-an-id") as Checked;
export const asLogWord = (value: string): Checked => (WORD.test(value) ? value : "not-a-word") as Checked;
const ENV_NAMES = /^[A-Z][A-Z0-9_]{0,63}(?:,[A-Z][A-Z0-9_]{0,63}){0,31}$/;
export const asLogNames = (names: readonly string[]): Checked =>
	(ENV_NAMES.test(names.join(",")) ? names.join(",") : "not-names") as Checked;
export const asLogHost = (value: string): Checked => (HOST.test(value) ? value : "not-a-host") as Checked;

export type ErrorClass = { readonly name: string; readonly code: string | null };

export function errorClass(error: unknown): ErrorClass {
	const named = [error instanceof Error ? error.name : null, (error as object | null)?.constructor?.name]
		.filter((n): n is string => typeof n === "string" && n !== "Error" && ERROR_NAME.test(n))
		.at(0);
	const name = !(error instanceof Error) ? typeof error : (named ?? "Error");
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && ERROR_CODE.test(code)) return { name, code };
		current = (current as { cause?: unknown }).cause;
	}
	return { name, code: null };
}

const TRANSIENT = new Set(["40001", "40P01", "08000", "08003", "08006", "57P01", "53300", "ECONNRESET", "ETIMEDOUT"]);

export const isTransient = (error: unknown): boolean => TRANSIENT.has(errorClass(error).code ?? "");

export function logLine<const F extends Record<string, Value>>(fields: LogFields<F>): void {
	console.error(JSON.stringify(fields));
}

export function logInfo<const F extends Record<string, Value>>(fields: LogFields<F>): void {
	console.log(JSON.stringify(fields));
}

export function logFailure<const F extends Record<string, Value>>(fields: LogFields<F>, error: unknown): void {
	console.error(JSON.stringify({ ...fields, error: errorClass(error) }));
}
