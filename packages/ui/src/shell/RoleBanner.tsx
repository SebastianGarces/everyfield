import { ViewIcon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { Icon } from "../foundations";

/**
 * The banner above the page for a Member seat (components.md, Role banner). The caller writes the text from the
 * person's actual seat and passes an optional action, such as "Ask for access".
 */
export function RoleBanner({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<div className="mb-[18px] flex items-center gap-3 rounded-card bg-blue-50 py-3 pr-4 pl-3.5 text-md text-ink-2 shadow-[inset_0_0_0_1px_var(--ef-blue-100)] max-app-sm:flex-wrap">
			<Icon icon={ViewIcon} size={18} className="text-blue-600" />
			<p className="min-w-0 flex-1">{children}</p>
			{action}
		</div>
	);
}
