import { FoundationsPreview } from "@everyfield/ui/foundations/preview";
import { ShellPreview } from "@everyfield/ui/shell/preview";

export function FoundationsPreviewPage() {
	return (
		<ShellPreview role="owner">
			<FoundationsPreview />
		</ShellPreview>
	);
}
