import { Alert } from "@everyfield/ui/controls";
import type { ReactNode } from "react";

export function SaveError({ message, reference, action }: { message: string; reference?: string; action?: ReactNode }) {
	return (
		<Alert role="alert" actions={action}>
			{message}
			{reference ? <span className="text-text-2"> Reference {reference}.</span> : null}
		</Alert>
	);
}
