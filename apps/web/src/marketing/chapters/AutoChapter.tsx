import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { COPY } from "../copy";
import { ICONS } from "../icons";
import { isPanelKind, type PanelKind } from "../scene-data";
import { AutoList, type AutoStep } from "./AutoList";

type Id = "intelligence" | "sending" | "every-plant" | "network-intelligence";
type Def = { title: string; mirror?: boolean; link?: string; steps: { kind: PanelKind; tone: string; title: string; body: string }[] };

const NETWORK = ["scope", "pipe", "lens", "top"] as const;
const NETWORK_TONES = ["g-sea", "g-rose", "g-sun", "g-slate"];

function defs(id: Id): Def {
  const S = COPY.shared;
  switch (id) {
    case "intelligence":
      return {
        title: S.intelligence.title,
        steps: [
          { kind: "focus", tone: "g-lilac", title: "One focus each week.", body: "Plant Intelligence reads your records and names the one thing that needs you most this week." },
          { kind: "facts", tone: "g-field", title: "Every finding shows its facts.", body: "Each finding links to the records it used, so you can check it." },
          { kind: "evry", tone: "g-sky", title: "Ask Evry why.", body: "Evry explains a finding against the rubric and prepares the work it points to. You approve each change." },
          { kind: "share", tone: "g-dawn", title: "You see it first.", body: "Each concern comes to you before anyone else. Your sending church sees a short summary, and only what you share." },
        ],
      };
    case "sending":
      return { title: S.sending.title, mirror: true, link: S.sending.link, steps: NETWORK.map((k, i) => ({ kind: k, tone: NETWORK_TONES[i]!, ...S.sending.steps[i]! })) };
    case "every-plant":
      return {
        title: S.oversight_page.chapter.title,
        steps: S.oversight_page.chapter.steps.map((s, i) => {
          if (!isPanelKind(s.panel)) throw new Error(`every-plant step ${i}: unknown panel "${s.panel}"`);
          return { kind: s.panel, tone: ["g-lilac", "g-dawn", "g-sky", "g-sun"][i]!, title: s.title, body: s.body };
        }),
      };
    case "network-intelligence":
      return { title: S.oversight_page.intelligence.title, mirror: true, steps: NETWORK.map((k, i) => ({ kind: k, tone: NETWORK_TONES[i]!, ...S.oversight_page.intelligence.steps[i]! })) };
  }
}

/**
 * An auto-advancing chapter: Plant Intelligence and the sending section on home, "See every plant you send" and
 * Network Intelligence on /oversight. The heading and the tab text are rendered here; AutoList runs the tabs and panels.
 * The page passes its panel elements by kind (it imports only its own panels, so each page ships only those).
 */
export function AutoChapter({ id, panels, revealUp }: { id: Id; panels: Partial<Record<PanelKind, ReactNode>>; revealUp?: boolean }) {
  const d = defs(id);
  const head = (
    <div className={cn("max-w-[640px]", d.mirror ? "mb-[clamp(14px,1.6vw,22px)]" : "mb-[clamp(28px,3vw,44px)]", d.link && "text-mk-h2 leading-[1.08] whitespace-nowrap")}>
      <Display as="h2" size="h2" id={id + "-title"} className={cn(d.link && "inline whitespace-normal")}>
        {d.title}
      </Display>
      {d.link ? (
        <Link
          href="/oversight"
          aria-label={d.link}
          className="relative -top-[.08em] ml-3 inline-grid size-[34px] place-items-center rounded-[9px] bg-mk-surface-2 align-middle text-ink/70 [transition:background-color_.15s_var(--ease-mk),color_.15s_var(--ease-mk)] hover:bg-mk-surface-3 hover:text-ink"
        >
          <Icon icon={ICONS.arrowUpRight} size={18} className="[&_path]:[stroke-width:1.8]" />
        </Link>
      ) : null}
    </div>
  );
  const steps: AutoStep[] = d.steps.map((s) => {
    if (!panels[s.kind]) throw new Error(`${id}: the page passes no "${s.kind}" panel`);
    return { ...s, panel: panels[s.kind] };
  });
  return <AutoList id={id} head={head} mirror={d.mirror} steps={steps} revealUp={revealUp} />;
}
