import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

// The one product root: every product page (sign-in, onboarding, People, Settings, connections and the design
// previews) renders inside it, so the product theme applies everywhere and its cookie is read in one place.
export default async function ProductLayout({ children }: { children: ReactNode }) {
	const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
	return <ProductRoot initialTheme={theme}>{children}</ProductRoot>;
}
