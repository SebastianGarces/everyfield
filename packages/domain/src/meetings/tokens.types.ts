import type { rsvpToken } from "@everyfield/contracts/meetings";
import type { z } from "zod";
import type { MintedRsvpToken } from "./tokens.ts";

type Refused<Target, Value> = [Value] extends [Target] ? false : true;

export const aMintedTokenIsNotAString: Refused<string, MintedRsvpToken> = true;
export const aMintedTokenIsNotARequestToken: Refused<z.infer<typeof rsvpToken>, MintedRsvpToken> = true;
export const aStringIsNotAMintedToken: Refused<MintedRsvpToken, string> = true;
