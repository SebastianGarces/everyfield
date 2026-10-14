import type { Metadata } from "next";
import { COPY } from "@/marketing/copy";
import { Legal } from "@/marketing/Legal";

const copy = COPY.shared.terms_page;
export const metadata: Metadata = { title: copy.title, alternates: { canonical: "/terms" } };

export default function Terms() {
  return <Legal path="/terms" copy={copy} />;
}
