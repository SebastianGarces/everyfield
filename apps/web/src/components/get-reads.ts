import type { ReadFailure, ReadRefusal, ReadsHandler } from "../server/platform/reads.ts";

export type { ReadFailure, ReadRefusal } from "../server/platform/reads.ts";

type Wire<H> = H extends ReadsHandler<infer W, string> ? W : never;
type SignedOut<H> = H extends ReadsHandler<unknown, infer C> ? C : never;
type Entry = { input: unknown; result: unknown };
type Args<E extends Entry> = undefined extends E["input"] ? [input?: E["input"]] : [input: E["input"]];
type Lost = { status: "lost" };

export type ReadResult<R, C extends string> = R | ReadRefusal<C> | ReadFailure | Lost;

const refusedByRead = <C extends string>(r: unknown): r is ReadRefusal<C> =>
	typeof r === "object" &&
	r !== null &&
	"status" in r &&
	r.status === "refused" &&
	"code" in r &&
	Object.keys(r).length === 2;

export async function refusalAs<T, C extends string, F>(
	read: Promise<T | ReadRefusal<C>>,
	reply: (refusal: ReadRefusal<C>) => F,
): Promise<Exclude<T, ReadRefusal<C>> | F> {
	const r = await read;
	return refusedByRead<C>(r) ? reply(r) : (r as Exclude<T, ReadRefusal<C>>);
}

function reader<H extends ReadsHandler<Record<string, Entry>, string>, F>(path: string, failed: F) {
	return async function get<K extends keyof Wire<H> & string>(
		what: K,
		...[input]: Args<Wire<H>[K]>
	): Promise<Wire<H>[K]["result"] | ReadRefusal<SignedOut<H>> | F | Lost> {
		const params = new URLSearchParams({ what });
		if (input !== undefined) params.set("in", JSON.stringify(input));
		try {
			const r = await fetch(`${path}?${params}`, { cache: "no-store" });
			if (r.ok) return await r.json();
			return r.status === 500 ? failed : { status: "lost" };
		} catch {
			return { status: "lost" };
		}
	};
}

const FAILED: ReadFailure = { status: "failed" };
const LOST: Lost = { status: "lost" };

export const readsFrom = <H extends ReadsHandler<Record<string, Entry>, string>>(path: string) =>
	reader<H, ReadFailure>(path, FAILED);

export const getReads = <H extends ReadsHandler<Record<string, Entry>, string>>(path: string) =>
	reader<H, Lost>(path, LOST);
