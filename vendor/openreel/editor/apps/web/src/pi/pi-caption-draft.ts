import { createContext } from "react";
import type { DraftState } from "./pi-draft";

export const PiCaptionDraftContext = createContext<DraftState | null>(null);
