"use client";

import { createRead, useRead } from "@/components/read";
import { Avatar } from "@everyfield/ui/display";
import { Skeleton } from "@everyfield/ui/controls";
import { readOwnPhoto } from "./fetch.ts";

const ownPhoto = createRead(readOwnPhoto, { failed: () => ({ src: null }), fresh: 0 });

export function OwnPhoto({ name }: { name: string }) {
	const photo = useRead(ownPhoto).value;
	return (
		<div className="flex items-center gap-3 px-2 pb-3" aria-busy={photo === undefined || undefined}>
			{photo === undefined ? (
				<Skeleton shape="block" width={80} height={80} />
			) : photo.src ? (
				<Avatar name={name} src={photo.src} size="xl" />
			) : (
				<p className="text-sm text-text-2">This photo cannot be shown now.</p>
			)}
		</div>
	);
}
