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
import { useEffect, useRef, useState } from "react";
import { readOwnSuppression, restoreOwnSuppression } from "./actions.ts";
import { outcomeText, restoreText, type Outcome, type SuppressionReport } from "./model.ts";

type Notice = { text: string; tone: "alert" | "status" };

function useKeys() {
	const keys = useRef<Record<string, string>>({});
	return {
		take: (name: string) => (keys.current[name] ??= crypto.randomUUID()),
		settle(name: string, result: Outcome<unknown>) {
			if (result.status !== "lost") keys.current[name] = crypto.randomUUID();
		},
	};
}

export function Address() {
	const keys = useKeys();
	const reasonRef = useRef<HTMLInputElement>(null);
	const [report, setReport] = useState<SuppressionReport | null>(null);
	const [reason, setReason] = useState("");
	const [reasonError, setReasonError] = useState<string | undefined>();
	const [status, setStatus] = useState<string | null>(null);
	const [tone, setTone] = useState<Notice["tone"]>("status");
	const [pending, setPending] = useState(false);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let live = true;
		void readOwnSuppression().then((result) => {
			if (!live) return;
			setLoaded(true);
			if (result.status !== "ok") {
				setTone("alert");
				setStatus(outcomeText(result) ?? "Unable to read this address.");
				return;
			}
			setReport(result.value);
		});
		return () => {
			live = false;
		};
	}, []);

	const onRestore = () => {
		const trimmed = reason.trim();
		if (!trimmed) {
			setReasonError("Enter the reason for this restore.");
			reasonRef.current?.focus();
			return;
		}
		setPending(true);
		setReasonError(undefined);
		void restoreOwnSuppression(keys.take("restore"), trimmed).then((result) => {
			keys.settle("restore", result);
			setPending(false);
			if (result.status !== "ok") {
				setTone("alert");
				setStatus(outcomeText(result) ?? "Unable to restore this address.");
				return;
			}
			setTone("status");
			setStatus(restoreText(result.value));
			if (result.value.suppressionClears > 0) {
				setReport((current) => (current ? { ...current, active: false } : current));
				setReason("");
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
			<p className="text-sm text-text-2">
				Older clears are not listed here. This shows whether the address is suppressed now.
			</p>
			{loaded ? null : (
				<p role="status" className="text-md text-ink">
					Checking this address.
				</p>
			)}
			{status ? (
				<p role={tone} className={tone === "alert" ? "text-sm font-medium text-magenta-600" : "text-md text-ink"}>
					{status}
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
				</div>
			) : null}
		</Card>
	);
}
