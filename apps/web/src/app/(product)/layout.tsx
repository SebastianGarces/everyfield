import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import type { Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { THEME_VIEWPORT } from "../viewport";

const theme = async () => parseTheme((await cookies()).get(THEME_COOKIE)?.value);

// The browser chrome and form controls follow the product theme from the first response; marketing pages keep the
// root layout's light viewport.
export async function generateViewport(): Promise<Viewport> {
	return THEME_VIEWPORT[await theme()];
}

// The one product root: every product page (sign-in, onboarding, People, Settings, connections and the design
// previews) renders inside it, so the product theme applies everywhere and its cookie is read in one place.
export default async function ProductLayout({ children }: { children: ReactNode }) {
	return <ProductRoot initialTheme={await theme()}>{children}</ProductRoot>;
}
