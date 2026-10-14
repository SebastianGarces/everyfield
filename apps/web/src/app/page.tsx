import type { Metadata } from "next";
import { MotionProvider } from "@/components/MotionProvider";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { homeHTML } from "@/marketing/markup";
import { Site } from "@/marketing/Site";

export const metadata: Metadata = pageMetadata(PAGES.home);

export default function Home() {
  return <Site path="/" provider={MotionProvider} html={homeHTML()} />;
}
