import { Display } from "@/components/Display";
import { Reveal } from "@/components/motion/Reveal";
import { VisionZoom } from "../visuals/VisionZoom";

/** "The vision, down to this week": the head on the left, the four-level zoom on the right (stacked below 901 px). */
export function VisionSection({ headline, body }: { headline: string; body: string }) {
  return (
    <section id="vision" aria-labelledby="vision-title" className="relative py-section">
      <div className="mx-auto grid max-w-mk grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-center gap-[clamp(36px,5vw,88px)] px-page max-mk-cx:grid-cols-[minmax(0,1fr)]">
        <Reveal className="max-w-[540px] max-mk-cx:mx-auto max-mk-cx:max-w-[640px] max-mk-cx:text-center">
          <Display as="h2" size="h2" id="vision-title">{headline}</Display>
          <p className="mt-5 text-[clamp(17px,1.3vw,19px)] leading-[1.55] text-pretty text-text-2">{body}</p>
        </Reveal>
        <VisionZoom />
      </div>
    </section>
  );
}
