// Shared by the My residency screens: addresses, the meeting line and zone names. No React and no server code.

export const MY_RESIDENCY_PATH = "/my-residency";
export const readingPath = (id: string) => `${MY_RESIDENCY_PATH}/reading/${id}`;

const day = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});
const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/** A wall-clock time (YYYY-MM-DDTHH:MM:SS) in its own zone, as "Tue, Oct 20, 2026 · 7:00 PM". */
export const meetingDay = (at: string) => day.format(new Date(`${at}Z`));
export const meetingTime = (at: string) => time.format(new Date(`${at}Z`));

/** A zone as people say it: "America/Los_Angeles" reads "Los Angeles time". */
export const zoneName = (zone: string) => `${(zone.split("/").pop() ?? zone).replace(/_/g, " ")} time`;
