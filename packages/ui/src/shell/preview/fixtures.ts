import {
  BookOpen01Icon,
  BookOpen02Icon,
  Calendar03Icon,
  ChartLineData01Icon,
  DashboardSquare01Icon,
  File02Icon,
  Mail01Icon,
  MessageEdit01Icon,
  Route01Icon,
  Settings02Icon,
  StartUp02Icon,
  TaskDone01Icon,
  UserGroupIcon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import type { ShellItem, ShellLink, ShellNav, ShellUser } from "../nav";

/**
 * Sample people and navigation for the shell preview. All names are invented sample data (design/handoff/README.md).
 * In the product, the caller builds the navigation from the person's actual seat or relationship; these fixtures only
 * show that the shell draws exactly the items it is given.
 */
export const PREVIEW_ROLES = ["owner", "member", "residency"] as const;
export type PreviewRole = (typeof PREVIEW_ROLES)[number];

export function parsePreviewRole(value: string): PreviewRole | null {
  return (PREVIEW_ROLES as readonly string[]).includes(value) ? (value as PreviewRole) : null;
}

export const ROLE_LABEL: Record<PreviewRole, string> = { owner: "Owner", member: "Member", residency: "Residency account" };

type Overlays = { onFeedback: () => void; onGuide: () => void; guideOpen: boolean };

const link = (base: string, key: string, label: string, icon: ShellLink["icon"], match?: "exact"): ShellLink =>
  ({ kind: "link", key, label, href: key === "overview" || key === "my-residency" ? base : `${base}/${key}`, icon, ...(match ? { match } : {}) });

function tools(base: string, o: Overlays): ShellItem[] {
  return [
    { kind: "action", key: "feedback", label: "Send feedback", icon: MessageEdit01Icon, onSelect: o.onFeedback },
    { kind: "action", key: "guide", label: "Guide", icon: BookOpen02Icon, onSelect: o.onGuide, expanded: o.guideOpen },
    link(base, "settings", "Settings", Settings02Icon),
  ];
}

/** A plant seat (Owner or Member): the prototype's top navigation and rail. A Member reads what the seat allows. */
function plantNav(base: string, o: Overlays): ShellNav {
  return {
    main: [
      link(base, "overview", "Overview", DashboardSquare01Icon, "exact"),
      link(base, "people", "People", UserMultipleIcon),
      link(base, "meetings", "Meetings", Calendar03Icon),
      link(base, "tasks", "Tasks", TaskDone01Icon),
      link(base, "ministries", "Ministries", UserGroupIcon),
      link(base, "wiki", "Wiki", BookOpen01Icon),
    ],
    pages: [
      link(base, "intelligence", "Plant Intelligence", ChartLineData01Icon),
      link(base, "launch", "Launch", StartUp02Icon),
      link(base, "communication", "Communication", Mail01Icon),
      link(base, "documents", "Documents", File02Icon),
    ],
    tools: tools(base, o),
  };
}

/**
 * A linked Discovery account without a seat (REQ-MUL-013): My residency, its private Wiki reading and documents. It
 * receives no People, Meetings, Tasks, Launch, organization directory or plant workspace.
 */
function residencyNav(base: string, o: Overlays): ShellNav {
  return {
    main: [link(base, "my-residency", "My residency", Route01Icon, "exact"), link(base, "wiki", "Wiki", BookOpen01Icon)],
    pages: [link(base, "documents", "Documents", File02Icon)],
    tools: tools(base, o),
  };
}

export function previewNav(role: PreviewRole, base: string, o: Overlays): ShellNav {
  return role === "residency" ? residencyNav(base, o) : plantNav(base, o);
}

export const PREVIEW_USER: Record<PreviewRole, ShellUser> = {
  owner: { name: "Daniel Reyes", initials: "DR", detail: "Lead planter · Harvest Point" },
  member: { name: "Maria Santos", initials: "MS", detail: "Member · Harvest Point" },
  residency: { name: "Jordan Ellis", initials: "JE", detail: "Resident · Austin Sending Network" },
};

export const PREVIEW_UNREAD: Record<PreviewRole, number> = { owner: 3, member: 1, residency: 0 };
