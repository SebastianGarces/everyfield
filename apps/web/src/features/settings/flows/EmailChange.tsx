"use client";

import { Mail01Icon } from "@hugeicons/core-free-icons";
import { normalizedEmail } from "@everyfield/contracts/identity";
import { Button, Field, Input } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useRef } from "react";
import { refusalOf } from "../save";
import type { SettingsError } from "../port";
import { useFlowState, useFlows } from "../store";

/** Why a link was not sent. A request that may have sent one says so: a new request replaces it safely. */
function notSent(error: SettingsError | null): string {
	if (!error || error.code === "unknown")
		return "We could not confirm that the link was sent. Send it again: the new link replaces the old one.";
	if (error.code === "temporary")
		return "The link was not sent. You can ask for 3 links in an hour. Wait a while, then try again.";
	return `The link was not sent. ${refusalOf(error).message}`;
}

type State =
	| { step: "idle" }
	| { step: "editing"; value: string; error?: string; sending: boolean }
	| { step: "sent"; email: string };

/**
 * Changing the sign-in email (REQ-IDN-007). The new address gets a link that works for 24 hours; until it is opened
 * the current address stays. Each request replaces the one before, so only the newest link works. One request runs at
 * a time: while it sends, Send link is loading, so a second Enter or click does nothing, and Cancel waits for the
 * answer, so the screen never hides a link that was sent.
 */
export function EmailChange({ currentEmail }: { currentEmail: string }) {
	const port = useFlows();
	// Kept in the settings store: leaving Your account while a link sends, or after it was sent, keeps that step.
	const [state, setState] = useFlowState<State>("email-change", { step: "idle" });
	const field = useRef<HTMLInputElement>(null);
	const start = () => setState({ step: "editing", value: "", sending: false });
	// After a refusal the field takes focus, so the reason is read with it and the address can be corrected at once.
	const refuse = (error: string) => {
		setState((s) => (s.step === "editing" ? { ...s, sending: false, error } : s));
		field.current?.focus();
	};
	const cancel = () => setState({ step: "idle" });

	const send = async () => {
		if (state.step !== "editing") return;
		const parsed = normalizedEmail.safeParse(state.value);
		if (!parsed.success) return refuse("Enter a full email address, like name@church.org.");
		if (parsed.data === currentEmail) return refuse("This is already your email.");
		setState({ ...state, error: undefined, sending: true });
		let reply;
		try {
			reply = await port.requestEmailChange({ newEmail: parsed.data });
		} catch {
			reply = null;
		}
		if (reply?.status === "ok") return setState({ step: "sent", email: parsed.data });
		// The form stays in the store while it sends (Cancel is disabled), so the reason lands even if another section
		// was opened meanwhile.
		refuse(notSent(reply?.status === "refused" ? reply.error : null));
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<span className="font-medium [overflow-wrap:anywhere] text-ink" data-current-email>
					{currentEmail}
				</span>
				{state.step === "idle" ? (
					<Button size="sm" variant="secondary" onClick={start}>
						Change
					</Button>
				) : null}
			</div>
			{state.step === "editing" ? (
				<form
					className="flex flex-wrap items-end gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						void send();
					}}
				>
					<Field label="New email" error={state.error} className="min-w-[240px] flex-1">
						<Input
							ref={field}
							type="email"
							autoComplete="email"
							autoFocus
							value={state.value}
							onChange={(e) => setState({ ...state, value: e.target.value, error: undefined })}
						/>
					</Field>
					<div className="flex gap-2">
						<Button type="submit" variant="primary" size="sm" loading={state.sending}>
							Send link
						</Button>
						<Button variant="ghost" size="sm" onClick={cancel} disabled={state.sending}>
							Cancel
						</Button>
					</div>
				</form>
			) : null}
			{state.step === "sent" ? (
				<div role="status" className="flex items-start gap-3 rounded-md bg-blue-50 px-4 py-3 text-sm text-ink-2">
					<Icon icon={Mail01Icon} size={18} className="mt-px text-blue-600" />
					<div className="min-w-0 flex-1">
						<p>
							We sent a link to <b className="font-semibold [overflow-wrap:anywhere] text-ink">{state.email}</b>. Open
							it within 24 hours to finish. Until then you sign in with {currentEmail}.
						</p>
						<p className="mt-1 text-text-3">A new request replaces this one, and only the newest link works.</p>
						<Button size="sm" variant="ghost" className="mt-1.5 -ml-2.5" onClick={start}>
							Use a different address
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}
