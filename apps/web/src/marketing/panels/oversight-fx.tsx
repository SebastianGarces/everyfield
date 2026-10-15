"use client";

import type { ReactNode } from "react";
import { FxProvider } from "@/components/motion/fx";
import { flash, out, P, pop, press, rise, swapOut, type Frame } from "@/components/motion/curves";
import { OV_GROUPS, OV_ROWS } from "../demo-data";

// Timing of the /oversight "See every plant you send" panels (oversight.tsx renders their markup on the server). Each panel
// plays once to its end and holds (Revision 25). The prototype's numbers, unchanged.

const sent = (t: number) => out(P(t, 5000, 380));
const plantsP = (t: number) => out(P(t, 2150, 300));
const PLANTS_ON = [(t: number) => 1 - plantsP(t), plantsP, () => 0];
const fadeOnly = (f: Frame): Frame => [f[0], 0, f[2], f[3]];

const FX = {
  "invite.press": (t: number) => press(t, 1250, 0.03),
  "invite.focus": (t: number) => flash(t, 1300, 2800),
  "invite.type": (t: number) => P(t, 1450, 1200),
  "invite.swap": (t: number) => out(P(t, 3800, 380)),
  "invite.row": (t: number) => rise(t, 4100),
  "invite.invited": (t: number) => swapOut(sent(t)),
  "invite.connected": (t: number) => pop(t, 5000),
  "plants.on": (t: number, i: number) => PLANTS_ON[i]!(t),
  "plants.press": (t: number) => press(t, 2100, 0.06),
  /** Rows rise in; the ones outside Austin dim when Austin is selected. */
  "plants.row": (t: number, k: number) => {
    const q = out(P(t, 300 + k * 110, 480));
    return [0, (1 - q) * 12, 1, q * (1 - 0.66 * (OV_ROWS[k]![1] ? 0 : out(P(t, 2250, 400))))];
  },
  "senders.count": (t: number, k: number) => OV_GROUPS[k]![3].length * out(P(t, 450 + k * 160, 700)),
  "senders.pill": (t: number, n: number) => out(P(t, 800 + n * 70, 360)),
  "senders.press": (t: number, k: number) => (k === 0 ? press(t, 2250, 0.03) : "none"),
  // The first group only fades in: in the prototype its press (a scale) replaced the rise's translate on the same element.
  "senders.rise": (t: number, k: number) => (k === 0 ? fadeOnly(rise(t, 250)) : rise(t, 250 + k * 160)),
  "help.days": (t: number) => 205 * out(P(t, 300, 1100)),
  "help.press": (t: number) => press(t, 2400),
  "help.swap": (t: number) => out(P(t, 2550, 380)),
};

export function OversightFx({ children }: { children: ReactNode }) {
  return <FxProvider fx={FX}>{children}</FxProvider>;
}
