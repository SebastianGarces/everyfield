import { DisplayPreview } from "@everyfield/ui/display/preview";
import { ShellPreview } from "@everyfield/ui/shell/preview";

export function DisplayPreviewPage() {
	return (
		<ShellPreview role="owner">
			<DisplayPreview />
		</ShellPreview>
	);
}
