import type { AppAssetPath } from "@everyfield/contracts/common";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { listPhotoRoute, personPhotosRequest } from "@everyfield/contracts/people";
import { PeopleReadContext, readPersonPhotos } from "@everyfield/domain/people";
import { avatarRoute } from "@everyfield/contracts/settings";
import "server-only";
import { z } from "zod";
import { readSection } from "../../settings/server.ts";
import { defineReads } from "../../../server/platform/reads.ts";
import { LOST, transient } from "../../../server/platform/transient.ts";

export const GET = defineReads(
	async () => ({ viewer: await getViewer() }),
	"access_denied",
	(get) => ({
		ownPhoto: get(z.undefined(), async ({ viewer }) => {
			const reply = await readSection(viewer, { section: "account" });
			if (reply.status !== "ok") return LOST;
			const account = reply.value.section === "account" ? reply.value.avatar : null;
			return { status: "ok", value: account?.status === "available" ? avatarRoute(account.avatar) : null } as const;
		}),
		photos: get(personPhotosRequest, async ({ viewer }, input) => {
			const db = requestDatabase();
			const none: Record<string, AppAssetPath> = {};
			const people = viewer.people;
			if (!people) return { status: "ok", value: none } as const;
			return transient(
				{ component: "evry", outcome: "row_photos_failed" },
				async () => {
					const reply = await readPersonPhotos(db, new PeopleReadContext(people.authority), input);
					if (reply.status !== "ok") return { status: "ok", value: none } as const;
					const photos: Record<string, AppAssetPath> = Object.fromEntries(
						reply.value.photos.map((p) => [p.personId, listPhotoRoute(p.photo)]),
					);
					return { status: "ok", value: photos } as const;
				},
				LOST,
			);
		}),
	}),
);
