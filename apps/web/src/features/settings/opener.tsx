"use client";

import { createContext, use, type MouseEvent } from "react";
import type { DialogSection } from "./model";

export const SettingsOpenerContext = createContext<((section: DialogSection) => void) | null>(null);

export function useSettingsLink(section: DialogSection): {
	href: string;
	onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
} {
	const open = use(SettingsOpenerContext);
	return {
		href: `/settings/${section}`,
		onClick: (event) => {
			if (!open || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
			event.preventDefault();
			open(section);
		},
	};
}

export function useOpenSettings(): ((section: DialogSection) => void) | null {
	return use(SettingsOpenerContext);
}
