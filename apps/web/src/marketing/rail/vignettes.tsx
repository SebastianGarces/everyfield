import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Avatar, Badge, CardIcon, UiButton, type Tone } from "@/components/kit/kit";
import { ICONS, type IconName } from "../icons";

// The small product vignettes on the phases rail cards (Marketing v15, Revision 26). Static pictures of the app with the
// demo church's data; Server Components.

const T = "font-display text-[16px] leading-[1.2] font-medium tracking-[-.02em] truncate";
const S = "truncate text-[12px] text-text-3";
const K = "text-[12px] font-semibold whitespace-nowrap text-text-2";
const IT = "truncate text-[13px] font-semibold";

function Vignette({ children }: { children: ReactNode }) {
  return <div className="rounded-[18px] bg-white px-[15px] pt-3.5 pb-[15px] text-[13px] leading-[1.4] text-text shadow-mk-vignette">{children}</div>;
}
function Head({ icon, tone, title, sub, right }: { icon: IconName; tone: Tone; title: string; sub: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <CardIcon tone={tone} icon={ICONS[icon]} size={34} glyph={16} />
      <div className="min-w-0 flex-1">
        <div className={T}>{title}</div>
        <div className={cn(S, "mt-px")}>{sub}</div>
      </div>
      {right}
    </div>
  );
}
function Delta({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-white px-2.5 text-[12.5px] font-semibold whitespace-nowrap shadow-[inset_0_0_0_1px_var(--color-line)] before:border-x-[5px] before:border-b-[7px] before:border-x-transparent before:border-b-green-500 before:content-['']">
      {children}
    </span>
  );
}
function Stat({ n, children }: { n: string; children: ReactNode }) {
  return (
    <div className="mt-3 flex items-center gap-3">
      <span className="font-display text-[50px] leading-[.95] font-medium tracking-[-.05em] whitespace-nowrap [font-stretch:100%]">{n}</span>
      {children}
    </div>
  );
}
function Inset({ icon, tone, title, sub }: { icon: IconName; tone: Tone; title: string; sub: string }) {
  return (
    <div className="mt-3 flex items-center gap-2.5 rounded-[12px] bg-surface px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <CardIcon tone={tone} icon={ICONS[icon]} size={30} glyph={16} />
      <div className="min-w-0 flex-1">
        <div className={IT}>{title}</div>
        <div className={cn(S, "mt-0.5")}>{sub}</div>
      </div>
    </div>
  );
}
/** A thin meter; the fill is hatched or solid. */
function Meter({ pct, color, hatch }: { pct: string; color: string; hatch?: boolean }) {
  return (
    <div className="relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-white shadow-[inset_0_0_0_1px_var(--color-line)]">
      <span className={cn("absolute inset-y-0.5 left-0.5 rounded-full", hatch && "mk-hatch")} style={{ width: `calc(${pct} - 4px)`, ...(hatch ? { "--hatch": color } : { background: color }) } as CSSProperties} />
    </div>
  );
}

/* ---------- Home: the six phases ---------- */
export function PhaseVignette({ i }: { i: number }) {
  if (i === 0)
    return (
      <Vignette>
        <Head icon="book" tone="blue" title="Guidance" sub="Discovery" />
        <div className="mt-3.5 grid gap-[9px]">
          {([[80, 54, true], [72, 46, false]] as const).map(([a, b, on], k) => (
            <div key={k} className={cn("flex items-center gap-2.5 rounded-[12px] px-2.5 py-[9px]", on ? "bg-green-50 shadow-mk-chip-on" : "bg-surface shadow-[inset_0_0_0_1px_var(--color-line)]")}>
              <span className={cn("grid size-[26px] flex-none place-items-center rounded-[8px]", on ? "bg-green-500 text-ink" : "bg-surface-2 text-ink-2")}>
                <Icon icon={on ? ICONS.book : ICONS.check} size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <i className={cn("block h-1.5 rounded-[9px]", on ? "bg-mk-green-600-24" : "bg-mk-bar")} style={{ width: a + "%" }} />
                <i className={cn("mt-1.5 block h-1.5 rounded-[9px] opacity-60", on ? "bg-mk-green-600-24" : "bg-mk-bar")} style={{ width: b + "%" }} />
              </span>
              {on ? <span className="flex-none rounded-full bg-ink px-2 py-1 text-[11px] font-semibold text-white">Now</span> : null}
            </div>
          ))}
        </div>
      </Vignette>
    );
  if (i === 1)
    return (
      <Vignette>
        <Head icon="users" tone="green" title="Core group" sub="Signed commitments" />
        <Stat n="34"><Delta>9 people</Delta></Stat>
        <Inset icon="task" tone="green" title="Vision meeting closed" sub="9 follow-up tasks" />
      </Vignette>
    );
  if (i === 2) {
    const seats = [["Worship", "MS", "violet"], ["Kids", "", ""], ["Welcome", "JO", "blue"], ["Prayer", "RA", "amber"], ["Tech", "KL", "teal"], ["Outreach", "TB", "green"], ["Setup", "AP", "magenta"], ["Admin", "LC", "ink"]] as const;
    return (
      <Vignette>
        <Head icon="calendar" tone="amber" title="Ministry areas" sub="Launch Sunday, Mar 14" right={<span className={K}>7 of 8</span>} />
        <div className="mt-3.5 grid grid-cols-4 gap-x-1.5 gap-y-3">
          {seats.map(([name, who, tone]) => (
            <div key={name} className="flex min-w-0 flex-col items-center gap-[5px]">
              {who ? (
                <Avatar tone={tone as Tone} small>{who}</Avatar>
              ) : (
                <span className="grid size-8 place-items-center rounded-full border-[1.5px] border-dashed border-amber-500 bg-amber-50 text-[15px] leading-none font-semibold text-amber-600">+</span>
              )}
              <span className={cn("max-w-full truncate text-[11px]", who ? "text-text-2" : "font-semibold text-amber-600")}>{name}</span>
            </div>
          ))}
        </div>
      </Vignette>
    );
  }
  if (i === 3)
    return (
      <Vignette>
        <Head icon="users" tone="violet" title="Training" sub="Who has finished" />
        <div className="mt-3.5 grid gap-[9px]">
          {([["Worship team", 8, 9, "var(--color-green-600)", true], ["Hospitality", 6, 6, "var(--color-green-500)", false], ["Kids ministry", 2, 6, "var(--color-amber-500)", true]] as const).map(([name, a, b, color, hatch]) => (
            <div key={name}>
              <div className="flex items-center justify-between gap-2"><span className={IT}>{name}</span><span className={K}>{a} of {b}</span></div>
              <Meter pct={((a / b) * 100).toFixed(1) + "%"} color={color} hatch={hatch} />
            </div>
          ))}
        </div>
      </Vignette>
    );
  if (i === 4)
    return (
      <Vignette>
        <Head icon="task" tone="blue" title="Launch milestones" sub="3 of 5 done" />
        <div className="mt-3.5 grid gap-[9px]">
          {([["Venue booked", true], ["Invite cards printed", true], ["Email to your people", true], ["Sound check", false]] as const).map(([name, done]) => (
            <div key={name} className={cn("flex items-center gap-2.5 text-[13px] whitespace-nowrap", done ? "font-medium text-text" : "text-text-2")}>
              <span className={cn("grid size-5 flex-none place-items-center rounded-[7px]", done ? "bg-ink text-white" : "shadow-[inset_0_0_0_1.5px_var(--color-line-2)]")}>
                {done ? <Icon icon={ICONS.check} size={13} className="[&_path]:[stroke-width:2.4]" /> : null}
              </span>
              {name}
            </div>
          ))}
        </div>
      </Vignette>
    );
  return (
    <Vignette>
      <Head icon="calendar" tone="green" title="Launch Sunday" sub="Mar 14, 2027" />
      <div className="mt-4 flex h-[86px] items-end gap-1.5">
        {[100, 70, 76, 79, 83, 88].map((h, k) => (
          <span key={k} className={cn("relative flex-1 rounded-t-[6px] rounded-b-[3px] [--hatch:var(--color-green-600)]", k ? "mk-hatch" : "bg-ink")} style={{ height: h + "%" }}>
            {k ? null : <b className="absolute inset-x-0 top-[7px] text-center text-[11px] font-semibold text-white">186</b>}
          </span>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11.5px] text-text-3"><span>Launch</span><span>Week 6</span></div>
    </Vignette>
  );
}

/* ---------- /oversight: what a sending church sees, plant by plant ---------- */
export function PlantVignette({ i }: { i: number }) {
  if (i === 0)
    return (
      <Vignette>
        <Head icon="calendar" tone="blue" title="Phase journey" sub="Eastside Commons" right={<span className={K}>3 · Training</span>} />
        <div className="mt-3.5 grid grid-cols-7 gap-1">
          {[1, 1, 1, 2, 0, 0, 0].map((s, k) => <span key={k} className={cn("h-2 rounded-[9px]", s === 1 ? "bg-ink" : s === 2 ? "bg-green-500" : "bg-surface-2")} />)}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[12px] text-text-2">
          {[["Discovery", "10 wk"], ["Core group", "34 wk"], ["Launch team", "18 wk"], ["Training", "6 wk so far"]].map((r) => (
            <span key={r[0]}><b className="block text-[14px] font-semibold text-ink">{r[1]}</b>{r[0]}</span>
          ))}
        </div>
      </Vignette>
    );
  if (i === 1)
    return (
      <Vignette>
        <Head icon="calendar" tone="green" title="Launch Sunday" sub="Sunday, May 2, 2027" />
        <Stat n="205"><span className={cn(S, "mt-px")}>days to go</span></Stat>
        <div>
          <div className="flex items-center justify-between gap-2"><span className={IT}>Milestones done</span><span className={K}>3 of 9</span></div>
          <Meter pct="33.3%" color="var(--color-green-500)" />
        </div>
      </Vignette>
    );
  if (i === 2)
    return (
      <Vignette>
        <Head icon="pin" tone="teal" title="By market" sub="Texas · 14 plants" right={<span className={K}>Plants</span>} />
        <div className="mt-3 grid gap-0.5">
          {([["Greater Austin", 5], ["Dallas–Fort Worth", 3], ["Greater San Antonio", 3], ["Greater Houston", 2]] as const).map(([name, n], k) => (
            <div key={name} className={cn("-mx-2 grid grid-cols-[minmax(0,1fr)_64px_16px] items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-[13px] font-medium", !k && "bg-green-50 shadow-mk-row-on")}>
              <span className="truncate">{name}</span>
              <span className="h-1.5 overflow-hidden rounded-[9px] bg-surface-2"><i className={cn("block h-full rounded-[9px]", k ? "bg-mk-bar-muted" : "bg-green-500")} style={{ width: (n / 5) * 100 + "%" }} /></span>
              <b className="text-right font-semibold tabular-nums">{n}</b>
            </div>
          ))}
        </div>
      </Vignette>
    );
  if (i === 3)
    return (
      <Vignette>
        <Head icon="users" tone="blue" title="People" sub="Committed adults" />
        <Stat n="46"><Delta>5 in 28 days</Delta></Stat>
        <Inset icon="calendar" tone="green" title="13 days between vision meetings" sub="On average" />
      </Vignette>
    );
  if (i === 4)
    return (
      <Vignette>
        <Head icon="users" tone="violet" title="Ministry teams" sub="Leader roles filled" right={<span className={K}>9 of 11</span>} />
        <div className="mt-3.5 grid gap-[9px]">
          {["Kids", "Production"].map((r) => (
            <div key={r} className="flex items-center justify-between gap-2.5 text-[13px] font-medium"><span>{r}</span><Badge status="risk" size="sm">Leader open</Badge></div>
          ))}
        </div>
      </Vignette>
    );
  return (
    <Vignette>
      <Head icon="compass" tone="amber" title="Where help could matter" sub="Eastside Commons" />
      <div className="mt-3 truncate text-[15px] leading-[1.3] font-semibold">Two leader roles are open, 205 days before launch</div>
      <div className="mt-3 flex gap-1.5">
        <UiButton variant="primary" size="sm">Offer help <Icon icon={ICONS.arrow} size={14} /></UiButton>
        <UiButton variant="ghost" size="sm">Later</UiButton>
      </div>
    </Vignette>
  );
}
