import type { Outcome } from "@everyfield/contracts/common";
import { useRef } from "react";

export function useKeys() {
	const keys = useRef<Record<string, string>>({});
	return {
		take: (name: string) => (keys.current[name] ??= crypto.randomUUID()),
		settle(name: string, result: Outcome<unknown>) {
			if (result.status !== "lost") keys.current[name] = crypto.randomUUID();
		},
	};
}
