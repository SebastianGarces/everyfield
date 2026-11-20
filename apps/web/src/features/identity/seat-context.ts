"use client";

import { createContext, use } from "react";
import type { Role } from "../people/server.ts";

export const OwnSeatContext = createContext<(role: Role | null) => void>(() => {});
export const useOwnSeatChange = () => use(OwnSeatContext);
