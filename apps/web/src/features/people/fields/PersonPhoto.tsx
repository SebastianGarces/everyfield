"use client";

import { Camera01Icon, Delete02Icon, ImageUpload01Icon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Spinner, useToast } from "@everyfield/ui/controls";
import { Avatar } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { Receipt } from "../boundary.ts";
import { runSave, type Outcome, type PersonStore } from "../model.ts";
import { fresh, problemText } from "../parts.tsx";
import type { PersonDraft } from "../StageDialog.tsx";
import { removePhoto, uploadPhoto, type PhotoSaved } from "./actions.ts";
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
const failText = (r: Outcome<unknown> | null) =>
	!r
		? "Another change to this person is still saving. Try again in a moment."
		: r.status === "refused" && r.code === "storage_unavailable"
			? "Photo storage is not set up yet."
			: r.status === "refused" && r.code === "invalid_input"
				? "The file is not a valid JPG, PNG or WebP photo under 3 MB."
				: problemText(r.status === "refused" ? r.code : "lost");

/**
 * The person's photo in the page header (REQ-PPL-005). The image comes only from the app's own route for the exact
 * version. Owners and Admins add, replace or remove it from the photo menu. A new photo shows at once from the chosen
 * file; the old one stays saved until the new one is, and a failed upload goes back to it with a message.
 */
export function PersonPhoto({
	store,
	person,
	initial,
	canEdit,
	enabled,
	onSaved,
}: {
	store: PersonStore<PlantPerson, PersonDraft>;
	person: PlantPerson;
	initial: PhotoResult;
	canEdit: boolean;
	/** Private photo storage is configured for this deployment. */
	enabled: boolean;
	onSaved: (receipt: Receipt) => void;
}) {
	const toast = useToast();
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

	async function save(slot: string, call: (key: string) => Promise<Outcome<PhotoSaved>>) {
		const r = await runSave(store, slot, slot, call, {
			fresh,
			toPerson: (v) => ({ ...store.get().saved, revision: v.personRevision }) as PlantPerson,
		});
		if (r?.status === "ok") {
			setPhoto(r.value.photo);
			onSaved(r.value.receipt);
		}
		return r;
	}

	async function upload(file: File) {
		const problem = photoProblem(file);
		if (problem) return toast({ tone: "error", message: problem });
		const local = URL.createObjectURL(file);
		setPreview(local);
		setBusy("upload");
		const revision = store.get().saved.revision;
		const r = await save("photo", (key) => {
			const form = new FormData();
			form.set("requestKey", key);
			form.set("expectedRevision", revision);
			form.set("personId", person.id);
			form.set("file", file);
			return uploadPhoto(form);
		});
		setBusy(null);
		if (input.current) input.current.value = "";
		if (r?.status !== "ok") {
			setPreview(null);
			return toast({ tone: "error", message: `The photo was not saved. ${failText(r)}` });
		}
		// Keep the chosen file on screen until the saved version has loaded, so the header never flashes empty.
		const saved = photoSrc(r.value.photo);
		if (!saved) return setPreview(null);
		const img = new Image();
		img.onload = img.onerror = () => setPreview((p) => (p === local ? null : p));
		img.src = saved;
		toast({ tone: "success", message: "Photo saved." });
	}

	async function remove() {
		setBusy("remove");
		const revision = store.get().saved.revision;
		const r = await save("photo", (key) => removePhoto(key, revision, person.id));
		setBusy(null);
		if (r?.status !== "ok") toast({ tone: "error", message: `The photo was not removed. ${failText(r)}` });
	}

	const avatar = <Avatar name={person.displayName} label={label} src={src} size="xl" decorative={canEdit} />;
	const has = photo.status === "available";
	if (!canEdit || (!enabled && !has)) return avatar;

	return (
		<div className="relative flex-none" aria-busy={busy !== null || undefined}>
			<Menu>
				<MenuTrigger asChild>
					<button
						type="button"
						aria-label={`${has ? "Change" : "Add"} photo of ${person.displayName}`}
						className="group relative block cursor-pointer rounded-full"
						disabled={busy !== null}
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
	);
}
