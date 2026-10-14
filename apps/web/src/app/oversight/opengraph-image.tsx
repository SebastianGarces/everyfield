import { COPY } from "@/marketing/copy";
import { shareAlt } from "@/marketing/meta";
import { SHARE_SIZE, SHARE_TYPE, shareImage } from "@/marketing/share";

const H = COPY.shared.oversight_page.hero;
export const alt = shareAlt(H.headline, H.subhead);
export const size = SHARE_SIZE;
export const contentType = SHARE_TYPE;

export default function Image() {
  return shareImage(H);
}
