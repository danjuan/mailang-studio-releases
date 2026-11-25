"use strict";

const videoWorkflowNames = {
  omni: "workflowOmni",
  frames: "referenceFrames",
  multiframe: "workflowMultiframe",
  edit: "workflowEdit",
  long: "workflowLong",
  remake: "workflowRemake",
};
const newKeyframe = () => ({ asset: null, duration: 4, prompt: "" });

function restoreKeyframes({ keyframeTransitions, plannedRequests, duration }) {
  if (!Array.isArray(keyframeTransitions) || keyframeTransitions.length !== plannedRequests ||
      keyframeTransitions.length < 1 || keyframeTransitions.length > 9) return [];
  const rows = [];
  let total = 0;
  for (const segment of keyframeTransitions) {
    if (!segment || !Number.isInteger(segment.duration) || segment.duration < 4 || segment.duration > 15 ||
        typeof segment.prompt !== "string" || segment.prompt.length > 300) return [];
    total += segment.duration;
    rows.push({ asset: null, duration: segment.duration, prompt: segment.prompt });
  }
  return total === duration ? [...rows, newKeyframe()] : [];
}

function newVideoWorkflowDraft(workflow = "omni") {
  return {
    workflow, model: "MiniMax-H3-Lite", resolution: "480P", count: 1, longDuration: 30, revision: 0,
    references: [], keyframes: [], pendingAssets: new Set(), videoSources: {}, remakeStrategy: "creative",
    prompt: "", ratio: "16:9", duration: 4, useFrames: workflow === "frames",
    frames: {}, pendingFrames: new Map(), requiredFrames: [],
  };
}

function editableVideoSource(draft) {
  return draft.videoSources.edit ?? draft.references.find(({ assets }) => assets.some(({ kind }) => kind === "video"));
}

function remakeInputError(draft) {
  const template = draft.videoSources.remake;
  if (!template) return "addRemakeVideo";
  if (draft.remakeStrategy === "creative") return "";
  const sourceUrl = template.assets[0].url;
  const hasMaterial = draft.references.some((entry) => entry !== template && entry.assets.some(
    ({ kind, url }) => kind === "image" || kind === "video" && url !== sourceUrl,
  ));
  return hasMaterial ? "" : "remakeOwnRequired";
}

function videoWorkflowError(draft, videoStitch) {
  if (!draft) return "";
  const { workflow, references, keyframes } = draft;
  if (!videoStitch && workflow === "long") return "stitchingUnavailable";
  if (!videoStitch && workflow === "multiframe" && keyframes.length > 2) return "multiframeNeedsStitch";
  if (workflow === "multiframe" && keyframes.length < 2) return "keyframesRequired";
  const usesOnlyFrames = ["frames", "multiframe"].includes(workflow);
  if (missingMentionLabels(draft).length || usesOnlyFrames && mentionsIn(draft.prompt).length) return "missingMention";
  if (workflow === "multiframe") {
    if (keyframes.some(({ asset }) => !asset)) return "pickFramesAgain";
    if (keyframes.slice(0, -1).some(({ duration }) => !Number.isInteger(duration) || duration < 4 || duration > 15)) {
      return "rangeHint";
    }
  }
  if (workflow === "long" && !splitLongVideoDuration(draft.longDuration)) {
    return "longRangeHint";
  }
  if (workflow === "remake") return remakeInputError(draft);
  if (!usesOnlyFrames) {
    const media = references.flatMap((entry) => entry.assets);
    const hasVideo = media.some(({ kind }) => kind === "video");
    if (!hasVideo && workflow === "edit") return "addSourceVideo";
    if (media.length && !media.some(({ kind }) => kind !== "audio")) return "visualReferenceRequired";
  }
  return "";
}

function videoWorkflowInput(draft, base) {
  const { workflow, model, resolution, count, references, keyframes, longDuration, frames } = draft;
  const mainVideo = workflow === "edit" ? editableVideoSource(draft) : draft.videoSources[workflow];
  const orderedReferences = mainVideo ? [mainVideo, ...references.filter((entry) => entry !== mainVideo)] : references;
  return {
    ...base, mode: workflow, model, resolution, count: workflow === "multiframe" ? 1 : count,
    duration: workflow === "long" ? longDuration : draft.duration,
    ...(workflow === "edit" && mainVideo?.editRegion ? { editRegion: mainVideo.editRegion } : {}),
    ...(workflow === "remake" ? { remakeStrategy: draft.remakeStrategy } : {}),
    ...(workflow === "frames" ? {
      frames: Object.fromEntries(Object.entries(frames).map(([role, frame]) => [role, frame.url])),
    } : workflow === "multiframe" ? {
      keyframes: keyframes.map(({ asset, duration, prompt }, index) => ({
        url: asset.url,
        ...(index < keyframes.length - 1 ? { duration, prompt: prompt.trim() } : {}),
      })),
    } : orderedReferences.length ? {
      references: orderedReferences.map(({ label, assets }) => ({ label, urls: assets.map(({ url }) => url) })),
    } : {}),
  };
}

function matchVideoQuote(request, quote) {
  const durations = request.mode === "long" ? splitLongVideoDuration(request.duration)
    : request.mode === "multiframe" ? request.keyframes.slice(0, -1).map(({ duration }) => duration)
    : [request.duration];
  const seconds = durations?.reduce((total, duration) => total + duration, 0);
  if (!seconds || quote?.requests !== durations.length * request.count ||
      quote.totalSeconds !== seconds * request.count) throw new Error("QUOTE_MISMATCH");
  return durations;
}

function createVideoWorkflow({
  getScope, getMode, getEpoch, labels, getLibrary, getCapabilities, prompt, editRegionEditor, openFramePreview, openReferencePreview,
  onChange, onError, onLayer,
}) {
  const keyframesNode = byId("keyframe-sequence");
  const updateKeyframeNavigation = createKeyframeNavigation(keyframesNode);
  const keyframeInput = byId("keyframe-file");
  const editTrigger = byId("video-edit-trigger");
  const editSourcePicker = byId("video-edit-source-picker");
  const editAssetPicker = byId("video-edit-asset-picker");
  const editSummary = byId("video-edit-summary");
  const quoteDialog = byId("video-quote");
  const clearButton = byId("clear-keyframes");
  const clearDialog = byId("clear-keyframes-dialog");
  const keyframeTargets = new WeakMap();
  let frameSelection;
  let clearSelection;
  let completeQuote;
  const cancelReorder = createKeyframeReorder(keyframesNode, () => {
    const draft = getScope()?.drafts.video;
    return getMode() === "video" && draft?.workflow === "multiframe" &&
      draft.keyframes.length > 1 && !draft.pendingAssets.size;
  }, (source, destination) => moveKeyframe(getScope().drafts.video.keyframes, source, destination));
  const references = createReferenceComposer({
    getScope, getMode, getEpoch, labels, getLibrary, prompt, openReferencePreview, onChange, onError,
    available: (kind) => kind === "image" ? getCapabilities().imageWorkflows : getCapabilities().advanced,
  });
  const { context, current, selectLocal, openLibrary } = references;
  const remake = createVideoRemakeUI({
    labels, onLayer,
    chooseLocal: (trigger) => selectLocal(context(trigger), true),
    chooseProject: (trigger) => openLibrary(context(trigger), "assets", true),
    chooseMaterial: (trigger) => selectLocal(context(trigger)),
    removeTemplate() {
      const draft = getScope()?.drafts.video;
      const entry = draft?.videoSources.remake;
      if (!entry) return;
      draft.references = draft.references.filter((reference) => reference !== entry);
      delete draft.videoSources.remake;
      prompt.value = prompt.value.replaceAll(`@[${entry.label}]`, "");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      onChange(true);
    },
    setStrategy(strategy) {
      const draft = getScope()?.drafts.video;
      if (draft?.workflow !== "remake" || !Object.hasOwn(remakeStrategyLabels, strategy)) return;
      draft.remakeStrategy = strategy;
      onChange();
    },
  });

  editSourcePicker.addEventListener("click", () => selectLocal(context(editSourcePicker), true));
  editAssetPicker.addEventListener("click", () => openLibrary(context(editAssetPicker), "assets", true));

  editTrigger.addEventListener("click", () => {
    const state = context(editTrigger);
    if (!state || state.workflow !== "edit") return;
    const entry = editableVideoSource(state.draft);
    const source = entry?.assets.find(({ kind }) => kind === "video");
    if (!source) return;
    editRegionEditor.open({
      source: source.url, region: entry.editRegion, trigger: editTrigger,
      apply(region) {
        if (!current(state) || editableVideoSource(state.draft) !== entry) return;
        entry.editRegion = region;
        onChange();
      },
    });
  });

  function selectKeyframe(state, entry, trigger, append) {
    if (!state || state.draft.pendingAssets.size) return;
    frameSelection = { state, entry, trigger, append };
    keyframeInput.click();
  }

  function storeKeyframe(state, entry, asset, append) {
    if (!current(state)) return;
    const rows = state.draft.keyframes;
    if (append) {
      if (entry.asset || rows.length >= 10) return;
      rows.push(entry);
    } else if (!rows.includes(entry)) return;
    entry.asset = asset;
    return () => {
      onChange(true);
      focusKeyframe(rows.indexOf(entry));
    };
  }

  async function readKeyframe({ state, entry, trigger, append }, files) {
    if (!current(state) || state.draft.pendingAssets.size || !files.length) return;
    if (files.length !== 1) {
      onError(frameFailure("FRAME_DROP_SINGLE"));
      trigger.focus({ preventScroll: true });
      return;
    }
    const ticket = Symbol();
    state.draft.pendingAssets.add(ticket);
    feedback(byId("generate-message"), "");
    onChange();
    try {
      const asset = await validateFrame(await readLocalFrame(files[0]));
      storeKeyframe(state, entry, asset, append)?.();
    } catch (error) {
      if (current(state)) {
        onError(error);
        trigger.focus({ preventScroll: true });
      }
    } finally {
      state.draft.pendingAssets.delete(ticket);
      if (current(state)) onChange();
    }
  }

  bindLocalMediaDrop(keyframesNode, (element) => {
    if (keyframesNode.hidden || frameSelection) return null;
    const target = element.closest(".keyframe-image");
    if (!keyframeTargets.has(target)) return null;
    const state = context(target);
    if (state?.workflow !== "multiframe" || state.scope.submitting.has("video") || state.draft.pendingAssets.size) return null;
    return target;
  }, (trigger, files) => {
    const { entry, append } = keyframeTargets.get(trigger);
    void readKeyframe({ state: context(trigger), entry, trigger, append }, files);
  });

  keyframeInput.addEventListener("cancel", () => {
    if (current(frameSelection?.state)) frameSelection.trigger.focus({ preventScroll: true });
    frameSelection = null;
  });
  keyframeInput.addEventListener("change", () => {
    const opened = frameSelection;
    frameSelection = null;
    const file = keyframeInput.files?.[0];
    keyframeInput.value = "";
    if (opened && file) void readKeyframe(opened, [file]);
  });

  function focusKeyframe(index) {
    const tile = keyframesNode.querySelector(`[data-keyframe-index="${index}"] .keyframe-image`)
      ?? keyframesNode.querySelector(".keyframe-card:last-child .keyframe-image");
    tile?.focus({ preventScroll: true });
    tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function moveKeyframe(rows, source, destination) {
    if (destination < 0 || destination >= rows.length || destination === source) return;
    const [frame] = rows.splice(source, 1);
    rows.splice(destination, 0, frame);
    onChange(true);
    focusKeyframe(destination);
  }

  clearButton.addEventListener("click", () => {
    const state = context(clearButton);
    if (state?.workflow !== "multiframe" || clearButton.disabled || !state.draft.keyframes.length) return;
    clearSelection = state;
    clearDialog.showModal();
    onLayer();
  });

  function closeClearKeyframes(confirmed, restoreFocus = true) {
    if (!clearDialog.open) return;
    const state = clearSelection;
    clearSelection = null;
    clearDialog.close();
    onLayer();
    if (!current(state) || !restoreFocus) return;
    if (!confirmed) {
      clearButton.focus({ preventScroll: true });
      return;
    }
    state.draft.keyframes = [];
    state.draft.prompt = "";
    prompt.value = "";
    feedback(byId("generate-message"), "");
    onChange(true);
    focusKeyframe(0);
  }

  byId("clear-keyframes-cancel").addEventListener("click", () => closeClearKeyframes(false));
  byId("clear-keyframes-confirm").addEventListener("click", () => closeClearKeyframes(true));
  clearDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeClearKeyframes(false);
  });

  function keyframeTransition(entry, index, text) {
    const transition = make("div", "keyframe-transition");
    const name = text.transitionBetween(index + 1, index + 2);
    const trigger = make("button", "keyframe-transition-trigger");
    const menu = make("div", "composer-menu keyframe-transition-menu");
    menu.id = `keyframe-transition-${index}`;
    menu.popover = "auto";
    menu.setAttribute("role", "dialog");
    const heading = make("h3", "keyframe-transition-heading", name);
    heading.id = `${menu.id}-heading`;
    menu.setAttribute("aria-labelledby", heading.id);
    trigger.type = "button";
    trigger.dataset.keyframeTransitionTrigger = "";
    trigger.popoverTargetElement = menu;
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-controls", menu.id);
    trigger.title = name;

    const duration = make("input");
    duration.type = "number";
    duration.min = "4";
    duration.max = "15";
    duration.value = Number.isFinite(entry.duration) ? String(entry.duration) : "";
    duration.autofocus = true;
    duration.setAttribute("aria-label", `${name} · ${text.secondsInput}`);
    const instruction = make("input");
    instruction.type = "text";
    instruction.maxLength = 300;
    instruction.value = entry.prompt;
    instruction.placeholder = text.transitionPrompt;
    instruction.setAttribute("aria-label", `${name} · ${text.transitionPrompt}`);

    function paintDuration() {
      const value = duration.value && duration.validity.valid ? text.secondsValue(entry.duration) : "—";
      trigger.textContent = value;
      trigger.setAttribute("aria-label", `${name} · ${value}`);
    }

    duration.addEventListener("input", () => {
      entry.duration = duration.valueAsNumber;
      paintDuration();
      onChange();
      scheduleMenuReposition();
    });
    instruction.addEventListener("input", () => {
      entry.prompt = instruction.value;
      onChange();
    });
    const timing = make("label", "workflow-duration");
    timing.append(make("span", "", text.transition), duration, make("span", "", text.secondsInput));
    paintDuration();
    menu.append(heading, timing, instruction);
    transition.append(trigger, menu);
    bindMenu(trigger, menu);
    return transition;
  }

  function pendingKeyframeTransition(index, text) {
    const zero = text.secondsValue(0);
    const hint = text.transitionNeedsFrame(index + 2);
    const button = make("button", "keyframe-transition-trigger keyframe-transition-pending", zero);
    button.type = "button";
    button.disabled = true;
    button.dataset.keyframeTransitionPending = "";
    button.title = hint;
    button.setAttribute("aria-label", `${text.transitionBetween(index + 1, index + 2)} · ${zero} · ${hint}`);
    return button;
  }

  function paintKeyframes(draft) {
    cancelReorder();
    const text = labels();
    const rows = draft.keyframes;
    const appendable = rows.length < 10 && rows.every(({ asset }) => asset);
    const items = appendable ? [...rows, newKeyframe()] : rows;
    keyframesNode.dataset.populated = String(rows.length > 0);
    const cards = items.map((entry, index) => {
      const append = index === rows.length;
      const card = make("div", "keyframe-card");
      const body = make("div", "keyframe-body");
      card.dataset.keyframeIndex = String(index);
      card.dataset.empty = String(!entry.asset);
      card.dataset.append = String(append);
      const name = text.keyframeName(index + 1);
      const image = action("", (button) => {
        const state = context(button);
        if (!state) return;
        if (entry.asset) void openFramePreview(state.scope, entry.asset, button);
        else selectKeyframe(state, entry, button, append);
      }, "keyframe-image");
      keyframeTargets.set(image, { entry, append });
      image.setAttribute("aria-label", entry.asset
        ? `${name} · ${entry.asset.name} · ${text.imagePreview}`
        : `${name} · ${text.fromDevice}`);
      if (entry.asset) image.setAttribute("aria-haspopup", "dialog");
      if (!append) {
        const header = make("div", "keyframe-header");
        const order = make("div", "keyframe-order");
        const earlier = action("←", () => moveKeyframe(rows, index, index - 1));
        earlier.disabled = !index;
        earlier.setAttribute("aria-label", `${name} · ${text.moveEarlier}`);
        const later = action("→", () => moveKeyframe(rows, index, index + 1));
        later.disabled = index === rows.length - 1;
        later.setAttribute("aria-label", `${name} · ${text.moveLater}`);
        const remove = action("×", () => {
          rows.splice(index, 1);
          onChange(true);
          focusKeyframe(Math.min(index, rows.length));
        });
        remove.dataset.keyframeRemove = "";
        remove.setAttribute("aria-label", `${text.remove} ${name}`);
        order.append(earlier, later, remove);
        header.append(make("span", "", name), order);
        body.append(header);
      }
      if (entry.asset) {
        const thumb = make("img");
        thumb.alt = "";
        thumb.src = entry.asset.url;
        thumb.draggable = false;
        image.append(thumb);
      } else {
        image.classList.add("keyframe-add");
        const plus = make("span", "keyframe-plus", "+");
        plus.setAttribute("aria-hidden", "true");
        image.append(plus, make("span", "", name));
      }
      const media = make("div", "keyframe-media");
      media.append(image);
      if (!append && rows.length > 1) {
        const grip = make("span", "keyframe-grip");
        grip.title = text.reorderKeyframe;
        grip.setAttribute("aria-hidden", "true");
        media.append(grip);
      }
      if (entry.asset) {
        const replace = action(text.replaceReference, (button) => selectKeyframe(context(button), entry, button, false),
          "reference-source keyframe-replace");
        replace.setAttribute("aria-label", `${name} · ${text.replaceFromDevice}`);
        media.append(replace);
      }
      if (getScope().projectAvailable === true) {
        const library = action("", (button) => {
          const state = context(button);
          if (!state || state.draft.pendingAssets.size) return;
          getLibrary().openFrame({
            trigger: button, title: name,
            select: (asset) => storeKeyframe(state, entry, asset, append),
          });
        }, "reference-source keyframe-library");
        library.setAttribute("aria-label", `${name} · ${text.fromProjectImage}`);
        library.setAttribute("aria-haspopup", "dialog");
        library.title = text.fromProjectImage;
        const icon = make("span", "keyframe-library-icon");
        icon.setAttribute("aria-hidden", "true");
        library.append(icon);
        media.append(library);
      }
      body.append(media);
      card.append(body);
      if (index < rows.length - 1) card.append(keyframeTransition(entry, index, text));
      else if (appendable && !append) card.append(pendingKeyframeTransition(index, text));
      return card;
    });
    keyframesNode.replaceChildren(...cards);
  }

  function paint(draft) {
    const { advanced } = getCapabilities();
    const visible = Boolean(draft && advanced && getMode() === "video");
    const usingRefs = visible && !["frames", "multiframe"].includes(draft.workflow);
    const usingKeyframes = visible && draft.workflow === "multiframe";
    const usingImageRefs = getMode() === "image" && getCapabilities().imageWorkflows && getScope();
    const showReferenceTiles = Boolean(usingImageRefs) || visible && ["omni", "long"].includes(draft.workflow);
    references.paint(usingImageRefs ? getScope().drafts.image : draft, {
      enabled: usingRefs || Boolean(usingImageRefs),
      inline: showReferenceTiles || visible && draft.workflow === "edit",
      tiles: showReferenceTiles,
      editEntry: visible && draft.workflow === "edit" ? editableVideoSource(draft) : null,
      template: visible && draft.workflow === "remake" ? draft.videoSources.remake : null,
    });
    keyframesNode.hidden = !usingKeyframes;
    if (usingKeyframes) paintKeyframes(draft);
    else {
      cancelReorder();
      keyframesNode.replaceChildren();
    }
    updateKeyframeNavigation();
    status(draft);
  }

  function status(draft) {
    const { advanced, videoStitch, imageWorkflows } = getCapabilities();
    const visible = advanced && getMode() === "video" && draft;
    remake.paint(draft, visible && draft.workflow === "remake", getScope()?.projectAvailable === true);
    const image = getMode() === "image" && imageWorkflows ? getScope()?.drafts.image : null;
    const error = image ? imageWorkflowError(image) : visible ? videoWorkflowError(draft, videoStitch) : "";
    const node = byId("workflow-status");
    const editing = visible && draft.workflow === "edit";
    const source = editing && editableVideoSource(draft);
    const reading = editing && draft.pendingAssets.size > 0;
    byId("video-edit-source-controls").hidden = !editing;
    editAssetPicker.hidden = !editing || getScope().projectAvailable !== true;
    editAssetPicker.disabled = reading;
    editSourcePicker.disabled = reading;
    byId("video-edit-source-label").textContent = labels()[source ? "videoEditReplace" : "attachSource"];
    editTrigger.hidden = !editing;
    editTrigger.disabled = !source || reading;
    const region = source?.editRegion;
    feedback(editSummary, region ? labels().videoEditMarked(region.atSeconds) : "");
    const duration = byId("keyframe-duration");
    const usingKeyframes = visible && draft.workflow === "multiframe";
    duration.hidden = !usingKeyframes;
    clearButton.hidden = !usingKeyframes || !draft.keyframes.length;
    clearButton.disabled = Boolean(usingKeyframes && (draft.pendingAssets.size || getScope().submitting.has("video")));
    if (usingKeyframes) {
      const total = draft.keyframes.slice(0, -1).reduce((seconds, frame) => seconds + frame.duration, 0);
      const value = !Number.isFinite(total) || error === "rangeHint" ? "—" : labels().secondsValue(total);
      duration.textContent = value;
      duration.setAttribute("aria-label", `${labels().totalDuration} · ${value}`);
    }
    feedback(node, error && error !== "keyframesRequired" ? labels()[error] : "");
    const setup = byId("workflow-setup");
    setup.hidden = !setup.querySelector(":scope > :not([hidden])");
  }

  byId("video-quote-cancel").addEventListener("click", () => quoteDialog.close("cancel"));
  byId("video-quote-approve").addEventListener("click", () => quoteDialog.close("approve"));
  quoteDialog.addEventListener("close", () => {
    const finish = completeQuote;
    completeQuote = null;
    finish?.(quoteDialog.returnValue === "approve");
  });

  function showConfirmation({ title, summary, breakdown = "", billing }) {
    byId("video-quote-title").textContent = title;
    byId("video-quote-summary").textContent = summary;
    const details = byId("video-quote-breakdown");
    details.replaceChildren(breakdown);
    details.hidden = !breakdown;
    byId("video-quote-billing").textContent = billing;
    quoteDialog.returnValue = "";
    quoteDialog.showModal();
    return new Promise((finish) => { completeQuote = finish; });
  }

  function confirm({ requests, totalSeconds }, workflow, durations, outputs) {
    const text = labels();
    let breakdown;
    if (workflow === "multiframe") {
      breakdown = make("ol", "quote-transitions");
      durations.forEach((duration, index) => {
        const item = make("li");
        item.append(
          make("span", "", text.transitionBetween(index + 1, index + 2)),
          make("strong", "", text.secondsValue(duration)),
        );
        breakdown.append(item);
      });
    } else if (workflow === "long") {
      breakdown = text.longSegmentBreakdown(durations, outputs);
    }
    return showConfirmation({
      title: text.confirmVideo, summary: text.requestSummary(requests, totalSeconds),
      breakdown,
      billing: text[durations.length > 1 ? "segmentBillingHint" : "billingHint"],
    });
  }

  function confirmImage(count) {
    const text = labels();
    return showConfirmation({ title: text.confirmImage, summary: text.imageBatchSummary(count), billing: text.imageBillingHint });
  }

  return {
    paint, status, typedMention: references.typedMention, confirm, confirmImage,
    layerOpen: () => remake.isOpen() || clearDialog.open,
    cancel() {
      references.cancel();
      cancelReorder();
      frameSelection = null;
      closeClearKeyframes(false, false);
      editRegionEditor.close({ restoreFocus: false });
      remake.close();
      if (quoteDialog.open) quoteDialog.close("cancel");
      keyframesNode.replaceChildren();
      updateKeyframeNavigation();
    },
  };
}
