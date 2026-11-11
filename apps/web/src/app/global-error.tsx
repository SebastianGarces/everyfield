"use client";

// The last boundary: it replaces the root layout when that layout fails, so it renders its own document and brings its
// own stylesheet and fonts instead of reading them from the layout.
import "../styles/marketing.css";
import { GlobalErrorDocument, type BoundaryProps } from "@/features/boundaries/Errors";
import { FONT_VARIABLES } from "./fonts";

export default function GlobalError(props: BoundaryProps) {
	return <GlobalErrorDocument {...props} className={FONT_VARIABLES} />;
}
