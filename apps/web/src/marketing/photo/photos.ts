// The marketing photos (foundations.md, Brand: Marketing photos). Each file in public/photos is a web copy in two widths,
// AVIF with a JPEG fallback. A crop names its photo, focus point, zoom and overlay; the slot picks a crop, never a file.
// Crops follow design/everyfield-marketing.html (data-photo). The grain and the black overlay are CSS, never baked in.

type Crop = {
	/** File stem in public/photos. */
	file: string;
	/** Pixel widths of the two copies, small then large (the file names carry the long edge, not the width). */
	w: readonly [small: number, large: number];
	/** Long edge in the file names of the two copies. */
	edge: readonly [small: number, large: number];
	/** Focus point: object-position, also the zoom origin. */
	pos: string;
	/** 1 = cover. */
	zoom?: number;
	/** Black overlay; 0.2 is the brand default. */
	shade?: number;
};

const LAND = [1200, 2400] as const;
const BLUR = [600, 1200] as const;

export const PHOTOS = {
	// Landscapes.
	field: { file: "field", w: [1200, 2400], edge: LAND, pos: "50% 16%" },
	storm: { file: "storm", w: [1200, 2400], edge: LAND, pos: "30% 60%" },
	hills: { file: "hills", w: [1200, 2400], edge: LAND, pos: "50% 60%" },
	harvest: { file: "harvest", w: [1187, 2373], edge: LAND, pos: "50% 62%" },
	trees: { file: "trees", w: [1200, 2400], edge: LAND, pos: "55% 50%" },
	plain: { file: "plain", w: [1200, 2400], edge: LAND, pos: "30% 70%" },
	reeds: { file: "reeds", w: [800, 1600], edge: LAND, pos: "50% 72%" },
	lake: { file: "lake", w: [800, 1600], edge: LAND, pos: "50% 67%" },
	wheat: { file: "wheat", w: [1200, 2400], edge: LAND, pos: "50% 62%" },
	// Blurred colorful photos: the heroes and the phase-card rail.
	bluebells: { file: "bluebells", w: [600, 1200], edge: BLUR, pos: "30% 40%" },
	poppies: { file: "poppies", w: [600, 1200], edge: BLUR, pos: "50% 92%", zoom: 1.5 },
	wildflowers: { file: "wildflowers", w: [600, 1200], edge: BLUR, pos: "60% 45%" },
	blossom: { file: "blossom", w: [400, 800], edge: BLUR, pos: "50% 40%" },
	meadow: { file: "meadow", w: [600, 1200], edge: BLUR, pos: "40% 50%" },
	// The lightest blur: a deeper overlay keeps its cream rail number at 3:1.
	glow: { file: "glow", w: [400, 800], edge: BLUR, pos: "50% 30%", shade: 0.36 },
} as const satisfies Record<string, Crop>;

export type PhotoName = keyof typeof PHOTOS;
export type MeshTone = "field" | "sky" | "sage" | "rose";

/**
 * What a surface shows: a treated photo, or a muted gradient when the slot holds a colorful UI card (photo rule 2).
 * No photo may appear twice on one page (photo rule 3).
 */
export type Backdrop = PhotoName | `mesh:${MeshTone}`;

export function photoSources(name: PhotoName) {
	const c: Crop = PHOTOS[name];
	const set = (ext: string) => c.edge.map((e, i) => `/photos/${c.file}-${e}.${ext} ${c.w[i]}w`).join(", ");
	return { avif: set("avif"), jpeg: set("jpg"), src: `/photos/${c.file}-${c.edge[0]}.jpg`, crop: c };
}
