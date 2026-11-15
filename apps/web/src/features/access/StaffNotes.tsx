"use client";

import { LockKeyIcon, Note01Icon, RefreshIcon, UserRemove01Icon } from "@hugeicons/core-free-icons";
import type { OrganizationNotesResult, PipelineAccessResult } from "@everyfield/contracts/access";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	EmptyState,
	Skeleton,
	StatePanel,
} from "@everyfield/ui/controls";
import { Avatar, Tag } from "@everyfield/ui/display";
import { cn, Icon, observeSize, useFocusRequest } from "@everyfield/ui/foundations";
import { useId, useMemo, useState } from "react";
import { createRead, useRead } from "../../components/read.tsx";
import { NotAvailable } from "./AccessStates";
import { DUTY_LABEL, type AllowedNotes, type ReadNotes } from "./port";

type Note = AllowedNotes["notes"][number];
type FirstPage = OrganizationNotesResult | { status: "failed" };
type More = { pages: AllowedNotes[]; status: "idle" | "loading" | "failed" | "unavailable" };

/**
 * The viewer's own duties for one pipeline person (pipelineAccess.readPerson, REQ-MUL-002). It names only the
 * viewer's duties, which the viewer already holds; it never lists other staff.
 */
export function PersonDuties({ access, personName }: { access: PipelineAccessResult; personName: string }) {
	if (access.status !== "allowed") return null;
	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className="text-sm text-text-3">Your role with {personName}</span>
			<ul className="flex flex-wrap gap-1.5" aria-label={`Your role with ${personName}`}>
				{access.duties.map((duty) => (
					<li key={duty.kind}>
						<Tag>{DUTY_LABEL[duty.kind]}</Tag>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Protected staff notes for one organization person (orgPeople.readNotes, REQ-MUL-002). Render it only when
 * `canReadStaffNotes` is true. It reads pages from the server and never keeps a note on screen after the server
 * stops allowing it: an `unavailable` page replaces every note already shown.
 */
export function StaffNotesPanel({
	personName,
	read,
	authorName,
	zone,
}: {
	personName: string;
	read: ReadNotes;
	/** The display name of a note's author account, from the consumer's own directory read (WP-006/ui R6). */
	authorName: (accountId: string) => string;
	/** The organization's time zone, for note times. */
	zone: string;
}) {
	const [{ read: readPage, first }] = useState(() => ({
		read,
		first: createRead<[null], FirstPage>(read, { failed: () => ({ status: "failed" }) }),
	}));
	const page = useRead(first, null);
	const [more, setMore] = useState<More>({ pages: [], status: "idle" });
	const [announce, setAnnounce] = useState("");
	const titleId = useId();

	const opening = page.value?.status === "allowed" ? page.value : null;
	const last = more.pages.at(-1) ?? opening;
	const notes = opening ? [...opening.notes, ...more.pages.flatMap((p) => p.notes)] : [];
	const newest = more.pages.at(-1)?.notes[0]?.id ?? null;
	const view =
		page.value === undefined
			? "loading"
			: page.value.status === "failed"
				? "failed"
				: page.value.status !== "allowed" || more.status === "unavailable"
					? "unavailable"
					: "shown";

	async function loadMore() {
		if (!last?.next || more.status === "loading") return;
		const after = last.next;
		setMore((m) => ({ ...m, status: "loading" }));
		try {
			const next = await readPage(after);
			if (next.status !== "allowed") return setMore((m) => ({ ...m, status: "unavailable" }));
			setMore((m) => ({ pages: [...m.pages, next], status: "idle" }));
			setAnnounce(next.notes.length === 1 ? "1 more note loaded." : `${next.notes.length} more notes loaded.`);
		} catch {
			setMore((m) => ({ ...m, status: "failed" }));
		}
	}

	return (
		<Card as="section" aria-labelledby={titleId}>
			<CardHeader>
				<CardHeading>
					<div className="flex flex-wrap items-center gap-2.5">
						<CardTitle id={titleId} size="sm">
							Staff notes
						</CardTitle>
						<span className="inline-flex h-[26px] items-center gap-1.5 rounded-pill bg-violet-100 px-2.5 text-[13px] font-semibold text-violet-600">
							<Icon icon={LockKeyIcon} size={16} className="size-3.5" />
							Staff only
						</span>
					</div>
					<CardDescription className="max-w-[60ch] text-pretty">
						Your organization’s administrators and {personName}’s responsible staff can read these. {personName},
						program directors and Evry cannot.
					</CardDescription>
				</CardHeading>
			</CardHeader>

			{view === "loading" ? (
				<div aria-busy="true" className="flex flex-col gap-5">
					<span className="sr-only">Loading staff notes…</span>
					{[0, 1].map((i) => (
						<div key={i} className="flex gap-3">
							<Skeleton shape="circle" width={32} height={32} />
							<div className="flex flex-1 flex-col gap-2">
								<Skeleton width="38%" />
								<Skeleton width="92%" />
								<Skeleton width="70%" />
							</div>
						</div>
					))}
				</div>
			) : view === "failed" ? (
				<StatePanel
					tone="error"
					title="We could not load the staff notes"
					headingLevel="h3"
					className="py-10"
					actions={
						<Button variant="secondary" icon={RefreshIcon} onClick={page.retry}>
							Try again
						</Button>
					}
				>
					This is a loading problem. No note was changed.
				</StatePanel>
			) : view === "unavailable" ? (
				<NotAvailable scope="section" />
			) : notes.length === 0 ? (
				<EmptyState icon={Note01Icon} title="No staff notes yet">
					Notes your staff write about {personName} will show here.
				</EmptyState>
			) : (
				<>
					<ol aria-labelledby={titleId} className="flex flex-col divide-y divide-line">
						{notes.map((note) => (
							<NoteRow
								key={note.id}
								note={note}
								authorName={authorName}
								zone={zone}
								focusRequest={note.id === newest ? newest : null}
							/>
						))}
					</ol>
					{last?.next || more.status === "failed" ? (
						<div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
							<Button variant="secondary" loading={more.status === "loading"} onClick={() => void loadMore()}>
								{more.status === "failed" ? "Try again" : "Show more notes"}
							</Button>
							{more.status === "failed" ? (
								<p role="alert" className="text-sm text-magenta-600">
									We could not load more notes. The notes above are still current.
								</p>
							) : null}
						</div>
					) : null}
				</>
			)}
			<p aria-live="polite" className="sr-only">
				{announce}
			</p>
		</Card>
	);
}

function NoteRow({
	note,
	authorName,
	zone,
	focusRequest,
}: {
	note: Note;
	authorName: (id: string) => string;
	zone: string;
	focusRequest: string | null;
}) {
	const [open, setOpen] = useState(false);
	const [clipped, setClipped] = useState(false);
	const bodyId = useId();
	const focusRef = useFocusRequest<HTMLLIElement>(focusRequest);
	const measure = useMemo(
		() =>
			open ? undefined : observeSize<HTMLParagraphElement>((el) => setClipped(el.scrollHeight > el.clientHeight + 1)),
		[open],
	);
	const name = note.author.kind === "account" ? authorName(note.author.accountId) : "Removed account";
	return (
		<li
			ref={focusRef}
			data-note={note.id}
			tabIndex={-1}
			className="flex gap-3 py-4 first:pt-0 last:pb-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
		>
			<Avatar name={name} size="sm" tone={note.author.kind === "account" ? "green" : "ink"} decorative>
				{note.author.kind === "removed" ? <Icon icon={UserRemove01Icon} size={16} /> : undefined}
			</Avatar>
			<div className="min-w-0 flex-1">
				<p className="text-sm">
					<span className="font-semibold text-ink">{name}</span>
					<span className="text-text-3">
						{" · "}
						<time dateTime={note.occurredAt}>{formatWhen(note.occurredAt, zone)}</time>
					</span>
				</p>
				<p
					ref={measure}
					id={bodyId}
					className={cn("mt-1 whitespace-pre-line break-words text-text-2 text-pretty", !open && "line-clamp-6")}
				>
					{note.body}
				</p>
				{clipped || open ? (
					<button
						type="button"
						aria-expanded={open}
						aria-controls={bodyId}
						onClick={() => setOpen((o) => !o)}
						className="mt-1.5 rounded-md text-sm font-semibold text-ink underline-offset-4 hover:underline"
					>
						{open ? "Show less" : "Show the whole note"}
					</button>
				) : null}
			</div>
		</li>
	);
}

function formatWhen(instant: string, zone: string): string {
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: zone,
	}).format(new Date(instant));
}
