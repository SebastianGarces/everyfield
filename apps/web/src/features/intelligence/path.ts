export const CHECK_IN_PATH = "/me/check-in";
export const evryOff = (pathname: string) => pathname === CHECK_IN_PATH || pathname.startsWith(CHECK_IN_PATH + "/");
