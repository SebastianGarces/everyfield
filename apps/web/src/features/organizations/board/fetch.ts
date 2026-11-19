import { getReads } from "../../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/organization/pipeline/read");

export const readGoals = () => get("goals");
export const readBoard = (query: unknown) => get("board", query);
export const readPerson = (personId: string) => get("person", { personId });
