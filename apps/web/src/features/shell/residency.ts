"use client";

import { createContext, use } from "react";

export type ResidencyState = {
	linked: boolean;
	ended: boolean;
	left: () => void;
};
export const Residency = createContext<ResidencyState>({ linked: false, ended: false, left: () => {} });
export const useResidency = () => use(Residency);
