import "server-only";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { PlantSeat } from "@/server/request-context";

export const peopleContext = (v: PlantSeat): PeopleContext => ({
	session: v.authority.session,
	selected: v.authority.actor.context.owner,
});
