// Demo church data of the product visuals (Server Components render it). Values are copied from the prototype
// (design/everyfield-marketing.html). Names and numbers belong to a demo church, as in the approved design.

export const HA_NAME = "Maria Lopez";
export const HA_DRAFT = "Hi Maria, it was good to have you at the vision meeting. Could we get coffee this week?";
export const CX_PEOPLE = [["tone-ink", "Prospect", 82, 58, "var(--ef-text-3)"], ["tone-blue", "Attendee", 41, 41, "var(--ef-blue-500)"], ["tone-amber", "Following up", 23, 23, "var(--ef-amber-500)"], ["tone-violet", "Interviewed", 14, 14, "var(--ef-violet-500)"], ["tone-green", "Core group", 34, 34, "var(--ef-green-500)"]] as const;
export const CX_TYPES = ["Vision meeting", "Training", "Orientation", "Service run", "Vision meeting"] as const;
export const CX_DRAFT = "Thank Kim for coming on Sunday. Ask what stood out to her, and offer to meet for coffee this week.";
export const CX_TEAMS = [["tone-green", "Core team", "var(--ef-green-500)", 12], ["tone-violet", "Launch team", "var(--ef-violet-500)", 28]] as const;
export const CX_SIGNS = [["MS", "Maria Santos", "Signed a core team commitment"], ["DP", "Daniel Park", "Joined the launch team"]] as const;
export const CX_Q = "Set up vision meeting #13 for Sun Oct 26 and invite our new prospects.";
export const CX_A = "Ready for your review: Sun Oct 26 at the Reyes home, the 90-minute agenda, 23 prospects as guests and the invitation email.";
export const SD_SCOPES = [["All plants", 14, 11, 5], ["Texas", 12, 10, 5], ["Greater Austin", 5, 4, 2]] as const;
export const SD_AREAS = [["Greater Austin", 5, "positive", "Strong"], ["Greater San Antonio", 3, "attention", "Watch"], ["Dallas–Fort Worth", 3, "positive", "Strong"], ["Greater Houston", 1, "unknown", "Too few"], ["Greater Oklahoma City", 2, "positive", "Strong"]] as const;
export const SD_PIPE = [["Discovery", 1, "6 wk"], ["Core group", 4, "31 wk"], ["Launch team", 3, "15 wk"], ["Training", 2, "9 wk"], ["Pre-launch", 2, "11 wk"], ["Launch Sunday", 0, ""], ["Post-launch", 2, ""]] as const;
export const OV_MAIL = "priya@eastsidecommons.org";
/* Sending churches: name, icon tone, place, plants [name, phase], summary, badge. */
export const OV_GROUPS = [
  ["Grace Church", "tone-blue", "Hyde Park, Austin", [["Harvest Point Church", 1], ["Eastside Commons", 3]], "Next launch Mar 14, 2027", ["positive", "On track"]],
  ["Redeemer Dallas", "tone-violet", "Uptown, Dallas", [["Deep Ellum Collective", 4], ["Oak Cliff Church", 2]], "Next launch Jan 24, 2027", ["positive", "On track"]],
  ["Alamo City Church", "tone-amber", "San Antonio", [["Alamo Heights Church", 2]], "Kids leader role open", ["attention", "Could use help"]],
] as const;
/* Plants in launch order: name, in Austin (1/0), icon tone, phase, committed adults, launch, findings. */
export const OV_ROWS = [
  ["Deep Ellum Collective", 0, "tone-teal", "4 · Pre-launch", "61", "Jan 24, 2027", "3 findings"],
  ["Harvest Point Church", 1, "tone-green", "1 · Core group", "34", "Mar 14, 2027", "1 finding"],
  ["Eastside Commons", 1, "tone-blue", "3 · Training", "46", "May 2, 2027", "4 findings"],
  ["Alamo Heights Church", 0, "tone-amber", "2 · Launch team", "28", "Sep 2027", "2 findings"],
] as const;
