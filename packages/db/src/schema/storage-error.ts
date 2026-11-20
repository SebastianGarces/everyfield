export type StorageErrorCode =
	"unavailable" | "invalid_file" | "invalid_avatar" | "invalid_upload_key" | "private_bucket_required";

export class StorageError extends Error {
	readonly code: StorageErrorCode;
	constructor(code: StorageErrorCode) {
		super(code);
		this.code = code;
	}
}
