import { readCatalog } from "@everyfield/evry";
import { evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
export const GET = () => evryResponse(async (_db, actor) => readCatalog(actor));
