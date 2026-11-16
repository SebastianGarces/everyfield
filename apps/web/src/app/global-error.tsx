"use client";

import "../styles/marketing.css";
import { GlobalErrorDocument, type BoundaryProps } from "@/features/boundaries/Errors";
import { FONT_VARIABLES } from "./fonts";

export default function GlobalError(props: BoundaryProps) {
	return <GlobalErrorDocument {...props} className={FONT_VARIABLES} />;
}
