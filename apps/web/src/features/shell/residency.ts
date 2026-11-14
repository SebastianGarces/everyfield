"use client";

import { createContext, use } from "react";

/**
 * The viewer's live residency link as the product frame knows it (WP-100), and how a page reports that it ended (the
 * Sharing card's Leave): My residency leaves the navigation and its page at once, without reading the page again.
 */
export type ResidencyState = {
	/** My residency is in the navigation. */
	linked: boolean;
	/** A page reported that the viewer left their residency since the frame loaded. */
	ended: boolean;
	left: () => void;
};
export const Residency = createContext<ResidencyState>({ linked: false, ended: false, left: () => {} });
export const useResidency = () => use(Residency);
