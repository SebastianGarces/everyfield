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
import { useEffect, useRef, useState } from "react";
import { querySearch, type PeopleQuery } from "../model.ts";
import { describeFilters, plural } from "./model.ts";

// Export the directory's current filters as CSV (REQ-PPL-019). The dialog names the filters before the download and
// the row count after it. One request per Download press; the file is every matching person, however many.

type State =
	| { kind: "ready" }
	| { kind: "exporting"; slow: boolean }
	| { kind: "done"; filename: string; returned: number; complete: boolean }
	| { kind: "failed"; denied: boolean };

export function ExportDialog({
	query,
	open,
	onOpenChange,
}: {
	query: PeopleQuery;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [state, setState] = useState<State>({ kind: "ready" });
	const busy = state.kind === "exporting";
	const slowTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(slowTimer.current), []);
	const filters = describeFilters(query);

	const download = async () => {
		setState({ kind: "exporting", slow: false });
		// A very large export is report work and can pass one second (C33); the dialog says so while it waits.
		slowTimer.current = setTimeout(() => setState((s) => (s.kind === "exporting" ? { ...s, slow: true } : s)), 1000);
		try {
			const res = await fetch(`/api/people/export${querySearch({ ...query, page: 1 })}`, { cache: "no-store" });
			if (!res.ok) {
				setState({ kind: "failed", denied: res.status === 403 });
				return;
			}
			const blob = await res.blob();
			const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "people.csv";
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 30_000);
			setState({
				kind: "done",
				filename,
				returned: Number(res.headers.get("x-export-returned") ?? 0),
				complete: res.headers.get("x-export-completeness") === "complete",
			});
		} catch {
			setState({ kind: "failed", denied: false });
		} finally {
			clearTimeout(slowTimer.current);
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
					title="Export people"
					description="A CSV file of everyone your current filters show."
				/>
				<DialogBody className="flex flex-col gap-4">
					<div>
						<p className="text-sm font-medium text-ink">Filters</p>
						<ul className="mt-1.5 flex flex-col gap-1 text-md text-text-2">
							{filters.map((f) => (
								<li key={f}>{f}</li>
							))}
						</ul>
					</div>
					<p className="text-sm text-text-2 text-pretty">
						The file has 15 columns, from first_name to created_at, with tags joined by semicolons. Import reads only
						the 12 contact columns, so an export is not a full backup.
					</p>
					<div aria-live="polite">
						{state.kind === "done" ? (
							<Card variant="callout" tone="green">
								<CalloutLabel tone="green" icon={Tick02Icon}>
									{state.complete ? "Downloaded" : "Downloaded, not complete"}
								</CalloutLabel>
								<CalloutText>
									{state.filename} has {plural(state.returned, "person", "people")}.
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
						) : state.kind === "exporting" && state.slow ? (
							<p className="text-sm text-text-2">Still preparing the file. A large export can take a few seconds.</p>
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
