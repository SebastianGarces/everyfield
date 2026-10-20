import { FoundationsPreview } from "@everyfield/ui/foundations/preview";
import { ShellPreview } from "@everyfield/ui/shell/preview";

export const metadata = { title: "Foundations" };

export default function FoundationsPage() {
  return (
    <ShellPreview role="owner">
      <FoundationsPreview />
    </ShellPreview>
  );
}
