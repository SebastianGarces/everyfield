"use client";

import type { PipelinePersonRecord } from "@everyfield/contracts/organizations";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardActions,
	CardBody,
	CardHeader,
	CardHeading,
	CardTitle,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Textarea,
} from "@everyfield/ui/controls";
import { useState, type FormEvent } from "react";
import { correctConversation, logConversation } from "./actions";
import { formatDay, refusalText } from "./model";
import { Problem } from "./Problem";

type Record = PipelinePersonRecord;
type Conversation = Record["conversations"][number];

/**
 * Leadership (“I see in you”) conversations with this person (REQ-MUL-009). Everyone who reads the record logs and
 * corrects them; only they read the notes, because the record's audience is the notes' audience. Logging is
 * human-only. Each correction stays in the conversation's history with the old and new day.
 */
export function ConversationsCard({ record, onChanged }: { record: Record; onChanged: () => Promise<void> }) {
	const [editing, setEditing] = useState<Conversation | "new" | null>(null);
	const live = !record.retired;
	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>Leadership conversations</CardTitle>
				</CardHeading>
				{live ? (
					<CardActions>
						<Button variant="secondary" size="sm" icon={PlusSignIcon} onClick={() => setEditing("new")}>
							Log conversation
						</Button>
					</CardActions>
				) : null}
			</CardHeader>
			<CardBody className="flex flex-col gap-4">
				<p className="text-sm text-text-2">
					Log each time someone on staff tells {record.name} what they see in them. All staff see the monthly counts.
					Only Owners, Admins and {record.name}’s responsible staff see these entries and notes, and notes never go to
					Evry.
				</p>
				{record.conversations.length ? (
					<ul className="flex flex-col gap-3">
						{record.conversations.map((c) => (
							<li key={c.id}>
								<Item conversation={c} onCorrect={live ? () => setEditing(c) : null} />
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-text-3">No conversations logged yet.</p>
				)}
			</CardBody>
			{live ? (
				<ConversationDialog
					open={editing !== null}
					onOpenChange={(open) => (open ? null : setEditing(null))}
					record={record}
					conversation={editing === "new" ? null : editing}
					onSaved={async () => {
						setEditing(null);
						await onChanged();
					}}
				/>
			) : null}
		</Card>
	);
}

function Item({ conversation: c, onCorrect }: { conversation: Conversation; onCorrect: (() => void) | null }) {
	return (
		<article className="flex flex-col gap-1.5 rounded-md bg-surface-2 px-3 py-2.5">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<span className="text-sm font-semibold text-ink">{formatDay(c.on)}</span>
				<span className="text-sm text-text-2">With {c.metBy ?? "former staff"}</span>
				{onCorrect ? (
					<Button variant="ghost" size="sm" className="ml-auto" onClick={onCorrect}>
						Correct
					</Button>
				) : null}
			</div>
			{c.note ? <p className="text-sm whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{c.note}</p> : null}
			<ol className="flex flex-col gap-0.5 text-xs text-text-3">
				<li>Logged {formatDay(c.loggedOn)}</li>
				{c.corrections.map((x) => (
					<li key={x.id}>
						{[
							x.dateFrom && x.dateTo ? `Date changed from ${formatDay(x.dateFrom)} to ${formatDay(x.dateTo)}` : null,
							x.noteChanged ? "Note edited" : null,
						]
							.filter(Boolean)
							.join(", ")}{" "}
						by {x.actor ?? "former staff"}, {formatDay(x.on)}
					</li>
				))}
			</ol>
		</article>
	);
}

function ConversationDialog({
	open,
	onOpenChange,
	...form
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	record: Record;
	conversation: Conversation | null;
	onSaved: () => Promise<void>;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm">{open ? <ConversationForm {...form} /> : null}</DialogContent>
		</Dialog>
	);
}

/** The day it happened (not after today) and an optional short note. Logging names the conversation's ID once. */
function ConversationForm({
	record,
	conversation,
	onSaved,
}: {
	record: Record;
	conversation: Conversation | null;
	onSaved: () => Promise<void>;
}) {
	const [conversationId] = useState(() => conversation?.id ?? crypto.randomUUID());
	const [on, setOn] = useState<string>(conversation?.on ?? record.asOf);
	const [note, setNote] = useState(conversation?.note ?? "");
	const [error, setError] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	async function submit(event: FormEvent) {
		event.preventDefault();
		const dayError = !on ? "Enter the date." : on > record.asOf ? "The date can’t be after today." : null;
		setError(dayError);
		if (dayError) return;
		setSaving(true);
		const values = { occurredOn: on, note: note.trim() || null };
		const answer = await (
			conversation
				? correctConversation({ conversationId, expectedRevision: conversation.revision, ...values })
				: logConversation({ conversationId, personId: record.personId, ...values })
		).catch(() => ({ status: "lost" as const }));
		setSaving(false);
		if (answer.status !== "ok") return setProblem(refusalText(answer));
		await onSaved();
	}
	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader
				title={conversation ? "Correct conversation" : "Log a leadership conversation"}
				description={
					conversation
						? "The history keeps the old date, the new date, who changed it and when."
						: `A conversation where you told ${record.name} what you see in them.`
				}
			/>
			<DialogBody className="flex flex-col gap-4">
				<Field label="Date it happened" error={error ?? undefined}>
					<Input type="date" value={on} max={record.asOf} onChange={(e) => setOn(e.target.value)} />
				</Field>
				<Field label="Note" optional hint={`Only Owners, Admins and ${record.name}’s responsible staff can read it.`}>
					<Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
				</Field>
				<Problem text={problem} />
			</DialogBody>
			<DialogFooter>
				<Button type="submit" variant="primary" loading={saving}>
					{conversation ? "Save" : "Log conversation"}
				</Button>
			</DialogFooter>
		</form>
	);
}
