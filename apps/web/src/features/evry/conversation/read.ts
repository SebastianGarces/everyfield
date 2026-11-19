import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { listPhotoRoute, personPhotosRequest } from "@everyfield/contracts/people";
import { PeopleReadContext, readPersonPhotos } from "@everyfield/domain/people";
import "server-only";
import { defineReads } from "../../../server/platform/reads.ts";
import { logFailure } from "@everyfield/domain/log";

export const GET = defineReads(
	async () => ({ viewer: await getViewer() }),
	"access_denied",
	(get) => ({
		photos: get(personPhotosRequest, async ({ viewer }, input) => {
			const db = requestDatabase();
			const none: Record<string, string> = {};
			if (!viewer.people) return { status: "ok", value: none } as const;
			try {
				const reply = await readPersonPhotos(db, new PeopleReadContext(viewer.people.authority), input);
				if (reply.status !== "ok") return { status: "ok", value: none } as const;
				const photos: Record<string, string> = Object.fromEntries(
					reply.value.photos.map((p) => [p.personId, listPhotoRoute(p.photo)]),
				);
				return { status: "ok", value: photos } as const;
			} catch (error) {
				logFailure({ component: "evry", outcome: "row_photos_failed" }, error);
				return { status: "lost" } as const;
			}
		}),
	}),
);
