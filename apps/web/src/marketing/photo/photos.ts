// The marketing photos (foundations.md, Brand: Marketing photos). photos.json holds each photo's files and crop;
// scripts/render-photo-css.mjs turns it into src/styles/photos.generated.css. A slot picks a photo by name, never a file.
// The grain and the black overlay are CSS, never baked into the files.
import type PHOTOS from "./photos.json";

export type PhotoName = keyof typeof PHOTOS;
export type MeshTone = "field" | "sky" | "sage" | "rose";

/**
 * What a surface shows: a treated photo, or a muted gradient when the slot holds a colorful UI card (photo rule 2).
 * No photo may appear twice on one page (photo rule 3).
 */
export type Backdrop = PhotoName | `mesh:${MeshTone}`;

/** The hero photos: each has a small hero copy, the page's LCP element (HeroBackdrop, scripts/render-hero-photos.mjs). */
export type HeroPhoto = "wildflowers" | "bluebells";
