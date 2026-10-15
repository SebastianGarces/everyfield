// Timing of the product-visual scenes, copied from the prototype (design/everyfield-marketing.html). The chapters read it
// in the browser; each panel's own curves are in its family's *-fx.tsx registry.

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
