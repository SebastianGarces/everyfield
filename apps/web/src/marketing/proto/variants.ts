// R6 local prototypes (not for release): the home page with the vision and Monday sections in different arrangements.
// The variant Sebastian picks is rebuilt properly; this folder and app/proto are then deleted.

export const VARIANTS = [
  { id: "current", path: "/", label: "Now", title: "Current order: Monday, then the vision" },
  { id: "a", path: "/proto/a", label: "A", title: "A: the vision first, then Monday" },
  { id: "b", path: "/proto/b", label: "B", title: "B: one section, the zoom flows into Monday" },
  { id: "c", path: "/proto/c", label: "C", title: "C: the plan inside the Monday dashboard" },
] as const;
export type VariantId = (typeof VARIANTS)[number]["id"];

/** Copy of the merged sections (B and C). It moves into design/marketing-copy.json if Sebastian picks one. */
export const PROTO_COPY = {
  b: {
    headline: "The vision, down to this week.",
    body: "Launch Sunday sets the date. Each phase has its benchmarks, and the launch milestones lead up to the day. EveryField keeps them in one place with this week's tasks, so you open Monday knowing what to do and why.",
    bridge: "Monday morning",
  },
  c: {
    headline: "Here is what a Monday looks like.",
    body: "Open EveryField and see Launch Sunday, your phase and the next launch milestone above this week's tasks. Below them: your core team, your next gathering and the follow-ups that need you first.",
  },
} as const;
