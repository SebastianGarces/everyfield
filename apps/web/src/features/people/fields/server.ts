import "server-only";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { Viewer } from "../server.ts";

/** The People context of the byte adapters, which run outside a people transaction. */
export const peopleContext = (v: Viewer): PeopleContext => ({
	session: v.authority.session,
	selected: v.authority.actor.context.owner,
});
