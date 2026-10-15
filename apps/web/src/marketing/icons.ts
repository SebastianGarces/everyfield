import {
  Alert02Icon, ArrowRight02Icon, ArrowUpRight01Icon, Book02Icon, Calendar03Icon, Compass01Icon, FavouriteIcon, Location01Icon,
  MoreHorizontalIcon, PencilEdit02Icon, PlusSignIcon, Rocket01Icon, Route01Icon, Share08Icon, SparklesIcon, TaskDone01Icon, Tick02Icon, UserMultipleIcon, ViewIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/**
 * The prototype's icon names (marketing-copy.json and the panel data use them) and the Hugeicons glyph that replaces each
 * hand-drawn path. Hugeicons, stroke rounded, free set (design/handoff/foundations.md).
 */
export const ICONS = {
  arrow: ArrowRight02Icon,
  arrowUpRight: ArrowUpRight01Icon,
  check: Tick02Icon,
  alert: Alert02Icon,
  users: UserMultipleIcon,
  calendar: Calendar03Icon,
  sparkle: SparklesIcon,
  eye: ViewIcon,
  book: Book02Icon,
  task: TaskDone01Icon,
  edit: PencilEdit02Icon,
  heart: FavouriteIcon,
  more: MoreHorizontalIcon,
  compass: Compass01Icon,
  pin: Location01Icon,
  network: Share08Icon,
  plus: PlusSignIcon,
  rocket: Rocket01Icon,
  route: Route01Icon,
} satisfies Record<string, IconSvgElement>;
export type IconName = keyof typeof ICONS;
export const isIconName = (s: string): s is IconName => Object.hasOwn(ICONS, s);
