import { getViewer } from "@/server/request-context";
import { avatarRoute } from "@everyfield/contracts/settings";
import type { ReactNode } from "react";
import { sectionSeed } from "../settings/routes";
import { settingsViewerOf } from "../settings/server";
import { ProductFrame } from "./ProductFrame.tsx";

/**
 * The product frame around every page in app/(product)/(frame)/ and the Wiki, so loading and error states sit inside
 * it and moving between pages keeps the frame. The name, photo and role are the signed-in actor's, for plant and
 * organization seats alike.
 */
export async function ProductFrameLayout({ children }: { children: ReactNode }) {
	const v = await getViewer();
	const settings = settingsViewerOf(v);
	return (
		<ProductFrame
			name={v?.displayName ?? "You"}
			photo={v?.avatar ? avatarRoute(v.avatar) : undefined}
			settings={settings}
			seed={await sectionSeed(settings)}
		>
			{children}
		</ProductFrame>
	);
}
