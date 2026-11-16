import type { FontId } from "@everyfield/contracts/branding";
import {
	DM_Sans,
	DM_Serif_Display,
	Inter,
	Lora,
	Merriweather,
	Nunito_Sans,
	Playfair_Display,
	Source_Sans_3,
	Source_Serif_4,
	Work_Sans,
} from "next/font/google";

const dmSerifDisplay = DM_Serif_Display({ weight: "400", subsets: ["latin"], display: "swap", preload: false });
const playfairDisplay = Playfair_Display({ subsets: ["latin"], display: "swap", preload: false });
const lora = Lora({ subsets: ["latin"], display: "swap", preload: false });
const merriweather = Merriweather({ weight: ["400", "700"], subsets: ["latin"], display: "swap", preload: false });
const sourceSerif4 = Source_Serif_4({ subsets: ["latin"], display: "swap", preload: false });
const dmSans = DM_Sans({ subsets: ["latin"], display: "swap", preload: false });
const inter = Inter({ subsets: ["latin"], display: "swap", preload: false });
const sourceSans3 = Source_Sans_3({ subsets: ["latin"], display: "swap", preload: false });
const workSans = Work_Sans({ subsets: ["latin"], display: "swap", preload: false });
const nunitoSans = Nunito_Sans({ subsets: ["latin"], display: "swap", preload: false });

const FAMILY: Record<FontId, string> = {
	"DM Serif Display": dmSerifDisplay.style.fontFamily,
	"Playfair Display": playfairDisplay.style.fontFamily,
	Lora: lora.style.fontFamily,
	Merriweather: merriweather.style.fontFamily,
	"Source Serif 4": sourceSerif4.style.fontFamily,
	"DM Sans": dmSans.style.fontFamily,
	Inter: inter.style.fontFamily,
	"Source Sans 3": sourceSans3.style.fontFamily,
	"Work Sans": workSans.style.fontFamily,
	"Nunito Sans": nunitoSans.style.fontFamily,
};

export function familyOf(font: string): string {
	return font in FAMILY ? FAMILY[font as FontId] : font;
}
