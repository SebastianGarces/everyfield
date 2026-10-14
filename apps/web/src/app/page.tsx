import type { Metadata } from "next";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { homeHTML } from "@/marketing/markup";
import { Site } from "@/marketing/Site";

export const metadata: Metadata = pageMetadata(PAGES.home);

export default function Home() {
  return <Site path="/" animated html={homeHTML()} />;
}
