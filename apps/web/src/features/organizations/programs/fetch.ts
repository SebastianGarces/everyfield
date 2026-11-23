import { readsFrom, refusalAs, type ReadRefusal } from "../../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = readsFrom<typeof GET>("/organization/pipeline/programs/read");
const unavailable = () => ({ status: "refused", refusal: { code: "unavailable" } }) as const;
const answer = <T extends object>(read: Promise<T | ReadRefusal<string>>) => refusalAs(read, unavailable);

export const reviewVersion = (enrollmentId: string) => answer(get("review", { enrollmentId }));
export const reviewVersions = (programId: string, enrollmentIds: string[]) =>
	answer(get("reviews", { programId, enrollmentIds }));
export const findReadings = (q: string) => answer(get("readings", { q }));
export const rereadProgram = (programId: string) => answer(get("program", { programId }));
export const rereadEnrollment = (enrollmentId: string) => answer(get("enrollment", { enrollmentId }));
