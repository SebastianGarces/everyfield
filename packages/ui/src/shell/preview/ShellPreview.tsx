"use client";

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn, HoverGroup, Icon, revealDelay, useHoverItem, useProductTheme } from "../../foundations";
import { AppShell } from "../AppShell";
import { currentKey, type ShellNav } from "../nav";
import { RoleBanner } from "../RoleBanner";
import { PREVIEW_ROLES, PREVIEW_UNREAD, PREVIEW_USER, previewNav, ROLE_LABEL, type PreviewRole } from "./fixtures";

/**
 * The shell preview at /design/shell/[role]/[page]: the AppShell with sample navigation for an Owner, a Member and a
 * residency account. Every control reports what it would open in the "Last action" card, so keyboard and pointer
 * use can be checked without the overlays, which belong to other packages. `children` replaces the sample page.
 */
export function ShellPreview({ role, children }: { role: PreviewRole; children?: ReactNode }) {
  const base = `/design/shell/${role}`;
  const [lastAction, setLastAction] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const nav = previewNav(role, base, {
    onFeedback: () => setLastAction("Send feedback opens the feedback dialog (WP-049)."),
    onGuide: () => {
      setGuideOpen((open) => !open);
      setLastAction(guideOpen ? "Guide closed." : "Guide opens the Wiki article for this page (WP-034). Select Guide again to close it.");
    },
    guideOpen,
  });

  return (
    <AppShell
      nav={nav}
      user={PREVIEW_USER[role]}
      homeHref={base}
      unread={PREVIEW_UNREAD[role]}
      onSearch={() => setLastAction("Search opens the command palette (WP-089).")}
      onNotifications={() => setLastAction("Notifications opens the notification pop-over (WP-030).")}
      onAskEvry={() => setLastAction("Ask Evry opens the Evry panel (WP-051).")}
      onUserMenu={() => setLastAction("The account menu opens the user menu (WP-010).")}
      banner={
        role === "member" ? (
          <RoleBanner action={<button type="button" onClick={() => setLastAction("Ask for access sends a request to the Owners and Admins.")} className="h-9 flex-none rounded-md bg-surface-raised px-3.5 text-sm font-medium text-ink shadow-raised transition-[background-color] hover:bg-surface-2">Ask for access</button>}>
            You have a <b className="font-semibold">Member</b> seat at Harvest Point. You can read what your seat allows and work on tasks assigned to you. Other changes need an Owner or Admin.
          </RoleBanner>
        ) : undefined
      }
    >
      {children ?? <SamplePage role={role} nav={nav} lastAction={lastAction} />}
    </AppShell>
  );
}

function SamplePage({ role, nav, lastAction }: { role: PreviewRole; nav: ShellNav; lastAction: string }) {
  const pathname = usePathname();
  const key = currentKey(nav, pathname);
  const title = [...nav.main, ...nav.pages, ...nav.tools].find((i) => i.key === key)?.label ?? "Page not in this navigation";
  const { theme } = useProductTheme();

  return (
    <>
      <PageHead crumb="App shell" title={title}>
        Sample page inside the app shell. Use the navigation to move between pages. Every page here is a placeholder.
      </PageHead>
      <div className="grid gap-5 app-lg:grid-cols-2">
        <Panel title="Preview as" index={0}>
          <p className="text-text-2">Each role shows only the destinations its navigation gives it.</p>
          <RoleSwitch current={role} />
        </Panel>
        <Panel title="Theme" index={1}>
          <p className="text-text-2">
            The product is in <b className="font-semibold text-ink">{theme === "dark" ? "dark" : "light"} mode</b>. Switch it with the sun and moon in the rail, or in Menu on a narrow screen. Marketing pages always stay light.
          </p>
          <Link href="/" className="inline-flex items-center gap-1.5 self-start font-medium text-ink underline decoration-green-500 decoration-2 underline-offset-[3px]">
            Open the marketing home page
            <Icon icon={ArrowRight01Icon} size={16} />
          </Link>
        </Panel>
        <Panel title="Last action" index={2}>
          <p role="status" className="text-text-2">{lastAction || "Use a control in the top bar or the rail. What it opens shows here."}</p>
        </Panel>
        <Panel title="Keyboard" index={3}>
          <ol className="list-decimal space-y-1 pl-5 text-text-2">
            <li>Tab first reaches Skip to content, then the top bar, the rail and the page.</li>
            <li>Each control shows the blue focus ring. Rail labels appear on focus.</li>
            <li>In the theme switch, the arrow keys change the theme.</li>
            <li>On a narrow screen, Esc closes Menu and returns focus to it.</li>
          </ol>
        </Panel>
      </div>
      <p className="mt-6 text-sm text-text-3">
        Also see the <Link href="/design/foundations" className="font-medium text-ink underline underline-offset-[3px]">foundations preview</Link>.
      </p>
    </>
  );
}

function RoleSwitch({ current }: { current: PreviewRole }) {
  return (
    <HoverGroup current={current} className="flex flex-wrap gap-1 self-start rounded-md bg-surface-2 p-1">
      {PREVIEW_ROLES.map((r) => (
        <RoleLink key={r} role={r} current={r === current} />
      ))}
    </HoverGroup>
  );
}

function RoleLink({ role, current }: { role: PreviewRole; current: boolean }) {
  const { handlers, indicator } = useHoverItem(role, "bg-hover");
  return (
    <Link href={`/design/shell/${role}`} aria-current={current ? "page" : undefined} {...handlers}
      className="relative inline-flex h-9 items-center rounded-[10px] px-3.5 text-md font-medium text-text-2 aria-[current=page]:bg-surface-raised aria-[current=page]:text-ink aria-[current=page]:shadow-nav-active">
      {indicator}
      {ROLE_LABEL[role]}
    </Link>
  );
}

/** Page header used by the previews: breadcrumb, title and subtitle (prototype .page-header). */
export function PageHead({ crumb, title, size = "default", children }: { crumb: string; title: string; size?: "default" | "xl"; children: ReactNode }) {
  return (
    <header className="reveal mb-[26px]" style={revealDelay(0)}>
      <p className="mb-2.5 flex items-center gap-2 text-md text-text-3">
        <span>Design system</span>
        <Icon icon={ArrowRight01Icon} size={16} />
        <span className="text-text-2">{crumb}</span>
      </p>
      <h1 className={cn("leading-[1.05] tracking-[-0.035em] text-ink max-app-sm:text-title-lg", size === "xl" ? "text-[52px]" : "text-display-sm")}>{title}</h1>
      <p className="mt-2 max-w-[760px] text-[15px] text-text-2">{children}</p>
    </header>
  );
}

function Panel({ title, index, children }: { title: string; index: number; children: ReactNode }) {
  return (
    <section className={cn("reveal flex flex-col gap-3 rounded-lg bg-surface p-[22px] shadow-card")} style={revealDelay(index + 1)}>
      <h2 className="text-title-sm text-ink">{title}</h2>
      {children}
    </section>
  );
}
