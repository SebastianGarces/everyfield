import { ownResidencyLinks } from "../organizations/mount";
import { evryAvailable } from "@everyfield/db/provider";
import { serverEnv } from "@/server/config";
import { getViewer } from "@/server/request-context";
import { avatarRoute } from "@everyfield/contracts/settings";
import type { ReactNode } from "react";
import { settingsViewerOf } from "../settings/server";
import { ProductFrame } from "./ProductFrame.tsx";

export async function ProductFrameLayout({
	children,
	settings: settingsDialog,
}: {
	children: ReactNode;
	settings?: ReactNode;
}) {
	const v = await getViewer();
	const settings = settingsViewerOf(v);
	const live =
		v.status === "active" && v.authority?.actor.context.kind === "account"
			? (await ownResidencyLinks()).find((l) => l.sharing.status === "active")
			: undefined;
	const residency = live ? { organizationName: live.organizationName } : null;
	return (
		<ProductFrame
			name={v.displayName ?? "You"}
			photo={v.avatar ? avatarRoute(v.avatar) : undefined}
			settings={settings}
			settingsDialog={settingsDialog}
			residency={residency}
			discovery={v.discovery}
			evryAvailable={evryAvailable(serverEnv())}
		>
			{children}
		</ProductFrame>
	);
}
