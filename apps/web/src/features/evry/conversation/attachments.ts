"use client";

import { useState } from "react";
import * as api from "./api.ts";
import type { Attachment } from "./model.ts";

// Files attached in the Evry panel (WP-054). The server signs a write-once upload into this conversation, the browser
// puts the file's exact bytes there, and the message that is sent next carries the staged files. A file belongs to the
// conversation it was attached in and is gone 24 hours later (evry.md, attachment limits).

/** The evry.md limits a browser checks before asking: CSV only, 10 MiB each, ten per message. */
export const ATTACH = { bytes: 10 * 1024 * 1024, perMessage: 10, accept: ".csv,text/csv" } as const;

export type Picked = {
	key: string;
	name: string;
	size: number;
	/** The conversation the file was staged in; a file never moves to another one. */
	conversationId: string | null;
	state: "uploading" | "ready" | "failed";
	attachment: Attachment | null;
};

/** "12 KB", "1.4 MB": a file's size the way a person reads it. */
export const fileSize = (bytes: number) =>
	bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Why a picked file can't be attached, or null. */
export function refusal(file: { name: string; size: number }, count: number): string | null {
	if (!/\.csv$/i.test(file.name))
		return "Evry can check CSV files only. Save the spreadsheet as CSV and attach it again.";
	if (file.size === 0) return `${file.name} is empty.`;
	if (file.size > ATTACH.bytes) return `${file.name} is larger than 10 MB. Split it into smaller files.`;
	if (count >= ATTACH.perMessage) return "You can attach up to 10 files to one message.";
	return null;
}

const FAILED: Record<string, string> = {
	access_denied: "Only an Owner or Admin can attach files here.",
	not_found: "This conversation is no longer available.",
};

/**
 * The files picked for the next message. `ensure` gives the conversation to stage them in, creating it when the panel
 * has none yet.
 */
export function useAttachments(ensure: () => Promise<{ id: string } | null>) {
	const [items, setItems] = useState<Picked[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const patch = (key: string, next: Partial<Picked>) =>
		setItems((list) => list.map((p) => (p.key === key ? { ...p, ...next } : p)));

	const upload = async (file: File, key: string) => {
		const conversation = await ensure();
		if (!conversation) return patch(key, { state: "failed" });
		patch(key, { conversationId: conversation.id });
		const staged = await api.stageAttachment(conversation.id, file.name, file.size);
		if (staged.status !== "ok") {
			if (staged.status === "refused") setNotice(FAILED[staged.error.code] ?? "That file could not be attached.");
			return patch(key, { state: "failed" });
		}
		const put = await fetch(staged.value.upload.url, {
			method: "PUT",
			headers: staged.value.upload.headers,
			body: file,
		}).catch(() => null);
		if (!put?.ok) return patch(key, { state: "failed" });
		patch(key, { state: "ready", attachment: staged.value.attachment });
	};

	const add = (files: readonly File[]) => {
		setNotice(null);
		let count = items.length;
		for (const file of files) {
			const problem = refusal(file, count);
			if (problem) {
				setNotice(problem);
				continue;
			}
			count++;
			const key = crypto.randomUUID();
			setItems((list) => [
				...list,
				{ key, name: file.name, size: file.size, conversationId: null, state: "uploading", attachment: null },
			]);
			void upload(file, key);
		}
	};

	return {
		items,
		notice,
		add,
		remove: (key: string) => setItems((list) => list.filter((p) => p.key !== key)),
		clear: () => (setItems([]), setNotice(null)),
		/** The staged files of `conversationId`, ready to send. */
		ready: (conversationId: string | null) =>
			items.filter((p) => p.state === "ready" && p.conversationId === conversationId).map((p) => p.attachment!),
		uploading: items.some((p) => p.state === "uploading"),
	};
}
