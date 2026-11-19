import { createRead } from "../../components/read.tsx";
import type { GuideResult } from "./actions.ts";
import { loadGuide } from "./fetch.ts";

export const guides = createRead((path: string) => loadGuide(path), {
	failed: (): GuideResult => ({ status: "unavailable" }),
});
