export const CHECK_IN_PATH = "/me/check-in";

type Seat = { context: string; role?: string } | null;

export const hasCheckIn = (seat: Seat) => seat?.context === "plant" && seat.role !== "member";

export const evryOff = (pathname: string, seat: Seat) =>
	hasCheckIn(seat) && (pathname === CHECK_IN_PATH || pathname.startsWith(CHECK_IN_PATH + "/"));
