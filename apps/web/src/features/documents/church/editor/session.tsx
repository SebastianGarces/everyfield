"use client";

import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader } from "@everyfield/ui/controls";
import { Extension, type Editor } from "@tiptap/core";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { holdLeave } from "../../../../components/save/leave.ts";
import { deleteBlock, moveBlock } from "./blocks.ts";

// What the Church Document editor and the plain document editor share around the paper: the save status line, the
// guard that asks before unsaved edits leave the page, and the block shortcuts.

export type SaveStatus =
	{ kind: "saved" } | { kind: "dirty" } | { kind: "saving" } | { kind: "failed"; reason: string };

/** Block shortcuts that need no toolbar: Move block up and down, Delete block. */
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

/** A way out of the page that waits for an answer: `go` leaves, `stay` (if any) puts back what the way out undid. */
export type LeaveRequest = { go: () => void; stay?: () => void };

/**
 * Asks before an in-app link, the Back button or a page-wide action such as Sign out (`leavePage`) leaves the page
 * while the document has changes that are not saved. The question is an Everyfield dialog (LeaveDialog), never a
 * browser confirm. Closing or reloading the tab can only show the browser's own beforeunload prompt; after the person
 * chose to leave, it stays quiet. The listeners stay on for the life of the editor and ask `unsaved` at the moment of
 * the click or the Back press, so no edit, however close to the click, gets past them.
 */
export function useLeaveGuard(editor: Editor | null, unsaved: () => boolean) {
	const router = useRouter();
	const [request, setRequest] = useState<LeaveRequest | null>(null);
	useEffect(() => {
		if (!editor) return;
		// The person chose "Leave without saving" for a way out that loads a new page (Sign out): no second question.
		let released = false;
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (released || !unsaved()) return;
			event.preventDefault();
			event.returnValue = "";
		};
		const onClick = (event: MouseEvent) => {
			if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
			const link = (event.target as Element | null)?.closest?.("a[href]");
			if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download") || link.target === "_blank") return;
			const url = new URL(link.href, window.location.href);
			if (url.origin !== window.location.origin) return;
			if (url.pathname === window.location.pathname && url.search === window.location.search) return;
			if (!unsaved()) return;
			event.preventDefault();
			event.stopPropagation();
			setRequest({ go: () => router.push(`${url.pathname}${url.search}${url.hash}`) });
		};
		// The Back button: a sentinel entry with the same address takes the first Back press. The edit that makes the
		// document unsaved pushes it, so it is in place before any Back press. Leaving the sentinel with nothing unsaved
		// (after a Save) goes on back, so one press still leaves the page.
		// The Settings dialog opens over the editor with its own history entries (/settings/account). They can sit above
		// the sentinel, so an edit checks the entry it is on, and Back onto a Settings entry is no way out: the editor is
		// still there under the dialog.
		const here = () => window.location.pathname + window.location.search;
		const home = here();
		const onSentinel = () => window.history.state?.efLeaveGuard === true;
		let armed = onSentinel();
		let leaving = false;
		const pushSentinel = () => {
			window.history.pushState({ ...window.history.state, efLeaveGuard: true }, "", window.location.href);
			armed = true;
		};
		const arm = () => {
			if (!onSentinel() && unsaved()) pushSentinel();
		};
		const onPopState = () => {
			const left = armed;
			armed = onSentinel();
			if (leaving || !left || armed || here() !== home) return;
			const back = () => {
				leaving = true;
				window.history.back();
			};
			if (unsaved()) setRequest({ go: back, stay: pushSentinel });
			else back();
		};
		const release = holdLeave((go) => {
			if (!unsaved()) return false;
			setRequest({
				go: () => {
					released = true;
					go();
				},
			});
			return true;
		});
		editor.on("update", arm);
		window.addEventListener("beforeunload", beforeUnload);
		window.addEventListener("popstate", onPopState);
		document.addEventListener("click", onClick, true);
		return () => {
			release();
			editor.off("update", arm);
			window.removeEventListener("beforeunload", beforeUnload);
			window.removeEventListener("popstate", onPopState);
			document.removeEventListener("click", onClick, true);
		};
	}, [editor, unsaved, router]);
	return { request, close: () => setRequest(null) };
}

/** Save and leave, Leave without saving, or Cancel. A save that fails keeps the page, with the reason in the status. */
export function LeaveDialog({
	request,
	onSave,
	onDone,
}: {
	request: LeaveRequest | null;
	onSave: () => Promise<boolean>;
	onDone: () => void;
}) {
	const [saving, setSaving] = useState(false);
	const finish = (leave: boolean) => {
		if (!request) return;
		onDone();
		if (leave) request.go();
		else request.stay?.();
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
							// A save that throws must not leave the dialog locked on "saving".
							const saved = await onSave().catch(() => false);
							setSaving(false);
							finish(saved);
						}}
					>
						Save and leave
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
