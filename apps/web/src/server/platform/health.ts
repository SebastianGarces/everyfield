import { liveness } from "@everyfield/domain/operations";
import { safeResponse } from "./boundary";

export function health() {
	return safeResponse(liveness());
}
