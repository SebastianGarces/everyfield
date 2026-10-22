import { Alert02Icon, LockKeyIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@everyfield/ui/foundations";
import type { ReactNode, Ref } from "react";
import type { Problem } from "./intent";

export function PrivateLine({ children }: { children: ReactNode }) {
	return (
		<p className="mt-3 flex items-start gap-2 text-sm text-text-3">
			<Icon icon={LockKeyIcon} size={16} className="mt-0.5 flex-none" />
			{children}
		</p>
	);
}

const UNKNOWN =
	"We could not confirm that this went through. Check your connection, then try again. Trying again never does it twice.";

/**
 * The live region for a failed command. `refused` says the server checked and changed nothing; the caller words it
 * for the action. `unknown` asks for a retry, which reuses the same request key. `focusRef` makes the message a focus
 * target, for a caller that moves focus to it.
 */
export function ProblemLine({
	problem,
	refused,
	action,
	focusRef,
}: {
	problem: Problem | null;
	refused?: string;
	action?: ReactNode;
	focusRef?: Ref<HTMLDivElement>;
}) {
	return (
		<div aria-live="assertive" className="empty:hidden">
			{problem ? (
				<div
					ref={focusRef}
					tabIndex={focusRef ? -1 : undefined}
					className="mt-4 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600 outline-none focus-visible:ring-2 focus-visible:ring-focus"
				>
					<Icon icon={Alert02Icon} size={16} className="mt-0.5 flex-none" />
					<p className="min-w-0 flex-1">{problem === "refused" && refused ? refused : UNKNOWN}</p>
					{action}
				</div>
			) : null}
		</div>
	);
}
