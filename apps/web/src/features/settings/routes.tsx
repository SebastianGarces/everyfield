import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { getViewer } from "@/server/request-context";
import { PeopleFrame } from "../people/PeopleFrame";

/**
 * The product root and frame around every /settings page, the same frame as People, so the name button's user menu
 * reaches the other settings pages and People is one click away. Each page still checks its own viewer and access.
 */
export async function SettingsLayout({ children }: { children: ReactNode }) {
	const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
	const viewer = (await getViewer())?.people ?? null;
	return (
		<ProductRoot initialTheme={theme}>
			<PeopleFrame name={viewer?.displayName ?? "You"} role={viewer?.role ?? null}>
				{children}
			</PeopleFrame>
		</ProductRoot>
	);
}
