import "server-only";
import type { z } from "zod";
import { ServerFailure, unexpected } from "./transient.ts";
import { parseJson } from "./json.ts";

export type ReadRefusal<C extends string> = { status: "refused"; code: C | "invalid_input" };
export type ReadFailure = { status: "failed" };

type Read<V, S extends z.ZodType, R> = { input: S; run: (viewer: V, value: z.output<S>) => Promise<R> };

export type ReadWire<D> = {
	[K in keyof D]: D[K] extends Read<never, infer S, infer R> ? { input: z.input<S>; result: R } : never;
};

export type ReadsHandler<W, C extends string> = ((request: Request) => Promise<Response>) & {
	readonly wire?: W;
	readonly signedOut?: C;
};

const answer = (body: unknown, status = 200) =>
	Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
const invalid = { status: "refused", code: "invalid_input" } as const;
const failed: ReadFailure = { status: "failed" };

function decoded(raw: string | null): { ok: true; value: unknown } | { ok: false } {
	if (raw === null) return { ok: true, value: undefined };
	const value = parseJson(raw);
	return value === undefined ? { ok: false } : { ok: true, value };
}

export function defineReads<V, C extends string, D extends Record<string, Read<V, z.ZodType, unknown>>>(
	viewer: () => Promise<V | null>,
	signedOut: C,
	build: (
		read: <S extends z.ZodType, R>(input: S, run: (viewer: V, value: z.output<S>) => Promise<R>) => Read<V, S, R>,
	) => D,
): ReadsHandler<ReadWire<D>, C> {
	const reads = build((input, run) => ({ input, run }));
	return async function GET(request: Request) {
		const params = new URL(request.url).searchParams;
		const name = params.get("what");
		const read = name !== null && Object.hasOwn(reads, name) ? reads[name] : undefined;
		const raw = decoded(params.get("in"));
		try {
			const signedIn = await viewer();
			if (!signedIn) return answer({ status: "refused", code: signedOut } satisfies ReadRefusal<C>);
			if (!read || !raw.ok) return answer(invalid);
			const input = read.input.safeParse(raw.value);
			return answer(input.success ? await read.run(signedIn, input.data) : invalid);
		} catch (error) {
			const failure = unexpected({ component: "reads", outcome: "failed" }, error);
			if (!(failure instanceof ServerFailure)) throw failure;
			return answer(failed, 500);
		}
	};
}
