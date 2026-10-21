"use client";

import { Button } from "@everyfield/ui/controls";
import { Avatar } from "@everyfield/ui/display";
import { useRef, useState } from "react";
import { refusalOf, useWrite } from "../save";
import type { AvatarMime, AvatarPort, AvatarResult, SectionResult } from "../port";

type Account = Extract<SectionResult, { section: "account" }>;

export const AVATAR_TYPES: readonly AvatarMime[] = ["image/jpeg", "image/png", "image/webp"];
export const AVATAR_MAX_BYTES = 3 * 1024 * 1024;

/** The client check before an upload (REQ-IDN-006). The server verifies the bytes and type again. */
export function avatarProblem(file: { size: number; type: string }): string | null {
	if (file.size === 0) return "This file is empty. Choose a photo.";
	if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return "Use a JPG, PNG or WebP photo.";
	if (file.size > AVATAR_MAX_BYTES) return "Choose a photo smaller than 3 MB.";
	return null;
}

/**
 * Your photo (REQ-IDN-006). The image shows only through the authenticated route for its version (port.avatarSrc),
 * never through a storage key or a signed URL. Upload is three steps: ask for an upload, send the bytes, then save.
 * Until the save succeeds the old photo stays. A retry of the same save or removal reuses its request key, so a lost
 * reply cannot apply it twice.
 */
export function AvatarControl({
	port,
	account,
	onChanged,
}: {
	port: AvatarPort;
	account: Account;
	onChanged: (avatar: AvatarResult) => void;
}) {
	const saving = useWrite("avatar");
	const removing = useWrite("avatar-remove");
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
	const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
	const src = account.avatar.status === "available" ? port.avatarSrc(account.avatar.avatar) : undefined;

	const fail = (text: string) => setMessage({ tone: "error", text });

	const upload = async (file: File) => {
		const problem = avatarProblem(file);
		if (problem) return fail(problem);
		setBusy("upload");
		setMessage({ tone: "info", text: "Uploading your photo…" });
		try {
			const staged = await port.requestAvatarUpload({ mime: file.type as AvatarMime, byteLength: file.size });
			if (staged.status === "refused") return fail(`Your photo did not upload. ${refusalOf(staged.error).message}`);
			const sent = await port.uploadAvatarBytes(staged.value.uploadId, file);
			if (sent.status === "refused") return fail(`Your photo did not upload. ${refusalOf(sent.error).message}`);
			const input = { uploadId: staged.value.uploadId };
			const saved = await saving.run(input, (requestKey) =>
				port.finalizeAvatar({ requestKey, expectedRevision: account.revision, input }),
			);
			if (!saved.ok) return fail(`Your photo was not saved. ${saved.refusal.message}`);
			onChanged(saved.value);
			setMessage({ tone: "info", text: "Photo saved." });
		} catch {
			fail("Your photo did not upload. Check your connection and try again.");
		} finally {
			setBusy(null);
			if (input.current) input.current.value = "";
		}
	};

	const remove = async () => {
		setBusy("remove");
		setMessage(null);
		try {
			const input = {};
			const removed = await removing.run(input, (requestKey) =>
				port.removeAvatar({ requestKey, expectedRevision: account.revision, input }),
			);
			if (!removed.ok) return fail(`Your photo was not removed. ${removed.refusal.message}`);
			onChanged(removed.value);
			setMessage({ tone: "info", text: "Photo removed." });
		} catch {
			fail("Your photo was not removed. Check your connection and try again.");
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="flex flex-wrap items-center gap-3">
			<Avatar
				name={account.name}
				label={src ? "Your photo" : `${account.name}, no photo`}
				src={src}
				size="lg"
				tone="green"
			/>
			<div className="flex flex-col gap-1.5">
				<div className="flex flex-wrap gap-2">
					<Button size="sm" variant="secondary" loading={busy === "upload"} onClick={() => input.current?.click()}>
						{src ? "Change photo" : "Add photo"}
					</Button>
					{src ? (
						<Button size="sm" variant="ghost" loading={busy === "remove"} onClick={remove} disabled={busy === "upload"}>
							Remove
						</Button>
					) : null}
				</div>
				<input
					ref={input}
					type="file"
					accept={AVATAR_TYPES.join(",")}
					className="sr-only"
					tabIndex={-1}
					aria-hidden="true"
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) void upload(file);
					}}
				/>
				<p
					aria-live="polite"
					data-avatar-message
					className={message?.tone === "error" ? "text-xs font-medium text-magenta-600" : "text-xs text-text-3"}
				>
					{message?.text ?? "JPG, PNG or WebP, up to 3 MB."}
				</p>
			</div>
		</div>
	);
}
