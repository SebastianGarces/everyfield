"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ConfirmEmailScreen } from "../restricted/ConfirmEmailScreen";
import { DeletionStatusScreen } from "../restricted/DeletionStatusScreen";
import { confirmFixtureEmail, createDeletionPort, DELETION_SCENARIOS, type DeletionScenario } from "./fixtures";
import type { RestrictedFlow } from "./flows";
import { createReplies, type Replies } from "./replies";
import { RepliesControl } from "./RepliesControl";

export function RestrictedPreview({ flow }: { flow: RestrictedFlow }) {
	const search = useSearchParams();
	const raw = search.get("state") ?? "pending";
	const scenario: DeletionScenario = (DELETION_SCENARIOS as readonly string[]).includes(raw)
		? (raw as DeletionScenario)
		: "pending";
	const signedOut = flow === "account-deletion" && search.get("step") === "proof";
	const [replies] = useState(() => createReplies(search.get("hold") === "1"));

	return (
		<>
			{search.get("hold") === "1" ? (
				<div className="fixed top-3 right-3 z-10">
					<RepliesControl replies={replies} />
				</div>
			) : null}
			{flow === "confirm-email" ? (
				<ConfirmEmailScreen
					proof={search.get("proof") ?? "valid"}
					confirm={confirmFixtureEmail(replies)}
					accountHref="/design/settings/account?as=admin"
				/>
			) : (
				<DeletionPreview
					key={`${flow}-${scenario}-${signedOut}`}
					flow={flow}
					scenario={scenario}
					signedOut={signedOut}
					requestedUntil={search.get("until")}
					replies={replies}
				/>
			)}
		</>
	);
}

function DeletionPreview({
	flow,
	scenario,
	signedOut,
	requestedUntil,
	replies,
}: {
	flow: Exclude<RestrictedFlow, "confirm-email">;
	scenario: DeletionScenario;
	signedOut: boolean;
	requestedUntil: string | null;
	replies: Replies;
}) {
	const [port] = useState(() =>
		createDeletionPort(flow === "account-deletion" ? "account" : "plant", scenario, { signedOut, replies }),
	);
	const [initial] = useState(() => (signedOut ? null : port.getStatus()));
	return (
		<DeletionStatusScreen
			subject={
				flow === "account-deletion" ? { kind: "account" } : { kind: "workspace", churchName: "Harvest Point Church" }
			}
			port={port}
			initial={initial}
			requestedUntil={requestedUntil}
			now={Date.now}
			zone="America/Chicago"
			signInHref="/design/settings?as=admin"
		/>
	);
}
