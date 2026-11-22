import type { SitePath } from "@everyfield/contracts/identity";
export const MY_RESIDENCY_PATH = "/my-residency";
export const readingPath = (id: string): SitePath => `${MY_RESIDENCY_PATH}/reading/${id}`;
export const milestoneAnchor = (id: string) => `milestone-${id}`;
export const milestonePath = (id: string) =>
	`${MY_RESIDENCY_PATH}?milestone=${encodeURIComponent(id)}#${milestoneAnchor(encodeURIComponent(id))}`;

const day = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});
const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

export const meetingDay = (at: string) => day.format(new Date(`${at}Z`));
export const meetingTime = (at: string) => time.format(new Date(`${at}Z`));

export const zoneName = (zone: string) => `${(zone.split("/").pop() ?? zone).replace(/_/g, " ")} time`;
