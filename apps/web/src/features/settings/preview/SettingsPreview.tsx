"use client";

import { Button, Card, CardDescription, CardTitle, Select } from "@everyfield/ui/controls";
import { ShellPreview } from "@everyfield/ui/shell/preview";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { offeredSections, parseSectionKey, SECTION_LABEL } from "../model";
import type { DeletionStatus, SectionKey } from "../port";
import { SettingsDialog } from "../SettingsDialog";
import { SharingSection } from "../sections/SharingSection";
import { SettingsProvider } from "../store";
import {
	createFixturePort,
	parsePersona,
	PERSONA_LABEL,
	PERSONAS,
	PREVIEW_RELATIONSHIPS,
	previewViewer,
	type Fault,
	type Operation,
	type PreviewPersona,
} from "./fixtures";

const BASE = "/design/settings";

/**
 * The settings design preview at /design/settings/[section]?as=<persona>. The page underneath is a placeholder inside
 * the app shell; Settings opens over it as the real app does. `as` picks the persona, `delay` the reply time in
 * milliseconds and `fail=<operation>:<code>` makes the first call of that operation fail. Every reply comes from the
 * fixture API, parsed by the settings contract.
 */
export function SettingsPreview() {
	const params = useParams<{ section?: string[] }>();
	const search = useSearchParams();
	const router = useRouter();
	const persona = parsePersona(search.get("as"));
	const delay = Number(search.get("delay") ?? 450);
	const section = parseSectionKey(params.section?.[0]);
	const query = (extra = "") => `?as=${persona}${search.get("delay") ? `&delay=${delay}` : ""}${extra}`;
	const hrefFor = (key: SectionKey) => `${BASE}/${key}${query()}`;

	// One fixture API per persona and load: switching persona is switching account, so nothing carries over.
	const fixture = useMemo(() => createFixturePort(persona, { delay }), [persona, delay]);
	useEffect(() => {
		for (const spec of search.getAll("fail")) {
			const [op, code] = spec.split(":");
			if (op && code) fixture.controls.failNext(op as Operation, code as Fault);
		}
		const hooks = window as unknown as { __settingsFixture?: unknown; __settingsNavigate?: (href: string) => void };
		hooks.__settingsFixture = fixture.controls;
		// A client-side navigation the browser tests use to switch persona while settings is open.
		hooks.__settingsNavigate = (href) => router.push(href, { scroll: false });
		// Faults from the URL apply once per fixture.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fixture]);

	const viewer = previewViewer(persona);
	const navigate = (key: SectionKey | null) => router.push(key ? hrefFor(key) : `${BASE}${query()}`, { scroll: false });
	// As in the product: a workspace request opens its status; an account request is signed out and asks for proof.
	const deleted = (status: DeletionStatus | null) => {
		if (status && "subject" in status && status.subject.kind === "plant")
			return router.push("/design/restricted/workspace-deletion?state=pending");
		const until = status?.status === "pending_deletion" ? `&until=${encodeURIComponent(status.cancelUntil)}` : "";
		router.push(`/design/restricted/account-deletion?state=pending&step=proof${until}`);
	};

	return (
		<ShellPreview role={persona === "member" ? "member" : "owner"}>
			<SettingsProvider key={`${persona}-${delay}`} port={fixture.port} viewer={viewer}>
				<PreviewPage persona={persona} query={query} fixture={fixture.controls} />
				<SettingsDialog
					section={section}
					onNavigate={navigate}
					hrefFor={hrefFor}
					slots={{ sharing: <SharingSection relationships={PREVIEW_RELATIONSHIPS} /> }}
					onDeletionRequested={deleted}
				/>
			</SettingsProvider>
		</ShellPreview>
	);
}

const FAULTS: { value: string; label: string }[] = [
	{ value: "none", label: "Every call succeeds" },
	{ value: "saveSection:conflict", label: "Next save: someone else changed it" },
	{ value: "saveSection:temporary", label: "Next save: temporary failure" },
	{ value: "saveSection:offline", label: "Next save: connection lost" },
	{ value: "getSection:temporary", label: "Next section load fails" },
	{ value: "setPlantTimezone:stale_preview", label: "Next time zone save: preview out of date" },
	{ value: "finalizeAvatar:temporary", label: "Next photo save fails" },
	{ value: "requestEmailChange:temporary", label: "Next email link: too many requests" },
	{ value: "changePassword:unknown", label: "Next password change: outcome unknown" },
];

function PreviewPage({
	persona,
	query,
	fixture,
}: {
	persona: PreviewPersona;
	query: (extra?: string) => string;
	fixture: ReturnType<typeof createFixturePort>["controls"];
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
							className="w-[340px] max-w-full"
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
