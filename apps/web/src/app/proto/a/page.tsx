import type { Metadata } from "next";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { HomePage } from "@/marketing/proto/HomePage";

export const metadata: Metadata = { ...pageMetadata(PAGES.home), robots: { index: false, follow: false } };

export default function ProtoHome() {
  return <HomePage variant="a" />;
}
