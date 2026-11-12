import type { ReactNode } from "react";

/** CSS-like style object compatible with both Takumi and Forme */
type Style = Record<string, unknown>;

/**
 * Base props shared by all pdfcn PDF components.
 */
export interface PDFComponentProps {
	style?: Style;
	children: ReactNode;
}
