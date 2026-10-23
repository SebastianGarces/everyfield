import { hash } from "../../hash.ts";
import { approvedWiki } from "../manifest/approved.ts";

// Local stand-in for a model. Values are float32 so the checksum matches the stored vector.
export function localEmbedding(text: string): number[] {
	const digest = hash(text);
	const values: number[] = [];
	for (let index = 0; index < approvedWiki.embeddingDimensions; index++) {
		const byte = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
		values.push(Math.fround(byte / 255));
	}
	return values;
}
