export const BUTTON_BASE =
	"inline-flex flex-none items-center rounded-sm bg-transparent text-sm font-medium whitespace-nowrap text-ink select-none transition-colors hover:bg-hover disabled:opacity-45 disabled:hover:bg-transparent data-[active-state=on]:bg-green-100 data-[active-state=on]:text-ink data-[state=open]:bg-hover";
const BUTTON_BOX = "h-9 min-w-9 justify-center gap-1.5 px-2";
export const BUTTON = `${BUTTON_BASE} ${BUTTON_BOX}`;
export const BUTTON_GROUP = "flex items-center gap-0.5 data-[orientation=vertical]:flex-col";
export const BUTTON_ICON = "flex-none";
export const TOOLBAR_BASE = "flex w-full items-center gap-1 border-line bg-surface-raised p-1.5";
export const TOOLBAR = `${TOOLBAR_BASE} overflow-x-auto overscroll-x-contain border-b [scrollbar-width:thin]`;
export const TOOLBAR_GROUP = "flex flex-none items-center gap-0.5";
export const SEPARATOR =
	"mx-1 h-5 w-px flex-none bg-line-2 data-[orientation=horizontal]:my-1 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full";
const SURFACE =
	"z-50 rounded-card bg-surface-raised p-1.5 text-md text-ink shadow-[var(--ef-shadow-pop),0_0_0_1px_var(--ef-line)] outline-none";
export const POPOVER = `${SURFACE} min-w-[280px] max-w-[calc(100vw-24px)]`;
export const MENU = `${SURFACE} min-w-[220px]`;
export const MENU_ITEM_BASE =
	"rounded-sm text-ink outline-none select-none data-[disabled]:opacity-45 data-[highlighted]:bg-hover data-[state=checked]:font-semibold";
const MENU_ITEM_ROW = "flex items-center gap-2 px-2.5 py-2 text-md";
export const MENU_ITEM = `${MENU_ITEM_BASE} ${MENU_ITEM_ROW}`;
export const TOOLTIP =
	"z-[60] flex items-center gap-2 rounded-sm bg-ink px-2.5 py-1.5 text-sm font-medium text-on-ink shadow-raised";
export const INPUT =
	"h-9 w-full min-w-0 rounded-sm bg-surface px-2.5 text-md text-ink shadow-[0_0_0_1px_var(--ef-line-2)] outline-none placeholder:text-text-3";
export const INPUT_GROUP = "flex min-w-0 flex-1 items-center";
