"use client";

import type { ReactNode } from "react";
import { FxProvider } from "@/components/motion/fx";
import { out, P, press, rise } from "@/components/motion/curves";
import { STAGE_AFTER, STAGE_BEFORE, TALK_MONTHS } from "./demo";

// Timing of the /oversight-only panels (panels.tsx renders their markup on the server). Each panel plays
// once to its end and holds, like the live /oversight panels.

const moved = (t: number) => out(P(t, 2850, 360));
const logged = (t: number) => out(P(t, 2550, 380));

const FX = {
  "digest.row": (t: number, k: number) => rise(t, 500 + k * 160),
  "digest.press": (t: number) => press(t, 2300),
  "stages.none": () => 0,
  "stages.n": (t: number, k: number) => STAGE_BEFORE[k]! * out(P(t, 300 + k * 90, 600)) + (STAGE_AFTER[k]! - STAGE_BEFORE[k]!) * moved(t),
  "goals.bar": (t: number, k: number) => "scaleX(" + ((STAGE_AFTER[k]! / 9) * out(P(t, 500 + k * 120, 650))).toFixed(4) + ")",
  "goals.n": (t: number, k: number) => STAGE_AFTER[k]! * out(P(t, 500 + k * 120, 650)),
  "talks.bar": (t: number, k: number) => "scaleY(" + (((TALK_MONTHS[k]![1] + (k === 3 ? logged(t) : 0)) / 10) * out(P(t, 300 + k * 110, 600))).toFixed(4) + ")",
  "talks.n": (t: number) => TALK_MONTHS[3][1] * out(P(t, 630, 600)) + logged(t),
  "talks.row": (t: number) => rise(t, 2650),
};

export function OversightPanelsFx({ children }: { children: ReactNode }) {
  return <FxProvider fx={FX}>{children}</FxProvider>;
}
