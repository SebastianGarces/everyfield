import { createSecretKey, type KeyObject } from "node:crypto";
import { OperatorRefused } from "./control.mts";

export const BACKUP_KEY_VARIABLE = "EVERYFIELD_BACKUP_KEY";

const HOW = "Set it to exactly 64 hex characters for this command only.";
export const BACKUP_KEY_HELP = {
	missing: `${BACKUP_KEY_VARIABLE} is missing. ${HOW}`,
	malformed: `${BACKUP_KEY_VARIABLE} is malformed. ${HOW}`,
};

export class BackupKeyRefused extends OperatorRefused {
	readonly problem: keyof typeof BACKUP_KEY_HELP;
	constructor(problem: keyof typeof BACKUP_KEY_HELP) {
		super(`backup_key_${problem}`);
		this.problem = problem;
	}
}

function parseBackupKey(value: string | undefined): KeyObject {
	if (!value) throw new BackupKeyRefused("missing");
	if (!/^[0-9a-f]{64}$/i.test(value)) throw new BackupKeyRefused("malformed");
	return createSecretKey(value, "hex");
}

export function takeBackupKey(): () => KeyObject {
	const value = process.env[BACKUP_KEY_VARIABLE];
	delete process.env[BACKUP_KEY_VARIABLE];
	return () => parseBackupKey(value);
}
