import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { InlineAlert } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import type { ReactNode, Ref } from "react";
import type { Problem } from "../../components/intent.ts";

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
		<InlineAlert ref={focusRef} tabIndex={focusRef ? -1 : undefined} actions={action} className="pt-4">
			{problem ? (problem === "refused" && refused ? refused : UNKNOWN) : null}
		</InlineAlert>
	);
}
