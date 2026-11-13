import {
	Alert02Icon,
	ArrowRight02Icon,
	ArrowUpRight01Icon,
	Book02Icon,
	BubbleChatIcon,
	Calendar03Icon,
	FavouriteIcon,
	Flag02Icon,
	Link01Icon,
	Location01Icon,
	SquareLock02Icon,
	MoreHorizontalIcon,
	PencilEdit02Icon,
	PlusSignIcon,
	Rocket01Icon,
	Route01Icon,
	Share08Icon,
	SparklesIcon,
	TaskDone01Icon,
	Tick02Icon,
	UserMultipleIcon,
	ViewIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/** The prototype's navigation compass (a ring and a needle), drawn in the Hugeicons stroke style. Hugeicons' compass
 *  glyphs are a drafting compass and a stopwatch-like dial, so this one keeps the prototype's geometry. */
const NavCompass: IconSvgElement = [
	["circle", { cx: "12", cy: "12", r: "8.5", stroke: "currentColor", strokeWidth: "1.5", key: "0" }],
	[
		"path",
		{
			d: "M15.5 8.5l-2 5-5 2 2-5z",
			stroke: "currentColor",
			strokeLinecap: "round",
			strokeLinejoin: "round",
			strokeWidth: "1.5",
			key: "1",
		},
	],
];

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
	compass: NavCompass,
	pin: Location01Icon,
	network: Share08Icon,
	plus: PlusSignIcon,
	rocket: Rocket01Icon,
	route: Route01Icon,
	flag: Flag02Icon,
	link: Link01Icon,
	chat: BubbleChatIcon,
	lock: SquareLock02Icon,
} satisfies Record<string, IconSvgElement>;
export type IconName = keyof typeof ICONS;
