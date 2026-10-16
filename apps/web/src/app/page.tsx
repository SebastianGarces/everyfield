import type { Metadata } from "next";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { HomePage } from "@/marketing/proto/HomePage";

export const metadata: Metadata = pageMetadata(PAGES.home);

export default function Home() {
  return <HomePage variant="current" />;
}
