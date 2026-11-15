"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Icon, useFocusRequest, type FocusRequest } from "@everyfield/ui/foundations";
import type { ReactNode } from "react";

export function Problem({ children, request = 1 }: { children: ReactNode; request?: FocusRequest }) {
	const ref = useFocusRequest<HTMLDivElement>(request);
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
