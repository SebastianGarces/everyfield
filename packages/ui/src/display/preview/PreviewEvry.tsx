"use client";

import { Calendar03Icon, Link01Icon, Notification01Icon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { Button } from "../../controls";
import { EvryBot } from "../../foundations";
import {
	Avatar,
	Cite,
	EvryComposer,
	EvryMessage,
	EvryPanel,
	EvryThinking,
	List,
	ListRow,
	ReviewActions,
	ReviewCard,
	StatusBadge,
	Tag,
} from "..";
import { Grid, Section } from "./kit";

export function EvrySection({ index }: { index: number }) {
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<"chat" | "history">("chat");
	const [asked, setAsked] = useState<string[]>([]);
	const [approving, setApproving] = useState(false);
	return (
		<Section
			index={index}
			title="Evry"
			code="<EvryPanel> <EvryMessage> <Cite> <ReviewCard state> <ReviewActions>"
			note="Every change Evry prepares waits for your approval of the exact revision shown. Editing makes a new revision and cancels approval of the old one."
		>
			<Grid cols={4}>
				<ReviewCard
					state="revised"
					title="Review 2 changes"
					meta="Revision 2"
					note="Revision 1 was replaced because you changed the due date."
					lines={[
						{
							content: (
								<>
									Assign <b>Call Kim Wu</b> to <b>Tom</b>, due <b>Oct 10</b>
								</>
							),
						},
						{
							content: (
								<>
									Assign <b>Call Sara Nunez</b> to <b>Ana</b>, due <b>Oct 10</b>
								</>
							),
						},
					]}
					actions={
						<ReviewActions
							revision={2}
							approving={approving}
							onApprove={() => {
								setApproving(true);
								setTimeout(() => setApproving(false), 1500);
							}}
							onEdit={() => undefined}
							onCancel={() => undefined}
						/>
					}
				/>
				<ReviewCard
					state="approved"
					title="Saved"
					meta="9:14 am"
					lines={[
						{ content: "Call Kim Wu assigned to Tom", result: "saved" },
						{ content: "Call Sara Nunez assigned to Ana", result: "saved" },
					]}
					footnote="Approved by Daniel"
					actions={
						<Button variant="ghost" size="sm">
							View tasks
						</Button>
					}
				/>
				<ReviewCard
					state="failed"
					title="1 of 2 not saved"
					lines={[
						{ content: "Call Kim Wu assigned to Tom", result: "saved" },
						{ content: "Ana Lee no longer has a seat, so the second task was not assigned.", result: "failed" },
					]}
					actions={
						<Button variant="secondary" size="sm">
							Choose someone else
						</Button>
					}
				/>
				<ReviewCard
					state="expired"
					title="Expired"
					note="The guest list changed after this was prepared. Nothing was saved."
					lines={[{ content: "Assign 3 follow-ups" }]}
					actions={
						<Button variant="secondary" size="sm">
							Prepare again
						</Button>
					}
				/>
			</Grid>
			<div className="mt-5 flex flex-wrap items-center gap-3">
				<Button variant="secondary" onClick={() => setOpen(true)}>
					<EvryBot size="sm" />
					Ask Evry
				</Button>
				<span className="text-sm text-text-3">Opens the companion panel. Esc closes it and returns focus here.</span>
			</div>
			<EvryPanel
				open={open}
				onOpenChange={setOpen}
				view={view}
				onViewChange={setView}
				mood={asked.length ? "thinking" : "idle"}
				context={
					<>
						<Tag icon={Calendar03Icon}>Vision meeting #11</Tag>
						<Tag icon={UserMultipleIcon}>9 first-timers</Tag>
						<Tag tone="green" icon={Link01Icon}>
							Page context on
						</Tag>
					</>
				}
				suggestions={["Draft a thank-you email", "Who is ready to interview?", "Summarize this week"]}
				onSuggest={(s) => setAsked((a) => [...a, s])}
				composer={<EvryComposer onSend={(t) => setAsked((a) => [...a, t])} />}
				history={
					<List>
						<ListRow
							title="Who still needs a follow-up?"
							subtitle="Now · 2 changes waiting for review"
							onClick={() => setView("chat")}
							trailing={
								<StatusBadge status="attention" size="sm">
									Review
								</StatusBadge>
							}
						/>
						<ListRow
							title="Draft thank-you email for meeting #11"
							subtitle="Sep 30 · email sent to 9 people"
							trailing={
								<StatusBadge status="positive" size="sm">
									Approved
								</StatusBadge>
							}
						/>
					</List>
				}
			>
				<EvryMessage role="user">Who from last Sunday still needs a follow-up?</EvryMessage>
				<EvryMessage role="evry">
					Three of the nine first-timers have no call yet: <b>Kim Wu</b>, <b>Eli Park</b> and <b>Sara Nunez</b>. The
					48-hour window closes tomorrow at 8 pm <Cite href="#attendance">Attendance · #11</Cite>.
					<div className="mt-3 flex flex-col gap-3 rounded-md bg-surface-2 px-3.5 py-3">
						{[
							["Kim Wu", "Invited by Tom · no owner", "magenta"],
							["Sara Nunez", "No owner", "blue"],
						].map(([n, m, t]) => (
							<div key={n} className="flex items-center gap-3">
								<Avatar name={n!} tone={t as "blue"} size="sm" decorative />
								<div className="min-w-0 flex-1">
									<div className="font-medium text-ink">{n}</div>
									<div className="text-xs text-text-3">{m}</div>
								</div>
								<StatusBadge status="risk" size="sm">
									22 h
								</StatusBadge>
							</div>
						))}
					</div>
				</EvryMessage>
				<EvryMessage role="user">Yes. Give Sara to Ana.</EvryMessage>
				<EvryMessage role="evry" mood="happy">
					Here is the change. Nothing is saved until you approve it.
					<ReviewCard
						className="mt-3"
						state="pending"
						title="Review 2 changes"
						meta="Revision 1"
						lines={[
							{
								content: (
									<>
										Assign follow-up <b>Call Kim Wu</b> to <b>Tom Baker</b>
									</>
								),
							},
							{
								content: (
									<>
										Assign follow-up <b>Call Sara Nunez</b> to <b>Ana Lee</b>
									</>
								),
							},
							{ content: "Tom and Ana get a notification.", icon: Notification01Icon, muted: true },
						]}
						actions={
							<ReviewActions
								revision={1}
								onApprove={() => undefined}
								onEdit={() => undefined}
								onCancel={() => undefined}
							/>
						}
					/>
				</EvryMessage>
				{asked.map((q, i) => (
					<EvryMessage key={i} role="user">
						{q}
					</EvryMessage>
				))}
				{asked.length ? <EvryThinking /> : null}
			</EvryPanel>
		</Section>
	);
}
