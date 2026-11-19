import { getReads, refusalAs } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/me/check-in/read");
const lost = () => ({ status: "lost" }) as const;

export const readCheckInHistory = (page: number) => refusalAs(get("history", { page }), lost);
