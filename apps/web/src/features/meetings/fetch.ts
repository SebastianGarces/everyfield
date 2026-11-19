import { getReads } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/meetings/read");

export const searchPeople = (query: string) => get("people", query);
