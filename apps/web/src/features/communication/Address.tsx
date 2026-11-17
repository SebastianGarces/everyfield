"use client";

import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Field,
	Input,
} from "@everyfield/ui/controls";
import { useRef, useState, useTransition } from "react";
import { createRead, useRead } from "../../components/read.tsx";
import { readOwnSuppression, restoreOwnSuppression } from "./actions.ts";
import { outcomeText, restoreText, type Outcome, type RestoreReport, type SuppressionReport } from "./model.ts";

const lost = <T,>(): Outcome<T> => ({ status: "lost" });
import { useKeys } from "./useKeys.ts";

type Notice = { text: string; tone: "alert" | "status" };

export const ownSuppression = createRead(() => readOwnSuppression(), {
	failed: (): Outcome<SuppressionReport> => ({ status: "lost" }),
});

export function Address() {
	const keys = useKeys();
	const reasonRef = useRef<HTMLInputElement>(null);
	const read = useRead(ownSuppression);
	const [reason, setReason] = useState("");
	const [reasonError, setReasonError] = useState<string | undefined>();
	const [restored, setRestored] = useState<Notice | null>(null);
	const [pending, start] = useTransition();
	const loaded = read.value !== undefined;
	const report = read.value?.status === "ok" ? read.value.value : null;
	const notice: Notice | null =
		restored ??
		(read.value && read.value.status !== "ok"
			? { text: outcomeText(read.value) ?? "Unable to read this address.", tone: "alert" }
			: null);

	const onRestore = () => {
		const trimmed = reason.trim();
		if (!trimmed) {
			setReasonError("Enter the reason for this restore.");
			reasonRef.current?.focus();
			return;
		}
		setReasonError(undefined);
		start(async () => {
			const result = await restoreOwnSuppression(keys.take("restore"), trimmed).catch(lost<RestoreReport>);
			keys.settle("restore", result);
			if (result.status !== "ok") {
				setRestored({ text: outcomeText(result) ?? "Unable to restore this address.", tone: "alert" });
				return;
			}
			setRestored({ text: restoreText(result.value), tone: "status" });
			if (result.value.suppressionClears > 0) {
				ownSuppression.patch((current) =>
					current.status === "ok" ? { ...current, value: { ...current.value, active: false } } : current,
				);
				setReason("");
				void readOwnSuppression()
					.catch(lost<SuppressionReport>)
					.then((fresh) => {
						if (fresh.status === "ok") ownSuppression.patch(() => fresh);
					});
			}
		});
	};

	return (
		<Card as="section" className="flex flex-col gap-4">
			<CardHeader>
				<CardHeading>
					<CardTitle>Your address</CardTitle>
					<CardDescription>Only the verified email on this account can be restored.</CardDescription>
				</CardHeading>
			</CardHeader>
			{loaded ? null : (
				<p role="status" className="text-md text-ink">
					Checking this address.
				</p>
			)}
			{notice ? (
				<p
					role={notice.tone}
					className={notice.tone === "alert" ? "text-sm font-medium text-magenta-600" : "text-md text-ink"}
				>
					{notice.text}
				</p>
			) : null}
			{report ? (
				<div className="flex flex-col gap-4">
					<p className="text-md text-ink">{report.address}</p>
					<p className="text-md text-ink">
						{report.active
							? "This address is suppressed. It does not receive church email."
							: "This address is not suppressed. It can receive church email."}
					</p>
					{report.active ? (
						<div className="flex flex-col gap-4">
							<Field label="Reason" hint="Say why this address should receive email again." error={reasonError}>
								<Input
									ref={reasonRef}
									value={reason}
									maxLength={500}
									onChange={(event) => {
										setReason(event.target.value);
										setReasonError(undefined);
									}}
								/>
							</Field>
							<Button variant="primary" onClick={onRestore} loading={pending} disabled={pending}>
								Restore this address
							</Button>
						</div>
					) : null}
					<section aria-labelledby="restores-title" className="flex flex-col gap-3">
						<h3 id="restores-title" className="text-sm font-medium text-ink-2">
							Past restores
						</h3>
						{report.restores.length === 0 ? (
							<p className="text-sm text-text-2">This address has not been restored before.</p>
						) : (
							<ol className="flex flex-col gap-3">
								{report.restores.map((restore) => (
									<li key={restore.at} className="flex flex-col gap-0.5 rounded-md bg-surface px-4 py-3">
										<p className="text-sm text-text-2">
											<time dateTime={restore.at}>{restoredOn(restore.at)}</time> · Restored by{" "}
											{restore.actorName ?? "a person with no name on record"}
										</p>
										<p className="text-md text-ink">{restore.reason}</p>
									</li>
								))}
							</ol>
						)}
					</section>
				</div>
			) : null}
		</Card>
	);
}

function restoredOn(iso: string): string {
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}
