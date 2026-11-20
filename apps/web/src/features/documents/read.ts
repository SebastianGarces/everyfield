import { requestDatabase } from "@/server/database";
import { viewerActor } from "@/server/request-context";
import { privateStorage } from "@everyfield/db/schema";
import { documentFormat, type ChurchCompare, type ChurchTemplateSummary } from "@everyfield/contracts/documents";
import { documentsReader, documentsWriter } from "@everyfield/domain/documents";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { refusedWith } from "./church/refusal.ts";
import type { CopySource, OwnedView, Resolved, SavedFile } from "./model.ts";
import { presentOwned, presentSaved, refused, runAs, storageMissing, type DocumentOutcome } from "./outcome.ts";
import { LOST, transient } from "../../server/platform/transient.ts";

export type CompareResult =
	{ status: "ok"; compare: ChurchCompare } | { status: "refused"; code: string; message: string } | { status: "lost" };
type ChurchTemplates =
	{ status: "ok"; templates: ChurchTemplateSummary[] } | { status: "refused"; message: string } | { status: "lost" };

export const GET = defineReads(
	async () => ({ actor: await viewerActor() }),
	"unavailable",
	(get) => ({
		resolved: get(
			z.strictObject({ templateId: z.string(), format: documentFormat }),
			({ actor }, input): Promise<DocumentOutcome<Resolved>> =>
				runAs(actor, async (db, a) => {
					const reply = await documentsReader.resolveContext(db, a, input);
					if (reply.status === "refused") return refused(reply.error);
					const value = reply.value;
					return {
						status: "ok",
						value: {
							templateId: value.templateId,
							format: value.format,
							fields: value.fields,
							missing: value.missing,
							complete: value.complete,
						},
					};
				}),
		),
		saved: get(z.undefined(), ({ actor }): Promise<DocumentOutcome<SavedFile[]>> =>
			runAs(actor, async (db, a) => {
				const reply = await documentsWriter["history.list"](db, a, {});
				if (reply.status === "refused") return refused(reply.error);
				return { status: "ok", value: reply.value.entries.map(presentSaved) };
			}),
		),
		written: get(
			z.undefined(),
			({ actor }): Promise<DocumentOutcome<{ documents: OwnedView[]; evidence: string | null }>> =>
				runAs(actor, async (db, a) => {
					const listed = await documentsWriter.listOwned(db, a, {});
					if (listed.status === "refused") return refused(listed.error);
					const evidence = await documentsWriter.readCoreValuesEvidence(db, a, {});
					if (evidence.status === "refused") return refused(evidence.error);
					return {
						status: "ok",
						value: { documents: listed.value.documents.map(presentOwned), evidence: evidence.value.text },
					};
				}),
		),
		sources: get(z.undefined(), ({ actor }): Promise<DocumentOutcome<CopySource[]>> =>
			runAs(actor, async (db, a) => {
				const reply = await documentsWriter.listCopySources(db, a, {});
				if (reply.status === "refused") return refused(reply.error);
				return {
					status: "ok",
					value: reply.value.documents.map((item) => ({
						id: item.id,
						title: item.title,
						revisionId: item.revisionId,
					})),
				};
			}),
		),
		templates: get(z.undefined(), async ({ actor }): Promise<ChurchTemplates> => {
			if (!actor) return refusedWith("access_denied");
			const reply = await transient(
				{ component: "church-documents", outcome: "template_list_failed" },
				() => documentsWriter.listChurch(requestDatabase(), actor, {}),
				LOST,
			);
			if (reply.status === "lost") return reply;
			if (reply.status !== "ok") return refusedWith(reply.error.code);
			return { status: "ok", templates: reply.value.templates };
		}),
		download: get(
			z.strictObject({ documentId: z.string() }),
			async ({ actor }, input): Promise<DocumentOutcome<{ url: string }>> => {
				const storage = privateStorage();
				if (!storage) return storageMissing;
				return runAs(actor, async (db, a) => {
					const reply = await documentsWriter.download(db, a, input, storage);
					if (reply.status === "refused") return refused(reply.error);
					return { status: "ok", value: { url: reply.value.url } };
				});
			},
		),
		compare: get(z.strictObject({ documentId: z.string() }), async ({ actor }, input): Promise<CompareResult> => {
			if (!actor) return { ...refusedWith("access_denied"), code: "access_denied" };
			const reply = await transient(
				{ component: "church-documents", outcome: "compare_failed" },
				() => documentsWriter.readTemplateCompare(requestDatabase(), actor, input),
				LOST,
			);
			if (reply.status === "lost") return reply;
			if (reply.status !== "ok")
				return { status: "refused", code: reply.error.code, message: refusedWith(reply.error.code).message };
			return { status: "ok", compare: reply.value };
		}),
	}),
);
