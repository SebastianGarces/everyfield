import { Alert, Button } from "@everyfield/ui/controls";
import type { ReactNode } from "react";

export function ChurchChanged({
	onReload,
	className,
	children,
}: {
	onReload: () => void;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Alert
			role="alert"
			tone="neutral"
			title="Your church changed"
			className={className}
			actions={
				<Button size="sm" variant="primary" onClick={onReload}>
					Reload
				</Button>
			}
		>
			<p>{children}</p>
		</Alert>
	);
}
