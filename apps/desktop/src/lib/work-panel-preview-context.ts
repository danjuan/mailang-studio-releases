import { createContext } from "react";

/** Chat actions can request preview mode through the shell that owns it. */
export const WorkPanelPreviewContext = createContext<(() => void) | null>(null);
