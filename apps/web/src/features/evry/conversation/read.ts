import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { listPhotoRoute, personPhotosRequest } from "@everyfield/contracts/people";
import { PeopleReadContext, readPersonPhotos } from "@everyfield/domain/people";
import "server-only";
import { defineReads } from "../../../server/platform/reads.ts";
import { LOST, transient } from "@/server/platform/transient";

export const GET = defineReads(
	async () => ({ viewer: await getViewer() }),
	"access_denied",
	(get) => ({
		photos: get(personPhotosRequest, async ({ viewer }, input) => {
			const db = requestDatabase();
			const none: Record<string, string> = {};
			const people = viewer.people;
			if (!people) return { status: "ok", value: none } as const;
			return transient(
				{ component: "evry", outcome: "row_photos_failed" },
				async () => {
					const reply = await readPersonPhotos(db, new PeopleReadContext(people.authority), input);
					if (reply.status !== "ok") return { status: "ok", value: none } as const;
					const photos: Record<string, string> = Object.fromEntries(
						reply.value.photos.map((p) => [p.personId, listPhotoRoute(p.photo)]),
					);
					return { status: "ok", value: photos } as const;
				},
				LOST,
			);
		}),
	}),
);
