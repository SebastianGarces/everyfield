"use client";

import { Add01Icon } from "@hugeicons/core-free-icons";
import { Button, PageHeader, SegmentedControl } from "@everyfield/ui/controls";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { Address } from "./Address.tsx";
import { Compose } from "./Compose.tsx";
import { History } from "./HistoryPanel.tsx";
import { parseRoute, routeHref, type PageData, type Route, type Step, type Template } from "./model.ts";
import { Templates } from "./Templates.tsx";

// Messages. The page opens on the history list. New message starts the guided flow. Every state is in the address, so
// reload and the Back button return to it. Opening a message or entering compose pushes an entry; a step change replaces.
// Every move inside the page writes the address with the history API, which Next.js keeps in step with
// useSearchParams, so it makes no server request. The page's data loads once; each panel reads what it shows.
// Next.js starts following the history API in an effect after hydration. A move before that, such as a fresh load of an
// unsaved message's Write going back to Who, goes through the router, or Next.js would not see it.
const historyFollowed = () => !/\[native code\]/.test(Function.prototype.toString.call(window.history.pushState));

type Section = "messages" | "templates" | "address";

export function CommunicationScreen({ data, canWrite }: { data: PageData; canWrite: boolean }) {
	const params = useSearchParams();
	const router = useRouter();
	const route = parseRoute(Object.fromEntries(params.entries()));
	const [templates, setTemplates] = useState<Template[]>(data.templates);
	const [banner, setBanner] = useState<string | null>(null);

	const go = useCallback(
		(next: Route, mode: "push" | "replace" = "push") => {
			const href = routeHref(next);
			if (!historyFollowed()) {
				if (mode === "push") router.push(href, { scroll: false });
				else router.replace(href, { scroll: false });
			} else if (mode === "push") window.history.pushState(null, "", href);
			else window.history.replaceState(null, "", href);
		},
		[router],
	);

	const section: Section = route.kind === "templates" ? "templates" : route.kind === "address" ? "address" : "messages";
	const composing = route.kind === "compose" && canWrite;
	const sections: { value: Section; label: string }[] = [
		{ value: "messages", label: "Messages" },
		{ value: "templates", label: "Templates" },
	];
	if (canWrite) sections.push({ value: "address", label: "Your address" });

	const openSection = (value: Section) => {
		setBanner(null);
		go(
			value === "templates"
				? { kind: "templates", template: null }
				: value === "address"
					? { kind: "address" }
					: { kind: "history", message: null, meeting: null, person: null },
		);
	};
	const newMessage = () => {
		setBanner(null);
		go({ kind: "compose", id: "new", step: "who", handoff: null });
	};

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				size="xl"
				title="Messages"
				subtitle="See what was sent, write a new message, and send or schedule the email."
				actions={
					canWrite && !composing ? (
						<Button variant="primary" icon={Add01Icon} onClick={newMessage}>
							New message
						</Button>
					) : null
				}
			/>
			{canWrite ? null : (
				<p className="text-md text-text-2">
					You can read messages. An Owner or Admin writes, schedules, and saves a follow-up.
				</p>
			)}
			{composing && route.kind === "compose" ? (
				<Compose
					key="compose"
					data={{ ...data, templates }}
					id={route.id}
					step={route.step}
					handoff={route.handoff}
					onStep={(step: Step) => go({ ...route, step }, "replace")}
					onSaved={(id, step) => go({ kind: "compose", id, step, handoff: null }, "replace")}
					onLeave={() => go({ kind: "history", message: null, meeting: null, person: null })}
					onDeleted={() => {
						setBanner("Draft deleted.");
						go({ kind: "history", message: null, meeting: null, person: null });
					}}
					onDone={(messageId, text) => {
						setBanner(text);
						go({ kind: "history", message: messageId, meeting: null, person: null });
					}}
				/>
			) : (
				<>
					<SegmentedControl
						label="Message sections"
						value={section}
						onValueChange={openSection}
						options={sections}
						wrap
					/>
					{route.kind === "templates" ? (
						<Templates
							templates={templates}
							setTemplates={setTemplates}
							canWrite={canWrite}
							selected={route.template}
							onSelect={(id) => go({ kind: "templates", template: id })}
							churchName={data.churchName}
							origin={data.origin}
						/>
					) : route.kind === "address" && canWrite ? (
						<Address />
					) : (
						<History
							canWrite={canWrite}
							personId={route.kind === "history" ? route.person : null}
							meetingId={route.kind === "history" ? route.meeting : null}
							selected={route.kind === "history" ? route.message : null}
							onSelected={(id) =>
								go({
									kind: "history",
									message: id,
									meeting: route.kind === "history" ? route.meeting : null,
									person: route.kind === "history" ? route.person : null,
								})
							}
							onCompose={(id, step, replace) =>
								go({ kind: "compose", id, step, handoff: null }, replace ? "replace" : "push")
							}
							onNew={newMessage}
							onOpen={(draft) => {
								go({ kind: "compose", id: draft.communicationId, step: "review", handoff: null });
							}}
							churchName={data.churchName}
							origin={data.origin}
							banner={banner}
						/>
					)}
				</>
			)}
		</div>
	);
}
