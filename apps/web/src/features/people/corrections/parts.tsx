"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * A problem under a form or on a page. It is an alert, and it takes focus when it appears, so a keyboard or screen
 * reader user lands on what went wrong instead of on a button that no longer helps. Give it a new `key` for a new
 * problem. Render it inside the open dialog when a dialog is open: the page behind a modal is hidden from assistive
 * technology.
 */
export function Problem({ children, focus = true }: { children: ReactNode; focus?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (focus) ref.current?.focus();
	}, []); // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<div
			ref={ref}
			role="alert"
			tabIndex={-1}
			className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600 outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)]"
		>
			<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
			<div className="min-w-0 flex-1 text-pretty">{children}</div>
		</div>
	);
}
