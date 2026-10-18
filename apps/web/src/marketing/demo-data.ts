// Demo church data of the product visuals (Server Components render it). Values are copied from the prototype
// (design/everyfield-marketing.html). Names and numbers belong to a demo church, as in the approved design.

export const HA_DRAFT = "Hi Maria, it was good to have you at the vision meeting. Could we get coffee this week?";
export const CX_PEOPLE = [
	["tone-ink", "Prospect", 82, 58, "var(--ef-text-3)"],
	["tone-blue", "Attendee", 41, 41, "var(--ef-blue-500)"],
	["tone-amber", "Following up", 23, 23, "var(--ef-amber-500)"],
	["tone-violet", "Interviewed", 14, 14, "var(--ef-violet-500)"],
	["tone-green", "Core group", 34, 34, "var(--ef-green-500)"],
] as const;
export const CX_TYPES = ["Vision meeting", "Training", "Orientation", "Service run", "Vision meeting"] as const;
export const SD_SCOPES = [
	["All plants", 14, 11, 5],
	["Texas", 12, 10, 5],
	["Greater Austin", 5, 4, 2],
] as const;
export const SD_AREAS = [
	["Greater Austin", 5, "positive", "Strong"],
	["Greater San Antonio", 3, "attention", "Watch"],
	["Dallas–Fort Worth", 3, "positive", "Strong"],
	["Greater Houston", 1, "unknown", "Too few"],
	["Greater Oklahoma City", 2, "positive", "Strong"],
] as const;
/* The 14 plants of the /oversight demo network by phase (oversight/demo.ts has its timeline). */
export const SD_PIPE = [
	["Discovery", 4, "8 wk"],
	["Core group", 3, "31 wk"],
	["Launch team", 2, "15 wk"],
	["Training", 1, "9 wk"],
	["Pre-launch", 2, "11 wk"],
	["Launch Sunday", 0, ""],
	["Post-launch", 2, ""],
] as const;
export const OV_MAIL = "priya@eastsidecommons.org";
/* Plants in launch order: name, in Austin (1/0), icon tone, phase, committed adults, launch, findings. */
export const OV_ROWS = [
	["Deep Ellum Collective", 0, "tone-teal", "4 · Pre-launch", "61", "Jan 24, 2027", "3 findings"],
	["Harvest Point Church", 1, "tone-green", "1 · Core group", "34", "Mar 14, 2027", "1 finding"],
	["Eastside Commons", 1, "tone-blue", "3 · Training", "46", "May 2, 2027", "4 findings"],
	["Alamo Heights Church", 0, "tone-amber", "2 · Launch team", "28", "Sep 2027", "2 findings"],
] as const;
