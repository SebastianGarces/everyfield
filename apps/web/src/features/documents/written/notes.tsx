// Lines the native page shows above a document, for the editor and the read view alike.

/** The section of Documents a plain document belongs to. */
export const SECTION = { church: "Written for your church", account: "Your documents" } as const;

/** A church copy made with Use for this church. */
export function CopiedNote() {
	return (
		<p className="text-sm text-text-2 text-pretty">
			Copied from Your documents. Changes here do not change the original.
		</p>
	);
}

/** A document whose current revision is plain text, saved before the editor. */
export function TextRevisionNote() {
	return (
		<p className="text-sm text-text-2 text-pretty">
			This document was saved as plain text before the editor, so each line opens as a paragraph. Your next save keeps
			the formatting you add.
		</p>
	);
}
