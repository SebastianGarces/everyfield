import { ImageResponse } from "next/og";
import { LOGO_SYMBOLS } from "@/marketing/logo-symbols";

const mark = LOGO_SYMBOLS.match(/<symbol id="ef-symbol" viewBox="(?<box>[^"]+)">(?<paths>[\s\S]*?)<\/symbol>/)?.groups;
if (!mark?.box || !mark.paths) throw new Error("logo-symbols.ts: symbol #ef-symbol is missing");
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.box}">${mark.paths.replaceAll("currentColor", "#181D19")}</svg>`;
const MARK = `data:image/svg+xml;base64,${Buffer.from(MARK_SVG).toString("base64")}`;

// The footer's symbol tile (SiteFooter): the ink symbol on new-growth green. iOS rounds the corners itself.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "#1AF197",
			}}
		>
			<img src={MARK} width={90} height={90} alt="" />
		</div>,
		size,
	);
}
