import { getViewer } from "@/server/request-context";
import type { ReactNode } from "react";
import { sectionSeed } from "../settings/routes";
import { settingsViewerOf } from "../settings/server";
import { ProductFrame } from "./ProductFrame.tsx";

/**
 * The product frame around every page in app/(product)/(frame)/ and the Wiki, so loading and error states sit inside
 * it and moving between pages keeps the frame. The name and role are the signed-in actor's, for plant and
 * organization seats alike.
 */
export async function ProductFrameLayout({ children }: { children: ReactNode }) {
	const v = await getViewer();
	const settings = settingsViewerOf(v);
	return (
		<ProductFrame name={v?.displayName ?? "You"} settings={settings} seed={await sectionSeed(settings)}>
			{children}
		</ProductFrame>
	);
}
