import { MARK, WORDMARK } from "./logo-paths";

type Shape = typeof MARK;

function Svg({ shape, className }: { shape: Shape; className?: string }) {
	return (
		<svg viewBox={shape.viewBox} fill="none" aria-hidden="true" focusable="false" className={className}>
			{shape.paths.map((p) => (
				<path
					key={p.d}
					d={p.d}
					fill="currentColor"
					fillRule={p.evenOdd ? "evenodd" : undefined}
					clipRule={p.evenOdd ? "evenodd" : undefined}
				/>
			))}
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
