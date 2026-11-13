"use client";

import { PageHeader, Skeleton } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import dynamic from "next/dynamic";
import type { WrittenView } from "../model.ts";
import { NativeProse } from "./NativeProse.tsx";
import { CopiedNote, SECTION } from "./notes.tsx";

// One plain native document. An Owner, an Admin or the account owner edits it in the shared editor, which loads as its
// own chunk; a Member, and anyone on an archived document, reads it as prose and never loads the editor.

const NativeEditor = dynamic(() => import("./NativeEditor.tsx"), {
	ssr: false,
	loading: () => (
		<div aria-busy="true" className="flex flex-col gap-4">
			<span className="sr-only" role="status">
				Loading the editor
			</span>
			<Skeleton className="h-14 w-72 rounded-card" />
			<Skeleton className="mx-auto h-12 w-full max-w-[816px] rounded-card" />
			<Skeleton className="mx-auto h-[640px] w-full max-w-[816px] rounded-none" />
		</div>
	),
});

export function WrittenScreen({
	doc,
	scope,
	canEdit,
	canStore,
}: {
	doc: WrittenView | null;
	scope: "church" | "account";
	canEdit: boolean;
	canStore: boolean;
}) {
	if (canEdit && !doc?.archived) return <NativeEditor doc={doc} scope={scope} canStore={canStore} />;
	if (!doc) return null;
	return (
		<div className="flex flex-col gap-4">
			<PageHeader
				breadcrumb={[{ label: "Documents", href: "/documents" }]}
				title={doc.title}
				subtitle={SECTION[scope]}
			/>
			<div className="flex w-full max-w-[816px] flex-col gap-2 self-center">
				{doc.kind === "core_values" || doc.archived ? (
					<div className="flex flex-wrap gap-1.5">
						{doc.kind === "core_values" ? <Tag>Core values</Tag> : null}
						{doc.archived ? <Tag>Archived</Tag> : null}
					</div>
				) : null}
				{doc.copied ? <CopiedNote /> : null}
				<p className="text-sm text-text-2">
					{doc.archived
						? "This document is archived. Its text stays here to read."
						: "You can read this document. Only an Owner or an Admin can change it."}
				</p>
			</div>
			<NativeProse body={doc.body} label={doc.title} />
		</div>
	);
}
