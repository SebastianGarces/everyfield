import type { Metadata } from "next";
import { COPY } from "@/marketing/copy";
import { oversightHTML } from "@/marketing/markup";
import { Site } from "@/marketing/Site";

export const metadata: Metadata = {
  title: "For sending churches and networks",
  description: COPY.shared.oversight_page.hero.subhead,
  alternates: { canonical: "/oversight" },
};

export default function Oversight() {
  return <Site path="/oversight" html={oversightHTML()} />;
}
