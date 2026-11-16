import { ShellPreview } from "@everyfield/ui/shell/preview";
import { ChurchLibrary } from "@/features/documents/church/ChurchLibrary";
import { PREVIEW_TEMPLATES } from "@/features/documents/church/preview/templates";

export const metadata = { title: "New from template" };

export default function TemplatePickerPreviewPage() {
	return (
		<ShellPreview role="owner">
			<ChurchLibrary documents={[]} templates={PREVIEW_TEMPLATES} churchTemplates={[]} canManage notice={null} />
		</ShellPreview>
	);
}
