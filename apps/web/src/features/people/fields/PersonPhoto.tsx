"use client";

import { Camera01Icon, Delete02Icon, ImageUpload01Icon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import { photoMime } from "@everyfield/contracts/people";
import {
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	Popover,
	PopoverAnchor,
	PopoverContent,
	Spinner,
	useToast,
} from "@everyfield/ui/controls";
import { Avatar, initials } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useRef, useState } from "react";
import type { z } from "zod";
import { SaveNotice, useSaveIntent } from "../../../components/save/parts.tsx";
import type { Receipt } from "../boundary.ts";
import { throughStore, type PersonStore } from "../person.store.ts";
import { problemText, usePersonState } from "../parts.tsx";
import type { PersonDraft } from "../StageDialog.tsx";
import { removePhoto, uploadPhoto, type PhotoSaved } from "./actions.ts";
import { readPhoto } from "../fetch.ts";
import { photoProblem, photoSrc, takeFile, type PhotoResult } from "./model.ts";

type PlantPerson = z.infer<typeof people.plantPerson>;
function photoRefusal(code: string): string {
	switch (code) {
		case "busy":
			return "Another change to this person was still saving, so nothing was sent. Try again when it ends.";
		case "storage_unavailable":
			return "Photo storage is not set up yet.";
		case "invalid_input":
			return "The file is not a valid JPG, PNG or WebP photo under 3 MB.";
		default:
			return problemText(code);
	}
}

export function PersonPhoto({
	store,
	person,
	initial,
	canEdit,
	enabled,
	onSaved,
	onConflict,
}: {
	store: PersonStore<PlantPerson, PersonDraft>;
	person: PlantPerson;
	initial: PhotoResult;
	canEdit: boolean;
	enabled: boolean;
	onSaved: (receipt: Receipt) => void;
	onConflict: () => void;
}) {
	const toast = useToast();
	usePersonState(store);
	const lane = useSaveIntent<{ problem?: string }>({
		explain: photoRefusal,
		busy: () => store.getState().pending !== null,
	});
	const input = useRef<HTMLInputElement>(null);
	const [photo, setPhoto] = useState(initial);
	const [preview, setPreview] = useState<string | null>(null);
	const [busy, setBusy] = useState<"upload" | "remove" | null>(null);

	const saved = photoSrc(photo);
	const src = busy === "remove" ? undefined : (preview ?? saved ?? undefined);
	const [shown, setShown] = useState<string | null>(null);
	const label = src && shown === src ? `Photo of ${person.displayName}` : person.displayName;

	const through = throughStore(
		store,
		"photo",
		(v: PhotoSaved) => ({ ...store.getState().saved, revision: v.personRevision }) as PlantPerson,
	);
	const refused = async (code: string) => {
		if (code !== "conflict") return;
		onConflict();
		const r = await readPhoto(person.id).catch(() => null);
		if (r?.status === "ok") setPhoto(r.value);
	};

	function drop(local: string) {
		setPreview((p) => (p === local ? null : p));
		URL.revokeObjectURL(local);
	}

	async function upload(file: File) {
		const problem = photoProblem(file);
		if (problem) return toast({ tone: "error", message: problem });
		const local = URL.createObjectURL(file);
		setPreview(local);
		setBusy("upload");
		const revision = store.getState().saved.revision;
		let settled = false;
		await lane.save({
			what: "The photo",
			send: (key) => {
				const form = new FormData();
				form.set("requestKey", key);
				form.set("expectedRevision", revision);
				form.set("personId", person.id);
				form.set("file", file);
				return uploadPhoto(form);
			},
			through,
			refused,
			ok: (value) => {
				settled = true;
				setPhoto(value.photo);
				onSaved(value.receipt);
				const saved = photoSrc(value.photo);
				if (!saved) return drop(local);
				const img = new Image();
				img.onload = img.onerror = () => drop(local);
				img.src = saved;
				toast({ tone: "success", message: "Photo saved." });
			},
		});
		setBusy(null);
		if (!settled) drop(local);
	}

	async function remove() {
		setBusy("remove");
		const revision = store.getState().saved.revision;
		await lane.save({
			what: "The photo",
			done: "removed",
			send: (key) => removePhoto(key, revision, person.id),
			through,
			refused,
			ok: (value) => {
				setPhoto(value.photo);
				onSaved(value.receipt);
			},
		});
		setBusy(null);
	}

	const avatar = (
		<Avatar
			name={person.displayName}
			label={label}
			src={src}
			size="xl"
			decorative={canEdit}
			onImageSettled={(result) => setShown(result === "loaded" ? (src ?? null) : null)}
		>
			{canEdit ? (
				<span
					aria-hidden="true"
					data-initials={initials(person.displayName)}
					className="before:content-[attr(data-initials)]"
				/>
			) : undefined}
		</Avatar>
	);
	const has = photo.status === "available";
	if (!canEdit || (!enabled && !has)) return avatar;

	return (
		<Popover open={lane.notice !== null}>
			<PopoverAnchor asChild>
				<div className="relative flex-none" aria-busy={busy !== null || undefined}>
					<Menu>
						<MenuTrigger asChild>
							<button
								type="button"
								aria-label={`${has ? "Change" : "Add"} photo of ${person.displayName}`}
								className="group relative block rounded-full"
								disabled={busy !== null || lane.wait !== null}
							>
								{avatar}
								<span
									aria-hidden="true"
									className="absolute right-0 bottom-0 grid size-8 place-items-center rounded-full bg-surface-raised text-ink-2 shadow-[0_0_0_2px_var(--ef-surface),var(--ef-shadow-pop)] transition-[background-color] duration-150 group-hover:bg-surface-2"
								>
									<Icon icon={Camera01Icon} size={16} />
								</span>
								{busy ? (
									<span className="absolute inset-0 grid place-items-center rounded-full bg-black/35 text-white">
										<Spinner size={20} />
										<span className="sr-only">{busy === "upload" ? "Saving the photo" : "Removing the photo"}</span>
									</span>
								) : null}
							</button>
						</MenuTrigger>
						<MenuContent align="start">
							{enabled ? (
								<MenuItem icon={ImageUpload01Icon} onSelect={() => input.current?.click()}>
									{has ? "Replace photo" : "Upload a photo"}
								</MenuItem>
							) : null}
							{has ? (
								<>
									{enabled ? <MenuSeparator /> : null}
									<MenuItem icon={Delete02Icon} danger onSelect={() => void remove()}>
										Remove photo
									</MenuItem>
								</>
							) : null}
						</MenuContent>
					</Menu>
					<input
						ref={input}
						type="file"
						accept={photoMime.options.join(",")}
						className="sr-only"
						tabIndex={-1}
						aria-hidden="true"
						onChange={(e) => {
							const file = takeFile(e.target);
							if (file) void upload(file);
						}}
					/>
				</div>
			</PopoverAnchor>
			<PopoverContent
				label="Photo"
				className="w-[340px]"
				onOpenAutoFocus={(e) => e.preventDefault()}
				onInteractOutside={(e) => e.preventDefault()}
				onEscapeKeyDown={() => lane.dismiss()}
			>
				<SaveNotice {...lane.noticeProps} dialogOpen={false} />
			</PopoverContent>
		</Popover>
	);
}
