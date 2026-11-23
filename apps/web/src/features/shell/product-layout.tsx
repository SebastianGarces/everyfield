import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import type { Viewport } from "next";
import { cookies } from "next/headers";
import Script from "next/script";
import type { ReactNode } from "react";
import { THEME_VIEWPORT } from "../../components/viewport";
import { viewerZone, ZONE_COOKIE, ZONE_COOKIE_SCRIPT } from "../../components/viewer-zone";

const theme = async () => parseTheme((await cookies()).get(THEME_COOKIE)?.value);

export async function generateProductViewport(): Promise<Viewport> {
	return THEME_VIEWPORT[await theme()];
}

export async function ProductLayout({ children }: { children: ReactNode }) {
	const jar = await cookies();
	return (
		<ProductRoot
			initialTheme={parseTheme(jar.get(THEME_COOKIE)?.value)}
			served={{ zone: viewerZone(jar.get(ZONE_COOKIE)?.value), now: Date.now() }}
		>
			{children}
			<Script id="viewer-zone">{ZONE_COOKIE_SCRIPT}</Script>
		</ProductRoot>
	);
}
