import "server-only";
import type { z } from "zod";

export type ReadRefusal<C extends string> = { status: "refused"; code: C | "invalid_input" };

type Read<V, S extends z.ZodType, R> = { input: S; run: (viewer: V, value: z.output<S>) => Promise<R> };

export type ReadWire<D> = {
	[K in keyof D]: D[K] extends Read<never, infer S, infer R> ? { input: z.input<S>; result: R } : never;
};

export type ReadsHandler<W, C extends string> = ((request: Request) => Promise<Response>) & {
	readonly wire?: W;
	readonly signedOut?: C;
};

const answer = (body: unknown) => Response.json(body, { headers: { "cache-control": "private, no-store" } });
const invalid = { status: "refused", code: "invalid_input" } as const;

function decoded(raw: string | null): { ok: true; value: unknown } | { ok: false } {
	if (raw === null) return { ok: true, value: undefined };
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch {
		return { ok: false };
	}
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
		const signedIn = await viewer();
		if (!signedIn) return answer({ status: "refused", code: signedOut } satisfies ReadRefusal<C>);
		const params = new URL(request.url).searchParams;
		const name = params.get("what");
		const read = name !== null && Object.hasOwn(reads, name) ? reads[name] : undefined;
		const raw = decoded(params.get("in"));
		if (!read || !raw.ok) return answer(invalid);
		const input = read.input.safeParse(raw.value);
		return answer(input.success ? await read.run(signedIn, input.data) : invalid);
	};
}
