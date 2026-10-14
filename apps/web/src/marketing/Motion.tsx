"use client";

import { useEffect } from "react";
import { startMotion } from "./engines";

/** Starts the prototype's motion engines once the server-rendered page is in the DOM. */
export function Motion() {
  useEffect(() => startMotion(), []);
  return null;
}
