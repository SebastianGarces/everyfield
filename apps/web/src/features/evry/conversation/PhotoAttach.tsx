"use client";

import { Attachment01Icon, Cancel01Icon, Csv01Icon, Image01Icon } from "@hugeicons/core-free-icons";
import { IconButton, Tooltip } from "@everyfield/ui/controls";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useRef } from "react";
import { uploadAvatarBytes } from "../../settings/flows/avatarBytes.ts";
import { stagePhoto } from "./photoActions.ts";
import { ATTACH, fileSize } from "./attachments.ts";
import type { Attachment } from "./model.ts";
import { NativeImage } from "@/components/native";

export type Attached = { src: string; name: string; size: number } & (
	| { status: "uploading" }
	| { status: "ready"; avatarId: string | null; attachment: Attachment | null; conversationId: string | null }
	| { status: "failed" }
);

export async function stageAvatar(file: File): Promise<string | null> {
	try {
		const staged = await stagePhoto({ mime: file.type, byteLength: file.size });
		if (!staged) return null;
		const sent = await uploadAvatarBytes(staged, file);
		return sent.status === "ok" ? staged.versionId : null;
	} catch {
		return null;
	}
}

export function AttachButton({
	disabled,
	church,
	onFiles,
}: {
	disabled: boolean;
	church: boolean;
	onFiles: (files: File[]) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const label = church ? "Attach a file" : "Attach a photo";
	return (
		<>
			<input
				ref={input}
				type="file"
				accept={church ? `${ATTACH.accept},${ATTACH.photos}` : ATTACH.photos}
				multiple={church}
				className="sr-only"
				tabIndex={-1}
				aria-hidden
				onChange={(e) => {
					const files = [...(e.target.files ?? [])];
					e.target.value = "";
					if (files.length) onFiles(files);
				}}
			/>
			<Tooltip content={church ? "Attach a CSV or a photo" : "Attach a photo"}>
				<IconButton
					icon={church ? Attachment01Icon : Image01Icon}
					label={label}
					size="sm"
					disabled={disabled}
					onClick={() => input.current?.click()}
				/>
			</Tooltip>
		</>
	);
}

export function PhotoChip({ photo, onRemove }: { photo: Attached; onRemove: () => void }) {
	return (
		<li
			className={cn(
				"flex h-[34px] max-w-full items-center gap-2 rounded-pill bg-surface-2 py-1 pr-1 pl-1 text-sm",
				photo.status === "failed" && "bg-magenta-50",
			)}
		>
			<NativeImage
				src={photo.src}
				alt=""
				className="size-[26px] flex-none rounded-full object-cover shadow-[0_0_0_1px_var(--ef-line-2)]"
			/>
			<span className="min-w-0 truncate text-ink">{photo.name}</span>
			<span className={cn("flex-none text-xs", photo.status === "failed" ? "text-magenta-600" : "text-text-3")}>
				{photo.status === "uploading"
					? "Attaching…"
					: photo.status === "failed"
						? "Couldn't attach"
						: fileSize(photo.size)}
			</span>
			<IconButton
				icon={Cancel01Icon}
				label={`Remove ${photo.name}`}
				size="sm"
				className="size-[26px]"
				onClick={onRemove}
			/>
		</li>
	);
}

export function SentFileIcon({ name }: { name: string }) {
	return <Icon icon={ATTACH.photoName.test(name) ? Image01Icon : Csv01Icon} size={16} className="flex-none" />;
}
