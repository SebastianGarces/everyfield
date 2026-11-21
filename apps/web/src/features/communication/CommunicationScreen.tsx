"use client";

import { Add01Icon } from "@hugeicons/core-free-icons";
import { Button, PageHeader, SegmentedControl } from "@everyfield/ui/controls";
import { useState } from "react";
import { addAddressRule, useAddress, writeAddress } from "../../components/location.ts";
import { Address, ownSuppression } from "./Address.tsx";
import { Compose } from "./Compose.tsx";
import { History } from "./HistoryPanel.tsx";
import { parseRoute, routeHref, type PageData, type Route, type Step, type Template } from "./model.ts";
import { Templates } from "./Templates.tsx";

type Section = "messages" | "templates" | "address";

addAddressRule("communication: an unsaved new message starts at Who", (to) => {
	if (to.pathname !== "/communication" || to.searchParams.get("compose") !== "new") return null;
	const route = parseRoute(Object.fromEntries(to.searchParams));
	if (route.kind !== "compose" || route.handoff || route.step === "who") return null;
	if (document.querySelector('[data-compose-draft="new"]')) return null;
	return routeHref({ ...route, step: "who" });
});

export function CommunicationScreen({ data, canWrite }: { data: PageData; canWrite: boolean }) {
	const address = useAddress();
	const [page, setPage] = useState(address);
	const here = address.pathname === "/communication";
	if (here && address !== page) setPage(address);
	const route = parseRoute(Object.fromEntries((here ? address : page).params.entries()));
	const [templates, setTemplates] = useState<Template[]>(data.templates);
	const [banner, setBanner] = useState<string | null>(null);

	const go = (next: Route, mode: "push" | "replace" = "push") =>
		writeAddress(routeHref(next), { replace: mode === "replace" });

	const section: Section = route.kind === "templates" ? "templates" : route.kind === "address" ? "address" : "messages";
	const composing = route.kind === "compose" && canWrite;
	const sections: { value: Section; label: string }[] = [
		{ value: "messages", label: "Messages" },
		{ value: "templates", label: "Templates" },
	];
	if (canWrite) sections.push({ value: "address", label: "Your address" });

	const openSection = (value: Section) => {
		setBanner(null);
		if (value === "address") ownSuppression.prefetch();
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
