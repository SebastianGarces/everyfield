"use client";

import { Button, Card, CardDescription, CardTitle, Select } from "@everyfield/ui/controls";
import { ShellPreview } from "@everyfield/ui/shell/preview";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { parsePreviewKit, type PreviewKit } from "../brand/fixtures";
import { offeredSections, parseSectionKey, SECTION_LABEL } from "../model";
import type { DeletionStatus, SectionKey } from "../port";
import { SharingSection } from "../sections/SharingSection";
import { LazySettingsDialog } from "../ProductSettings";
import { SettingsProvider } from "../store";
import {
	createFixturePort,
	parsePersona,
	parseWikiScenario,
	PERSONA_LABEL,
	PERSONAS,
	PREVIEW_RELATIONSHIPS,
	previewViewer,
	type Fault,
	type Operation,
	type PreviewPersona,
	type WikiScenario,
} from "./fixtures";
import { createReplies, type Replies } from "./replies";
import { RepliesControl } from "./RepliesControl";

const BASE = "/design/settings";

export function SettingsPreview() {
	const search = useSearchParams();
	const persona = parsePersona(search.get("as"));
	const kit = parsePreviewKit(search.get("kit"));
	const wiki = parseWikiScenario(search.get("wiki"));
	return (
		<PreviewSession
			key={`${persona}-${kit}-${wiki}`}
			persona={persona}
			kit={kit}
			wiki={wiki}
			faults={search.getAll("fail")}
			held={search.get("hold") === "1"}
		/>
	);
}

function PreviewSession({
	persona,
	kit,
	wiki,
	faults,
	held,
}: {
	persona: PreviewPersona;
	kit: PreviewKit;
	wiki: WikiScenario;
	faults: string[];
	held: boolean;
}) {
	const params = useParams<{ section?: string[] }>();
	const router = useRouter();
	const section = parseSectionKey(params.section?.[0]);
	const [replies] = useState(() => createReplies(held));
	const [fixture] = useState(() => createFixturePort(persona, { kit, wiki, faults: faults.map(parseFault), replies }));
	const query = (extra = "") =>
		`?as=${persona}${held ? "&hold=1" : ""}${kit !== "none" ? `&kit=${kit}` : ""}${wiki !== "unordered" ? `&wiki=${wiki}` : ""}${extra}`;
	const hrefFor = (key: SectionKey) => `${BASE}/${key}${query()}`;

	const viewer = previewViewer(persona);
	const navigate = (key: SectionKey | null) => router.push(key ? hrefFor(key) : `${BASE}${query()}`, { scroll: false });
	const deleted = (status: DeletionStatus | null) => {
		if (status && "subject" in status && status.subject.kind === "plant")
			return router.push("/design/restricted/workspace-deletion?state=pending");
		const until = status?.status === "pending_deletion" ? `&until=${encodeURIComponent(status.cancelUntil)}` : "";
		router.push(`/design/restricted/account-deletion?state=pending&step=proof${until}`);
	};

	return (
		<ShellPreview role={persona === "member" ? "member" : "owner"}>
			<SettingsProvider port={fixture.port} viewer={viewer}>
				<PreviewPage persona={persona} query={query} fixture={fixture.controls} replies={replies} />
				<LazySettingsDialog
					section={section}
					onNavigate={navigate}
					hrefFor={hrefFor}
					slots={{ sharing: <SharingSection relationships={PREVIEW_RELATIONSHIPS} /> }}
					onDeletionRequested={deleted}
					headerActions={<RepliesControl replies={replies} toggle={false} />}
				/>
			</SettingsProvider>
		</ShellPreview>
	);
}

function parseFault(spec: string): readonly [Operation, Fault, number] {
	const [op, code, skip] = spec.split(":");
	return [op as Operation, code as Fault, Number(skip ?? 0) || 0];
}

const FAULTS: { value: string; label: string }[] = [
	{ value: "none", label: "Every call succeeds" },
	{ value: "saveSection:conflict", label: "Next save: someone else changed it" },
	{ value: "saveSection:temporary", label: "Next save: temporary failure" },
	{ value: "saveSection:offline", label: "Next save: connection lost" },
	{ value: "getSection:temporary", label: "Next section load fails" },
	{ value: "saveBrand:conflict", label: "Next brand kit save: someone else saved first" },
	{ value: "saveBrand:invalid_ein", label: "Next brand kit save: EIN refused" },
	{ value: "saveBrand:offline", label: "Next brand kit save: connection lost" },
	{ value: "uploadBytes:invalid_file", label: "Next logo upload: the file cannot be used" },
	{ value: "finalizeUpload:conflict", label: "Next logo upload: someone else saved first" },
	{ value: "finalizeUpload:alt_text_required", label: "Next logo upload: server wants alt text" },
	{ value: "setPlantTimezone:stale_preview", label: "Next time zone save: preview out of date" },
	{ value: "saveWikiOrder:conflict", label: "Next Wiki order save: someone else saved first" },
	{ value: "saveWikiOrder:temporary", label: "Next Wiki order save fails" },
	{ value: "finalizeAvatar:temporary", label: "Next photo save fails" },
	{ value: "requestEmailChange:temporary", label: "Next email link: too many requests" },
	{ value: "changePassword:unknown", label: "Next password change: outcome unknown" },
];

function PreviewPage({
	persona,
	query,
	fixture,
	replies,
}: {
	persona: PreviewPersona;
	query: (extra?: string) => string;
	fixture: ReturnType<typeof createFixturePort>["controls"];
	replies: Replies;
}) {
	const router = useRouter();
	const [fault, setFault] = useState("none");
	const calls = useSyncExternalStore(
		fixture.onChange,
		() => JSON.stringify(fixture.calls),
		() => "{}",
	);
	const sections = offeredSections(previewViewer(persona), ["sharing"]);

	return (
		<div className="flex flex-col gap-6">
			<div>
				<p className="text-sm text-text-3">Design preview · WP-010</p>
				<h1 className="mt-1 font-display text-title-lg tracking-[-0.02em] text-ink">Settings</h1>
				<p className="mt-2 max-w-[640px] text-text-2">
					This page stands in for whatever page Settings opens over. Each section has its own link. Sample data, no
					database: replies come from fixtures that the settings contract checks.
				</p>
			</div>
			<div className="grid gap-5 app-lg:grid-cols-2">
				<Card>
					<CardTitle>Open a section</CardTitle>
					<CardDescription>Sections offered to this persona.</CardDescription>
					<ul className="mt-4 flex flex-wrap gap-2">
						{sections.map((key) => (
							<li key={key}>
								<Button asChild variant="secondary" size="sm">
									<Link href={`${BASE}/${key}${query()}`} scroll={false}>
										{SECTION_LABEL[key]}
									</Link>
								</Button>
							</li>
						))}
					</ul>
				</Card>
				<Card>
					<CardTitle>Preview as</CardTitle>
					<CardDescription>Switching persona is switching account: drafts do not carry over.</CardDescription>
					<ul className="mt-4 flex flex-wrap gap-2">
						{PERSONAS.map((p) => (
							<li key={p}>
								<Button asChild variant={p === persona ? "primary" : "secondary"} size="sm">
									<Link href={`${BASE}?as=${p}`} aria-current={p === persona ? "page" : undefined}>
										{PERSONA_LABEL[p]}
									</Link>
								</Button>
							</li>
						))}
					</ul>
				</Card>
				<Card>
					<CardTitle>Make the next call fail</CardTitle>
					<CardDescription>Choose a failure, then open a section and use it.</CardDescription>
					<div className="mt-4 flex flex-wrap items-center gap-2">
						<Select
							aria-label="Failure for the next call"
							className="max-w-full"
							options={FAULTS}
							value={fault}
							onValueChange={(v) => {
								setFault(v);
								if (v === "none") return;
								const [op, code] = v.split(":");
								fixture.failNext(op as Operation, code as Fault);
							}}
						/>
					</div>
					<div className="mt-3">
						<RepliesControl replies={replies} />
					</div>
					<p className="mt-3 text-xs text-text-3" data-fixture-calls={calls}>
						Calls so far:{" "}
						{Object.entries(JSON.parse(calls) as Record<string, number>)
							.map(([k, v]) => `${k} ${v}`)
							.join(", ") || "none"}
					</p>
				</Card>
				<Card>
					<CardTitle>Restricted pages</CardTitle>
					<CardDescription>What a deletion request or an email link opens. No settings and no shell.</CardDescription>
					<ul className="mt-4 flex flex-wrap gap-2">
						{[
							["/design/restricted/account-deletion?state=pending", "Account deletion"],
							["/design/restricted/workspace-deletion?state=pending", "Workspace deletion"],
							["/design/restricted/confirm-email?proof=valid", "Confirm email"],
						].map(([href, label]) => (
							<li key={href}>
								<Button variant="secondary" size="sm" onClick={() => router.push(href!)}>
									{label}
								</Button>
							</li>
						))}
					</ul>
				</Card>
			</div>
		</div>
	);
}
