import { getReads, type ReadResult } from "../../../components/get-reads.ts";
import type { ReadRefusal } from "../../../server/platform/reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/organization/pipeline/programs/read");
const unavailable = { status: "refused", refusal: { code: "unavailable" } } as const;
const refusedByRead = <T extends object>(r: ReadResult<T, string>): r is ReadRefusal<string> => "code" in r;

async function answer<T extends object>(read: Promise<ReadResult<T, string>>) {
	const r = await read;
	return refusedByRead(r) ? unavailable : r;
}

export const reviewVersion = (enrollmentId: string) => answer(get("review", { enrollmentId }));
export const reviewVersions = (programId: string, enrollmentIds: string[]) =>
	answer(get("reviews", { programId, enrollmentIds }));
export const findReadings = (q: string) => answer(get("readings", { q }));
export const rereadProgram = (programId: string) => answer(get("program", { programId }));
export const rereadEnrollment = (enrollmentId: string) => answer(get("enrollment", { enrollmentId }));
