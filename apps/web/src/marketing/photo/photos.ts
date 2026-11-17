import type { StaticImageData } from "next/image";
import blossom from "./files/blossom.jpg";
import bluebells from "./files/bluebells.jpg";
import field from "./files/field.jpg";
import lake from "./files/lake.jpg";
import lilies from "./files/lilies.jpg";
import lupins from "./files/lupins.jpg";
import marigolds from "./files/marigolds.jpg";
import meadow from "./files/meadow.jpg";
import poppies from "./files/poppies.jpg";
import reeds from "./files/reeds.jpg";
import swirl from "./files/swirl.jpg";
import wildflowers from "./files/wildflowers.jpg";

type Crop = {
	src: StaticImageData;
	pos: string;
	zoom?: number;
	shade?: number;
};

export const PHOTOS = {
	field: { src: field, pos: "50% 16%" },
	reeds: { src: reeds, pos: "50% 72%" },
	lake: { src: lake, pos: "50% 67%" },
	bluebells: { src: bluebells, pos: "30% 40%" },
	poppies: { src: poppies, pos: "50% 92%", zoom: 1.5 },
	wildflowers: { src: wildflowers, pos: "60% 45%" },
	blossom: { src: blossom, pos: "50% 40%" },
	meadow: { src: meadow, pos: "40% 50%" },
	marigolds: { src: marigolds, pos: "50% 40%" },
	lilies: { src: lilies, pos: "50% 45%" },
	lupins: { src: lupins, pos: "50% 50%" },
	swirl: { src: swirl, pos: "40% 50%" },
} as const satisfies Record<string, Crop>;

export type PhotoName = keyof typeof PHOTOS;

export type Backdrop = PhotoName;

export type HeroPhoto = "wildflowers" | "bluebells";
