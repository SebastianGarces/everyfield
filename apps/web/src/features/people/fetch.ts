import { getReads } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/people/read");

export const findHouseholds = (search: string) => get("households", { search });
export const findWitnesses = (search: string) => get("witnesses", { search });
