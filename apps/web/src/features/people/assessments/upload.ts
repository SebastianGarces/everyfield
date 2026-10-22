import { sendTwice, type Outcome } from "../../../components/save/model.ts";
import { saveCommitmentWithDocument, signCommitmentUpload, type CommitmentSaved } from "./actions.ts";

// The commitment document on design B (RT-2): sign a five-minute PUT URL, put the file's bytes straight into the private
// bucket, then save the card with that upload in one statement. One save intent owns one DocumentUpload, so Check again
// (the same intent) never signs or uploads again, and a lost PUT is checked by the save before any second PUT.

type Signed = Extract<Awaited<ReturnType<typeof signCommitmentUpload>>, { status: "ok" }>["value"];
/**
 * One file's way into the bucket. `put` is what this browser knows about the bytes: not sent yet, sent with no answer
 * (they may be there), or stored (the bucket answered 2xx, or 412 because If-None-Match found them already there).
 */
export type DocumentUpload = { file: File; signed: Signed | null; signedAt: number; put: "none" | "sent" | "stored" };
export const newUpload = (file: File): DocumentUpload => ({ file, signed: null, signedAt: 0, put: "none" });
/** A refused save leaves its upload pending for 15 minutes; a corrected form reuses it for 10, then signs again. */
export const reusable = (u: DocumentUpload | undefined): u is DocumentUpload =>
	!!u && u.put === "stored" && Date.now() - u.signedAt < 10 * 60_000;

/** The PUT the sign step allows: its exact headers and the file itself as the body, so the length is the file's. */
function putFile(
	signed: Signed,
	file: File,
	onProgress: (share: number) => void,
): Promise<"stored" | "lost" | "refused"> {
	return new Promise((done) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", signed.url);
		for (const [name, value] of Object.entries(signed.headers)) xhr.setRequestHeader(name, value);
		xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
		xhr.onload = () =>
			done(
				(xhr.status >= 200 && xhr.status < 300) || xhr.status === 412
					? "stored"
					: xhr.status >= 500
						? "lost"
						: "refused",
			);
		xhr.onerror = xhr.ontimeout = xhr.onabort = () => done("lost");
		xhr.send(file);
	});
}

const refusal = (code: string): Outcome<never> => ({ status: "refused", code });
/** The sign step's refusals in the card's words (parts.tsx recordProblem). */
const signProblem = (code: string) => (code === "storage_unavailable" ? code : "upload_failed");

/**
 * One send of a card with its document under request key `key`: sign when this intent has no live URL, put the bytes
 * unless they are known to be stored, then save. After a PUT with no answer the save is the check: when it answers
 * `unavailable` (no object yet), the same conditional PUT runs once more and the save follows with the same key.
 */
export async function saveWithDocument(
	key: string,
	input: Record<string, unknown> & { personId: string },
	upload: DocumentUpload,
	onProgress: (share: number | null) => void,
): Promise<Outcome<CommitmentSaved>> {
	const { file } = upload;
	if (!upload.signed || (upload.put === "none" && Date.parse(upload.signed.expiresAt) - Date.now() < 30_000)) {
		const signed = await sendTwice(() =>
			signCommitmentUpload({ personId: input.personId, mime: file.type, byteLength: file.size }),
		);
		if (signed.status === "lost") return refusal("upload_lost");
		if (signed.status === "refused") return refusal(signProblem(signed.code));
		Object.assign(upload, { signed: signed.value, signedAt: Date.now(), put: "none" });
	}
	const signed = upload.signed!;
	const put = async () => {
		upload.put = "sent";
		onProgress(0);
		const answer = await putFile(signed, file, onProgress);
		onProgress(null);
		if (answer === "stored") upload.put = "stored";
		return answer;
	};
	if (upload.put === "none") {
		const answer = await put();
		if (answer === "refused") return refusal("upload_failed");
	}
	const save = () => sendTwice(() => saveCommitmentWithDocument(key, { ...input, documentUploadId: signed.uploadId }));
	let saved = await save();
	if (upload.put === "sent" && saved.status === "refused" && saved.code === "unavailable") {
		if ((await put()) !== "stored") return refusal("upload_lost");
		saved = await save();
	}
	if (saved.status === "ok") upload.put = "stored";
	return saved;
}
