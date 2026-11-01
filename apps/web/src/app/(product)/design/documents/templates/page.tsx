import { ShellPreview } from "@everyfield/ui/shell/preview";
import { ChurchLibrary } from "@/features/documents/church/ChurchLibrary";
import { PREVIEW_TEMPLATES } from "@/features/documents/church/preview/templates";

export const metadata = { title: "New from template" };

// "New from template" with 60 invented templates, to check search and paging (WP-036). The /design layout returns 404
// in production.
export default function TemplatePickerPreviewPage() {
	return (
		<ShellPreview role="owner">
			<ChurchLibrary documents={[]} templates={PREVIEW_TEMPLATES} canManage deleted={false} />
		</ShellPreview>
	);
}
