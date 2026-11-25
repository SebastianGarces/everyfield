import type { WriteTx } from "@everyfield/domain/access";
import { PeopleReadContext, peopleReader } from "@everyfield/domain/people";
import { personRequest } from "@everyfield/contracts/people";
import type { EvryActor } from "../../context/actor.ts";

export async function stageWarnings(tx: WriteTx, actor: EvryActor, personId: string) {
	const ctx = new PeopleReadContext(actor.authority);
	const request = personRequest.parse({ personId });
	const found = await peopleReader.getPerson(tx, ctx, request);
	const person = found.status === "ok" && found.value.status === "available" ? found.value.person : null;
	if (!person || !("stage" in person) || person.lifecycle.state !== "live") return null;
	const warnings = await peopleReader.getStatusWarnings(tx, ctx, request);
	return warnings.status === "ok" ? { person, warnings: warnings.value } : null;
}
