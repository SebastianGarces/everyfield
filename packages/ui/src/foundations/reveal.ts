import type { CSSProperties } from "react";

export function revealDelay(index: number): CSSProperties {
	return { "--reveal-delay": `${Math.min(index * 30, 400)}ms` } as CSSProperties;
}
