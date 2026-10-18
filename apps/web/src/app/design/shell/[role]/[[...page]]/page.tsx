import { ShellPreview } from "@everyfield/ui/shell/preview";
import { parsePreviewRole } from "@everyfield/ui/shell/preview/fixtures";
import { notFound } from "next/navigation";

export const metadata = { title: "App shell" };

export default async function ShellPage({ params }: { params: Promise<{ role: string; page?: string[] }> }) {
  const role = parsePreviewRole((await params).role);
  if (!role) notFound();
  return <ShellPreview role={role} />;
}
