"use client";

import { createRead, useRead } from "@/components/read";
import { Avatar } from "@everyfield/ui/display";
import { Skeleton } from "@everyfield/ui/controls";
import { readOwnPhoto } from "./fetch.ts";

const ownPhoto = createRead(readOwnPhoto, { failed: () => null, fresh: 0 });

export function OwnPhoto({ name }: { name: string }) {
	const photo = useRead(ownPhoto);
	return (
		<div className="flex items-center gap-3 px-2 pb-3" aria-busy={photo.value === undefined || undefined}>
			{photo.value === undefined ? (
				<Skeleton shape="block" width={80} height={80} />
			) : photo.value ? (
				<Avatar name={name} src={photo.value} size="xl" />
			) : (
				<p className="text-sm text-text-2">This photo is no longer on your account.</p>
			)}
		</div>
	);
}
