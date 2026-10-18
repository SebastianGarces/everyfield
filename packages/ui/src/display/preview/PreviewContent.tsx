"use client";

import { Add01Icon, Calendar03Icon, Edit02Icon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { Button } from "../../controls";
import {
	FaqList,
	HowToSteps,
	InsertHint,
	KeyValue,
	KeyValueList,
	Prose,
	RevisionList,
	SetupChecklist,
	Toc,
	UiRef,
	useActiveHeading,
	WikiEditor,
	WikiSourceBar,
	WikiTree,
	type EditorCommand,
} from "..";
import { FAQ, SOURCES, WIKI_PHASES } from "./fixtures";
import { Grid, Section, Specimen } from "./kit";

const HEADINGS = [
	{ id: "w-before", label: "Before the meeting" },
	{ id: "w-during", label: "During the meeting" },
	{ id: "w-cards", label: "Response cards", level: 3 as const },
	{ id: "w-after", label: "After the meeting" },
];

export function ContentSection({ index }: { index: number }) {
	const [source, setSource] = useState("asn");
	const [title, setTitle] = useState("Run your first vision meeting");
	const [active, setActive] = useState<EditorCommand[]>(["bold"]);
	const current = useActiveHeading(HEADINGS.map((h) => h.id));
	const toggle = (cmd: EditorCommand) => setActive((a) => (a.includes(cmd) ? a.filter((c) => c !== cmd) : [...a, cmd]));
	return (
		<Section
			index={index}
			title="Content"
			code="<SetupChecklist> <HowTo.Steps> <Faq> <WikiTree> <Toc> <Prose> <WikiSourceBar> <WikiEditor>"
			note="Reading and setup parts for the Wiki, Help and first-week screens. The editor is the frame; the editing engine comes from the editor contract."
		>
			<Grid cols={2}>
				<Specimen title="Your first week" description="2 of 5 done">
					<SetupChecklist
						label="First-week setup"
						steps={[
							{ title: "Create Harvest Point Church", done: true },
							{ title: "Choose your phase and launch target", done: true },
							{
								title: "Add the people you already know",
								hint: "Import a spreadsheet or add them one by one.",
								done: false,
								action: (
									<Button variant="primary" size="sm">
										Import
									</Button>
								),
							},
							{
								title: "Plan your first vision meeting",
								hint: "The Playbook suggests one every 14 days.",
								done: false,
								action: (
									<Button variant="secondary" size="sm">
										Plan
									</Button>
								),
							},
						]}
					/>
				</Specimen>
				<Specimen title="Questions people ask">
					<FaqList items={FAQ} defaultOpen={["wiki-help"]} />
				</Specimen>
				<Specimen title="Record attendance at the door" className="col-span-full">
					<HowToSteps
						steps={[
							{
								title: "Open the meeting.",
								body: (
									<>
										Go to <UiRef icon={Calendar03Icon}>Meetings</UiRef> and choose today&apos;s meeting.
									</>
								),
							},
							{
								title: "Start check-in.",
								body: (
									<>
										Press <UiRef>Start check-in</UiRef>. On a phone, the list fills the screen.
									</>
								),
							},
							{
								title: "Add a first-time guest.",
								body: (
									<>
										Press <UiRef icon={Add01Icon}>New guest</UiRef>, type a name and an email or phone.
									</>
								),
							},
						]}
					/>
				</Specimen>
			</Grid>
			<WikiSourceBar
				className="mt-5"
				sources={SOURCES}
				currentId={source}
				preferredId="asn"
				onChoose={setSource}
				settingsHref="#settings-sharing"
				admin={
					<>
						<Button variant="ghost" size="sm" icon={ViewOffIcon}>
							Hide
						</Button>
						<Button variant="secondary" size="sm" icon={Edit02Icon}>
							Edit
						</Button>
					</>
				}
			/>
			<div className="mt-5 grid grid-cols-[250px_minmax(0,1fr)_240px] items-start gap-5 max-app-lg:grid-cols-[220px_minmax(0,1fr)] max-app-md:grid-cols-1">
				<Specimen className="px-2.5 py-3.5 max-app-sm:px-2.5">
					<WikiTree phases={WIKI_PHASES} currentId="first" />
				</Specimen>
				<Specimen className="px-11 py-9 max-app-sm:px-5 max-app-sm:py-6">
					<Prose>
						<p className="text-lg text-ink">
							A vision meeting is a short, warm gathering where you share why this church should exist.
						</p>
						<h2 id="w-before">Before the meeting</h2>
						<p>Pick a home with room for about 40 adults. Ask two or three core members to host with you.</p>
						<ul>
							<li>Print response cards and a guest sign-in sheet.</li>
							<li>Plan childcare so parents can listen.</li>
						</ul>
						<h2 id="w-during">During the meeting</h2>
						<p>Tell the story of the place and the people you hope to reach. Leave time for questions.</p>
						<blockquote>
							“Where there is no vision, the people perish.”<cite>Proverbs 29:18</cite>
						</blockquote>
						<h3 id="w-cards">Response cards</h3>
						<p>Close by handing out response cards.</p>
						<h2 id="w-after">After the meeting</h2>
						<p>
							Call every first-time guest within 48 hours. Everyfield creates these follow-ups when you{" "}
							<a href="#finalize">finalize attendance</a>.
						</p>
					</Prose>
				</Specimen>
				<Specimen className="max-app-lg:hidden">
					<Toc items={HEADINGS} current={current} />
				</Specimen>
			</div>
			<WikiEditor
				className="mt-5"
				title={title}
				onTitleChange={setTitle}
				blockLabel="Heading 2"
				active={active}
				disabled={["redo"]}
				onCommand={toggle}
				aside={
					<>
						<Specimen title="Version" className="px-[22px] py-5">
							<KeyValueList>
								<KeyValue k="Based on" value="Everyfield global v4" size="sm" />
								<KeyValue k="Your edits" value="2 changed · 1 added" size="sm" />
							</KeyValueList>
						</Specimen>
						<Specimen title="History" className="px-[22px] py-5">
							<RevisionList
								revisions={[
									{ id: "d", title: "Draft", meta: "Ruth Allen · now", state: "draft" },
									{
										id: "3",
										title: "Version 3",
										meta: "Ruth Allen · Sep 12 · published",
										state: "current",
										action: (
											<a href="#v3" className="text-xs underline">
												View
											</a>
										),
									},
									{ id: "2", title: "Version 2", meta: "Marcus Hill · Aug 3" },
								]}
							/>
						</Specimen>
					</>
				}
			>
				<div
					contentEditable
					suppressContentEditableWarning
					aria-label="Article body"
					role="textbox"
					aria-multiline="true"
					className="outline-none"
				>
					<p className="text-lg text-ink">
						A vision meeting is a short, warm gathering where you share why this church should exist.
					</p>
					<h2>Before the meeting</h2>
					<p data-change="changed">
						Pick a home with room for about 40 adults. In Austin, many plants use a school cafeteria instead.
					</p>
					<h2 data-change="added">Childcare checklist for network plants</h2>
					<ul data-change="added">
						<li>Two trusted adults in every room, never one alone.</li>
						<li>A sign-in sheet with a parent phone number.</li>
					</ul>
					<InsertHint />
				</div>
			</WikiEditor>
		</Section>
	);
}
