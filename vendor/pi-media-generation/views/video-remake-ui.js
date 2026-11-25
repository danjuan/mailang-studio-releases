const remakeStrategyLabels = {
  creative: "remakeCreative",
  "replace-subject": "remakeSubject",
  "imitate-motion": "remakeMotion",
};

function createVideoRemakeUI({ labels, onLayer, chooseLocal, chooseProject, chooseMaterial, removeTemplate, setStrategy }) {
  const inputs = byId("remake-inputs");
  const template = byId("remake-template");
  const templateName = byId("remake-template-name");
  const remove = byId("remake-template-remove");
  const material = byId("remake-material");
  const materialCount = byId("remake-material-count");
  const trigger = byId("remake-strategy-trigger");
  const options = byId("remake-strategy-options");
  const dialog = byId("remake-template-dialog");
  const local = byId("remake-template-device");
  const project = byId("remake-template-project");
  const preview = byId("remake-template-preview");
  const message = byId("remake-template-message");
  let selected;
  let objectUrl;

  function close(restoreFocus = false) {
    const wasOpen = dialog.open;
    if (objectUrl) {
      const video = preview.querySelector("video");
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
    }
    preview.replaceChildren();
    preview.hidden = true;
    if (wasOpen) dialog.close();
    if (wasOpen) onLayer();
    if (restoreFocus && template.checkVisibility()) template.focus({ preventScroll: true });
  }

  template.addEventListener("click", () => {
    if (dialog.open) return;
    feedback(message, "");
    if (selected) {
      try {
        objectUrl = createLocalMp4ObjectUrl(selected.url);
        const video = make("video");
        video.controls = true;
        video.preload = "metadata";
        video.setAttribute("aria-label", labels().videoPreview);
        video.addEventListener("error", () => feedback(message, labels().previewError, true), { once: true });
        video.src = objectUrl;
        preview.append(video);
        preview.hidden = false;
      } catch {
        feedback(message, labels().previewError, true);
      }
    }
    dialog.showModal();
    onLayer();
  });
  local.addEventListener("click", () => {
    close(true);
    chooseLocal(template);
  });
  project.addEventListener("click", () => {
    close(true);
    chooseProject(template);
  });
  byId("remake-template-cancel").addEventListener("click", () => close(true));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close(true);
  });
  dialog.addEventListener("close", () => { if (!dialog.open && objectUrl) close(); });
  remove.addEventListener("click", () => {
    removeTemplate();
    template.focus({ preventScroll: true });
  });
  material.addEventListener("click", () => chooseMaterial(material));
  options.addEventListener("click", (event) => {
    const option = event.target.closest("[data-remake-strategy]");
    if (!option || option.disabled) return;
    setStrategy(option.dataset.remakeStrategy);
    closeMenu(options, trigger);
  });

  function paint(draft, visible, projectAvailable) {
    inputs.hidden = !visible;
    trigger.hidden = !visible;
    if (!visible) {
      selected = undefined;
      if (dialog.open) close();
      return;
    }
    const entry = draft.videoSources.remake;
    selected = entry?.assets[0];
    const text = labels();
    const strategy = text[remakeStrategyLabels[draft.remakeStrategy]];
    byId("remake-strategy-value").textContent = strategy;
    trigger.setAttribute("aria-label", `${text.remakeStrategyLabel} · ${strategy}`);
    setMenuValue(options, "data-remake-strategy", draft.remakeStrategy);
    templateName.textContent = selected?.name ?? text.templateRole;
    template.title = templateName.textContent;
    remove.hidden = !selected;
    project.hidden = !projectAvailable;
    const count = draft.references.filter((reference) => reference !== entry)
      .reduce((sum, reference) => sum + reference.assets.length, 0);
    materialCount.textContent = count ? text.countValue(count) : "";
    template.disabled = material.disabled = draft.pendingAssets.size > 0;
  }

  return { paint, close, isOpen: () => dialog.open };
}
