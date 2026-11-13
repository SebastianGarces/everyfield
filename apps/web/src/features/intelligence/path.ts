// The private check-in's address, apart from the model so the frame imports no check-in code (REQ-PI-038).

/** The private check-in page. Evry is off while it is open. */
export const CHECK_IN_PATH = "/me/check-in";
export const evryOff = (pathname: string) => pathname === CHECK_IN_PATH || pathname.startsWith(CHECK_IN_PATH + "/");
