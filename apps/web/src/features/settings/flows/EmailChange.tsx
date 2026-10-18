"use client";

import { Mail01Icon } from "@hugeicons/core-free-icons";
import { normalizedEmail } from "@everyfield/contracts/identity";
import { Button, Field, Input } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useState } from "react";
import { refusalOf } from "../save";
import { useSettings } from "../store";

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
	const { port } = useSettings();
	const [state, setState] = useState<State>({ step: "idle" });
	const start = () => setState({ step: "editing", value: "", sending: false });
	const cancel = () => setState({ step: "idle" });

	const send = async () => {
		if (state.step !== "editing") return;
		const parsed = normalizedEmail.safeParse(state.value);
		if (!parsed.success) return setState({ ...state, error: "Enter a full email address, like name@church.org." });
		if (parsed.data === currentEmail) return setState({ ...state, error: "This is already your email." });
		setState({ ...state, error: undefined, sending: true });
		let reply;
		try {
			reply = await port.requestEmailChange({ newEmail: parsed.data });
		} catch {
			reply = null;
		}
		if (reply?.status === "ok") return setState({ step: "sent", email: parsed.data });
		setState((s) =>
			s.step === "editing"
				? {
						...s,
						sending: false,
						error: reply
							? `The link was not sent. ${refusalOf(reply.error).message}`
							: "The link was not sent. Check your connection and try again.",
					}
				: s,
		);
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<span className="font-medium break-all text-ink" data-current-email>
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
							We sent a link to <b className="font-semibold break-all text-ink">{state.email}</b>. Open it within 24
							hours to finish. Until then you sign in with {currentEmail}.
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
