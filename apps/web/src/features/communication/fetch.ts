import { getReads } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/communication/read");

export const searchRecipients = (query: string) => get("recipients", query);
