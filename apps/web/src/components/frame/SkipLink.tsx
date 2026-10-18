/** The first Tab stop on every page. Off screen until it has keyboard focus; it moves focus to the main landmark. */
export function SkipLink() {
	return (
		<a
			href="#view"
			className="fixed top-3 left-3 z-100 -translate-y-[160%] rounded-[12px] bg-ink px-4 py-3 text-[15px] font-semibold text-white no-underline focus-visible:translate-y-0 focus-visible:outline-ink"
		>
			Skip to content
		</a>
	);
}
