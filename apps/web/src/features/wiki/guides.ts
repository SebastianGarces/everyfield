import { createRead } from "../../components/read.tsx";
import { loadGuide, type GuideResult } from "./actions.ts";

export const guides = createRead((path: string) => loadGuide(path), {
	failed: (): GuideResult => ({ status: "unavailable" }),
});
