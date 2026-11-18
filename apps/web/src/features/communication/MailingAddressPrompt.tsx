"use client";

import { Alert, Button } from "@everyfield/ui/controls";
import type { ReactNode } from "react";
import { useSettingsLink } from "../settings/opener.tsx";

export function MailingAddressPrompt({ children }: { children: ReactNode }) {
	const link = useSettingsLink("church");
	return (
		<Alert
			title="Sending is held"
			actions={
				<Button asChild variant="secondary">
					<a {...link}>Add mailing address</a>
				</Button>
			}
		>
			<p>{children}</p>
		</Alert>
	);
}
