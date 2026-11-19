import type { ReadRefusal, ReadsHandler } from "../server/platform/reads.ts";

type Wire<H> = H extends ReadsHandler<infer W, string> ? W : never;
type SignedOut<H> = H extends ReadsHandler<unknown, infer C> ? C : never;
type Entry = { input: unknown; result: unknown };
type Args<E extends Entry> = undefined extends E["input"] ? [input?: E["input"]] : [input: E["input"]];

export type ReadResult<R, C extends string> = R | ReadRefusal<C> | { status: "lost" };

export function getReads<H extends ReadsHandler<Record<string, Entry>, string>>(path: string) {
	return async function get<K extends keyof Wire<H> & string>(
		what: K,
		...[input]: Args<Wire<H>[K]>
	): Promise<ReadResult<Wire<H>[K]["result"], SignedOut<H>>> {
		const params = new URLSearchParams({ what });
		if (input !== undefined) params.set("in", JSON.stringify(input));
		try {
			const r = await fetch(`${path}?${params}`, { cache: "no-store" });
			return r.ok ? await r.json() : { status: "lost" };
		} catch {
			return { status: "lost" };
		}
	};
}
