"use client";

import { Camera01Icon, Delete02Icon, ImageUpload01Icon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
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
import { Avatar } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { SaveNotice, useSaveIntent } from "../../../components/save/parts.tsx";
import type { Receipt } from "../boundary.ts";
import { throughStore, type PersonStore } from "../model.ts";
import { problemText, useStore } from "../parts.tsx";
import type { PersonDraft } from "../StageDialog.tsx";
import { readPhoto, removePhoto, uploadPhoto, type PhotoSaved } from "./actions.ts";
import { photoSrc, type PhotoResult } from "./model.ts";

type PlantPerson = z.infer<typeof people.plantPerson>;
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX = 3 * 1024 * 1024;

/** The client check before an upload (REQ-PPL-005). The server verifies the bytes and type again. */
export function photoProblem(file: { size: number; type: string }): string | null {
	if (file.size === 0) return "This file is empty. Choose a photo.";
	if (!TYPES.includes(file.type)) return "Use a JPG, PNG or WebP photo.";
	if (file.size > MAX) return "Choose a photo smaller than 3 MB.";
	return null;
}
/** The words for a refused photo change. */
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

/**
 * The person's photo in the page header (REQ-PPL-005). The image comes only from the app's own route for the exact
 * version. Owners and Admins add, replace or remove it from the photo menu. A new photo shows at once from the chosen
 * file; the old one stays saved until the new one is. Changes save through a save lane (components/save) in the person
 * store: a lost answer is replayed with the same key, an answer that stays unknown offers Check again, and only a
 * server answer says the photo was not saved. The photo has no card, so its notice opens under it.
 */
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
	/** Private photo storage is configured for this deployment. */
	enabled: boolean;
	onSaved: (receipt: Receipt) => void;
	/** The person changed elsewhere: read the person again. */
	onConflict: () => void;
}) {
	const toast = useToast();
	// Another change to this person is saving: the photo waits, and Check again waits for it (C65, C68).
	useStore(store);
	const lane = useSaveIntent<{ problem?: string }>({
		explain: photoRefusal,
		busy: () => store.get().pending !== null,
	});
	const input = useRef<HTMLInputElement>(null);
	const [photo, setPhoto] = useState(initial);
	const [preview, setPreview] = useState<string | null>(null);
	const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
	useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

	// The saved photo shows only once its bytes have loaded; until then, or if the route refuses, the initials stay, so
	// the header never shows a broken image (REQ-PPL-005).
	const saved = photoSrc(photo);
	const [loaded, setLoaded] = useState<string | null>(null);
	useEffect(() => {
		if (!saved) return;
		let live = true;
		const img = new Image();
		img.onload = () => live && setLoaded(saved);
		img.src = saved;
		return () => {
			live = false;
		};
	}, [saved]);
	const src = busy === "remove" ? undefined : (preview ?? (saved && loaded === saved ? saved : undefined));
	const label = src ? `Photo of ${person.displayName}` : person.displayName;

	const through = throughStore(
		store,
		"photo",
		(v: PhotoSaved) => ({ ...store.get().saved, revision: v.personRevision }) as PlantPerson,
	);
	/** A conflict: the person or the photo changed elsewhere, so the page reads the person and the photo again. */
	const refused = async (code: string) => {
		if (code !== "conflict") return;
		onConflict();
		const r = await readPhoto(person.id).catch(() => null);
		if (r?.status === "ok") setPhoto(r.value);
	};

	async function upload(file: File) {
		const problem = photoProblem(file);
		if (problem) return toast({ tone: "error", message: problem });
		const local = URL.createObjectURL(file);
		setPreview(local);
		setBusy("upload");
		const revision = store.get().saved.revision;
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
				// Keep the chosen file on screen until the saved version has loaded, so the header never flashes empty.
				const saved = photoSrc(value.photo);
				if (!saved) return setPreview(null);
				const img = new Image();
				img.onload = img.onerror = () => setPreview((p) => (p === local ? null : p));
				img.src = saved;
				toast({ tone: "success", message: "Photo saved." });
			},
		});
		setBusy(null);
		if (input.current) input.current.value = "";
		if (!settled) setPreview(null);
	}

	async function remove() {
		setBusy("remove");
		const revision = store.get().saved.revision;
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

	const avatar = <Avatar name={person.displayName} label={label} src={src} size="xl" decorative={canEdit} />;
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
								className="group relative block cursor-pointer rounded-full"
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
						accept={TYPES.join(",")}
						className="sr-only"
						tabIndex={-1}
						aria-hidden="true"
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void upload(file);
						}}
					/>
				</div>
			</PopoverAnchor>
			<PopoverContent
				label="Photo"
				className="w-[340px] p-0"
				// The notice is an assertive live region: it is read out where it is, without taking focus from the page.
				onOpenAutoFocus={(e) => e.preventDefault()}
				onInteractOutside={(e) => e.preventDefault()}
				onEscapeKeyDown={() => lane.dismiss()}
			>
				<SaveNotice {...lane.noticeProps} dialogOpen={false} className="" />
			</PopoverContent>
		</Popover>
	);
}
