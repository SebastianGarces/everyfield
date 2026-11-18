export const SECTION = { church: "Written for your church", account: "Your documents" } as const;

export function CopiedNote() {
	return (
		<p className="text-sm text-text-2 text-pretty">
			Copied from Your documents. Changes here do not change the original.
		</p>
	);
}

export function TextRevisionNote() {
	return (
		<p className="text-sm text-text-2 text-pretty">
			This document was saved as plain text before the editor, so each line opens as a paragraph. Your next save keeps
			the formatting you add.
		</p>
	);
}
