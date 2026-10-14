// Demo data and timing shared by the panel markup (markup.ts, server) and the motion engine (engines.ts, client).
// Values are copied from the prototype (design/everyfield-marketing.html). Names and numbers belong to a demo church.

export const HA_NAME = "Maria Lopez";
export const HA_DRAFT = "Hi Maria, it was good to have you at the vision meeting. Could we get coffee this week?";

export const CX_PEOPLE = [["tone-ink", "Prospect", 82, 58, "var(--ef-text-3)"], ["tone-blue", "Attendee", 41, 41, "var(--ef-blue-500)"], ["tone-amber", "Following up", 23, 23, "var(--ef-amber-500)"], ["tone-violet", "Interviewed", 14, 14, "var(--ef-violet-500)"], ["tone-green", "Core group", 34, 34, "var(--ef-green-500)"]] as const;
export const CX_TYPES = ["Vision meeting", "Training", "Orientation", "Service run", "Vision meeting"] as const;
export const CX_DRAFT = "Thank Kim for coming on Sunday. Ask what stood out to her, and offer to meet for coffee this week.";
export const CX_TEAMS = [["tone-green", "Core team", "var(--ef-green-500)", 12], ["tone-violet", "Launch team", "var(--ef-violet-500)", 28]] as const;
export const CX_SIGNS = [["MS", "Maria Santos", "Signed a core team commitment"], ["DP", "Daniel Park", "Joined the launch team"]] as const;
export const CX_Q = "Why does Plant Intelligence say my follow-up is slipping?";
export const CX_A = "17 of 24 new guests heard from you within 48 hours. 7 have had no contact yet. I drafted a follow-up task for each one.";
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

type Scene = { L: number; still: number; end?: number; once?: boolean; cur: [number, string][]; clicks: number[] };
/* L: loop length. still: the frame for reduced motion. cur: cursor path [ms, target]. clicks: press times.
   end: the panel plays once to this time and holds. once: plays once even outside an auto list. */
export const CX_SCN = {
  people: { L: 6400, still: 4200, cur: [[0, "rest"], [700, "rest"], [1500, ".cx-t0"], [2500, ".cx-t0"], [3300, "rest"]], clicks: [2000] },
  meet: { L: 7200, still: 5600, cur: [[0, "rest"], [400, "rest"], [1000, ".cx-t0"], [2300, ".cx-t0"], [3100, ".cx-t1"], [3700, ".cx-t1"], [4500, "rest"]], clicks: [1100, 3300] },
  follow: { L: 8600, still: 6500, cur: [[0, "mid"], [3700, "mid"], [4500, ".cx-t0"], [5400, ".cx-t0"], [6200, "mid"]], clicks: [4900] },
  teams: { L: 7600, still: 6000, cur: [[0, "rest"], [700, "rest"], [1400, ".cx-t0"], [2100, ".cx-t0"], [2900, ".cx-t1"], [3800, ".cx-t1"], [4600, "rest"]], clicks: [1700, 3300] },
  focus: { L: 6800, still: 3700, end: 3700, cur: [[0, "rest"], [1100, "rest"], [1900, ".cx-t0"], [2900, ".cx-t0"], [3700, "rest"]], clicks: [2400] },
  facts: { L: 6600, still: 3600, end: 3600, cur: [[0, "rest"], [1000, "rest"], [1800, ".cx-t0"], [2800, ".cx-t0"], [3600, "rest"]], clicks: [2300] },
  evry: { L: 8400, still: 6400, end: 6400, cur: [[0, "rest"], [3900, "rest"], [4700, ".cx-t0"], [5600, ".cx-t0"], [6400, "rest"]], clicks: [5100] },
  share: { L: 6600, still: 3500, end: 3500, cur: [[0, "rest"], [900, "rest"], [1700, ".cx-t0"], [2700, ".cx-t0"], [3500, "rest"]], clicks: [2200] },
  scope: { L: 5000, still: 3800, end: 3800, cur: [[0, "rest"], [900, "rest"], [1500, ".cx-t0"], [1950, ".cx-t0"], [2550, ".cx-t1"], [3150, ".cx-t1"], [3800, "rest"]], clicks: [1700, 2900] },
  pipe: { L: 4200, still: 3000, end: 3000, cur: [[0, "rest"], [1700, "rest"], [2400, ".cx-t0"]], clicks: [] },
  lens: { L: 4700, still: 3500, end: 3500, cur: [[0, "rest"], [1200, "rest"], [1900, ".cx-t0"], [2600, ".cx-t0"], [3400, "rest"]], clicks: [2300] },
  top: { L: 4800, still: 3600, end: 3600, cur: [[0, "rest"], [1300, "rest"], [2000, ".cx-t0"], [2800, ".cx-t0"], [3600, "rest"]], clicks: [2400] },
  invite: { L: 7000, still: 5600, end: 5600, once: true, cur: [[0, "rest"], [500, "rest"], [1100, ".cx-t0"], [2800, ".cx-t0"], [3400, ".cx-t1"], [4000, ".cx-t1"], [4700, "rest"]], clicks: [1250, 3600] },
  senders: { L: 5000, still: 3400, end: 3400, cur: [[0, "rest"], [1300, "rest"], [2000, ".cx-t0"], [2700, ".cx-t0"], [3400, "rest"]], clicks: [2250] },
  plants: { L: 5600, still: 3400, end: 3400, once: true, cur: [[0, "rest"], [1100, "rest"], [1800, ".cx-t0"], [2600, ".cx-t0"], [3400, "rest"]], clicks: [2100] },
  help: { L: 5600, still: 3600, end: 3600, once: true, cur: [[0, "rest"], [1300, "rest"], [2000, ".cx-t0"], [2800, ".cx-t0"], [3600, "rest"]], clicks: [2400] },
} satisfies Record<string, Scene>;
export type PanelKind = keyof typeof CX_SCN;
export const SCENES: Record<PanelKind, Scene> = CX_SCN;
export const isPanelKind = (k: string | undefined): k is PanelKind => k !== undefined && Object.hasOwn(CX_SCN, k);
