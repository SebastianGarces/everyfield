import { Fragment, type ReactNode } from "react";

/* Draft markers in the copy ("[PLACEHOLDER: …]", "[DRAFT …]") render highlighted, so no one reads them as final text. */
const MARKER = /(\[(?:PLACEHOLDER|DRAFT)[^\]]*\])/;

/** Copy text with its draft markers highlighted. `plain` renders the text between markers (links, for example). */
export function marked(text: string, plain: (part: string) => ReactNode = (part) => part): ReactNode[] {
	return text.split(MARKER).map((part, i) =>
		i % 2 ? (
			<mark key={i} className="bg-amber-100 px-1 font-semibold text-ink">
				{part}
			</mark>
		) : (
			<Fragment key={i}>{plain(part)}</Fragment>
		),
	);
}
