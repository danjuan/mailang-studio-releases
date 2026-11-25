import React from "react";
import ReactDOM from "react-dom/client";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./index.css";
import { AstryxProvider } from "./components/astryx/AstryxProvider";
import { initCustomFonts } from "./components/editor/inspector/font-options";
import { PiDraftApp } from "./pi/PiDraftApp";

async function startPiEditor(): Promise<void> {
  if (location.hash === "#pi-export-job" && window.pluginBridge) {
    const { runPiExportJob } = await import("./pi/pi-export-job");
    await runPiExportJob(window.pluginBridge);
    return;
  }

  void initCustomFonts();
  const root = document.getElementById("root");
  if (!root) throw new Error("OpenReel editor mount point is unavailable.");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AstryxProvider><PiDraftApp /></AstryxProvider>
    </React.StrictMode>,
  );
}

void startPiEditor();
