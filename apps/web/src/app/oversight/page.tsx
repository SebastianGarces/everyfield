import type { Metadata } from "next";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { oversightHTML } from "@/marketing/markup";
import { Site } from "@/marketing/Site";

export const metadata: Metadata = pageMetadata(PAGES.oversight);

export default function Oversight() {
  return <Site path="/oversight" html={oversightHTML()} />;
}
