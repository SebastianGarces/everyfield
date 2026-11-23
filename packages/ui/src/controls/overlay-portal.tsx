"use client";

import { useRef, useSyncExternalStore } from "react";
import { focusOrigin } from "../foundations/focus";

const subscribe = () => () => {};

export function usePortalContainer(): HTMLElement | null {
	return useSyncExternalStore(
		subscribe,
		() =>
			document.querySelector<HTMLElement>("[data-product-root] main") ??
			document.querySelector<HTMLElement>("[data-product-root]"),
		() => null,
	);
}

type AutoFocusHandler = (event: Event) => void;

function openerOf(active: Element | null): HTMLElement | null {
	const origin = focusOrigin(active);
	const button = origin?.closest('[role="menu"]')?.getAttribute("aria-labelledby");
	return (button && document.getElementById(button)) || origin;
}

export function useReturnFocus(own: { onOpenAutoFocus?: AutoFocusHandler; onCloseAutoFocus?: AutoFocusHandler } = {}) {
	const opener = useRef<HTMLElement | null>(null);
	return {
		onOpenAutoFocus: (event: Event) => {
			opener.current = openerOf(document.activeElement);
			own.onOpenAutoFocus?.(event);
		},
		onCloseAutoFocus: (event: Event) => {
			own.onCloseAutoFocus?.(event);
			if (event.defaultPrevented) return;
			const target = opener.current;
			opener.current = null;
			if (target?.isConnected) {
				event.preventDefault();
				target.focus({ preventScroll: true });
			}
		},
	};
}
