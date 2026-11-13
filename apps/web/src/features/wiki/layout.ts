// The wiki article layout switches at one width, WIDE = 1280px (D-f: the spec's app-lg, 1341px, left the article under
// 50% of a 1280x720 screen). Tailwind reads class names as literals, so each class string below spells the width out.
// Moving the switch means editing this file only.

/** Mobile-only controls: the Articles drawer button and the inline contents list. */
export const BELOW_WIDE_ONLY = "min-[1280px]:hidden";
/** The page header gap above the columns when the layout is fixed. */
export const HEADER_GAP = "min-[1280px]:mb-4";
export const SOURCE_BAR_GAP = "mb-6 min-[1280px]:mb-4";
/** Headings stop just under the top of the article column. */
export const HEADING_STOP = "min-[1280px]:[&_h2]:scroll-mt-3 min-[1280px]:[&_h3]:scroll-mt-3";
/**
 * The frame fills the space below the app bar. FixedFrame sets --frame-h from its own top. The fallback is the height
 * with no banner, so the first layout is already close.
 */
export const FRAME =
	"min-[1280px]:-mb-[72px] min-[1280px]:flex min-[1280px]:h-[var(--frame-h,calc(100dvh-132px))] min-[1280px]:flex-col";
export const GRID_FIXED =
	"grid items-start gap-8 min-[1280px]:min-h-0 min-[1280px]:flex-1 min-[1280px]:grid-cols-[250px_minmax(0,1fr)_220px] min-[1280px]:items-stretch min-[1280px]:gap-0";
export const GRID = "grid items-start gap-8 min-[1280px]:grid-cols-[250px_minmax(0,1fr)_220px]";
/** Scroll container classes, applied by the caller after the width classes. */
export const RAIL_FIXED =
	"hidden min-[1280px]:block min-[1280px]:min-h-0 min-[1280px]:overflow-y-auto min-[1280px]:pr-3 min-[1280px]:pb-6";
export const RAIL_TOC_PAD = "min-[1280px]:pl-6";
export const RAIL_STICKY = "hidden min-[1280px]:sticky min-[1280px]:top-24 min-[1280px]:block";
export const ARTICLE_FIXED =
	"min-w-0 min-[1280px]:min-h-0 min-[1280px]:overflow-y-auto min-[1280px]:px-4 min-[1280px]:pb-6";
