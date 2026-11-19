"use client";

import * as C from "@everyfield/contracts/organizations";
import { Button, Card, Skeleton } from "@everyfield/ui/controls";
import { useMemo } from "react";
import { currentOneTimeLinkValue, useOneTimeLinkValue } from "../../components/location.ts";
import { createRead, useRead } from "../../components/read.tsx";
import { AuthFrame, AuthHeading } from "../identity/AuthFrame";
import { readRelationshipInvitation } from "./invitation/client.ts";
import type { RelationshipInvitationRead } from "./invitation/handler.ts";
import { InvitationResponse } from "./InvitationResponse";
import type { Invitation } from "./port";
import { createNames, realRun } from "./real";

type State =
	| { kind: "loading" }
	| { kind: "signed_out"; returnTo: string }
	| { kind: "unavailable" }
	| { kind: "invitation"; invitation: Invitation; names: Record<string, string>; zone: string };

const LOADING: State = { kind: "loading" };
const UNAVAILABLE: State = { kind: "unavailable" };

function stateOf(read: RelationshipInvitationRead, invitationId: string): State {
	if (read.kind === "signed_out")
		return { kind: "signed_out", returnTo: `/connections/respond?invitation=${encodeURIComponent(invitationId)}` };
	if (read.kind !== "invitation") return UNAVAILABLE;
	return {
		kind: "invitation",
		invitation: C.invitationResult.parse(read.invitation),
		names: read.names,
		zone: read.zone,
	};
}

const invitations = createRead(
	(invitationId: string) =>
		readRelationshipInvitation(invitationId, currentOneTimeLinkValue("connections/respond") ?? "").then((read) =>
			stateOf(read, invitationId),
		),
	{ failed: () => UNAVAILABLE, keep: () => false },
);

export function RealRespond({ invitationId }: { invitationId: string | null }) {
	const linked = useOneTimeLinkValue("connections/respond");
	const proof = linked ?? "";
	const usable = Boolean(invitationId && proof);
	const read = useRead(usable ? invitations : null, invitationId ?? "");
	const state = linked === undefined ? LOADING : !usable ? UNAVAILABLE : (read.value ?? LOADING);

	const names = useMemo(() => createNames(state.kind === "invitation" ? state.names : {}), [state]);

	if (state.kind === "signed_out")
		return (
			<AuthFrame>
				<AuthHeading title="Sign in to answer this request">
					Use the account of an Owner or Admin of the organization that received it.
				</AuthHeading>
				<Button asChild variant="primary" className="mt-6 w-full">
					<a href={`/signin?returnTo=${encodeURIComponent(state.returnTo)}`}>Sign in</a>
				</Button>
			</AuthFrame>
		);

	return (
		<div className="min-h-dvh px-10 py-12 max-app-sm:px-4 max-app-sm:py-6">
			<main id="main">
				{state.kind === "loading" ? (
					<Card className="mx-auto w-full max-w-[560px]" aria-busy="true">
						<span className="sr-only" role="status">
							Loading the request
						</span>
						<Skeleton shape="block" height={220} />
					</Card>
				) : (
					<InvitationResponse
						invitation={state.kind === "invitation" ? state.invitation : null}
						proof={state.kind === "invitation" ? proof : ""}
						nameOf={names.nameOf}
						zone={state.kind === "invitation" ? state.zone : "UTC"}
						run={realRun}
						connectionsHref="/settings/sharing"
					/>
				)}
			</main>
		</div>
	);
}
