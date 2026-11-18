import { ownResidencyLinks } from "../organizations/mount";
import { getViewer } from "@/server/request-context";
import { avatarRoute } from "@everyfield/contracts/settings";
import type { ReactNode } from "react";
import { sectionSeed } from "../settings/routes";
import { settingsViewerOf } from "../settings/server";
import { ProductFrame } from "./ProductFrame.tsx";

export async function ProductFrameLayout({ children }: { children: ReactNode }) {
	const v = await getViewer();
	const settings = settingsViewerOf(v);
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
