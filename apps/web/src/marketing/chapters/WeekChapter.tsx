import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { COPY } from "../copy";
import { ICONS, isIconName } from "../icons";
import { followDemo, MEET_WHEN, PEOPLE_TITLE, teamsDemo } from "../home/demo";
import { FollowPanel, MeetPanel, PeoplePanel, TeamsPanel } from "../panels/week";
import { isPanelKind, type PanelKind } from "../scene-data";
import { ScrollChapter, type ChapterStep } from "./ScrollChapter";

/* Revision 13: week panel and icon colours in step order are blue, orange, green, lilac; the title phrase for each step. */
const TONES = ["g-sky", "g-dawn", "g-field", "g-lilac"];
const WORDS = ["Reach", "gather", "follow up", "commit"];
const P = COPY.shared.panels;
const PANELS: Partial<Record<PanelKind, () => ReactNode>> = {
  people: () => <PeoplePanel title={PEOPLE_TITLE} note={P.week_people_line} />,
  meet: () => <MeetPanel when={MEET_WHEN} />,
  follow: () => <FollowPanel demo={followDemo(P)} />,
  teams: () => <TeamsPanel demo={teamsDemo(P)} />,
};

/** Splits the heading into text and the step phrases, in order. Falls back to plain text if a phrase is missing. */
function titleParts(title: string, words: string[]) {
  const out: (string | { w: number; text: string })[] = [];
  let at = 0;
  for (const [i, w] of words.entries()) {
    const j = title.indexOf(w, at);
    if (j < 0) return [title];
    if (j > at) out.push(title.slice(at, j));
    out.push({ w: i, text: w });
    at = j + w.length;
  }
  if (at < title.length) out.push(title.slice(at));
  return out;
}

/**
 * "Reach, gather, follow up, commit": the home week chapter. The step text is rendered here; the client chapter adds
 * the scroll-linked panel and the step states (data-on on the step, data-fold on the section, data-rv while rising in).
 */
export function WeekChapter() {
  const W = COPY.shared.week;
  const steps: ChapterStep[] = W.steps.map((s, i) => {
    if (!isPanelKind(s.panel) || !PANELS[s.panel]) throw new Error(`week step ${i}: no panel "${s.panel}"`);
    const tone = TONES[i] ?? "g-field";
    return {
      kind: s.panel,
      panel: PANELS[s.panel]!(),
      tone,
      text: (
        <div
          data-txt=""
          className={cn(
            "[--cx-h3:clamp(18px,1.4vw,21px)] [--cx-ti:calc(var(--cx-h3)*1.48)]",
            "[transition:opacity_.25s_cubic-bezier(.37,0,.63,1)] motion-reduce:[transition:none] mk-cx:motion-safe:group-data-[on=false]/step:opacity-[.82]",
            // Rise in once (the chapter marks steps below the fold with data-rv).
            "group-data-[rv]/step:*:[transition:opacity_.42s_var(--ease-mk-out),transform_.42s_var(--ease-mk-out)]",
            "group-data-[rv=wait]/step:*:opacity-0 group-data-[rv=wait]/step:*:[transform:translateY(14px)] group-data-[rv=in]/step:[&>:nth-child(2)]:[transition-delay:75ms]",
          )}
        >
          <div data-tl="" className="flex items-start gap-3.5">
            <span aria-hidden="true" className={cn("mt-[calc((var(--cx-h3)*1.15-var(--cx-ti))/2)] grid size-(--cx-ti) flex-none place-items-center rounded-[calc(var(--cx-ti)*.265)] bg-[var(--g-base)] text-ink shadow-mk-icon-tile", tone)}>
              <Icon icon={isIconName(s.icon) ? ICONS[s.icon] : ICONS.sparkle} className="size-1/2 [&_path]:[stroke-width:1.8]" />
            </span>
            <h3 className="min-w-0 font-display text-(length:--cx-h3) leading-[1.15] font-medium tracking-[-0.02em] [font-stretch:100%] [text-wrap:balance]">{s.title}</h3>
          </div>
          <p className="mt-3 max-w-[46ch] text-text-2 group-data-[fold]/chap:[transition:opacity_.25s_cubic-bezier(.37,0,.63,1)] group-data-[fold]/chap:group-data-[past]/step:opacity-0">{s.body}</p>
        </div>
      ),
    };
  });
  return <ScrollChapter id="week" title={titleParts(W.title, WORDS)} steps={steps} />;
}
