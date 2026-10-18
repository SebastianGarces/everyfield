import type { CSSProperties } from "react";

/**
 * Staggered page reveal (foundations.md, Motion): blocks rise 14px and fade in over 0.4s in reading order. Each block
 * starts 30ms after the one before it, with a 400ms cap. Put the `reveal` class on the block and spread this style.
 * Reduced motion turns the animation off in product.css.
 */
export function revealDelay(index: number): CSSProperties {
	return { "--reveal-delay": `${Math.min(index * 30, 400)}ms` } as CSSProperties;
}
