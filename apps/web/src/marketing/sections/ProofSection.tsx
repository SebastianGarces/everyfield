import { MondayOverview } from "../visuals/MondayOverview";
import { SectionHead } from "./SectionHead";

/** "Here is what a Monday looks like": the head and the overview dashboard. */
export function ProofSection({ headline, body, caption }: { headline: string; body: string; caption?: string }) {
  return (
    <section id="proof" className="relative py-section">
      <div className="mx-auto max-w-mk px-page">
        <SectionHead headline={headline} body={body} className="mb-[clamp(36px,5vw,64px)]" />
        <div>
          <figure className="relative m-0 min-w-0">
            <MondayOverview />
            {caption ? <figcaption className="mt-3.5 text-[14px] text-text-3">{caption}</figcaption> : null}
          </figure>
        </div>
      </div>
    </section>
  );
}
