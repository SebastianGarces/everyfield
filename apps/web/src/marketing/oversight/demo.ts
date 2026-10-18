import type { Status } from "@/components/kit/kit";
import type { Copy } from "../copy";
import { OV_ROWS } from "../demo-data";
import type { DashDemo } from "../visuals/NetworkDash";

// Demo data of /oversight. One network, so every section agrees:
//   As of Mon, Oct 19, 2026 (the home page's Monday). Countdowns are derived from it.
//   Austin Sending Network: 14 plants in Texas and Oklahoma (Austin 5, San Antonio 3, Dallas–Fort Worth 3, Houston 1,
//   Oklahoma City 2; 12 in Texas). 11 share findings; the other 3 show Limited visibility.
//   Status: 7 On track, 3 Watch, 1 Launch readiness, 3 Limited visibility.
//   Phases: Discovery 4 (Mueller Hope Church is one of them), Core group 3, Launch team 2,
//   Training 1, Pre-launch 2, Post-launch 2. Five launch in the next 12 months; 4 of those 5 have a Concern on
//   Emerging leadership (Network Intelligence step 4).
//   Grace Church's leader pipeline: 15 people. Hannah Cole moves from Apprentice to Resident on Mon, Oct 19.
// The strings the copy file owns (shared.panels) are passed in; the rest is panel data.

type P = Copy["shared"]["panels"];

export const AS_OF = "2026-10-19";
const DAY = 86_400_000;
/** Whole days from the demo date to a launch date (both ISO dates, so no time zone shifts the count). */
export const daysUntil = (iso: string) => Math.round((Date.parse(iso) - Date.parse(AS_OF)) / DAY);
/** Eastside Commons launches Sun, May 2, 2027: 195 days after the demo Monday. */
export const EASTSIDE_DAYS = daysUntil("2027-05-02");

/** The live hero lists Deep Ellum last; in launch order it comes first, and the plant with no date comes last. */
export const dashDemo = (p: P): DashDemo => ({
  plants: [
    ["Deep Ellum Collective", "Dallas, TX", "teal", "4 · Pre-launch", "61", "Jan 24, 2027", "Launch readiness", "risk"],
    ["Harvest Point Church", "Hyde Park, Austin, TX", "green", "1 · Core group", "34", "Mar 14, 2027", "On track", "positive"],
    ["Eastside Commons", "East Austin, Austin, TX", "blue", "3 · Training", "46", "May 2, 2027", p.status_watch, "attention"],
    ["Alamo Heights Church", "San Antonio, TX", "amber", "2 · Launch team", "28", "Sep 2027", p.status_watch, "attention"],
    [p.mueller_plant, "Mueller, Austin, TX", "violet", "0 · Discovery", "8", "Not set", "Limited visibility", "unknown"],
  ],
  stats: [
    ["Plants", "14", "In 2 states", 0],
    ["Launching in 12 months", "5", "Next: Deep Ellum, Jan 24", 0],
    ["Committed adults", "412", "Across 14 plants", 0],
    [p.hero_dash_attention_label, "3", "1 more at Launch readiness", 1],
  ],
  lastCol: "Status",
  // Network rubric NIR-05, slowed theme: 3 plants whose confirmed first-adult clock is 21 to 27 days, among the 11
  // plants with known growth evidence. The 3 plants that share no findings get no denominator credit.
  finding: {
    num: "3 of 11",
    unit: "plants with known evidence: no new adult in 21 to 27 days",
    title: p.hero_dash_finding,
    text: p.mueller_plant + " and 2 other plants do not share findings, so they are not counted.",
  },
});

const STATUS: Record<(typeof OV_ROWS)[number][0], readonly [Status, string]> = {
  "Deep Ellum Collective": ["risk", "Launch readiness"],
  "Harvest Point Church": ["positive", "On track"],
  "Eastside Commons": ["attention", "Watch"],
  "Alamo Heights Church": ["attention", "Watch"],
};
/** The chapter's plants in launch order (same rows and Austin flags as the live panel), with their status. */
export const PLANT_ROWS = OV_ROWS.map((r) => {
  const s = STATUS[r[0]];
  return [r[0], r[1], r[2], r[3], r[4], r[5], s[1], s[0]] as const;
});

/** The daily digest of Sun, Oct 25: counts and dates only, with no plant or person names (NTF-008). */
export const DIGEST = [
  ["calendar", "Vision meetings", "2 held", "Sun, Oct 25"],
  ["users", "Team trainings", "1 held", "Sun, Oct 25"],
  ["task", "Launch tasks", "23 done", "Sun, Oct 25"],
] as const;

/** Grace Church's leader pipeline before and after Hannah Cole's move. */
export const STAGES = ["Potential leader", "Apprentice", "Resident", "Commissioned"] as const;
export const STAGE_BEFORE = [9, 4, 1, 1] as const;
export const STAGE_AFTER = [9, 3, 2, 1] as const;

/** Leadership conversations per month; October gains the one logged in the panel. */
export const TALK_MONTHS = [["Jul", 5], ["Aug", 7], ["Sep", 9], ["Oct", 6]] as const;
export const TALKS = [["Mark Ellis met with Hannah Cole", "Oct 16"], ["Ruth Alvarez met with Luis Romero", "Oct 14"]] as const;
export const TALK_NEW = ["Mark Ellis met with Ben Torres", "Oct 19"] as const;

/** The residency template (MUL-010) and Luis Romero's milestones. */
export const RES_STAGES = [["Assimilating", "2 to 3 mo"], ["Training and planning", "6 to 9 mo"], ["Gathering", "2 to 3 mo"], ["Sending and planting", "2 to 3 mo"]] as const;
export const MILESTONES = [
  ["Start a small group and raise a replacement", "done"],
  ["Present the vision to sending leadership", "marked"],
  ["Write a church planting prospectus", "open"],
] as const;

/** What Harvest Point Church shares with Grace Church (IDN-022 categories). */
export const SHARING = [["People", true], ["Meetings", true], ["Tasks", true], ["Ministry teams", true], ["Findings", true], ["Daily activity", true], ["Wiki reading", false]] as const;
