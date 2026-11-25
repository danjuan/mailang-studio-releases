"use strict";

const bridge = window.pluginBridge;
const panelMessage = byId("panel-message");
const panelContent = byId("panel-content");
const keyForm = byId("key-form");
const keyInput = byId("api-key");
const generateForm = byId("generate-form");
const promptInput = byId("prompt");
const generateButton = byId("generate");
const historyMessage = byId("history-message");
const results = byId("results");
const loadMore = byId("load-more");
const settings = byId("settings");
const frameSlots = [...document.querySelectorAll("[data-frame]")];
const swapFrames = byId("swap-frames");
const historyScroll = byId("session-creations");
const historyRecent = byId("history-recent");
const thumbs = thumbnailLoader(historyScroll);
let resultMenuId = 0;

const pollingStates = new Set(["submitting", "running", "saving"]);
const retryableSave = (record) => record.status === "save-failed" && record.error !== "IMAGE_DATA_UNAVAILABLE";
const legacyRatios = ["1:1", "16:9", "9:16"];
const defaultImageModel = "MiniMax-H3-Image";
const modelLabels = {
  "MiniMax-H3-Lite": "MiniMax H3 Lite",
  "MiniMax-H3-Highspeed": "MiniMax H3 Highspeed",
  "MiniMax-H3-Image": "MiniMax H3 Image",
  "MiniMax-H3-Image-Highspeed": "MiniMax H3 Image Highspeed",
};
const freshImageDraft = () => ({
  prompt: "", ratio: "1:1", area: "1K", model: defaultImageModel, count: 1,
  references: [], pendingAssets: new Set(), revision: 0, requireImageReference: false,
});
const freshDrafts = () => ({
  image: freshImageDraft(),
  video: newVideoWorkflowDraft(),
});
let strings = mediaTranslations.en;
let locale = "en";
let dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
let supported = false;
let referenceFrames = false;
let videoWorkflows = false;
let imageWorkflows = false;
let videoStitch = false;
let sessionScope = null;
let mode = "image";
let composerEpoch = 0;
const key = { configured: false, editing: false, busy: false };
let keyVersion = 0;
let selectionVersion = 0;
let appearanceVersion = 0;

const preview = createMediaPreview({ getScope: () => sessionScope, labels: () => strings, onLayer: syncThumbnails });
const openFramePreview = (scope, frame, trigger) => preview.open(scope, [{ ...frame, kind: "image" }], trigger, localPreviewSource);
initializeMenus();
initializeComposerOptions();
for (const id of ["mode-options", "model-options", "frame-mode-options", "ratio-options", "count-options", "duration-options", "long-duration-options"]) {
  setMenuPlacement(byId(id), () => ({ offsetX: -6 }));
}

const library = createMediaLibrary({
  bridge, getScope: () => sessionScope, labels: () => strings,
  saveCreationSelection() {
    const { selectionStart, selectionEnd, selectionDirection } = promptInput;
    return () => promptInput.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
  },
  onAvailability(scope) {
    paintFrames();
    paintHistory(scope);
  },
  onLayer: syncThumbnails, openPreview: showPreview,
});
const editRegionEditor = createVideoEditRegion({ labels: () => strings, onLayer: syncThumbnails });
const video = createVideoWorkflow({
  getScope: () => sessionScope,
  getMode: () => mode,
  getEpoch: () => composerEpoch,
  labels: () => strings,
  getLibrary: () => library,
  getCapabilities: () => ({ advanced: videoWorkflows, videoStitch, imageWorkflows }),
  editRegionEditor,
  openFramePreview,
  openReferencePreview: (scope, assets, trigger, restoreTrigger) =>
    preview.open(scope, assets, trigger, localPreviewSource, { restoreTrigger }),
  prompt: promptInput,
  onLayer: syncThumbnails,
  onChange(repaint) {
    const draft = sessionScope?.drafts[mode];
    if (draft) draft.revision++;
    if (repaint) video.paint(sessionScope?.drafts.video);
    paintGenerate();
  },
  onError(error) { feedback(byId("generate-message"), errorText(error, strings), true); },
});
const creativeStarters = createCreativeStarters({
  getScope: () => sessionScope, getMode: () => mode,
  canUseVideo: () => videoWorkflows, labels: () => strings, apply: applyCreativeStarter,
});

function syncThumbnails() {
  thumbs.setEnabled(!preview.isOpen() && !settings.open && !library.isOpen() && !editRegionEditor.isOpen() &&
    !video.layerOpen() && !byId("video-quote").open);
  library.setThumbnails(!preview.isOpen() && library.isOpen());
}

function paintKey() {
  byId("key-configured").hidden = !key.configured || key.editing;
  keyForm.hidden = key.configured && !key.editing;
  keyInput.disabled = key.busy;
  byId("save-key").disabled = key.busy;
  byId("cancel-key").hidden = !key.configured;
  byId("cancel-key").disabled = key.busy;
  const trigger = byId("open-settings");
  trigger.dataset.configured = String(key.configured);
  trigger.setAttribute("aria-label", `${strings.apiKey} · ${key.configured ? strings.keyConfigured : strings.keyNeeded}`);
}

function videoFramesReady(draft) {
  return !draft.useFrames || (!draft.pendingFrames.size &&
    (draft.frames.first || draft.frames.last) && draft.requiredFrames.every((role) => draft.frames[role]));
}

function videoReady(draft) {
  return videoFramesReady(draft) && (!videoWorkflows ||
    (!draft.pendingAssets.size && !videoWorkflowError(draft, videoStitch)));
}

function imageReady(draft) {
  return !imageWorkflows || (!draft.pendingAssets.size && !imageWorkflowError(draft));
}

function paintGenerate() {
  const scope = sessionScope;
  const frameDraft = mode === "video" && referenceFrames ? scope?.drafts.video : null;
  swapFrames.disabled = !frameDraft?.useFrames || frameDraft.pendingFrames.size > 0 ||
    !(frameDraft.frames.first || frameDraft.frames.last);
  const needsKeyframes = mode === "video" && videoWorkflows && scope?.drafts.video.workflow === "multiframe" &&
    scope.drafts.video.keyframes.length < 2;
  promptInput.hidden = needsKeyframes;
  promptInput.disabled = needsKeyframes;
  byId("keyframe-guide").hidden = !needsKeyframes;
  const videoPrompt = videoWorkflows && scope?.drafts.video.workflow === "remake" ? strings.remakePrompt : strings.videoPrompt;
  promptInput.placeholder = mode === "image" ? strings.imagePrompt : videoPrompt;
  const busy = scope?.submitting.has(mode);
  generateButton.disabled = !scope || !key.configured || key.editing || busy || !promptInput.value.trim() ||
    (mode === "video" ? !videoReady(scope.drafts.video) : !imageReady(scope.drafts.image));
  byId("composer-key").hidden = key.configured;
  generateButton.hidden = !key.configured;
  const generateLabel = busy ? strings.submitting : mode === "image" ? strings.generateImage : strings.generateVideo;
  byId("generate-label").textContent = generateLabel;
  generateButton.setAttribute("aria-label", generateLabel);
  generateButton.title = generateLabel;
  byId("composer-key").title = strings.configureKey;
  video.status(scope?.drafts.video);
  creativeStarters.paint();
}

function paintFrames() {
  const draft = sessionScope?.drafts.video;
  const available = mode === "video" && referenceFrames && draft;
  const using = available && draft.useFrames;
  const trigger = byId("frame-mode-trigger");
  trigger.hidden = !available;
  const workflow = videoWorkflows && draft ? draft.workflow : using ? "frames" : "text";
  const name = strings[videoWorkflowNames[workflow] ?? "textVideo"];
  byId("frame-mode-icon").dataset.glyph = workflow;
  byId("frame-mode-value").textContent = name;
  trigger.setAttribute("aria-label", `${strings.videoInput} · ${name}`);
  const modes = byId("frame-mode-options");
  modes.querySelector('[data-frame-mode="text"]').hidden = videoWorkflows;
  for (const option of modes.querySelectorAll("[data-workflow]")) option.hidden = !videoWorkflows;
  setMenuValue(modes, "data-frame-mode", workflow);
  byId("frame-slots").hidden = !using;
  byId("ratio-trigger").hidden = Boolean(using) && !videoWorkflows;
  byId("adaptive-ratio").hidden = !using || videoWorkflows;
  video.paint(draft);
  if (!using) return;
  for (const slot of frameSlots) {
    const role = slot.dataset.frame;
    const frame = draft.frames[role];
    const thumb = slot.querySelector(".frame-thumb");
    if ((thumb.firstElementChild?.getAttribute("src") ?? "") !== (frame?.url ?? "")) {
      thumb.replaceChildren();
      if (frame) {
        const image = make("img");
        image.alt = "";
        image.src = frame.url;
        thumb.append(image);
      }
    }
    const required = draft.requiredFrames.includes(role) && !frame;
    const label = role === "first" ? strings.firstFrame : strings.lastFrame;
    const tile = slot.querySelector("[data-frame-trigger]");
    const slotMenu = slot.querySelector("[data-frame-menu]");
    tile.dataset.required = String(required);
    tile.setAttribute("aria-label", [label, frame?.name, required ? strings.frameRequired : "", frame ? strings.imagePreview : strings.fromDevice].filter(Boolean).join(" · "));
    if (frame) tile.setAttribute("aria-haspopup", "dialog");
    else tile.removeAttribute("aria-haspopup");
    tile.title = frame?.name ?? "";
    slotMenu.setAttribute("aria-label", `${label} · ${strings.frameSources}`);
    const local = slot.querySelector("[data-frame-local]");
    local.textContent = frame ? strings.replaceFromDevice : strings.fromDevice;
    const project = slot.querySelector("[data-frame-library]");
    project.hidden = sessionScope.projectAvailable !== true;
    slot.querySelector("[data-frame-subjects]").hidden = project.hidden;
    slot.querySelector("[data-frame-remove]").hidden = !frame;
  }
}

function paintForm() {
  const modeTrigger = byId("mode-trigger");
  byId("mode-icon").dataset.glyph = mode + "-model";
  byId("mode-value").textContent = strings[mode];
  modeTrigger.setAttribute("aria-label", `${strings.generationMode} · ${strings[mode]}`);
  setMenuValue(byId("mode-options"), "data-mode", mode);
  const draft = sessionScope?.drafts[mode];
  promptInput.value = draft?.prompt ?? "";
  paintParameters(draft);
  paintFrames();
  paintGenerate();
}

function updateDuration(value) {
  const draft = mode === "video" ? sessionScope?.drafts.video : null;
  if (!draft || value === draft.duration) return;
  draft.duration = value;
  draft.revision++;
  paintParameters(draft);
}

function bindDurationInputs(slider, number, update) {
  slider.addEventListener("input", () => update(slider.valueAsNumber));
  number.addEventListener("input", () => {
    if (number.value && number.validity.valid) update(number.valueAsNumber);
  });
  const normalize = () => {
    const value = number.valueAsNumber;
    const duration = Number.isFinite(value)
      ? Math.max(Number(number.min), Math.min(Number(number.max), Math.round(value))) : slider.valueAsNumber;
    number.value = String(duration);
    update(duration);
  };
  number.addEventListener("change", normalize);
  number.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    normalize();
  });
}

function createDurationEditor() {
  const heading = make("p", "menu-group-label");
  heading.id = "duration-heading";
  const slider = make("input");
  slider.id = "duration-slider";
  slider.type = "range";
  slider.autofocus = true;
  const number = make("input");
  number.id = "duration-input";
  number.type = "number";
  number.inputMode = "numeric";
  for (const input of [slider, number]) {
    input.min = "4";
    input.max = "15";
    input.step = "1";
  }
  bindDurationInputs(slider, number, updateDuration);

  const editor = make("div", "duration-editor");
  const track = make("div", "duration-track");
  track.append(slider);
  const seconds = make("label", "duration-number");
  seconds.append(number, make("span", "", "s"));
  editor.append(track, seconds);

  const presets = make("div", "duration-presets menu-choices");
  presets.id = "duration-presets";
  presets.setAttribute("role", "radiogroup");
  for (const value of [4, 5, 6, 8, 10, 15]) {
    const option = action(String(value), () => updateDuration(value), "");
    option.dataset.durationPreset = String(value);
    option.setAttribute("role", "radio");
    presets.append(option);
  }
  return [heading, editor, presets];
}

function paintDurationOptions(advanced, duration) {
  const menu = byId("duration-options");
  // Keep stable DOM and focus if a selected duration changes while it is open.
  if (menu.dataset.slider !== String(advanced)) {
    menu.dataset.slider = String(advanced);
    menu.setAttribute("role", advanced ? "dialog" : "menu");
    byId("duration-trigger").setAttribute("aria-haspopup", advanced ? "dialog" : "menu");
    if (advanced) {
      menu.setAttribute("aria-labelledby", "duration-heading");
      menu.dataset.menuLayout = "choices";
      menu.replaceChildren(...createDurationEditor());
    } else {
      menu.removeAttribute("aria-labelledby");
      delete menu.dataset.menuLayout;
      menu.replaceChildren(...[4, 6, 8].map((value) => {
        const option = action("", () => updateDuration(value), "");
        option.dataset.duration = String(value);
        option.setAttribute("role", "menuitemradio");
        option.tabIndex = -1;
        return option;
      }));
    }
  }
  if (advanced) {
    const slider = byId("duration-slider");
    const number = byId("duration-input");
    slider.value = String(duration);
    if (number.valueAsNumber !== duration) number.value = String(duration);
    slider.setAttribute("aria-label", strings.duration);
    slider.setAttribute("aria-valuetext", strings.secondsValue(duration));
    number.setAttribute("aria-label", strings.duration);
    number.nextElementSibling.textContent = strings.secondsInput;
    byId("duration-heading").textContent = strings.videoDurationOptions;
    const presets = byId("duration-presets");
    presets.setAttribute("aria-label", strings.durationPresets);
    for (const option of presets.children) {
      option.setAttribute("aria-label", strings.secondsValue(Number(option.dataset.durationPreset)));
    }
    setMenuValue(presets, "data-duration-preset", duration);
  } else {
    for (const option of menu.children) option.textContent = strings.secondsValue(Number(option.dataset.duration));
    setMenuValue(menu, "data-duration", duration);
  }
}

function paintLongDuration(draft, visible) {
  const trigger = byId("long-duration-trigger");
  trigger.hidden = !visible;
  if (!visible) return;
  const { longDuration, count } = draft;
  const value = strings.secondsValue(longDuration);
  byId("long-duration-value").textContent = value;
  trigger.setAttribute("aria-label", `${strings.totalDuration} · ${value}`);
  const slider = byId("long-duration-slider");
  const number = byId("long-duration");
  slider.value = String(longDuration);
  slider.setAttribute("aria-valuetext", value);
  if (number.valueAsNumber !== longDuration) number.value = String(longDuration);
  const menu = byId("long-duration-options");
  setMenuValue(menu, "data-long-duration", longDuration);
  const segments = splitLongVideoDuration(longDuration);
  const estimate = segments ? strings.longPlanPreview(segments.length, segments.length * count) : "";
  const plan = byId("long-duration-plan");
  if (plan.textContent !== estimate) plan.textContent = estimate;
}

function paintParameters(draft) {
  const ratio = draft?.ratio ?? "1:1";
  const isVideo = mode === "video";
  const advanced = isVideo && videoWorkflows;
  const imageAdvanced = !isVideo && imageWorkflows;
  const parametersEnabled = advanced || imageAdvanced;
  const multiframe = advanced && draft?.workflow === "multiframe";
  const quality = isVideo ? draft?.resolution ?? "480P" : draft?.area ?? "1K";
  const model = draft?.model ?? (isVideo ? "MiniMax-H3-Lite" : defaultImageModel);
  const modelTrigger = byId("model-trigger");
  const modelOptions = byId("model-options");
  const modelMenuLabel = isVideo ? strings.videoModel : strings.imageModel;
  modelTrigger.hidden = !parametersEnabled;
  byId("model-name").hidden = parametersEnabled;
  const modelText = modelLabels[model];
  byId("model-name").textContent = modelText;
  for (const option of modelOptions.querySelectorAll("[data-model]")) {
    option.hidden = option.hasAttribute("data-image-model") === isVideo;
  }
  byId("model-icon").dataset.glyph = isVideo ? "video-model" : "image-model";
  byId("model-value").textContent = modelText;
  modelTrigger.setAttribute("aria-label", `${modelMenuLabel} · ${modelText}`);
  modelOptions.setAttribute("aria-label", modelMenuLabel);
  setMenuValue(modelOptions, "data-model", model);
  const followsFrames = isVideo && (draft?.useFrames || draft?.workflow === "multiframe");
  const ratioText = followsFrames ? strings.adaptiveRatio : ratio === "auto" ? strings.automaticRatio : ratio;
  const ratioLabel = `${ratioText} · ${quality}`;
  byId("ratio-value").textContent = ratioLabel;
  const ratioTrigger = byId("ratio-trigger");
  ratioTrigger.setAttribute("aria-label", `${strings.ratio} · ${ratioLabel}`);
  ratioTrigger.dataset.ratioDisplay = followsFrames ? "auto" : ratio;
  byId("adaptive-ratio").textContent = `${strings.adaptiveRatio} · ${quality}`;
  const ratioOptions = byId("ratio-options");
  const ratioLayout = imageAdvanced ? "image" : advanced ? "video" : "legacy";
  ratioOptions.dataset.ratioLayout = advanced && followsFrames ? "quality" : ratioLayout;
  setMenuValue(ratioOptions, "data-ratio", ratio);
  byId("ratio-group").hidden = advanced && followsFrames;
  byId("resolution-group").hidden = !advanced;
  byId("image-area-options").hidden = !imageAdvanced;
  for (const option of ratioOptions.querySelectorAll("[data-ratio]")) {
    option.hidden = (option.hasAttribute("data-image-ratio") && !imageAdvanced) ||
      (option.hasAttribute("data-extended-ratio") && !parametersEnabled);
  }
  setMenuValue(ratioOptions, "data-resolution", quality);
  setMenuValue(byId("image-area-options"), "data-image-area", quality);
  const count = draft?.count ?? 1;
  const countText = strings.countValue(count);
  byId("count-trigger").hidden = !parametersEnabled || multiframe;
  byId("count-value").textContent = countText;
  byId("count-trigger").setAttribute("aria-label", `${strings.outputCount} · ${countText}`);
  const counts = byId("count-options");
  for (const option of counts.querySelectorAll("[data-count]")) {
    option.setAttribute("aria-label", strings.countValue(Number(option.dataset.count)));
  }
  setMenuValue(counts, "data-count", count);
  const duration = draft?.duration ?? 4;
  const long = advanced && draft?.workflow === "long";
  paintLongDuration(draft, long);
  byId("duration-trigger").hidden = !isVideo || long || multiframe;
  byId("duration-value").textContent = strings.secondsValue(duration);
  byId("duration-trigger").setAttribute("aria-label", `${strings.duration} · ${strings.secondsValue(duration)}`);
  paintDurationOptions(advanced, duration);
  creativeStarters.paint();
}
function paintPanel() {
  panelContent.hidden = !supported || !sessionScope;
  feedback(panelMessage, !supported ? strings.update : !sessionScope ? strings.noSession : "");
  paintKey();
  paintGenerate();
}

function applyAppearance(appearance) {
  locale = typeof appearance?.locale === "string" && /^zh\b/i.test(appearance.locale) ? "zh-CN" : "en";
  strings = locale === "en" ? mediaTranslations.en : mediaTranslations.zh;
  dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  document.documentElement.lang = locale;
  document.documentElement.dataset.base = appearance?.base === "dark" ||
    (appearance?.base !== "light" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  document.title = strings.title;
  for (const element of document.querySelectorAll("[data-text]")) element.textContent = strings[element.dataset.text];
  for (const element of document.querySelectorAll("[data-label]")) element.setAttribute("aria-label", strings[element.dataset.label]);
  for (const element of document.querySelectorAll("[data-placeholder]")) element.placeholder = strings[element.dataset.placeholder];
  swapFrames.title = strings.swapFrames;
  paintForm();
  if (supported) paintPanel();
  if (sessionScope) paintHistory(sessionScope);
  preview.paint();
}

function activeScope(snapshot) {
  return typeof snapshot?.sessionId === "string" &&
    !snapshot.sessionId.startsWith("remote:") && !snapshot.sessionId.startsWith("native-pi:") &&
    !(typeof snapshot.projectPath === "string" && snapshot.projectPath.startsWith("remote-project:"))
    ? snapshot.sessionId : null;
}

function switchSession(snapshot) {
  const id = activeScope(snapshot);
  if ((sessionScope?.id ?? null) === id && sessionScope?.projectPath === snapshot?.projectPath) {
    paintPanel();
    return;
  }
  if (sessionScope) clearTimeout(sessionScope.poll);
  const currentMenu = document.querySelector(".composer-menu:popover-open");
  if (currentMenu) closeMenu(currentMenu);
  video.cancel();
  preview.close(false);
  library.close();
  if (settings.open) settings.close();
  thumbs.reset();
  for (const slot of frameSlots) {
    const thumb = slot.querySelector(".frame-thumb");
    thumb.replaceChildren();
  }
  keyInput.value = "";
  key.editing = false;
  sessionScope = id === null ? null : {
    id,
    projectPath: snapshot?.projectPath,
    projectAvailable: snapshot?.projectPath ? null : false,
    drafts: freshDrafts(),
    videoDrafts: new Map(),
    items: new Map(),
    nodes: new Map(),
    pages: [],
    nextCursor: null,
    submitting: new Set(),
    busy: false,
    loaded: false,
    loadFailed: false,
    poll: null,
    watchUntil: 0,
  };
  results.replaceChildren();
  panelContent.dataset.empty = "false";
  byId("empty-heading").hidden = true;
  feedback(byId("generate-message"), "");
  feedback(byId("key-message"), "");
  feedback(historyMessage, "");
  loadMore.hidden = true;
  paintForm();
  paintPanel();
  historyScroll.scrollTop = 0;
  paintHistoryNavigation();
  syncThumbnails();
  if (sessionScope) {
    void fetchHistory(sessionScope);
    void library.check(sessionScope);
  }
}

async function readKeyStatus() {
  if (key.busy) return;
  const request = keyVersion;
  try {
    const result = await bridge.invoke("media.keyStatus");
    if (request === keyVersion) {
      key.configured = result?.configured === true;
      referenceFrames = result?.referenceFrames === true;
      videoWorkflows = result?.videoWorkflows === true;
      imageWorkflows = result?.imageWorkflows === true;
      videoStitch = result?.videoStitch === true;
      paintKey();
      paintParameters(sessionScope?.drafts[mode]);
      paintFrames();
      paintGenerate();
    }
  } catch {
    if (request === keyVersion) feedback(byId("key-message"), strings.errorDefault, true);
  }
}

keyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = keyInput.value.trim();
  if (!value || key.busy) return;
  const scope = sessionScope;
  keyInput.value = "";
  keyVersion++;
  key.busy = true;
  paintKey();
  feedback(byId("key-message"), "");
  try {
    const result = await bridge.invoke("media.setKey", { key: value });
    key.configured = result?.configured === true;
    key.editing = false;
    if (sessionScope) {
      sessionScope.watchUntil = Date.now() + 8000;
      void fetchHistory(sessionScope);
    }
  } catch (error) {
    feedback(byId("key-message"), errorText(error, strings), true);
  } finally {
    key.busy = false;
    paintKey();
    paintGenerate();
    if (scope === sessionScope && settings.open && key.configured && !key.editing) byId("change-key").focus();
  }
});

byId("change-key").addEventListener("click", () => {
  key.editing = true;
  paintKey();
  keyInput.focus();
});

byId("cancel-key").addEventListener("click", () => {
  keyInput.value = "";
  key.editing = false;
  feedback(byId("key-message"), "");
  paintKey();
  byId("change-key").focus();
});

function resetComposerInput() {
  composerEpoch++;
  const draft = sessionScope?.drafts[mode];
  draft?.pendingAssets.clear();
  draft?.pendingFrames?.clear();
  video.cancel();
  if (preview.isOpen()) preview.close(false);
  library.close();
}

function selectMode(target) {
  if (mode === target) return;
  resetComposerInput();
  mode = target;
  feedback(byId("generate-message"), "");
  paintForm();
}

function switchAdvancedVideoDraft(scope, workflow) {
  const current = scope.drafts.video;
  scope.videoDrafts.set(current.workflow, current);
  scope.drafts.video = scope.videoDrafts.get(workflow) ?? newVideoWorkflowDraft(workflow);
}

function applyCreativeStarter(scope, kind, preset) {
  resetComposerInput();
  mode = kind;
  if (kind === "video" && scope.drafts.video.workflow !== "omni") switchAdvancedVideoDraft(scope, "omni");
  const draft = scope.drafts[kind];
  Object.assign(draft, preset);
  draft.revision++;
  feedback(byId("generate-message"), "");
  paintForm();
  promptInput.focus();
  promptInput.setSelectionRange(draft.prompt.length, draft.prompt.length);
}

for (const option of byId("mode-options").querySelectorAll("[data-mode]")) {
  option.addEventListener("click", () => {
    closeMenu(byId("mode-options"), byId("mode-trigger"));
    selectMode(option.dataset.mode);
  });
}
for (const option of byId("ratio-options").querySelectorAll("[data-ratio]")) {
  option.addEventListener("click", () => {
    const draft = sessionScope?.drafts[mode];
    if (!draft) return;
    draft.ratio = option.dataset.ratio;
    draft.revision++;
    paintParameters(draft);
  });
}
for (const [element, attribute, keyName, convert] of [
  ["ratio-options", "resolution", "resolution", String],
  ["image-area-options", "image-area", "area", String],
  ["count-options", "count", "count", Number],
  ["model-options", "model", "model", String],
]) {
  for (const option of byId(element).querySelectorAll(`[data-${attribute}]`)) {
    option.addEventListener("click", () => {
      const advanced = mode === "video" ? videoWorkflows : imageWorkflows;
      const draft = sessionScope?.drafts[mode];
      if (!draft || !advanced || option.hidden) return;
      draft[keyName] = convert(option.getAttribute(`data-${attribute}`));
      draft.revision++;
      paintParameters(draft);
      if (attribute === "model") closeMenu(byId(element), byId(`${attribute}-trigger`));
    });
  }
}
function updateLongDuration(value) {
  const draft = mode === "video" ? sessionScope?.drafts.video : null;
  if (!videoWorkflows || draft?.workflow !== "long" || value === draft.longDuration) return;
  draft.longDuration = value;
  draft.revision++;
  paintLongDuration(draft, true);
}

const longDurationSlider = byId("long-duration-slider");
const longDurationNumber = byId("long-duration");
for (const input of [longDurationSlider, longDurationNumber]) {
  input.min = String(longVideoMinSeconds);
  input.max = String(longVideoMaxSeconds);
}
bindDurationInputs(longDurationSlider, longDurationNumber, updateLongDuration);
for (const preset of byId("long-duration-options").querySelectorAll("[data-long-duration]")) {
  preset.addEventListener("click", () => updateLongDuration(Number(preset.dataset.longDuration)));
}

function openSettings() {
  if (settings.open) return;
  paintKey();
  settings.showModal();
  (key.configured ? byId("change-key") : keyInput).focus();
  syncThumbnails();
}
byId("open-settings").addEventListener("click", openSettings);
byId("composer-key").addEventListener("click", openSettings);
byId("close-settings").addEventListener("click", () => settings.close());
settings.addEventListener("close", () => {
  if (settings.open) return;
  keyInput.value = "";
  key.editing = false;
  paintKey();
  paintGenerate();
  syncThumbnails();
  // The composer trigger is replaced once a key is configured.
  if (sessionScope && !document.activeElement?.closest("#panel-content")) byId("open-settings").focus();
});

function setFrame(scope, role, frame) {
  if (scope !== sessionScope || mode !== "video") return;
  const draft = scope.drafts.video;
  if (!draft.useFrames) return;
  draft.pendingFrames.delete(role);
  if (frame) draft.frames[role] = frame;
  else delete draft.frames[role];
  draft.revision++;
  feedback(byId("generate-message"), "");
  paintFrames();
  paintGenerate();
}

swapFrames.addEventListener("click", () => {
  const draft = sessionScope?.drafts.video;
  if (swapFrames.disabled || !draft) return;
  const { first, last } = draft.frames;
  draft.frames = { ...(last ? { first: last } : {}), ...(first ? { last: first } : {}) };
  draft.requiredFrames = draft.requiredFrames.map((role) => role === "first" ? "last" : "first");
  draft.revision++;
  feedback(byId("generate-message"), "");
  paintFrames();
  paintGenerate();
});

for (const option of byId("frame-mode-options").querySelectorAll("[data-frame-mode]")) {
  option.addEventListener("click", () => {
    const scope = sessionScope;
    if (!scope || !referenceFrames) return;
    const requested = option.dataset.frameMode;
    if (!videoWorkflows && !["text", "frames"].includes(requested)) return;
    const workflow = requested === "text" ? "omni" : requested;
    closeMenu(byId("frame-mode-options"), byId("frame-mode-trigger"));
    const draft = scope.drafts.video;
    if (draft.workflow === workflow) return;
    resetComposerInput();
    if (videoWorkflows) {
      switchAdvancedVideoDraft(scope, workflow);
    } else {
      draft.workflow = workflow;
      draft.useFrames = workflow === "frames";
      if (!draft.useFrames) draft.requiredFrames = [];
    }
    feedback(byId("generate-message"), "");
    paintForm();
  });
}

for (const slot of frameSlots) {
  const role = slot.dataset.frame;
  const fileInput = slot.querySelector("input[type=file]");
  const tile = slot.querySelector("[data-frame-trigger]");
  const menu = slot.querySelector("[popover]");
  let openedFrom;
  const captureDraft = () => mode === "video" && sessionScope?.drafts.video.useFrames
    ? { scope: sessionScope, draft: sessionScope.drafts.video, epoch: composerEpoch } : null;
  const browse = () => {
    closeMenu(menu, tile);
    openedFrom = captureDraft();
    if (openedFrom) fileInput.click();
  };
  tile.addEventListener("click", () => {
    const state = captureDraft();
    const frame = state?.draft.frames[role];
    if (frame) {
      closeMenu(menu);
      void openFramePreview(state.scope, frame, tile);
    } else {
      browse();
    }
  });
  slot.querySelector("[data-frame-local]").addEventListener("click", browse);
  const choose = (tab) => {
    const scope = sessionScope;
    closeMenu(menu, tile);
    library.openFrame({
      tab, trigger: tile, title: strings[role === "first" ? "firstFrame" : "lastFrame"],
      select: (frame) => setFrame(scope, role, frame),
    });
  };
  slot.querySelector("[data-frame-library]").addEventListener("click", () => choose("assets"));
  slot.querySelector("[data-frame-subjects]").addEventListener("click", () => choose("subjects"));
  slot.querySelector("[data-frame-remove]").addEventListener("click", () => {
    closeMenu(menu, tile);
    if (sessionScope) {
      const draft = sessionScope.drafts.video;
      draft.requiredFrames = draft.requiredFrames.filter((required) => required !== role);
      setFrame(sessionScope, role, null);
    }
  });
  fileInput.addEventListener("cancel", () => { openedFrom = null; });
  async function loadFrame(started, file) {
    const { scope, draft, epoch } = started;
    const sameDraft = () => sessionScope === scope && mode === "video" && composerEpoch === epoch && scope.drafts.video === draft;
    if (!sameDraft()) return;
    const ticket = Symbol();
    draft.pendingFrames.set(role, ticket);
    paintGenerate();
    const current = () => sameDraft() && draft.pendingFrames.get(role) === ticket;
    try {
      const frame = await validateFrame(await readLocalFrame(file));
      if (current()) setFrame(scope, role, frame);
    } catch (error) {
      if (current() && mode === "video") feedback(byId("generate-message"), errorText(error, strings), true);
    } finally {
      if (current()) {
        draft.pendingFrames.delete(role);
        paintGenerate();
      }
    }
  }
  fileInput.addEventListener("change", () => {
    const started = openedFrom;
    openedFrom = null;
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (started && file) void loadFrame(started, file);
  });
  bindLocalMediaDrop(tile, () => {
    const state = captureDraft();
    return state && referenceFrames && !state.draft.pendingFrames.has(role) && !state.scope.submitting.has("video") ? tile : null;
  }, (_, files) => {
    const started = captureDraft();
    if (!started) return;
    closeMenu(menu, tile);
    if (files.length !== 1) {
      feedback(byId("generate-message"), errorText(new Error("FRAME_DROP_SINGLE"), strings), true);
      return;
    }
    void loadFrame(started, files[0]);
  });
}

promptInput.addEventListener("input", (event) => {
  if (!sessionScope) return;
  const draft = sessionScope.drafts[mode];
  draft.prompt = promptInput.value;
  draft.revision++;
  feedback(byId("generate-message"), "");
  video.typedMention(event);
  paintGenerate();
});

generateForm.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing && event.target instanceof HTMLInputElement) {
    event.preventDefault();
  }
});

generateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const scope = sessionScope;
  const kind = mode;
  const draft = scope?.drafts[kind];
  const prompt = draft?.prompt.trim();
  if (!scope || !draft || !prompt || !key.configured || key.editing || scope.submitting.has(kind) ||
      (kind === "video" ? !videoReady(draft) : !imageReady(draft))) return;
  if ([...prompt].length > 4000) {
    feedback(byId("generate-message"), strings.promptLength, true);
    promptInput.focus();
    return;
  }
  const workflow = draft.workflow;
  const visible = () => sessionScope === scope && mode === kind && scope.drafts[kind] === draft && draft.workflow === workflow;
  const revision = draft.revision;
  const epoch = composerEpoch;
  const submissionCurrent = () => visible() && composerEpoch === epoch && draft.revision === revision;
  let restoreGenerateFocus = false;
  scope.submitting.add(kind);
  paintGenerate();
  feedback(byId("generate-message"), "");
  try {
    let items;
    const input = { sessionId: scope.id, prompt, ratio: draft.ratio };
    const advanced = kind === "video" && videoWorkflows && (
      !["omni", "frames"].includes(workflow) || (workflow === "omni" && draft.references.length) ||
      draft.count !== 1 || draft.model !== "MiniMax-H3-Lite" || draft.resolution !== "480P" || ![4, 6, 8].includes(draft.duration) ||
      !legacyRatios.includes(draft.ratio)
    );
    const advancedImage = kind === "image" && imageWorkflows && (
      draft.references.length || draft.count !== 1 || draft.area !== "1K" ||
      draft.model !== defaultImageModel || !legacyRatios.includes(draft.ratio)
    );
    if (advancedImage) {
      const { area, model, count, references } = draft;
      if (count > 1) {
        const confirmation = video.confirmImage(count);
        syncThumbnails();
        const approved = await confirmation;
        syncThumbnails();
        if (!approved || !submissionCurrent()) {
          restoreGenerateFocus = !approved && submissionCurrent();
          return;
        }
      }
      const result = await bridge.invoke("media.submitImage", {
        ...input, area, model, count, confirmedCount: count,
        references: references.map(({ label, assets }) => ({ label, urls: assets.map(({ url }) => url) })),
      });
      items = Array.isArray(result?.items) ? result.items : [];
    } else if (advanced) {
      const request = videoWorkflowInput(draft, input);
      const quote = await bridge.invoke("media.quoteVideo", request);
      if (!submissionCurrent()) return;
      const durations = matchVideoQuote(request, quote);
      if (quote.requests > 1) {
        const confirmation = video.confirm(quote, request.mode, durations, request.count);
        syncThumbnails();
        const approved = await confirmation;
        syncThumbnails();
        if (!approved || !submissionCurrent()) {
          restoreGenerateFocus = !approved && submissionCurrent();
          return;
        }
      }
      const result = await bridge.invoke("media.submitVideo", { ...request, confirmedRequests: quote.requests });
      items = Array.isArray(result?.items) ? result.items : [];
    } else {
      const legacyInput = { ...input, kind };
      if (kind === "video") {
        legacyInput.duration = draft.duration;
        if (draft.useFrames && referenceFrames) {
          legacyInput.frames = Object.fromEntries(Object.entries(draft.frames).map(([role, frame]) => [role, frame.url]));
        }
      }
      items = [await bridge.invoke("media.submit", legacyInput)];
    }
    if (sessionScope === scope) {
      for (const item of items) {
        if (item?.sessionId === scope.id && typeof item.id === "string") scope.items.set(item.id, item);
      }
      paintHistory(scope);
      historyScroll.scrollTop = 0;
      paintHistoryNavigation();
    }
    if (visible()) feedback(byId("generate-message"), strings.accepted);
  } catch (error) {
    if (visible()) feedback(byId("generate-message"), errorText(error, strings, strings.submissionError), true);
    if (sessionScope === scope) void readKeyStatus();
  } finally {
    scope.submitting.delete(kind);
    if (sessionScope === scope) {
      paintGenerate();
      if (restoreGenerateFocus) generateButton.focus({ preventScroll: true });
      void fetchHistory(scope);
      planPoll(scope);
    }
  }
});

function reuseRecord(record) {
  const scope = sessionScope;
  if (scope?.id !== record.sessionId) return;
  resetComposerInput();
  if (record.kind === "image") {
    scope.drafts.image = {
      ...freshImageDraft(),
      prompt: record.prompt,
      ratio: imageWorkflows || legacyRatios.includes(record.ratio) ? record.ratio : "1:1",
      ...(imageWorkflows ? {
        area: record.imageArea ?? "1K", model: record.imageModel ?? defaultImageModel,
        requireImageReference: Boolean(record.imageReferenceCount),
      } : {}),
    };
  }
  if (record.kind === "video") {
    const workflow = videoWorkflows && Object.hasOwn(videoWorkflowNames, record.workflow) ? record.workflow
      : referenceFrames && record.frameMode ? "frames" : "omni";
    const previous = scope.drafts.video;
    if (videoWorkflows && previous.workflow !== workflow) scope.videoDrafts.set(previous.workflow, previous);
    scope.drafts.video = {
      ...newVideoWorkflowDraft(workflow),
      prompt: record.prompt,
      ratio: record.ratio,
      resolution: record.resolution ?? "480P",
      model: record.model ?? "MiniMax-H3-Lite",
      ...(workflow === "remake" && Object.hasOwn(remakeStrategyLabels, record.remakeStrategy)
        ? { remakeStrategy: record.remakeStrategy } : {}),
      ...(workflow === "long" ? { longDuration: record.duration, duration: 4 }
        : { duration: workflow === "multiframe" ? 4 : record.duration }),
      ...(workflow === "multiframe" ? { keyframes: restoreKeyframes(record) } : {}),
      requiredFrames: record.frameMode === "both" ? ["first", "last"] : record.frameMode ? [record.frameMode] : [],
    };
  }
  mode = record.kind;
  const draft = scope.drafts[mode];
  const requiresReferences = record.kind === "image" ? imageWorkflows && imageWorkflowError(draft) :
    videoWorkflows && ((record.workflow && !["omni", "long"].includes(record.workflow)) || mentionsIn(record.prompt).length);
  paintForm();
  const missing = draft.useFrames ? draft.requiredFrames[0] : null;
  const slot = frameSlots.find((item) => item.dataset.frame === missing);
  const firstKeyframe = draft.workflow === "multiframe" && byId("keyframe-sequence").querySelector(".keyframe-image");
  const firstReference = byId("reference-repairs").querySelector('[data-reference-state="missing"] [data-reference-replace]');
  const showReferenceReminder = requiresReferences && !firstKeyframe && byId("workflow-status").hidden;
  feedback(byId("generate-message"), draft.useFrames ? strings.pickFramesAgain : showReferenceReminder ? strings.restoreReferences : "");
  (slot?.querySelector("[data-frame-trigger]") || firstKeyframe || firstReference || promptInput).focus();
}

function buildResult(scope, record, details) {
  const li = make("li", "result");
  li.dataset.recordId = record.id;
  const open = (button) => showPreview(scope, record, button);
  if (record.status === "saved") {
    const cover = mediaCover(record.kind === "image" ? strings.imageKind : strings.videoKind, record.kind, open);
    cover.setAttribute("aria-label", `${strings.preview} ${record.prompt.slice(0, 120)}`);
    li.append(cover);
    thumbs.observe(cover, () => bridge.invoke("sessionMedia.source", { sessionId: scope.id, id: record.id }), record.kind);
  }
  const body = make("div", "result-body");
  const header = make("header");
  const meta = make("div", "result-meta");
  const kind = make("strong", "", record.kind === "image" ? strings.imageKind : strings.videoKind);
  const date = new Date(record.createdAt);
  const stamped = Number.isFinite(date.valueOf()) ? make("time", "", dateFormat.format(date)) : null;
  meta.append(kind);
  if (stamped) {
    stamped.dateTime = date.toISOString();
    meta.append(stamped);
  }
  const status = make("span", "result-status", strings[record.status === "saved" ? "archived" : record.status] ?? strings.loading);
  status.setAttribute("role", "status");
  status.dataset.state = record.status;
  header.append(meta, status);
  body.append(header, make("p", "result-prompt", record.prompt), make("p", "result-params", details));
  if (record.error) body.append(make("p", "result-error", errorText(record.error, strings)));

  const actions = make("div", "result-actions");
  const trigger = make("button", "result-menu-trigger", "···");
  trigger.type = "button";
  trigger.dataset.resultMenu = "";
  trigger.setAttribute("aria-label", strings.workActions);
  trigger.setAttribute("aria-haspopup", "menu");
  const menu = make("div", "composer-menu result-menu");
  menu.id = `result-menu-${++resultMenuId}`;
  menu.setAttribute("popover", "auto");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", strings.workActions);
  trigger.setAttribute("popovertarget", menu.id);
  const response = make("p", "message");
  response.hidden = true;
  response.setAttribute("role", "status");
  const appendAction = (name, label, run) => {
    const button = action(label, (element) => {
      closeMenu(menu, trigger);
      return run(element);
    }, "");
    button.dataset.resultAction = name;
    button.setAttribute("role", "menuitem");
    menu.append(button);
  };
  if (record.status === "saved") {
    appendAction("export", strings.saveAs, (button) => resultAction(record, button, response, "sessionMedia.export"));
    if (scope.projectAvailable) {
      appendAction("promote", strings.addToAssets, (button) => resultAction(record, button, response, "projectMedia.addFromSession"));
    }
  }
  appendAction("reuse", strings.reuse, () => reuseRecord(record));
  if (retryableSave(record)) {
    appendAction("retry", strings.retrySave, (button) => resultAction(record, button, response, "media.retrySave"));
  }
  actions.append(trigger, menu);
  header.append(actions);
  body.append(response);
  bindMenu(trigger, menu);
  li.append(body);
  return li;
}

async function resultAction(record, button, response, channel) {
  const scope = sessionScope;
  if (scope?.id !== record.sessionId) return;
  const exporting = channel === "sessionMedia.export";
  button.disabled = true;
  feedback(response, "");
  try {
    const output = await bridge.invoke(channel, { sessionId: scope.id, id: record.id });
    if (scope !== sessionScope) return;
    if (exporting) {
      if (output === true) feedback(response, strings.exportSuccess);
    } else if (channel === "projectMedia.addFromSession") {
      feedback(response, strings.addedToAssets);
    } else {
      feedback(response, strings.retryAccepted);
      scope.watchUntil = Date.now() + 8000;
      void fetchHistory(scope);
    }
  } catch (error) {
    if (scope === sessionScope) feedback(response, errorText(error, strings, exporting ? strings.exportFailure : strings.errorDefault), true);
  } finally {
    button.disabled = false;
  }
}

function paintHistoryNavigation() {
  const hasResults = results.childElementCount > 0;
  const showRecent = hasResults && historyScroll.scrollTop > 1;
  if (hasResults && !showRecent && document.activeElement === historyRecent) {
    historyScroll.focus({ preventScroll: true });
  }
  historyRecent.hidden = !showRecent;
}

historyScroll.addEventListener("scroll", paintHistoryNavigation, { passive: true });
historyRecent.addEventListener("click", () => {
  historyScroll.scrollTop = 0;
  historyScroll.focus({ preventScroll: true });
  paintHistoryNavigation();
});

function paintHistory(scope) {
  const records = [...scope.items.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const empty = scope.loaded && !scope.loadFailed && !records.length;
  panelContent.dataset.empty = String(empty);
  byId("empty-heading").hidden = !empty;
  creativeStarters.paint();
  let previous = null;
  for (const record of records) {
    const ratio = record.frameMode || record.workflow === "multiframe"
      ? strings.adaptiveRatio : record.ratio === "auto" ? strings.automaticRatio : record.ratio;
    const workflow = videoWorkflowNames[record.workflow];
    const strategy = record.workflow === "remake" ? strings[remakeStrategyLabels[record.remakeStrategy]] : "";
    const details = record.kind === "image" ? [
      ratio, record.imageArea ?? "1K", modelLabels[record.imageModel],
      record.imageReferenceCount ? strings.imageReferenceCount(record.imageReferenceCount) : "",
    ].filter(Boolean).join(" · ") :
      [workflow ? strings[workflow] : "", strategy, ratio, record.resolution ?? "480P", strings.secondsValue(record.duration)]
        .filter(Boolean).join(" · ");
    const hash = JSON.stringify([locale, record.status, record.error, details, scope.projectAvailable === true]);
    const existing = scope.nodes.get(record.id);
    let node = existing?.node;
    if (existing?.hash !== hash) {
      const next = buildResult(scope, record, details);
      const focused = node?.contains(document.activeElement);
      const coverFocused = focused && document.activeElement.matches(".media-cover");
      if (node) {
        const cover = node.querySelector(".media-cover");
        if (cover) thumbs.unobserve(cover);
        node.replaceWith(next);
      }
      if (focused) (coverFocused ? next.querySelector(".media-cover") : next.querySelector("[data-result-menu]"))?.focus();
      node = next;
      scope.nodes.set(record.id, { hash, node });
    }
    if (node !== (previous ? previous.nextElementSibling : results.firstElementChild)) {
      results.insertBefore(node, previous ? previous.nextElementSibling : results.firstElementChild);
    }
    previous = node;
  }

  feedback(historyMessage, scope.loadFailed ? strings.loadFailed
    : !scope.loaded ? strings.loading
    : !records.length ? strings.historyEmpty : "", scope.loadFailed);
  loadMore.textContent = scope.loadFailed ? strings.loadRetry : strings.loadMore;
  loadMore.hidden = !scope.loadFailed && !scope.nextCursor;
  loadMore.disabled = scope.busy;
  paintHistoryNavigation();
  scheduleMenuReposition();
}

function planPoll(scope) {
  clearTimeout(scope.poll);
  if (sessionScope !== scope) return;
  const pending = [...scope.items.values()].some((record) => pollingStates.has(record.status));
  if (pending || scope.submitting.size > 0 || Date.now() < scope.watchUntil) {
    scope.poll = setTimeout(() => void fetchHistory(scope), 1800);
  }
}

async function fetchHistory(scope, more = false) {
  if (sessionScope !== scope || scope.busy) return;
  if (more && !scope.nextCursor) return;
  scope.busy = true;
  paintHistory(scope);
  try {
    const firstCursor = more ? scope.nextCursor : null;
    const remaining = new Set(more ? [] : [...scope.items.values()].filter((record) => pollingStates.has(record.status)).map((record) => record.id));
    const pages = [];
    let cursor = firstCursor;
    do {
      const response = await bridge.invoke("sessionMedia.list", { sessionId: scope.id, ...(cursor ? { before: cursor } : {}) });
      if (scope !== sessionScope) return;
      if (!Array.isArray(response?.items)) throw new Error("HISTORY_UNAVAILABLE");
      for (const item of response.items) {
        if (item?.sessionId !== scope.id || typeof item.id !== "string" || !["image", "video"].includes(item.kind)) continue;
        if (item.error === "INVALID_KEY" && scope.items.get(item.id)?.error !== "INVALID_KEY") void readKeyStatus();
        scope.items.set(item.id, item);
        remaining.delete(item.id);
      }
      pages.push(response.nextCursor ?? null);
      cursor = response.nextCursor === cursor ? null : response.nextCursor ?? null;
    } while (!more && cursor && (pages.length < scope.pages.length || remaining.size));
    scope.pages = more ? [...scope.pages, ...pages] : pages;
    scope.nextCursor = cursor;
    scope.loaded = true;
    scope.loadFailed = false;
  } catch {
    if (sessionScope === scope) scope.loadFailed = true;
  } finally {
    scope.busy = false;
    if (sessionScope === scope) {
      paintHistory(scope);
      planPoll(scope);
    }
  }
}

loadMore.addEventListener("click", () => {
  const scope = sessionScope;
  if (scope) void fetchHistory(scope, !scope.loadFailed);
});

function showPreview(scope, record, trigger, channel = "sessionMedia.source") {
  preview.open(scope, [record], trigger, async () => {
    const url = await bridge.invoke(channel, { sessionId: scope.id, id: record.id });
    return isMediaUrl(url) ? { url } : null;
  }, { autoplay: true });
}

async function initialize() {
  if (!bridge) {
    applyAppearance(null);
    paintPanel();
    return;
  }
  const listeners = [
    bridge.on("appearance:changed", (appearance) => {
      appearanceVersion++;
      applyAppearance(appearance);
    }),
    bridge.on("session:activated", (snapshot) => {
      selectionVersion++;
      if (supported) switchSession(snapshot);
    }),
  ];
  window.addEventListener("pagehide", () => {
    listeners.forEach((unsubscribe) => unsubscribe());
    if (sessionScope) clearTimeout(sessionScope.poll);
    preview.close(false);
    video.cancel();
    library.close();
    thumbs.reset();
  }, { once: true });

  const appearanceRequest = appearanceVersion;
  const appearance = await bridge.invoke("app.getAppearance").catch(() => null);
  if (appearanceRequest === appearanceVersion) applyAppearance(appearance);
  supported = await bridge.invoke("sessionMedia.capabilities").catch(() => false) === true;
  paintPanel();
  if (!supported) return;
  void readKeyStatus();
  const request = selectionVersion;
  const snapshot = await bridge.invoke("session.getActive").catch(() => null);
  if (request === selectionVersion) switchSession(snapshot);
}

void initialize();
