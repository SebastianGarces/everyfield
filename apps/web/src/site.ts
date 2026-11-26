import type { Who } from "@/access/steps";

export const SITE_URL = "https://everyfield.app";

export const ACCESS_PATH = "/access";
export const accessFor = (role: Who) => `${ACCESS_PATH}?role=${role}`;

export const LIVE_PAGES = ["/", "/oversight", "/access", "/privacy", "/terms"] as const;

// Served but kept out of the sitemap, robots and search until the owner makes them live.
export const HIDDEN_PAGES = ["/discovery"] as const;
