import { getReads } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/onboarding/read");

export async function loadOnboardingEntry() {
	const r = await get("entry");
	if (r.status !== "ok") throw new Error(`onboarding entry read ${r.status}`);
	return r.value;
}
