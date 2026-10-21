"use client";

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { ConfirmEmailScreen } from "../restricted/ConfirmEmailScreen";
import { DeletionStatusScreen } from "../restricted/DeletionStatusScreen";
import { confirmFixtureEmail, createDeletionPort, DELETION_SCENARIOS, type DeletionScenario } from "./fixtures";

import type { RestrictedFlow } from "./flows";

/**
 * The restricted pages at /design/restricted/[flow]. `state` picks a deletion scenario (pending, late, skew, purging,
 * purged, cancelled); `step=proof` starts signed out, asking for the email and password ("correct horse"), and `until`
 * is the deadline a request just returned; `proof` picks the email link (valid, expired, unknown).
 */
export function RestrictedPreview({ flow }: { flow: RestrictedFlow }) {
	const search = useSearchParams();
	const raw = search.get("state") ?? "pending";
	const scenario: DeletionScenario = (DELETION_SCENARIOS as readonly string[]).includes(raw)
		? (raw as DeletionScenario)
		: "pending";
	const signedOut = flow === "account-deletion" && search.get("step") === "proof";
	const port = useMemo(
		() => createDeletionPort(flow === "account-deletion" ? "account" : "plant", scenario, { signedOut }),
		[flow, scenario, signedOut],
	);
	const initial = useMemo(() => (signedOut ? null : port.getStatus()), [port, signedOut]);

	if (flow === "confirm-email")
		return (
			<ConfirmEmailScreen
				proof={search.get("proof") ?? "valid"}
				confirm={confirmFixtureEmail}
				accountHref="/design/settings/account?as=admin"
			/>
		);
	return (
		<DeletionStatusScreen
			key={`${flow}-${scenario}`}
			subject={
				flow === "account-deletion" ? { kind: "account" } : { kind: "workspace", churchName: "Harvest Point Church" }
			}
			port={port}
			initial={initial}
			requestedUntil={search.get("until")}
			now={Date.now}
			zone="America/Chicago"
			signInHref="/design/settings?as=admin"
		/>
	);
}
