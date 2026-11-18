import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import type { Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { THEME_VIEWPORT } from "../../components/viewport";

const theme = async () => parseTheme((await cookies()).get(THEME_COOKIE)?.value);

export async function generateProductViewport(): Promise<Viewport> {
	return THEME_VIEWPORT[await theme()];
}

export async function ProductLayout({ children }: { children: ReactNode }) {
	return <ProductRoot initialTheme={await theme()}>{children}</ProductRoot>;
}
