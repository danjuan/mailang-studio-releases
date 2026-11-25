"use strict";

function createCreativeStarters({ getScope, getMode, canUseVideo, labels, apply }) {
  const row = byId("creative-starters");
  const buttons = [...row.querySelectorAll("[data-creative-starter]")];
  byId("creative-starter-preview").src = creativeStarterLighthouse;

  function available(kind, scope) {
    if (!scope?.loaded || scope.loadFailed || scope.items.size || scope.submitting.size) return false;
    if (kind === "video" && !canUseVideo()) return false;
    const active = scope.drafts[getMode()];
    if (active.pendingAssets.size || active.pendingFrames?.size) return false;
    const draft = kind === "video" && scope.drafts.video.workflow !== "omni"
      ? scope.videoDrafts.get("omni") : scope.drafts[kind];
    return !draft || (draft.revision === 0 && !draft.prompt && !draft.references.length &&
      !draft.pendingAssets.size && !draft.pendingFrames?.size);
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const scope = getScope();
      const kind = button.dataset.creativeStarter;
      if (!available(kind, scope)) return;
      const text = labels();
      if (kind === "image") {
        apply(scope, kind, { prompt: text.starterImagePrompt });
        return;
      }
      const label = text.starterVideoReference;
      apply(scope, kind, {
        prompt: text.starterVideoPrompt(`@[${label}]`),
        duration: 6,
        references: [{
          label, sourceName: label,
          assets: [{ kind: "image", name: "lighthouse-reference.jpg", url: creativeStarterLighthouse }],
        }],
      });
    });
  }

  return {
    paint() {
      const scope = getScope();
      for (const button of buttons) button.hidden = !available(button.dataset.creativeStarter, scope);
      row.hidden = buttons.every((button) => button.hidden);
    },
  };
}
