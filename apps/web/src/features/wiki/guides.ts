import { createRead } from "../../components/read.tsx";
import type { GuideResult } from "./actions.ts";
import { loadGuide } from "./fetch.ts";
import type { ReadFailure } from "../../components/get-reads.ts";

export const guides = createRead((path: string) => loadGuide(path), {
	failed: (): GuideResult | ReadFailure => ({ status: "unavailable" }),
});
