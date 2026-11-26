"use client";

import { createContext, use } from "react";

export const EvryOpenerContext = createContext<(() => void) | null>(null);

export const useEvryOpener = () => use(EvryOpenerContext);
