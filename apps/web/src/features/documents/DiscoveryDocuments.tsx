"use client";

import { File02Icon } from "@hugeicons/core-free-icons";
import { Button, CardIcon, InlineAlert, PageHeader } from "@everyfield/ui/controls";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { startFromTemplate } from "./actions.ts";
import { documentProblem } from "./model.ts";
import { NativeDocuments } from "./native.tsx";
import { ONLY_YOU } from "./written/notes.tsx";

type DiscoveryTemplate = { id: string; title: string; description: string };

export function DiscoveryDocuments({ templates }: { templates: DiscoveryTemplate[] }) {
	return (
		<>
			<PageHeader size="xl" title="Documents" subtitle="Write your own documents, or start from a template." />
			<NativeDocuments written="account" canEdit note={ONLY_YOU} className="mt-0" />
			<TemplateList templates={templates} />
		</>
	);
}

function TemplateList({ templates }: { templates: DiscoveryTemplate[] }) {
	const router = useRouter();
	const [busy, setBusy] = useState<string | null>(null);
	const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
	const keys = useRef(new Map<string, string>());

	async function start(id: string) {
		if (busy) return;
		const key = keys.current.get(id) ?? crypto.randomUUID();
		keys.current.set(id, key);
		setBusy(id);
		setProblem(null);
		const result = await startFromTemplate(id, key).catch(() => ({ status: "lost" }) as const);
		if (result.status === "ok") {
			router.push(`/documents/written/${result.value.id}`);
			return;
		}
		setBusy(null);
		if (result.status === "refused") keys.current.delete(id);
		setProblem({
			id,
			text:
				result.status === "lost"
					? "The connection dropped. Try again. It won't make a second copy."
					: documentProblem(result.code, result.problem, "This template didn't open. Nothing was made."),
		});
	}

	return (
		<section aria-labelledby="discovery-templates" className="mt-10 flex flex-col gap-4">
			<div>
				<h2 id="discovery-templates" className="font-title text-title-sm tracking-[-0.02em] text-ink">
					Start from a template
				</h2>
				<p className="mt-1 max-w-[640px] text-sm text-text-2 text-pretty">
					Each one makes a private document you can edit. Your name is filled in. Church details stay blank for you to
					fill in.
				</p>
			</div>
			<ul className="grid gap-3 sm:grid-cols-2">
				{templates.map((template) => (
					<li
						key={template.id}
						className="flex flex-col gap-3 rounded-card bg-surface-raised p-4 shadow-[0_0_0_1px_var(--ef-line)]"
					>
						<div className="flex items-start gap-3">
							<CardIcon icon={File02Icon} tone="blue" size={36} />
							<div className="min-w-0 flex-1">
								<h3 className="font-sans text-md font-semibold tracking-normal text-ink">{template.title}</h3>
								<p className="mt-0.5 text-sm text-text-2 text-pretty">{template.description}</p>
							</div>
						</div>
						<div className="flex flex-col gap-2">
							<Button
								variant="secondary"
								className="self-start"
								loading={busy === template.id}
								disabled={busy !== null && busy !== template.id}
								onClick={() => void start(template.id)}
								aria-label={`Use ${template.title}`}
							>
								Use this template
							</Button>
							<InlineAlert>{problem?.id === template.id ? problem.text : null}</InlineAlert>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
