"use client";

import { useRef, useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * The element every overlay portals into: the product root, not <body>. Product rules (font, focus ring, the dark
 * variant and the light-token island) are scoped to [data-product-root], so an overlay outside it would lose them.
 * Overlays open only after hydration, so the server value (no container) never renders an open overlay.
 */
export function usePortalContainer(): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => document.querySelector<HTMLElement>("[data-product-root]"),
    () => null,
  );
}

type AutoFocusHandler = (event: Event) => void;

/**
 * Returns focus to the element that had it when the overlay opened. Radix restores focus only to its own Trigger, so
 * an overlay opened from caller state (a Guide button, a keyboard shortcut) would drop focus on <body> when it closes.
 * When onOpenAutoFocus runs, focus has not moved into the overlay yet, so the opener is still the active element.
 * The caller's own handlers run first; if one prevents the default, this hook leaves focus alone.
 */
export function useReturnFocus(own: { onOpenAutoFocus?: AutoFocusHandler; onCloseAutoFocus?: AutoFocusHandler } = {}) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
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
