import type { Reply, RetryEligibility } from "@everyfield/contracts/common";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { WriteUnavailable } from "./writes.ts";

type SafeErrorOption = z.ZodObject<{
	code: z.ZodLiteral<string>;
	details: z.ZodType<object, object>;
	correlationId: z.ZodType<string>;
	retry: z.ZodLiteral<RetryEligibility>;
}>;
type SafeErrorUnion = z.ZodDiscriminatedUnion<readonly SafeErrorOption[], "code">;
type Code<S extends SafeErrorUnion> = z.output<S>["code"];
type Details<S extends SafeErrorUnion, C extends Code<S>> = Extract<z.input<S>, { code: C }>["details"];
export type Deny<S extends SafeErrorUnion> = <C extends Code<S>>(
	code: C,
	...details: Record<never, never> extends Details<S, C> ? [details?: Details<S, C>] : [details: Details<S, C>]
) => never;

export function defineRefusals<S extends SafeErrorUnion>(
	schema: S,
	options: { writeUnavailable?: z.output<S>["code"] } = {},
) {
	type Failure = z.output<S>;
	const retryOf = new Map<string, RetryEligibility>(
		schema.options.map((option) => [option.shape.code.value, option.shape.retry.value]),
	);

	class Refusal extends Error {
		readonly code: Code<S>;
		readonly details: object;
		constructor(code: Code<S>, details: object = {}) {
			super(code);
			this.code = code;
			this.details = details;
		}
	}
	const deny: Deny<S> = (code, ...[details]) => {
		throw new Refusal(code, details);
	};
	function refused(code: Code<S>, details: object = {}): { status: "refused"; error: Failure } {
		return {
			status: "refused",
			error: schema.parse({ code, details, correlationId: randomUUID(), retry: retryOf.get(code) }),
		};
	}
	function refusalOf(error: unknown): { status: "refused"; error: Failure } {
		if (error instanceof Refusal) return refused(error.code, error.details);
		if (options.writeUnavailable !== undefined && error instanceof WriteUnavailable)
			return refused(options.writeUnavailable);
		throw error;
	}
	async function settle<T>(body: () => Promise<T>): Promise<Reply<T, Failure>> {
		try {
			return { status: "ok", value: await body() };
		} catch (error) {
			return refusalOf(error);
		}
	}
	return { Refusal, deny, refused, refusalOf, settle };
}
