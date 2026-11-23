"use client";

import { Alert } from "@everyfield/ui/controls";
import type { FocusRequest } from "@everyfield/ui/foundations";
import type { ReactNode } from "react";

export function Problem({ children, request = 1 }: { children: ReactNode; request?: FocusRequest }) {
	return (
		<Alert role="alert" focus={request}>
			{children}
		</Alert>
	);
}
