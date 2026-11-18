import { ShellPreview } from "@everyfield/ui/shell/preview";
import { ChurchLibrary } from "../ChurchLibrary";
import { PREVIEW_TEMPLATES } from "./templates";

export function TemplatePickerPreviewPage() {
	return (
		<ShellPreview role="owner">
			<ChurchLibrary documents={[]} templates={PREVIEW_TEMPLATES} churchTemplates={[]} canManage notice={null} />
		</ShellPreview>
	);
}
