import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge({
	override: {
		conflictingClassGroups: { "font-size": [] },
	},
	extend: {
		theme: {
			text: [
				"display-lg",
				"display-md",
				"display-sm",
				"title-lg",
				"title-md",
				"title-sm",
				"nav",
				"mk-display-xl",
				"mk-h1",
				"mk-h2",
				"mk-h3",
				"mk-hero",
				"mk-lead",
				"mk-lead-sm",
				"mk-pic-2xs",
				"mk-pic-xs",
			],
			shadow: [
				"card",
				"nav",
				"nav-active",
				"pill",
				"pop",
				"raised",
				"edge",
				"edge-inset",
				(value: string) => value.startsWith("mk-"),
			],
			radius: ["card", "frame", "pill", "nav", "nav-item"],
			container: ["content", "content-wide", "mk"],
			spacing: ["topbar", "page", "section", "section-photo"],
			ease: ["slide", "mk", "mk-out"],
			animate: ["mk-caret", "mk-ov-rise", "mk-shimmer"],
			font: ["body", "display", "sans", "title"],
		},
	},
});

export function cn(...parts: (string | false | null | undefined)[]): string {
	return merge(...parts);
}
