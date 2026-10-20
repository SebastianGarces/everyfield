"use client";

import * as C from "@everyfield/contracts/organizations";
import { Button, Card, Skeleton } from "@everyfield/ui/controls";
import { useEffect, useMemo, useState } from "react";
import { AuthFrame, AuthHeading } from "../identity/AuthFrame";
import { loadInvitation } from "./actions";
import { InvitationResponse } from "./InvitationResponse";
import type { PendingInvitation } from "./port";
import { createNames, realRun } from "./real";

type State =
	| { kind: "loading" }
	| { kind: "signed_out"; returnTo: string }
	| { kind: "unavailable" }
	| { kind: "invitation"; invitation: PendingInvitation; names: Record<string, string>; proof: string };

const KEEP = "ef-relationship-proof";

/**
 * /connections/respond?invitation=<id>#<proof>, the link in the emailed request (ruling D10). The proof lives only
 * in the fragment, so it never reaches a server log. The page reads it, removes it from the address bar and keeps it
 * in this tab only while the person signs in.
 */
export function RealRespond({ invitationId }: { invitationId: string | null }) {
	const [state, setState] = useState<State>({ kind: "loading" });
	useEffect(() => {
		const fromLink = window.location.hash.slice(1);
		if (fromLink) {
			sessionStorage.setItem(`${KEEP}/${invitationId}`, fromLink);
			history.replaceState(null, "", window.location.pathname + window.location.search);
		}
		const proof = fromLink || sessionStorage.getItem(`${KEEP}/${invitationId}`) || "";
		let live = true;
		// A link without its proof gets the same answer as any other unusable link.
		const reply =
			invitationId && proof ? loadInvitation(invitationId, proof) : Promise.resolve({ kind: "unavailable" } as const);
		reply.then(
			(r) => {
				if (!live) return;
				if (r.kind === "signed_out")
					return setState({
						kind: "signed_out",
						returnTo: `/connections/respond?invitation=${encodeURIComponent(invitationId ?? "")}`,
					});
				if (r.kind !== "invitation") return setState({ kind: "unavailable" });
				setState({
					kind: "invitation",
					invitation: C.invitationResult.omit({}).parse(r.invitation) as PendingInvitation,
					names: r.names,
					proof,
				});
			},
			() => live && setState({ kind: "unavailable" }),
		);
		return () => {
			live = false;
		};
	}, [invitationId]);

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
						proof={state.kind === "invitation" ? state.proof : ""}
						nameOf={names.nameOf}
						zone="UTC"
						run={realRun}
						connectionsHref="/settings/sharing"
					/>
				)}
			</main>
		</div>
	);
}
