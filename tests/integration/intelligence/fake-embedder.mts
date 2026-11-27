import type { WikiQueryEmbedder } from "../../../packages/reference/src/starter/verify/query.ts";

export const FAKE_PROFILE = "fake-embedding/1";
export const DIMENSIONS = 1536;

export const axis = (index: number) => Array.from({ length: DIMENSIONS }, (_, at) => (at === index ? 1 : 0));
export const near = (index: number, other: number, weight: number) => {
	const norm = Math.hypot(weight, 1 - weight);
	return Array.from({ length: DIMENSIONS }, (_, at) =>
		at === index ? weight / norm : at === other ? (1 - weight) / norm : 0,
	);
};
export const vectorText = (v: readonly number[]) => `[${v.join(",")}]`;

export function fakeEmbedder(
	options: {
		vector?: readonly number[];
		tokens?: number;
		fail?: () => Error;
		profile?: string;
		dimensions?: number;
	} = {},
): WikiQueryEmbedder & { texts: string[] } {
	const texts: string[] = [];
	return {
		profile: options.profile ?? FAKE_PROFILE,
		dimensions: options.dimensions ?? DIMENSIONS,
		texts,
		async embed(text) {
			texts.push(text);
			if (options.fail) throw options.fail();
			return { vector: options.vector ?? axis(0), tokens: options.tokens ?? 5 };
		},
	};
}
