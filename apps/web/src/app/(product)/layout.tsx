import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import type { Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { THEME_VIEWPORT } from "../viewport";

const theme = async () => parseTheme((await cookies()).get(THEME_COOKIE)?.value);

export async function generateViewport(): Promise<Viewport> {
	return THEME_VIEWPORT[await theme()];
}

export default async function ProductLayout({ children }: { children: ReactNode }) {
	return <ProductRoot initialTheme={await theme()}>{children}</ProductRoot>;
}
