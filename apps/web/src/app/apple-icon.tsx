import { ImageResponse } from "next/og";
import { symbolSvg } from "@/marketing/share";

// The footer's mark tile (prototype.css .ft-mark): ink mark on the accent green. iOS rounds the corners itself.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#1CE362" }}>
        <img src={symbolSvg("ef-mark", "#181D19")} width={99} height={80} alt="" />
      </div>
    ),
    size,
  );
}
