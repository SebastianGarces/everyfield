import type {
	privateObjectPath,
	putPrivateObject,
	readPrivateObject,
	readPrivateUpload,
	signPrivatePut,
	toUploadKey,
} from "./storage.ts";

type Refused<Target, Value> = [Value] extends [Target] ? false : true;
type UploadKeyInput = Parameters<typeof putPrivateObject>[3]["uploadKey"];
type ObjectPathInputs =
	| Parameters<typeof signPrivatePut>[1]
	| Parameters<typeof readPrivateObject>[1]
	| Parameters<typeof readPrivateUpload>[1];
type BuiltUploadKey = ReturnType<typeof toUploadKey>;
type BuiltObjectPath = ReturnType<typeof privateObjectPath>;

export const anObjectPathIsRefusedAsAnUploadKey: Refused<UploadKeyInput, BuiltObjectPath> = true;
export const anUploadKeyIsRefusedAsAnObjectPath: Refused<ObjectPathInputs, BuiltUploadKey> = true;
export const aPlainStringIsRefusedAsEither: [Refused<UploadKeyInput, string>, Refused<ObjectPathInputs, string>] = [
	true,
	true,
];
export const eachBuiltValueIsAccepted: [
	Refused<UploadKeyInput, BuiltUploadKey>,
	Refused<ObjectPathInputs, BuiltObjectPath>,
] = [false, false];
