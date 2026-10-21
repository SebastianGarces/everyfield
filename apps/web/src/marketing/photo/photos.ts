// The marketing photos (foundations.md, Brand: Marketing photos). One source file per photo, imported statically, so
// next/image serves resized AVIF or WebP copies under content-hashed URLs. A slot picks a photo by name, never a file.
// The grain and the black overlay are CSS layers over the image, never baked into the files.
import type { StaticImageData } from "next/image";
import blossom from "./files/blossom.jpg";
import bluebells from "./files/bluebells.jpg";
import field from "./files/field.jpg";
import lake from "./files/lake.jpg";
import meadow from "./files/meadow.jpg";
import plain from "./files/plain.jpg";
import poppies from "./files/poppies.jpg";
import reeds from "./files/reeds.jpg";
import wheat from "./files/wheat.jpg";
import wildflowers from "./files/wildflowers.jpg";

type Crop = {
	src: StaticImageData;
	/** Focus point: object-position, also the zoom origin. */
	pos: string;
	/** 1 = cover. */
	zoom?: number;
	/** Black overlay; 0.2 is the brand default. */
	shade?: number;
};

/* Crops from design/everyfield-marketing.html (data-photo). */
export const PHOTOS = {
	// Landscapes.
	field: { src: field, pos: "50% 16%" },
	plain: { src: plain, pos: "30% 70%" },
	reeds: { src: reeds, pos: "50% 72%" },
	lake: { src: lake, pos: "50% 67%" },
	wheat: { src: wheat, pos: "50% 62%" },
	// Blurred colorful photos: the heroes and the phase-card rail.
	bluebells: { src: bluebells, pos: "30% 40%" },
	poppies: { src: poppies, pos: "50% 92%", zoom: 1.5 },
	wildflowers: { src: wildflowers, pos: "60% 45%" },
	blossom: { src: blossom, pos: "50% 40%" },
	meadow: { src: meadow, pos: "40% 50%" },
	// Second crops for the six-card rails: five colorful photos fill six cards (Sebastian's pick pending, see the task
	// note). A rail may reuse a photo shown elsewhere on its page; other sections never repeat one.
	bluebellsClose: { src: bluebells, pos: "80% 70%", zoom: 1.6 },
	poppiesWide: { src: poppies, pos: "20% 60%", zoom: 1.2 },
} as const satisfies Record<string, Crop>;

export type PhotoName = keyof typeof PHOTOS;
export type MeshTone = "field" | "sky" | "sage" | "rose";

/**
 * What a surface shows: a treated photo, or a muted gradient when the slot holds a colorful UI card (photo rule 2).
 * No photo may appear twice on one page (photo rule 3).
 */
export type Backdrop = PhotoName | `mesh:${MeshTone}`;

/** The hero photos (home = wildflowers, /oversight = bluebells). */
export type HeroPhoto = "wildflowers" | "bluebells";
