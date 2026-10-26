import type { Who } from "@/access/steps";

/** Production origin. Sitemap, robots and canonical URLs use it. */
export const SITE_URL = "https://everyfield.app";

/** Every link to the request page goes to the top of /access, where the visitor picks a form. No form anchors. */
export const ACCESS_PATH = "/access";
/** A link to /access with the "who are you" answer chosen (Revision 8: the network path on /oversight). */
export const accessFor = (role: Who) => `${ACCESS_PATH}?role=${role}`;

/** The pages that are live. The sitemap lists exactly these; nav and footer link only to these. */
export const LIVE_PAGES = ["/", "/oversight", "/access", "/privacy", "/terms"] as const;
