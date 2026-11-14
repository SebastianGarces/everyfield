import { ownResidencyLinks } from "@/server/organizations";
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
	// A seatless account's live residency link puts My residency in its navigation (WP-100). Only for an account
	// without a seat, and the same per-request read the Sharing page's residency cards use: no extra statement there.
	const live =
		v?.status === "active" && v.authority?.actor.context.kind === "account"
			? (await ownResidencyLinks()).find((l) => l.sharing.status === "active")
			: undefined;
	const residency = live ? { organizationName: live.organizationName } : null;
	return (
		<ProductFrame
			name={v?.displayName ?? "You"}
			photo={v?.avatar ? avatarRoute(v.avatar) : undefined}
			settings={settings}
			seed={await sectionSeed(settings)}
			residency={residency}
		>
			{children}
		</ProductFrame>
	);
}
