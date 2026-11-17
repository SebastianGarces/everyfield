"use client";

import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader } from "@everyfield/ui/controls";
import { Extension } from "@tiptap/core";
import { useState } from "react";
import { useLeaveRequest } from "../../../../components/save/leave.ts";
import { saveAndLeave } from "../../save-chain.ts";
import { deleteBlock, moveBlock } from "./blocks.ts";

export type SaveStatus =
	{ kind: "saved" } | { kind: "dirty" } | { kind: "saving" } | { kind: "failed"; reason: string };

export const BlockShortcuts = Extension.create({
	name: "blockShortcuts",
	addKeyboardShortcuts() {
		return {
			"Mod-Alt-ArrowUp": () => moveBlock(this.editor, -1),
			"Mod-Alt-ArrowDown": () => moveBlock(this.editor, 1),
			"Mod-Alt-Backspace": () => deleteBlock(this.editor),
		};
	},
});

export function SaveStatusText({
	status,
	revision,
	accepted,
	onRetry,
}: {
	status: SaveStatus;
	revision: string;
	accepted: string | null;
	onRetry: () => void;
}) {
	return (
		<p
			role="status"
			aria-live="polite"
			className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-2"
		>
			{status.kind === "saved" ? (
				<span>
					{accepted ? `${accepted} ` : "Saved "}
					<span className="tabular-nums">· Revision {revision}</span>
				</span>
			) : status.kind === "dirty" ? (
				<span>Unsaved changes</span>
			) : status.kind === "saving" ? (
				<span>Saving…</span>
			) : (
				<>
					<span className="text-magenta-600">Not saved. {status.reason}</span>
					<Button variant="outline" size="sm" icon={Refresh01Icon} onClick={onRetry}>
						Retry
					</Button>
				</>
			)}
		</p>
	);
}

export function LeaveDialog({ onSave }: { onSave: () => Promise<boolean> }) {
	const request = useLeaveRequest();
	const [saving, setSaving] = useState(false);
	const finish = (leave: boolean) => {
		if (!request) return;
		if (leave) request.leave();
		else request.stay();
	};
	return (
		<Dialog
			open={request !== null}
			onOpenChange={(open) => {
				if (!open && !saving) finish(false);
			}}
		>
			<DialogContent size="md">
				<DialogHeader
					title="Leave without saving?"
					description="This document has changes that are not saved. If you leave now, they are lost."
					closable={false}
				/>
				<DialogFooter>
					<Button variant="secondary" disabled={saving} onClick={() => finish(false)}>
						Cancel
					</Button>
					<Button variant="danger" disabled={saving} onClick={() => finish(true)}>
						Leave without saving
					</Button>
					<Button
						variant="primary"
						loading={saving}
						onClick={async () => {
							setSaving(true);
							await saveAndLeave(onSave, (leave) => {
								setSaving(false);
								finish(leave);
							});
						}}
					>
						Save and leave
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
