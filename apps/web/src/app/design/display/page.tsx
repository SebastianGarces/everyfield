import { DisplayPreview } from "@everyfield/ui/display/preview";
import { ShellPreview } from "@everyfield/ui/shell/preview";

export const metadata = { title: "Display" };

export default function DisplayPage() {
  return (
    <ShellPreview role="owner">
      <DisplayPreview />
    </ShellPreview>
  );
}
