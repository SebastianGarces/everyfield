import { ControlsPreview } from "@everyfield/ui/controls/preview";
import { ShellPreview } from "@everyfield/ui/shell/preview";

export const metadata = { title: "Controls" };

export default function ControlsPage() {
  return (
    <ShellPreview role="owner">
      <ControlsPreview />
    </ShellPreview>
  );
}
