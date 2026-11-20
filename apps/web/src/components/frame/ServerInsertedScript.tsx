"use client";

import { useServerInsertedHTML } from "next/navigation";
import { useRef, type ReactNode } from "react";

export function ServerInsertedScript({ children }: { children: ReactNode }) {
	const sent = useRef(false);
	useServerInsertedHTML(() => {
		if (sent.current) return null;
		sent.current = true;
		return children;
	});
	return null;
}
