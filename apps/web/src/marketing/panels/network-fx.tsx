"use client";

import { useTransform } from "motion/react";
import type { ReactNode } from "react";
import { FxProvider, useFx, useT } from "@/components/motion/fx";
import { m } from "@/components/motion/m";
import { inOut, out, P, press, rise } from "@/components/motion/curves";
import { SD_PIPE, SD_SCOPES } from "../demo-data";

// Timing of the sending section (home) and Network Intelligence (/oversight) panels; network.tsx renders their markup on
// the server. Each panel plays once to its end and holds (Revision 19). The prototype's numbers, unchanged.

const scopeA = (t: number) => out(P(t, 300, 900));
const q1 = (t: number) => inOut(P(t, 1800, 600));
const q2 = (t: number) => inOut(P(t, 3000, 600));
const p1 = (t: number) => out(P(t, 1750, 300));
const p2 = (t: number) => out(P(t, 2950, 300));
const SCOPE_ON = [(t: number) => 1 - p1(t), (t: number) => p1(t) - p2(t), (t: number) => p2(t)];
const S = SD_SCOPES;

const FX = {
  "scope.on": (t: number, i: number) => SCOPE_ON[i]!(t),
  "scope.press": (t: number, i: number) => press(t, i === 1 ? 1700 : 2900, 0.06),
  "scope.stat": (t: number, k: number) => {
    const i = (k + 1) as 1 | 2 | 3;
    return S[0][i] * scopeA(t) + (S[1][i] - S[0][i]) * q1(t) + (S[2][i] - S[1][i]) * q2(t);
  },
  "scope.area": (t: number, k: number) => 1 - 0.72 * (k === 4 ? out(P(t, 1850, 400)) : k ? out(P(t, 3050, 400)) : 0),
  "pipe.bar": (t: number, k: number) => "scaleX(" + ((SD_PIPE[k]![1] / 4) * out(P(t, 300 + k * 120, 650))).toFixed(4) + ")",
  "pipe.count": (t: number, k: number) => SD_PIPE[k]![1] * out(P(t, 300 + k * 120, 650)),
  "pipe.wk": (t: number, k: number) => out(P(t, 900 + k * 120, 400)),
  "pipe.launch": (t: number) => 5 * out(P(t, 1900, 800)),
  "lens.press": (t: number) => press(t, 2300, 0.1),
  "lens.wipe": (t: number, i: number) => inOut(P(t, 350 + i * 250, 700)),
  "lens.sheet": (t: number) => { const sh = out(P(t, 2450, 420)); return [0, (1 - sh) * 16, 1, sh]; },
  "lens.plant": (t: number, k: number) => rise(t, 2650 + k * 110),
  "top.n": (t: number) => 4 * out(P(t, 300, 800)),
  "top.press": (t: number) => press(t, 2400),
};

export function NetworkFx({ children }: { children: ReactNode }) {
  return <FxProvider fx={FX}>{children}</FxProvider>;
}

/**
 * A left-to-right wipe with transforms only: a rounded window slides in from the left while its content slides the
 * other way, so the bar stays put and its right edge stays rounded (the prototype animated clip-path).
 */
export function Wipe({ fx, n, children }: { fx: string; n?: number; children: ReactNode }) {
  const t = useT(), p = useFx<number>(fx, n);
  const win = useTransform(t, (v) => "translate3d(" + (-(1 - p(v)) * 100).toFixed(2) + "%,0,0)");
  const back = useTransform(t, (v) => "translate3d(" + ((1 - p(v)) * 100).toFixed(2) + "%,0,0)");
  return (
    <div className="h-2 overflow-hidden rounded-full">
      <m.div className="h-full overflow-hidden rounded-full will-change-transform" style={{ transform: win }}>
        <m.div className="flex h-full gap-0.5 will-change-transform" style={{ transform: back }}>{children}</m.div>
      </m.div>
    </div>
  );
}
