import { cn } from "../foundations";

/**
 * A small ring spinner in the current text color. Decorative: the busy control carries aria-busy and its own label.
 * Under reduced motion it stops turning and stays visible as a partial ring.
 */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
	return (
		<span
			aria-hidden="true"
			style={{ width: size, height: size }}
			className={cn(
				"inline-block flex-none animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none",
				className,
			)}
		/>
	);
}
