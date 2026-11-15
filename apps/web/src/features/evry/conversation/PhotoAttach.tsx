"use client";

import { Cancel01Icon, Image01Icon } from "@hugeicons/core-free-icons";
import { IconButton, Tooltip } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useRef } from "react";
import { uploadAvatarBytes } from "../../settings/flows/avatarBytes.ts";
import { stagePhoto } from "./photoActions.ts";
import { NativeImage } from "@/components/native";

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 3 * 1024 * 1024;

export type Attached =
	| { status: "uploading"; src: string }
	| { status: "ready"; src: string; id: string }
	| { status: "failed"; src: string | null; message: string };

export function checkPhoto(file: File): Attached | null {
	if (!TYPES.includes(file.type)) return { status: "failed", src: null, message: "Choose a JPG, PNG or WebP photo." };
	if (file.size > MAX_BYTES) return { status: "failed", src: null, message: "Choose a photo smaller than 3 MB." };
	return null;
}

export async function stageAttached(file: File, src: string): Promise<Attached> {
	const failed: Attached = { status: "failed", src, message: "That photo did not upload. Try again." };
	try {
		const staged = await stagePhoto({ mime: file.type, byteLength: file.size });
		if (!staged) return failed;
		const sent = await uploadAvatarBytes(staged, file);
		return sent.status === "ok" ? { status: "ready", src, id: staged.versionId } : failed;
	} catch {
		return failed;
	}
}

export function AttachButton({ disabled, onFile }: { disabled: boolean; onFile: (file: File) => void }) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<input
				ref={input}
				type="file"
				accept={TYPES.join(",")}
				className="sr-only"
				tabIndex={-1}
				aria-hidden
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (file) onFile(file);
				}}
			/>
			<Tooltip content="Attach a photo">
				<IconButton
					icon={Image01Icon}
					label="Attach a photo"
					size="sm"
					disabled={disabled}
					onClick={() => input.current?.click()}
				/>
			</Tooltip>
		</>
	);
}

export function AttachedPhoto({ photo, onRemove }: { photo: Attached; onRemove: () => void }) {
	const status =
		photo.status === "uploading" ? "Uploading…" : photo.status === "ready" ? "Photo attached" : photo.message;
	return (
		<div className="mb-2 flex items-center gap-2.5" aria-live="polite">
			{photo.src ? (
				<NativeImage
					src={photo.src}
					alt=""
					className="size-10 flex-none rounded-md object-cover shadow-[0_0_0_1px_var(--ef-line-2)]"
				/>
			) : (
				<span className="grid size-10 flex-none place-items-center rounded-md bg-surface-2 text-text-3">
					<Icon icon={Image01Icon} size={18} />
				</span>
			)}
			<span
				className={
					photo.status === "failed" ? "min-w-0 flex-1 text-sm text-magenta-600" : "min-w-0 flex-1 text-sm text-text-2"
				}
			>
				{status}
			</span>
			<IconButton icon={Cancel01Icon} label="Remove the photo" size="sm" onClick={onRemove} />
		</div>
	);
}
