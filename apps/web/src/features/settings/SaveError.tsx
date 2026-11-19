import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@everyfield/ui/foundations";
import type { ReactNode } from "react";

export function SaveError({ message, reference, action }: { message: string; reference?: string; action?: ReactNode }) {
	return (
		<div
			role="alert"
			className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600"
		>
			<Icon icon={Alert02Icon} size={16} />
			<span className="min-w-0 flex-1">
				{message}
				{reference ? <span className="text-text-2"> Reference {reference}.</span> : null}
			</span>
			{action}
		</div>
	);
}
