/** Closed domain change families. Operation names belong only to retry identity. */
export function writeAction(operation: string): string {
	const [domain, verb = ""] = operation.split(".");
	if (domain === "people") return "people.updated";
	if (domain === "orgPeople") return "people.updated";
	if (domain === "settings") return "settings.changed";
	if (domain === "seats")
		return /Invitation|invite/.test(verb)
			? "invitation.changed"
			: verb === "remove"
				? "membership.ended"
				: "membership.role_changed";
	if (domain === "residency")
		return /Invitation|invite/.test(verb)
			? "invitation.changed"
			: verb === "leave"
				? "membership.ended"
				: "sharing.changed";
	if (domain === "associations") return verb === "end" ? "affiliation.ended" : "invitation.changed";
	if (domain === "organizations") return "organization.profile_changed";
	if (domain === "privacy" || domain === "pipelineSharing") return "sharing.changed";
	if (domain === "account")
		return verb === "requestDeletion"
			? "account.deletion_requested"
			: verb === "cancelDeletion"
				? "deletion.cancelled"
				: verb === "changePassword"
					? "identity.credential_changed"
					: verb === "confirmEmailChange"
						? "identity.email_changed"
						: "settings.changed";
	if (domain === "churches")
		return verb === "requestWorkspaceDeletion" ? "plant.deletion_requested" : "deletion.cancelled";
	if (domain === "plant") return verb === "setDigestSchedule" ? "church.digestSchedule.set" : "plant.profile_changed";
	if (domain === "discovery") return verb === "convertToPlant" ? "plant.created" : "identity.domain_accepted";
	if (domain === "onboarding")
		return verb === "createPlant"
			? "plant.created"
			: verb === "declareJourney"
				? "phase.declared"
				: "phase.transitioned";
	if (operation === "identity.answerLeadOnboarding") return "identity.domain_accepted";
	throw Error("unknown_write_action:" + operation);
}
