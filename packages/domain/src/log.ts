type Value = string | number | boolean | null;
export type LogWord<V> = V extends string ? (Record<never, never> extends Record<V, true> ? never : V) : V;
export type LogFields<F> = { readonly [K in keyof F]: LogWord<F[K]> | Checked };

declare const checked: unique symbol;
type Checked = string & { readonly [checked]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD = /^[a-z][a-z0-9_-]{0,63}$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{1,31})$/;

export const asLogId = (value: string): Checked => (UUID.test(value) ? value : "not-an-id") as Checked;
export const asLogWord = (value: string): Checked => (WORD.test(value) ? value : "not-a-word") as Checked;

export type ErrorClass = { readonly name: string; readonly code: string | null };

export function errorClass(error: unknown): ErrorClass {
	const name = !(error instanceof Error) ? typeof error : ERROR_NAME.test(error.name) ? error.name : "Error";
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && ERROR_CODE.test(code)) return { name, code };
		current = (current as { cause?: unknown }).cause;
	}
	return { name, code: null };
}

export function logLine<const F extends Record<string, Value>>(fields: LogFields<F>): void {
	console.error(JSON.stringify(fields));
}

export function logInfo<const F extends Record<string, Value>>(fields: LogFields<F>): void {
	console.log(JSON.stringify(fields));
}

export function logFailure<const F extends Record<string, Value>>(fields: LogFields<F>, error: unknown): void {
	console.error(JSON.stringify({ ...fields, error: errorClass(error) }));
}
