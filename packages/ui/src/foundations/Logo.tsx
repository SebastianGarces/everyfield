import { LOCKUP, MARK, WORDMARK } from "./logo-paths.generated";

type Shape = typeof MARK;

function Paths({ shape }: { shape: Shape }) {
	return shape.paths.map((p) => (
		<path
			key={p.d}
			d={p.d}
			fill="currentColor"
			fillRule={p.evenOdd ? "evenodd" : undefined}
			clipRule={p.evenOdd ? "evenodd" : undefined}
		/>
	));
}

function Svg({ shape, className }: { shape: Shape; className?: string }) {
	return (
		<svg viewBox={shape.viewBox} fill="none" aria-hidden="true" focusable="false" className={className}>
			<Paths shape={shape} />
		</svg>
	);
}

/** The Everyfield mark. It takes the current text color; the caller sets the size. */
export function LogoMark({ className }: { className?: string }) {
	return <Svg shape={MARK} className={className} />;
}

/** The Everyfield wordmark. It takes the current text color; the caller sets the size. */
export function Wordmark({ className }: { className?: string }) {
	return <Svg shape={WORDMARK} className={className} />;
}

/** The Everyfield lockup: mark and wordmark in the prototype's proportions. Ink on light, cream on ink; the caller sets the size. */
export function Lockup({ className }: { className?: string }) {
	return (
		<svg viewBox={LOCKUP.viewBox} fill="none" aria-hidden="true" focusable="false" className={className}>
			<svg viewBox={MARK.viewBox} {...LOCKUP.mark}>
				<Paths shape={MARK} />
			</svg>
			<svg viewBox={WORDMARK.viewBox} {...LOCKUP.wordmark}>
				<Paths shape={WORDMARK} />
			</svg>
		</svg>
	);
}
