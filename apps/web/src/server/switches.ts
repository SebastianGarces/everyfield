import "server-only";
import { readSwitches } from "@everyfield/domain/flags";
import { cache } from "react";
import { requestDatabase } from "./database";

export const requestSwitches = cache(() => readSwitches(requestDatabase()));
