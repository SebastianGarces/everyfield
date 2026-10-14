import type { Metadata } from "next";
import { COPY } from "@/marketing/copy";
import { Legal } from "@/marketing/Legal";

const copy = COPY.shared.privacy_page;
export const metadata: Metadata = { title: copy?.title ?? "Privacy policy", alternates: { canonical: "/privacy" } };

export default function Privacy() {
  return <Legal path="/privacy" fallbackTitle="Privacy policy" copy={copy} />;
}
