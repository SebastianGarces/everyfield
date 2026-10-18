import {
  BookOpen01Icon,
  Calendar03Icon,
  HandPrayerIcon,
  MentorIcon,
  Plant01Icon,
  Rocket01Icon,
  TaskDone01Icon,
  UserGroupIcon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { cn, EvryBot, Icon, LogoMark, revealDelay, Wordmark, type EvryBotSize, type EvryMood } from "..";
import { PageHead } from "../../shell/preview/ShellPreview";
import { HoverDemo } from "./HoverDemo";

/**
 * The foundations preview at /design/foundations, after the prototype's #/foundations page: logo, color roles, type,
 * shape, elevation, patterns, focus, motion and the Evry character. Every value comes from tokens.css. Gradient cards
 * (InsightCard) are surfaces and ship with WP-089.
 */
export function FoundationsPreview() {
  return (
    <>
      <PageHead crumb="Foundations" title="Foundations">
        Brand, color roles, type, shape and patterns. Everything else is built from these tokens. Dark mode uses the same token names with dark values: switch it with the sun and moon in the rail.
      </PageHead>

      <Section index={1} title="Logo" code="LogoMark · Wordmark">
        <div className="grid gap-5 app-md:grid-cols-3">
          <BrandTile className="bg-ink-fixed text-cream" />
          <BrandTile className="bg-green text-ink-fixed" />
          <BrandTile className="bg-cream text-ink-fixed shadow-card" />
        </div>
        <Note>In the app the mark is brand green and the wordmark is ink, with no background (top bar).</Note>
      </Section>

      <Section index={2} title="Brand colors" code="--ef-ink · --ef-green · --ef-cream">
        <Note>The app runs on neutral greys so the data hues stand out. Ink carries the brand inside the app. Field green is for the logo and rare brand moments. Cream is for marketing and print.</Note>
        <div className="grid gap-5 app-md:grid-cols-3">
          <Swatch className="bg-ink" name="Ink" use="--ef-ink · text, active nav, primary button" />
          <Swatch className="bg-green" name="Field green" use="--ef-green · logo, brand moments, green 500" />
          <Swatch className="bg-cream" name="Cream" use="--ef-cream · brand and marketing only" />
        </div>
      </Section>

      <Section index={3} title="Data hues and roles" code="--ef-{hue}-{600|500|300|100|50}">
        <Note>Every hue has one job. 600 and 700 are for text and icons. Text on a 500 fill is ink, never white. 300 draws hatch lines, 100 tints badges and 50 washes large areas.</Note>
        <div className="grid gap-5 app-md:grid-cols-2 app-lg:grid-cols-3">
          <Ramp label="Green · healthy, committed, positive" steps={[["700", "bg-green-700"], ["500", "bg-green-500"], ["300", "bg-green-300"], ["100", "bg-green-100"], ["50", "bg-green-50"]]} />
          <Ramp label="Blue · measured, actual, information" steps={[["600", "bg-blue-600"], ["500", "bg-blue-500"], ["300", "bg-blue-300"], ["100", "bg-blue-100"], ["50", "bg-blue-50"]]} />
          <Ramp label="Rose · risk, gap, overdue" steps={[["600", "bg-magenta-600"], ["500", "bg-magenta-500"], ["300", "bg-magenta-300"], ["100", "bg-magenta-100"], ["50", "bg-magenta-50"]]} />
          <Ramp label="Orange · attention, waiting, draft" steps={[["600", "bg-amber-600"], ["500", "bg-amber-500"], ["300", "bg-amber-300"], ["100", "bg-amber-100"], ["50", "bg-amber-50"]]} />
          <Ramp label="Lilac and teal · categories only" steps={[["v600", "bg-violet-600"], ["v500", "bg-violet-500"], ["v100", "bg-violet-100"], ["t600", "bg-teal-600"], ["t500", "bg-teal-500"], ["t100", "bg-teal-100"]]} />
          <Ramp label="Neutrals · app surfaces and text" steps={[["text-2", "bg-text-2"], ["text-3", "bg-text-3"], ["canvas", "bg-canvas"], ["frame", "bg-frame"], ["surface", "bg-surface"], ["raised", "bg-surface-raised"]]} />
        </div>
      </Section>

      <Section index={4} title="Type" code="--ef-font-display · --ef-font-body">
        <div className="grid gap-5 app-md:grid-cols-2">
          <Specimen label="Bricolage Grotesque · titles and numbers">
            <div className="num text-[76px] leading-none text-ink max-app-sm:text-display-md">34 of 50</div>
            <div className="mt-3 font-display text-display-sm tracking-[-.035em] text-ink">Core group</div>
            <div className="mt-2.5 font-display text-title-md text-ink">Vision meeting · Oct 12</div>
            <p className="mt-3 text-sm text-text-3">display-lg 76 · display-sm 40 · title-lg 28 · title-md 22 · title-sm 18</p>
          </Specimen>
          <Specimen label="Instrument Sans · body and UI">
            <p className="text-lg text-ink">Gather a core group of committed adults who share the vision before launch.</p>
            <p className="mt-3 text-md text-ink">Body 14 is the default for UI text, lists and tables.</p>
            <p className="mt-3 text-sm text-text-2">Small 13 is for captions, table headers and helper text.</p>
            <p className="mt-3 text-xs text-text-3">XS 12 is for labels, chips and counts.</p>
            <p className="mt-4 flex flex-wrap gap-2 text-ink"><span className="font-normal">Regular 400</span>·<span className="font-medium">Medium 500</span>·<span className="font-semibold">Semibold 600</span></p>
          </Specimen>
        </div>
      </Section>

      <Section index={5} title="Shape, elevation and patterns" code="--ef-radius-* · --ef-shadow-* · .hatch">
        <div className="grid gap-5 app-md:grid-cols-2 app-lg:grid-cols-4">
          <Specimen label="Radius">
            <div className="flex flex-wrap items-end gap-3">
              <div className="size-10 rounded-xs bg-surface-2" />
              <div className="size-12 rounded-sm bg-surface-2" />
              <div className="size-14 rounded-md bg-surface-2" />
              <div className="size-16 rounded-lg bg-surface-2" />
              <div className="size-[72px] rounded-card bg-surface-2" />
            </div>
            <p className="mt-3 text-xs text-text-3">6 · 10 · 14 · 20 · 26 card · 34 frame</p>
          </Specimen>
          <Specimen label="Elevation">
            <div className="flex gap-3">
              <div className="h-16 flex-1 rounded-md bg-surface shadow-card" />
              <div className="h-16 flex-1 rounded-md bg-surface-raised shadow-raised" />
              <div className="h-16 flex-1 rounded-md bg-surface-raised shadow-pop" />
            </div>
            <p className="mt-3 text-xs text-text-3">card · raised · pop</p>
          </Specimen>
          <Specimen label="Hatch = planned or estimated">
            <div className="flex flex-col gap-2">
              <div className="hatch h-4 rounded-pill [--hatch:var(--ef-blue-300)]" />
              <div className="hatch h-4 w-[70%] rounded-pill [--hatch:var(--ef-magenta-500)]" />
              <div className="hatch h-4 w-1/2 rounded-pill [--hatch:var(--ef-green-500)]" />
            </div>
            <p className="mt-3 text-xs text-text-3">Solid fill = actual or recorded</p>
          </Specimen>
          <Specimen label="Icons · Hugeicons stroke rounded">
            <div className="flex flex-wrap gap-3 text-ink-2">
              {[UserMultipleIcon, Calendar03Icon, TaskDone01Icon, UserGroupIcon, BookOpen01Icon, Rocket01Icon, HandPrayerIcon, MentorIcon, Plant01Icon].map((icon, i) => (
                <Icon key={i} icon={icon} size={22} />
              ))}
            </div>
            <p className="mt-3 text-xs text-text-3">24 in the rail and top bar · 18 in buttons · 16 inline</p>
          </Specimen>
        </div>
      </Section>

      <Section index={6} title="Focus and motion" code="--ef-focus · --ef-slide-dur · --ef-slide-ease">
        <Note>Press Tab to see the focus ring: 2px in --ef-focus with a 2px offset, on keyboard focus only. One shared highlight slides to the hovered or focused item and rests on the selected one. Reduced motion turns the slide, the page reveal and the Evry animations off.</Note>
        <div className="flex flex-wrap items-center gap-5">
          <HoverDemo />
          <a href="#evry" className="font-medium text-ink underline underline-offset-[3px]">A focusable link</a>
        </div>
      </Section>

      <Section index={7} title="Evry character" code="EvryBot size · mood" id="evry">
        <div className="grid gap-5 app-md:grid-cols-2">
          <Specimen label="Sizes · xs 18 · sm 24 · md 30 · lg 40 · xl 96">
            <div className="flex flex-wrap items-end gap-5">
              {(["xs", "sm", "md", "lg", "xl"] as EvryBotSize[]).map((size, i) => (
                <EvryBot key={size} size={size} blinkOffset={i / 5} />
              ))}
            </div>
          </Specimen>
          <Specimen label="Moods · idle · thinking · talking · happy">
            <div className="flex flex-wrap items-end gap-6">
              {(["idle", "thinking", "talking", "happy"] as EvryMood[]).map((mood, i) => (
                <figure key={mood} className="flex flex-col items-center gap-2">
                  <EvryBot size="lg" mood={mood} blinkOffset={i / 4} />
                  <figcaption className="text-xs text-text-3">{mood}</figcaption>
                </figure>
              ))}
            </div>
          </Specimen>
        </div>
      </Section>

      <Section index={8} title="Content width" code="--ef-content-max · data-width=&quot;wide&quot;">
        <Note>The top bar and the rail span the window. The content column stops at 1536px and centers in the space beside the rail. Dense list pages (People, Meetings, Documents) use the wide column, up to 1920px. Below 1024px the rail and the top navigation move into Menu.</Note>
      </Section>
    </>
  );
}

function Section({ index, title, code, id, children }: { index: number; title: string; code: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="reveal mb-11 scroll-mt-28" style={revealDelay(index)} aria-labelledby={`f-${index}`}>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <h2 id={`f-${index}`} className="text-[26px] text-ink">{title}</h2>
        <code className="rounded-xs bg-surface-2 px-[7px] py-[3px] font-mono text-xs text-text-2">{code}</code>
      </div>
      {children}
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mb-[18px] max-w-[760px] text-text-2">{children}</p>;
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-surface p-[22px] shadow-card">
      <p className="mb-3 text-xs text-text-3">{label}</p>
      {children}
    </div>
  );
}

function BrandTile({ className }: { className: string }) {
  return (
    <div className={cn("grid h-[210px] place-items-center rounded-[22px] max-app-sm:h-40", className)}>
      <div className="flex items-center gap-4">
        <LogoMark className="h-auto w-16 max-app-sm:w-12" />
        <Wordmark className="h-auto w-[220px] max-app-sm:w-40" />
      </div>
    </div>
  );
}

function Swatch({ className, name, use }: { className: string; name: string; use: string }) {
  return (
    <div className="overflow-hidden rounded-[18px] bg-surface shadow-card">
      <div className={cn("h-[92px]", className)} />
      <div className="px-3.5 py-3">
        <b className="block font-semibold text-ink">{name}</b>
        <span className="font-mono text-xs text-text-3">{use}</span>
      </div>
    </div>
  );
}

/** Text on 600/700 and on the text greys is on-ink; text on a 500 fill is brand ink in both themes; tints use ink. */
function stepText(step: string): string {
  if (/^(v|t)?(600|700)$/.test(step) || step.startsWith("text-")) return "text-on-ink";
  if (/500$/.test(step)) return "text-ink-fixed";
  return "text-ink";
}

function Ramp({ label, steps }: { label: string; steps: [string, string][] }) {
  return (
    <Specimen label={label}>
      <div className="grid h-[54px] overflow-hidden rounded-md" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map(([step, bg]) => (
          <div key={step} className={cn("flex items-end px-2 py-1.5 font-mono text-[11px]", bg, stepText(step))}>{step}</div>
        ))}
      </div>
    </Specimen>
  );
}
