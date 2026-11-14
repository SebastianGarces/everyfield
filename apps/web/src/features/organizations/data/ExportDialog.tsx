"use client";

import { Alert02Icon, FileExportIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	CalloutLabel,
	CalloutText,
	Card,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
} from "@everyfield/ui/controls";
import { useState } from "react";
import { PIPELINE_PATH, plural } from "../board/model";

// Export the whole pipeline as CSV (REQ-MUL-005), in the People export's shape: the dialog says what the file holds and
// leaves out before the download and how many people it has after it. One request per Download press.

type State =
	| { kind: "ready" }
	| { kind: "exporting" }
	| { kind: "done"; filename: string; people: number }
	| { kind: "failed"; denied: boolean };

export function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const [state, setState] = useState<State>({ kind: "ready" });
	const busy = state.kind === "exporting";

	const download = async () => {
		setState({ kind: "exporting" });
		try {
			const res = await fetch(`${PIPELINE_PATH}/export`, { cache: "no-store" });
			if (!res.ok) {
				setState({ kind: "failed", denied: res.status === 403 });
				return;
			}
			const blob = await res.blob();
			const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "pipeline.csv";
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 30_000);
			setState({ kind: "done", filename, people: Number(res.headers.get("x-export-people") ?? 0) });
		} catch {
			setState({ kind: "failed", denied: false });
		}
	};

	const close = () => {
		if (busy) return;
		onOpenChange(false);
		setState({ kind: "ready" });
	};

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
			<DialogContent size="sm" aria-busy={busy || undefined}>
				<DialogHeader
					icon={FileExportIcon}
					tone="blue"
					title="Export pipeline"
					description="A CSV file of everyone in your pipeline, live and retired."
				/>
				<DialogBody className="flex flex-col gap-4">
					<div>
						<p className="text-sm font-medium text-ink">In the file</p>
						<p className="mt-1 text-md text-text-2 text-pretty">
							Contact details, stage history, programs, enrollments and milestone completions. Its first lines say when
							it was made.
						</p>
					</div>
					<div>
						<p className="text-sm font-medium text-ink">Left out</p>
						<p className="mt-1 text-md text-text-2 text-pretty">
							Notes, stage move reasons, conversations and feedback, anything from a resident’s own account, and
							progress a resident doesn’t share with you.
						</p>
					</div>
					<div aria-live="polite">
						{state.kind === "done" ? (
							<Card variant="callout" tone="green">
								<CalloutLabel tone="green" icon={Tick02Icon}>
									Downloaded
								</CalloutLabel>
								<CalloutText>
									{state.filename} has {plural(state.people, "person", "people")}.
								</CalloutText>
							</Card>
						) : state.kind === "failed" ? (
							<Card variant="callout" tone="magenta" role="alert">
								<CalloutLabel tone="magenta" icon={Alert02Icon}>
									The export did not download
								</CalloutLabel>
								<CalloutText>
									{state.denied
										? "Your seat may have changed. Reload the page to check your access."
										: "The connection dropped or the server did not answer. Try again."}
								</CalloutText>
							</Card>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" disabled={busy} onClick={close}>
						{state.kind === "done" ? "Close" : "Cancel"}
					</Button>
					<Button variant="primary" loading={busy} onClick={download}>
						{state.kind === "done" ? "Download again" : "Download CSV"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
