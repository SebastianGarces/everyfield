"use client";

import { domMin, LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/**
 * Motion for the marketing site. Use the `m` components inside this provider (strict mode rejects the full `motion`
 * components, which would bundle every feature). domMin is the smallest feature set: the DOM renderer that writes
 * MotionValue styles, which is all the scenes use (their clocks are MotionValues; no gestures, layout or exit animations).
 * It loads with the provider, not after hydration: a MotionValue set before the renderer exists is never written, and
 * reduced motion sets every scene to its still frame at once. reducedMotion="user" follows the visitor's system setting.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domMin} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
