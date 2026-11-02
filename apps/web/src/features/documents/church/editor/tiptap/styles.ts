// The look of the copied Tiptap parts. Tiptap ships these as SCSS class names (`tiptap-button`, `tiptap-toolbar`, ...);
// here each one is a Tailwind class string built from the product tokens (font, color, radius, spacing), so the
// toolbar reads as part of Everyfield in light and dark mode and shares the controls' focus ring and cursors.

export const BUTTON =
	"inline-flex h-9 min-w-9 flex-none cursor-pointer items-center justify-center gap-1.5 rounded-sm bg-transparent px-2 text-sm font-medium whitespace-nowrap text-ink select-none transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent data-[active-state=on]:bg-green-100 data-[active-state=on]:text-ink data-[state=open]:bg-hover";
export const BUTTON_GROUP = "flex items-center gap-0.5 data-[orientation=vertical]:flex-col";
export const BUTTON_ICON = "flex-none";
export const TOOLBAR =
	"flex w-full items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-line bg-surface-raised p-1.5 [scrollbar-width:thin]";
export const TOOLBAR_GROUP = "flex flex-none items-center gap-0.5";
export const SEPARATOR =
	"mx-1 h-5 w-px flex-none bg-line-2 data-[orientation=horizontal]:my-1 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full";
export const SURFACE =
	"z-50 rounded-card bg-surface-raised p-1.5 text-md text-ink shadow-[var(--ef-shadow-pop),0_0_0_1px_var(--ef-line)] outline-none";
export const POPOVER = `${SURFACE} min-w-[280px] max-w-[calc(100vw-24px)]`;
export const MENU = `${SURFACE} min-w-[220px]`;
export const MENU_ITEM =
	"flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-md text-ink outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-hover data-[state=checked]:font-semibold";
export const TOOLTIP =
	"z-[60] flex items-center gap-2 rounded-sm bg-ink px-2.5 py-1.5 text-sm font-medium text-on-ink shadow-raised";
export const INPUT =
	"h-9 w-full min-w-0 rounded-sm bg-surface px-2.5 text-md text-ink shadow-[0_0_0_1px_var(--ef-line-2)] outline-none placeholder:text-text-3";
export const INPUT_GROUP = "flex min-w-0 flex-1 items-center";
