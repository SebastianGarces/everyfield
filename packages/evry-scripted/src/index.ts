import { withTransientRetry, type QualifiedModel } from "@everyfield/evry";
import { scriptedModel } from "./scripted.ts";

export { scriptedModel };
export {
	scriptedAssessmentDrafter,
	scriptedDraft,
	scriptedLanguageJudge,
	type ScriptedReply,
} from "./scripted-assessment.ts";

export const scriptedQualifiedModel = (): QualifiedModel => ({
	status: "qualified",
	id: "evry-scripted",
	model: withTransientRetry(scriptedModel()),
});
