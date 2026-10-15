/** Production origin. Sitemap, robots and canonical URLs use it. */
export const SITE_URL = "https://everyfield.app";

/** Every link to the request page goes to the top of /access, where the visitor picks a form. No form anchors. */
export const ACCESS_PATH = "/access";

/** The pages that are live. The sitemap lists exactly these; nav and footer link only to these. */
export const LIVE_PAGES = ["/", "/oversight", "/access", "/privacy", "/terms"] as const;
