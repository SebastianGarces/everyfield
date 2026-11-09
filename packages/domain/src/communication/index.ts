import "server-only";

export {
	CommunicationRefusal,
	withCommunicationWrite,
	type CommunicationContext,
	type CommunicationReply,
} from "./core.ts";
export { communicationWriter } from "./writer.ts";
export { audiencePeople, recipientsDigest, updatesOff } from "./audience.ts";
export { BATCH_LIMIT, mailAddressHash } from "./delivery.ts";
export type { DeliveryKeys, DeliveryTransport } from "./delivery.ts";
