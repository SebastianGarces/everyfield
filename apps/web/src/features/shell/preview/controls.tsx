import { ControlsPreview } from "@everyfield/ui/controls/preview";
import { ShellPreview } from "@everyfield/ui/shell/preview";

export function ControlsPreviewPage() {
	return (
		<ShellPreview role="owner">
			<ControlsPreview />
		</ShellPreview>
	);
}
