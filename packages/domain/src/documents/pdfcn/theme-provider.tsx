import { isValidElement } from "react";
import type { DependencyList, ReactNode } from "react";

import { professionalTheme } from "./themes/professional.ts";

export type PdfcnTheme = typeof professionalTheme;

let serializedTheme = professionalTheme;

export interface PdfcnThemeProviderProps {
	theme?: PdfcnTheme;
	children: ReactNode;
}

const renderForSerializer = (children: ReactNode, theme: PdfcnTheme): ReactNode => {
	serializedTheme = theme;

	if (!isValidElement(children) || typeof children.type !== "function") {
		return children;
	}
	if ((children.type as { __formeType?: string }).__formeType === "Document") {
		return children;
	}

	return (children.type as (props: unknown) => ReactNode)(children.props);
};

export const PdfcnThemeProvider = ({ theme, children }: PdfcnThemeProviderProps) =>
	renderForSerializer(children, theme ?? professionalTheme);

export const usePdfcnTheme = (): PdfcnTheme => serializedTheme;

// Vendored from pdfcn: the Forme serializer has no hooks, so the factory runs each time.
/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
export const useSafeMemo = <T,>(factory: () => T, _deps: DependencyList): T => factory();
