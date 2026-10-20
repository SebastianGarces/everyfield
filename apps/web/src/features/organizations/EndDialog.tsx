"use client";

import { endRelationshipRequest } from "@everyfield/contracts/organizations";
import { Unlink01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTrigger,
	Field,
	Textarea,
} from "@everyfield/ui/controls";
import { useState, type ReactNode } from "react";
import { useIntent } from "./intent";
import { ProblemLine } from "./parts";
import type { ReadHistory } from "./History";
import type { Relationship } from "./port";

/** `subject`: the plant, sending church or Discovery account leaves. `organization`: the organization ends it. */
export type Side = "subject" | "organization";
type HistoryPage = Awaited<ReturnType<ReadHistory>>;
/** Ends one connection. The answer is the first history page as it is now, or null when nothing was ended. */
export type EndConnection = (command: ReturnType<typeof endRelationshipRequest.parse>) => Promise<HistoryPage | null>;

const REASON_LIMIT = 1000;

/**
 * Ending exactly one connection (REQ-IDN-021, REQ-IDN-027). Either side's Owner or Admin can end its own link. Other
 * connections stay. The reason is optional and goes to the connection history only.
 */
export function EndDialog({
	side,
	relationship,
	otherName,
	end,
	onEnded,
	trigger,
}: {
	side: Side;
	relationship: Relationship;
	/** The name of the other side of this connection. */
	otherName: string;
	end: EndConnection;
	/**
	 * After a committed end, with the history as it is now; after closing with an unconfirmed one, with null, and the
	 * list then loads again.
	 */
	onEnded: (history: HistoryPage | null) => void;
	trigger: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState("");
	const send = useIntent<ReturnType<typeof endRelationshipRequest.parse>>("relationship-end");
	const pending = send.pending !== null;
	const tooLong = reason.trim().length > REASON_LIMIT;

	const change = (next: boolean) => {
		if (pending) return;
		setOpen(next);
		if (!next) {
			if (send.held) onEnded(null);
			setReason("");
			send.release();
		}
	};

	const submit = async () => {
		if (tooLong) return;
		const text = reason.trim();
		const result = await send.run(
			"dialog",
			(requestKey) =>
				endRelationshipRequest.parse({
					requestKey,
					expectedRevision: relationship.revision,
					input: {
						relationshipId: relationship.id,
						pair: relationship.pair,
						confirmed: true,
						reason: text === "" ? null : text,
					},
				}),
			end,
			(history) => history !== null,
		);
		if (result.ok && result.reply) {
			change(false);
			onEnded(result.reply);
		}
	};

	const leaving = side === "subject";
	const consequences = leaving
		? [
				`${otherName} stops seeing anything your church shares, right away.`,
				"Your other connections do not change.",
				`Your sharing choices are kept. If you connect with ${otherName} again, they come back.`,
				`${otherName} gets a notice that the connection ended.`,
			]
		: [
				`You stop seeing anything ${otherName} shared, right away.`,
				`${otherName}'s other connections do not change.`,
				`${otherName} gets a notice that the connection ended.`,
			];

	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent size="sm" role="alertdialog">
				<DialogHeader
					icon={Unlink01Icon}
					tone="magenta"
					title={leaving ? `Leave ${otherName}?` : `End the connection with ${otherName}?`}
				/>
				<DialogBody>
					<ul className="flex flex-col gap-2 rounded-md bg-surface px-5 py-4 text-text-2">
						{consequences.map((c) => (
							<li key={c} className="flex gap-2.5">
								<span aria-hidden="true" className="mt-[9px] size-1.5 flex-none rounded-full bg-text-3" />
								{c}
							</li>
						))}
					</ul>
					<Field
						label="Reason"
						optional
						className="mt-5"
						hint="Kept in the connection history. Members do not see it."
						error={tooLong ? `Use ${REASON_LIMIT.toLocaleString("en-US")} characters or fewer.` : undefined}
					>
						<Textarea
							value={reason}
							readOnly={send.held !== null}
							onChange={(e) => setReason(e.target.value)}
							invalid={tooLong}
							rows={3}
						/>
					</Field>
					<ProblemLine
						problem={send.problem}
						refused="The connection did not end. It may have changed or ended already. Close this and check the list again."
					/>
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={() => change(false)} disabled={pending}>
						{send.held ? "Close" : "Cancel"}
					</Button>
					<Button variant="danger" onClick={submit} loading={pending}>
						{send.held ? "Try again" : leaving ? "Leave" : "End connection"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
