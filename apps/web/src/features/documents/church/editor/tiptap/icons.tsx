import {
	Delete02Icon,
	Link01Icon,
	LinkSquare02Icon,
	Redo02Icon,
	TextBoldIcon,
	TextItalicIcon,
	TextUnderlineIcon,
	Undo02Icon,
	ArrowTurnBackwardIcon,
} from "@hugeicons/core-free-icons";
import { Icon, type IconSvgElement } from "@everyfield/ui/foundations";

// Tiptap's own SVG icon components are replaced by the product's Hugeicons set, so the toolbar draws with the same
// stroke as the rest of the app. Each export keeps the name and the `className` prop of the Tiptap file it replaces.

const make = (icon: IconSvgElement) =>
	function ToolbarIcon({ className }: { className?: string }) {
		return <Icon icon={icon} size={18} className={className} />;
	};

export const BoldIcon = make(TextBoldIcon);
export const ItalicIcon = make(TextItalicIcon);
export const UnderlineIcon = make(TextUnderlineIcon);
export const LinkIcon = make(Link01Icon);
export const ExternalLinkIcon = make(LinkSquare02Icon);
export const TrashIcon = make(Delete02Icon);
export const CornerDownLeftIcon = make(ArrowTurnBackwardIcon);
export const Undo2Icon = make(Undo02Icon);
export const Redo2Icon = make(Redo02Icon);
