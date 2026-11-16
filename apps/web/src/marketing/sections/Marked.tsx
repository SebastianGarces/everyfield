import { Fragment, type ReactNode } from "react";

const MARKER = /(\[(?:PLACEHOLDER|DRAFT)[^\]]*\])/;

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
