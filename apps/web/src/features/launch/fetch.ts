import { readsFrom, refusalAs } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = readsFrom<typeof GET>("/launch/read");
const lost = () => ({ status: "lost" }) as const;

export const readGatheringOffers = () => refusalAs(get("offers"), lost);
export const suggestGuests = (query: string) => refusalAs(get("guests", { query }), lost);
export const readLaunchHistory = () => refusalAs(get("history"), lost);
