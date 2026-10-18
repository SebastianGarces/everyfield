"use client";

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { ConfirmEmailScreen } from "../restricted/ConfirmEmailScreen";
import { DeletionStatusScreen } from "../restricted/DeletionStatusScreen";
import { createDeletionPort, createFixturePort, DELETION_SCENARIOS, type DeletionScenario } from "./fixtures";

import type { RestrictedFlow } from "./flows";

/**
 * The restricted pages at /design/restricted/[flow]. `state` picks a deletion scenario (pending, late, skew, purging,
 * purged, cancelled); `proof` picks the email link (valid, expired, unknown).
 */
export function RestrictedPreview({ flow }: { flow: RestrictedFlow }) {
	const search = useSearchParams();
	const raw = search.get("state") ?? "pending";
	const scenario: DeletionScenario = (DELETION_SCENARIOS as readonly string[]).includes(raw)
		? (raw as DeletionScenario)
		: "pending";
	const port = useMemo(
		() => createDeletionPort(flow === "account-deletion" ? "account" : "plant", scenario),
		[flow, scenario],
	);
	const emailPort = useMemo(() => createFixturePort("admin").port, []);

	if (flow === "confirm-email")
		return (
			<ConfirmEmailScreen
				proof={search.get("proof") ?? "valid"}
				confirm={emailPort.confirmEmailChange}
				accountHref="/design/settings/account?as=admin"
			/>
		);
	return (
		<DeletionStatusScreen
			key={`${flow}-${scenario}`}
			subject={
				flow === "account-deletion"
					? { kind: "account", email: "ana@harvestpoint.org" }
					: { kind: "workspace", churchName: "Harvest Point Church" }
			}
			port={port}
			now={Date.now}
			zone="America/Chicago"
			signInHref="/design/settings?as=admin"
		/>
	);
}
