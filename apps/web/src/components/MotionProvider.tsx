"use client";

import { LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

// The animation features load in their own chunk after hydration, so pages pay for them only once, off the critical path.
// domAnimation is the smallest set that covers animate, exit, variants, hover, tap and focus; nothing here needs layout
// animations (domMax).
const features = () => import("./motion-features").then((m) => m.default);

/**
 * Motion for the marketing site. Use the `m` components inside this provider (strict mode rejects the full `motion`
 * components, which would bundle every feature). reducedMotion="user" follows the visitor's system setting: transform
 * and layout animations are skipped, opacity and colour still fade.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={features} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
