"use strict";

const videoInputLimits = { image: frameLimit, video: 50_000_000, audio: 15_000_000 };
const videoInputCounts = { image: 9, video: 3, audio: 3 };
const referenceMime = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav",
};
const referenceTypes = new Set(Object.values(referenceMime));
const encodedReferenceLimit = 63_500_000;
const referenceMentionPattern = /@\[([^\[\]\r\n]{1,100})\]/gu;

function mentionsIn(text) {
  return [...text.matchAll(referenceMentionPattern)].map((match) => match[1]);
}

function expandReferenceDeletion(prompt, backward, freshEnd) {
  const { selectionStart, selectionEnd, selectionDirection, value } = prompt;
  let start = selectionStart;
  let end = selectionEnd;
  const collapsed = start === end;
  const afterInsertedSpace = backward && collapsed && start === freshEnd && value[start - 1] === " ";
  const point = backward ? start - (afterInsertedSpace ? 2 : 1) : start;
  for (const match of value.matchAll(referenceMentionPattern)) {
    const from = match.index;
    const to = from + match[0].length;
    const overlaps = collapsed ? from <= point && point < to : from < selectionEnd && selectionStart < to;
    if (!overlaps) continue;
    start = Math.min(start, from);
    end = Math.max(end, to);
  }
  // Let the browser delete this selection so undo restores the entire mention.
  if (start !== selectionStart || end !== selectionEnd) prompt.setSelectionRange(start, end, selectionDirection);
}

function missingMentionLabels(draft) {
  const attached = new Set(draft.references.map(({ label }) => label));
  return [...new Set(mentionsIn(draft.prompt))].filter((label) => !attached.has(label));
}

function imageWorkflowError(draft) {
  if (missingMentionLabels(draft).length) return "missingMention";
  return draft.requireImageReference && !draft.references.length ? "restoreReferences" : "";
}

function validateReferenceList(references) {
  const media = references.flatMap(({ assets }) => assets);
  if (media.length > 12 || Object.entries(videoInputCounts).some(([kind, count]) => media.filter((item) => item.kind === kind).length > count)) {
    throw new Error("REFERENCE_LIMIT");
  }
  if (media.reduce((bytes, { url }) => bytes + url.length, 0) > encodedReferenceLimit) throw new Error("REFERENCE_TOO_LARGE");
}

function readBlobUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("INVALID_REFERENCE"));
    reader.readAsDataURL(blob);
  });
}

async function readLocalReference(file) {
  const reported = file.type === "audio/x-wav" ? "audio/wav" : file.type;
  const mime = reported || referenceMime[file.name.toLowerCase().split(".").at(-1)];
  if (!referenceTypes.has(mime)) throw new Error("INVALID_REFERENCE");
  const kind = mime.split("/")[0];
  if (!file.size) throw new Error("INVALID_REFERENCE");
  if (file.size > videoInputLimits[kind]) throw new Error("REFERENCE_TOO_LARGE");
  if (kind === "image") return { ...await validateFrame(await readLocalFrame(file)), kind };
  const url = await readBlobUrl(new Blob([file], { type: mime }));
  return { name: file.name, kind, url };
}

function createReferenceComposer({
  getScope, getMode, getEpoch, labels, getLibrary, available, prompt, openReferencePreview, onChange, onError,
}) {
  const mention = byId("reference-trigger");
  const menu = byId("reference-options");
  const results = byId("reference-results");
  const projectSubjects = byId("reference-project-subjects");
  const projectAssets = byId("reference-project-assets");
  const projectGroups = [projectSubjects, projectAssets];
  const categories = byId("reference-categories");
  const categoryButtons = ["all", ...projectSubjectKinds].map((kind) => {
    const key = kind === "all" ? "allReferences" : kind;
    const button = action(labels()[key], () => {
      if (!referenceMenuIsCurrent(selection)) return;
      selection.category = kind;
      filterMenuEntries(selection);
    }, "");
    button.tabIndex = -1;
    button.dataset.referenceCategory = kind;
    button.dataset.text = key;
    button.setAttribute("role", "menuitemradio");
    categories.append(button);
    return button;
  });
  const noMatches = byId("reference-no-matches");
  const thumbs = thumbnailLoader(menu);
  const referencesNode = byId("reference-bindings");
  const repairsNode = byId("reference-repairs");
  const workflowSetup = byId("workflow-setup");
  const referenceRail = byId("reference-rail");
  const referenceAdd = byId("reference-add");
  const referenceInput = byId("reference-file");
  const composerInput = prompt.closest(".composer-input");
  let selection;
  let localSelection;
  let composing = false;
  let promptVersion = 0;
  let lastInputValue = prompt.value;
  let referenceEdits = [];
  let freshReferenceEnd = -1;
  let visibleReferences;
  let previousView;
  const promptTargets = createPromptReferenceTargets({ prompt, pattern: referenceMentionPattern, labels, open(reference, target) {
    const state = context(target);
    if (composing || state?.draft !== reference.draft || !state.draft.references.includes(reference.entry)) return;
    closeMenu(menu);
    openReferencePreview(state.scope, reference.entry.assets, target, () => current(state) ? prompt : null);
  } });

  prompt.addEventListener("input", (event) => {
    const before = lastInputValue;
    lastInputValue = prompt.value;
    promptVersion++;
    freshReferenceEnd = -1;
    if (!event.isTrusted) referenceEdits = [];
    else if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      restoreReferenceEdit(before, event.inputType === "historyUndo");
    } else if (referenceEdits.length) {
      referenceEdits = referenceEdits.filter((edit) => {
        // A manual paste or retype can replay the same text edit. Native undo
        // does not identify the command, so leave those attachments alone.
        edit.replayedStart ||= edit.before === before;
        return !edit.undone && !(edit.replayedStart && edit.after === lastInputValue);
      });
    }
  });
  menu.addEventListener("beforetoggle", (event) => {
    thumbs.setEnabled(event.newState === "open");
    if (event.newState === "closed") thumbs.reset();
  });
  categories.addEventListener("mousedown", (event) => {
    if (selection?.trigger === prompt && document.activeElement === prompt) event.preventDefault();
  });

  setMenuPlacement(menu, () => {
    if (!current(selection)) return null;
    const { trigger, start, end, projectAvailable } = selection;
    const placement = { trigger, keepFocus: true, gap: 12, offsetX: -12,
      preferredAboveRoom: projectAvailable ? 96 : undefined };
    if (trigger === mention) {
      // Use the button for horizontal alignment, visibility, and focus.
      // Leave the prompt visible when opening above the toolbar.
      return { ...placement, aboveAnchorTop: prompt.getBoundingClientRect().top };
    }
    if (trigger !== prompt) return placement;
    if (prompt.value[start] !== "@") return null;
    // Keep the original marker as the anchor while visible. A wrapped search
    // can scroll that marker out even though the user is still typing it.
    const indices = [start];
    if (end > start + 1 && prompt.selectionStart === end && prompt.selectionEnd === end) indices.push(end - 1);
    const anchor = textareaCharacterBounds(prompt, indices);
    if (!anchor) return null;
    const promptTop = prompt.getBoundingClientRect().top;
    const inset = parseFloat(getComputedStyle(prompt).paddingTop) + prompt.clientTop;
    return { ...placement, anchor, aboveAnchorTop: Math.max(promptTop, anchor.top - inset) };
  });

  function context(trigger, typed = false) {
    const scope = getScope();
    const kind = getMode();
    if (!scope || !available(kind)) return null;
    const draft = scope.drafts[kind];
    const end = prompt.selectionStart;
    const start = typed ? end - 1 : end;
    return { scope, kind, draft, workflow: draft.workflow, epoch: getEpoch(), trigger, start, end, promptVersion };
  }

  function current(state) {
    return state && state.epoch === getEpoch() && state.scope === getScope() && getMode() === state.kind &&
      state.scope.drafts[state.kind] === state.draft && state.draft.workflow === state.workflow && available(state.kind);
  }

  function selectionCurrent(state) {
    return current(state) && state.promptVersion === promptVersion;
  }

  function restoreReferenceCaret(state) {
    if (selectionCurrent(state) && state.trigger === prompt) prompt.setSelectionRange(state.end, state.end);
  }

  function restoreReferenceEdit(before, undo) {
    const draft = getScope()?.drafts[getMode()];
    const edit = referenceEdits.findLast((entry) => entry.draft === draft && entry.undone !== undo &&
      entry[undo ? "after" : "before"] === before && entry[undo ? "before" : "after"] === prompt.value);
    if (!edit) return;
    const { entries, previous, previousIndex, videoOnly, previousVideo, workflow } = edit;
    const prior = previous ? [previous] : [];
    const removed = undo ? entries : prior;
    const restored = undo ? prior : entries;
    if (removed.some((entry) => !draft.references.includes(entry))) return;
    const remaining = draft.references.filter((entry) => !removed.includes(entry));
    if (restored.some(({ label }) => remaining.some((entry) => entry.label === label))) return;
    if (videoOnly && draft.videoSources[workflow] !== (undo ? entries[0] : previousVideo)) return;
    remaining.splice(previousIndex, 0, ...restored);
    draft.references = remaining;
    if (videoOnly) {
      const source = undo ? previousVideo : entries[0];
      if (source) draft.videoSources[workflow] = source;
      else delete draft.videoSources[workflow];
    }
    edit.undone = undo;
    onChange(true);
  }

  function insertMentions(state, entries, attachment) {
    if (!selectionCurrent(state)) return;
    prompt.focus({ preventScroll: true });
    const value = prompt.value;
    const { start, end } = state;
    const prefix = start > 0 && !/\s/u.test(value[start - 1]) ? " " : "";
    const content = entries.map(({ label }) => `@[${label}]`).join(" ");
    const text = prefix + content + " ";
    prompt.setSelectionRange(start, end);
    // Match each native text edit to the attachments that it added or replaced.
    if (document.execCommand("insertText", false, text)) {
      if (attachment) referenceEdits.push({
        ...attachment, entries, draft: state.draft, workflow: state.workflow, before: value, after: prompt.value, undone: false,
      });
    } else {
      prompt.setRangeText(text, start, end, "end");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    }
    freshReferenceEnd = prompt.selectionEnd;
  }

  function priorReference(state, videoOnly) {
    if (videoOnly) {
      return state.workflow === "edit" ? editableVideoSource(state.draft) : state.draft.videoSources[state.workflow];
    }
    if (state.targetLabel !== undefined) return state.draft.references.find(({ label }) => label === state.targetLabel);
  }

  function addBindings(state, groups, videoOnly = false) {
    if (!selectionCurrent(state)) return;
    const { draft, targetLabel } = state;
    const previous = priorReference(state, videoOnly);
    if (targetLabel !== undefined && groups.length !== 1) throw new Error("REFERENCE_LIMIT");
    if (targetLabel !== undefined && !previous && !mentionsIn(draft.prompt).includes(targetLabel)) return;
    const existing = draft.references.filter((entry) => entry !== previous);
    const entries = [];
    for (const { name, assets, subjectId, subjectKind } of groups) {
      const naming = name.normalize("NFC").replace(/[\[\]@\x00-\x1f\x7f]/gu, " ").replace(/\s+/gu, " ").trim();
      const base = [...(naming || labels().referenceDetails)].slice(0, 52).join("");
      let label = base;
      for (let suffix = 2; existing.some((entry) => entry.label === label); suffix++) label = `${base} ${suffix}`;
      const entry = { label: targetLabel ?? previous?.label ?? label, assets, subjectId, subjectKind, sourceName: name };
      existing.push(entry);
      entries.push(entry);
    }
    if (state.kind === "image" && entries.some((entry) => entry.assets.some(({ kind }) => kind !== "image"))) {
      throw new Error("INVALID_REFERENCE");
    }
    validateReferenceList(existing);
    const previousIndex = previous ? draft.references.indexOf(previous) : draft.references.length;
    const previousVideo = videoOnly ? draft.videoSources[state.workflow] : undefined;
    draft.references = previous ? draft.references.map((entry) => entry === previous ? entries[0] : entry) : existing;
    if (videoOnly) draft.videoSources[state.workflow] = entries[0];
    onChange(true);
    if (targetLabel !== undefined || previous && mentionsIn(prompt.value).includes(previous.label)) {
      referenceEdits = referenceEdits.filter(({ entries, undone }) => !undone && !entries.includes(previous));
      return () => prompt.focus({ preventScroll: true });
    }
    return () => insertMentions(state, entries, { previous, previousIndex, videoOnly, previousVideo });
  }

  function openLibrary(state, tab, videoOnly = false) {
    if (!current(state) || state.scope.projectAvailable !== true) return;
    closeMenu(menu);
    const text = labels();
    getLibrary().open({
      tab, trigger: state.trigger,
      onRestoreFocus: () => restoreReferenceCaret(state),
      pick: {
        kind: videoOnly ? "video" : "reference",
        title: videoOnly ? (state.workflow === "edit" ? text.attachSource : text.chooseTemplate) :
          state.targetLabel !== undefined ? text.chooseReferenceFor(state.targetLabel) : text.mentionMedia,
        kinds: state.kind === "image" ? ["image"] : videoOnly ? ["video"] : ["image", "video", "audio"],
        subjects: !videoOnly,
        select: (name, assets, subject) => addBindings(state, [{ name, assets, ...subject }], videoOnly),
      },
    });
  }

  function selectLocal(state, videoOnly = false) {
    if (!current(state)) return;
    closeMenu(menu);
    localSelection = { state, videoOnly };
    referenceInput.multiple = !videoOnly && state.targetLabel === undefined;
    const images = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";
    referenceInput.accept = state.kind === "image" ? images : videoOnly ? "video/mp4,.mp4" :
      images + ",video/mp4,audio/mpeg,audio/wav,.mp4,.mp3,.wav";
    referenceInput.click();
  }

  referenceAdd.addEventListener("click", () => {
    if (!referenceRail.hidden) selectLocal(context(referenceAdd));
  });
  function referenceMenuIsCurrent(state) {
    return selection === state && current(state) && menu.matches(":popover-open");
  }

  async function chooseProjectReference(state, { name, assets, subjectId, subjectKind }, button) {
    if (!referenceMenuIsCurrent(state) || state.reading) return;
    const ticket = Symbol();
    state.reading = true;
    state.draft.pendingAssets.add(ticket);
    button.disabled = true;
    onChange();
    const { revision } = state.draft;
    const stillPicking = () => referenceMenuIsCurrent(state) && selectionCurrent(state) && state.draft.revision === revision;
    try {
      const references = await getLibrary().readReferences(state.scope, assets, stillPicking);
      if (!references || !stillPicking()) return;
      const finish = addBindings(state, [{ name, assets: references, subjectId, subjectKind }]);
      closeMenu(menu);
      finish?.();
    } catch (error) {
      if (stillPicking()) onError(error);
    } finally {
      state.reading = false;
      button.disabled = false;
      state.draft.pendingAssets.delete(ticket);
      if (current(state)) onChange();
    }
  }

  function menuAction(label, select) {
    const button = action(label, select, "mention-item");
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    return button;
  }

  function searchName(value) {
    return value.normalize("NFKC").toLocaleLowerCase();
  }

  function decorateOption(button, state, asset, subjectKind) {
    button.dataset.referenceName = searchName(button.textContent);
    if (subjectKind) button.dataset.referenceKind = subjectKind;
    if (!asset) return;
    const thumbnail = make("span", "reference-option-thumbnail");
    thumbnail.dataset.referenceThumbnail = "";
    thumbnail.setAttribute("aria-hidden", "true");
    thumbnail.append(make("span", "reference-option-kind", labels()[`${asset.kind}Kind`]));
    if (asset.kind === "image" && asset.id) {
      thumbs.observe(thumbnail, () => getLibrary().readAssetSource(state.scope, asset.id));
    } else if (asset.kind === "image" && frameDataHeader.test(asset.url)) {
      const image = make("img");
      image.alt = "";
      image.draggable = false;
      image.addEventListener("load", () => { thumbnail.dataset.loaded = "true"; }, { once: true });
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = asset.url;
      thumbnail.append(image);
    }
    button.prepend(thumbnail);
  }

  function visibleOptions() {
    return [...menu.querySelectorAll("button[data-reference-name]:not([hidden]):not(:disabled)")];
  }

  function focusReferenceOption(key) {
    const option = visibleOptions().at(key === "ArrowUp" ? -1 : 0);
    if (option) focusMenuOption(menu, option);
    else focusMenuEdge(menu, key);
  }

  function filterMenuEntries(state) {
    const query = searchName(state.query);
    for (const button of categoryButtons) {
      button.setAttribute("aria-checked", String(button.dataset.referenceCategory === state.category));
    }
    let matched = false;
    for (const option of results.querySelectorAll("[data-reference-name]")) {
      const inCategory = state.category === "all" || option.dataset.referenceKind === state.category;
      option.hidden = !inCategory || !option.dataset.referenceName.includes(query);
      if (!option.hidden) matched = true;
    }
    for (const group of projectGroups) {
      group.hidden = !group.querySelector(":scope > :not([hidden]):not(.menu-group-label)");
    }
    noMatches.hidden = !state.catalogReady || matched || (!query && state.category === "all");
    if (menu.matches(":popover-open")) positionMenu(menu);
  }

  function renderReferenceGroup(group, items, title) {
    group.replaceChildren(...items);
    if (title && items.length) {
      group.prepend(make("p", "menu-group-label", title));
    }
  }

  async function loadProjectReferences(state) {
    let catalog;
    try {
      catalog = await getLibrary().readCatalog(state.scope);
    } catch (error) {
      if (referenceMenuIsCurrent(state)) {
        projectSubjects.replaceChildren(make("p", "reference-menu-note", errorText(error, labels())));
        filterMenuEntries(state);
      }
      return;
    }
    if (!referenceMenuIsCurrent(state)) return;
    const text = labels();
    const assets = new Map(catalog.assets.map((asset) => [asset.id, asset]));
    const subjects = catalog.subjects
      .filter((subject) => state.targetLabel !== undefined || !state.draft.references.some((entry) => entry.subjectId === subject.id))
      .map((subject) => {
        const members = subject.assetIds.map((id) => assets.get(id)).filter(Boolean);
        const button = menuAction(subject.name, (trigger) => void chooseProjectReference(
          state, { name: subject.name, assets: members, subjectId: subject.id, subjectKind: subject.kind }, trigger,
        ));
        button.dataset.referenceSubjectId = subject.id;
        decorateOption(button, state, assets.get(subject.coverId), subject.kind);
        return button;
      });
    if (!catalog.subjects.length) {
      const create = menuAction(text.createReferenceSubject, () => {
        if (!referenceMenuIsCurrent(state)) return;
        closeMenu(menu);
        getLibrary().open({
          tab: "subjects", trigger: state.trigger,
          onRestoreFocus: () => restoreReferenceCaret(state),
          onSubjectCreated() {
            if (selection !== state || !selectionCurrent(state) || state.scope.projectAvailable !== true ||
                !state.trigger.checkVisibility()) return;
            // Show the newly created subject even if the old query used a different name.
            state.query = "";
            setMenuEntries(state);
            menu.showPopover({ source: state.trigger });
          },
        });
      });
      create.id = "reference-create-subject";
      const empty = make("div", "reference-empty");
      const icon = make("span", "reference-empty-icon", "+");
      icon.setAttribute("aria-hidden", "true");
      empty.append(icon, make("p", "", text.referenceEmptySubjects), create);
      subjects.push(empty);
    }
    const kinds = state.kind === "image" ? ["image"] : ["image", "video", "audio"];
    const media = catalog.assets.filter((asset) => kinds.includes(asset.kind)).map((asset) => {
      const button = menuAction(asset.name, (trigger) => void chooseProjectReference(
        state, { name: asset.name, assets: [asset] }, trigger,
      ));
      button.dataset.referenceAssetId = asset.id;
      decorateOption(button, state, asset);
      return button;
    });
    renderReferenceGroup(projectSubjects, subjects, catalog.subjects.length ? text.subjects : "");
    renderReferenceGroup(projectAssets, media, text.assets);
    state.catalogReady = true;
    const hasBoundSubjects = state.targetLabel === undefined && state.draft.references.some(
      ({ subjectId, subjectKind }) => subjectId || subjectKind,
    );
    if (!catalog.subjects.length && !hasBoundSubjects) {
      const categoryHadFocus = categories.contains(document.activeElement);
      categories.hidden = true;
      state.category = "all";
      if (categoryHadFocus) {
        state.trigger.focus({ preventScroll: true });
        restoreReferenceCaret(state);
      }
    }
    filterMenuEntries(state);
  }

  function setMenuEntries(state) {
    selection = state;
    state.query ??= "";
    state.category = "all";
    thumbs.reset();
    for (const item of results.querySelectorAll("[data-bound-reference]")) item.remove();
    const available = state.scope.projectAvailable === true;
    state.projectAvailable = available;
    state.catalogReady = !available;
    menu.classList.toggle("reference-with-catalog", available);
    categories.hidden = !available;
    const kinds = subjectKinds(state.scope);
    for (const button of categoryButtons) {
      const kind = button.dataset.referenceCategory;
      button.hidden = kind !== "all" && !kinds.includes(kind);
    }
    byId("reference-assets").hidden = !available;
    byId("reference-subjects").hidden = !available;
    for (const group of projectGroups) {
      group.hidden = true;
      group.replaceChildren();
    }
    const hint = byId("reference-menu-hint");
    const text = labels();
    hint.textContent = state.targetLabel !== undefined ? text.chooseReferenceFor(state.targetLabel) :
      state.trigger === prompt ? text.referenceSearchHint : text.referenceToolbarHint;
    if (available) {
      projectSubjects.hidden = false;
      projectSubjects.append(make("p", "reference-menu-note", labels().loading));
      void loadProjectReferences(state);
    }
    const bound = state.targetLabel === undefined ? state.draft.references : [];
    for (const entry of bound) {
      const option = menuAction(`@[${entry.label}]`, () => {
        closeMenu(menu);
        insertMentions(state, [entry]);
      });
      option.dataset.boundReference = "";
      decorateOption(option, state, entry.assets[0], entry.subjectKind);
      option.dataset.referenceName = searchName(entry.label);
      results.insertBefore(option, projectSubjects);
    }
    filterMenuEntries(state);
    results.scrollTop = 0;
  }

  mention.addEventListener("click", () => {
    if (!menu.matches(":popover-open")) {
      const state = context(mention);
      if (state) {
        setMenuEntries(state);
        mention.focus({ preventScroll: true });
      }
    }
  });
  mention.addEventListener("keydown", (event) => {
    if (event.key === "Tab") closeMenu(menu);
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const state = context(mention);
    if (!state) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!menu.matches(":popover-open")) {
      setMenuEntries(state);
      menu.showPopover({ source: mention });
    }
    focusReferenceOption(event.key);
  }, { capture: true });

  function dismissTypedMention(event) {
    const state = selection;
    event.stopImmediatePropagation();
    event.preventDefault();
    closeMenu(menu, prompt);
    restoreReferenceCaret(state);
  }

  prompt.addEventListener("keydown", (event) => {
    if (event.isComposing || composing || event.defaultPrevented) return;
    const unmodified = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    if (unmodified && !mention.hidden && (event.key === "Backspace" || event.key === "Delete")) {
      expandReferenceDeletion(prompt, event.key === "Backspace", freshReferenceEnd);
    }
    if (selection?.trigger !== prompt || !referenceMenuIsCurrent(selection)) return;
    if (event.key === "Escape") dismissTypedMention(event);
    if (event.key === "Tab") closeMenu(menu);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusReferenceOption(event.key);
    }
    if (event.key === "Enter" && unmodified && selectionCurrent(selection)) {
      const option = visibleOptions()[0];
      if (selection.reading || option) event.preventDefault();
      if (!selection.reading && !event.repeat) option?.click();
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (selection?.targetLabel !== undefined && (event.key === "Escape" || event.key === "Tab")) {
      event.stopImmediatePropagation();
      event.preventDefault();
      closeMenu(menu, selection.trigger.isConnected ? selection.trigger : mention);
      return;
    }
    if (selection?.trigger !== prompt) return;
    if (event.key === "Escape") dismissTypedMention(event);
    if (event.key === "Tab") {
      event.stopImmediatePropagation();
      closeMenu(menu, prompt);
      restoreReferenceCaret(selection);
    }
  }, { capture: true });
  prompt.addEventListener("selectionchange", () => {
    if (freshReferenceEnd !== prompt.selectionStart || freshReferenceEnd !== prompt.selectionEnd) freshReferenceEnd = -1;
    if (composing || selection?.trigger !== prompt || !referenceMenuIsCurrent(selection)) return;
    if (prompt.selectionStart !== selection.end || prompt.selectionEnd !== selection.end) closeMenu(menu);
  });
  prompt.addEventListener("compositionstart", () => { composing = true; });
  prompt.addEventListener("compositionend", (event) => {
    composing = false;
    typedMention(event);
  });
  byId("reference-local").addEventListener("click", () => selectLocal(selection));
  byId("reference-assets").addEventListener("click", () => openLibrary(selection, "assets"));
  byId("reference-subjects").addEventListener("click", () => openLibrary(selection, "subjects"));
  referenceInput.addEventListener("cancel", () => {
    const state = localSelection?.state;
    localSelection = null;
    if (current(state)) {
      state.trigger.focus({ preventScroll: true });
      restoreReferenceCaret(state);
    }
  });
  referenceInput.addEventListener("change", async () => {
    const opened = localSelection;
    localSelection = null;
    const files = [...referenceInput.files];
    referenceInput.value = "";
    if (opened) await readLocalFiles(opened.state, files, opened.videoOnly);
  });

  async function readLocalFiles(state, files, videoOnly = false) {
    if (!selectionCurrent(state) || !files.length) return;
    const ticket = Symbol();
    state.draft.pendingAssets.add(ticket);
    onChange();
    const { revision } = state.draft;
    const stillReading = () => selectionCurrent(state) && state.draft.revision === revision;
    try {
      const previous = priorReference(state, videoOnly);
      const combinedBytes = state.draft.references
        .filter((entry) => entry !== previous)
        .flatMap(({ assets }) => assets)
        .reduce((bytes, { url }) => bytes + url.length, 0);
      if (files.length > (videoOnly || state.targetLabel !== undefined ? 1 : 12)) throw new Error("REFERENCE_LIMIT");
      if (combinedBytes + files.reduce((bytes, file) => bytes + Math.ceil(file.size / 3) * 4 + 40, 0) > encodedReferenceLimit) {
        throw new Error("REFERENCE_TOO_LARGE");
      }
      const groups = [];
      for (const file of files) {
        const asset = await readLocalReference(file);
        if (!stillReading()) return;
        const requiredKind = state.kind === "image" ? "image" : videoOnly ? "video" : null;
        if (requiredKind && asset.kind !== requiredKind) throw new Error("INVALID_REFERENCE");
        groups.push({ name: file.name.replace(/\.[^.]*$/, ""), assets: [asset] });
      }
      addBindings(state, groups, videoOnly)?.();
    } catch (error) {
      if (stillReading()) {
        onError(error);
        state.trigger.focus({ preventScroll: true });
      }
    } finally {
      state.draft.pendingAssets.delete(ticket);
      if (current(state)) onChange();
    }
  }

  bindLocalMediaDrop(composerInput, (target) => {
    if (!composerInput.contains(target) || !visibleReferences?.tiles || visibleReferences.draft.pendingAssets.size ||
        composing || prompt.hidden || prompt.disabled) return null;
    return composerInput;
  }, (_target, files) => {
    const focused = document.activeElement;
    const state = context(composerInput.contains(focused) ? focused : prompt);
    if (!state) return;
    // Preserve selected text and keep existing mention tokens intact.
    let insertion = focused === prompt ? prompt.selectionEnd : prompt.value.length;
    for (const token of prompt.value.matchAll(referenceMentionPattern)) {
      const end = token.index + token[0].length;
      if (insertion > token.index && insertion < end) {
        insertion = end;
        break;
      }
    }
    state.start = state.end = insertion;
    closeMenu(menu);
    void readLocalFiles(state, files);
  });

  function chooseReplacement(button, label) {
    const state = context(button);
    if (!state) return;
    state.targetLabel = label;
    closeMenu(menu);
    setMenuEntries(state);
    menu.showPopover({ source: button });
    focusMenuEdge(menu, "ArrowDown");
  }

  function removeReference(draft, label, entry) {
    if (entry) {
      draft.references = draft.references.filter((item) => item !== entry);
      for (const workflow of Object.keys(draft.videoSources ?? {})) {
        if (draft.videoSources[workflow] === entry) delete draft.videoSources[workflow];
      }
    }
    prompt.value = prompt.value.replaceAll(`@[${label}]`, "");
    if (getMode() === "image" && !draft.references.length && !mentionsIn(prompt.value).length) {
      draft.requireImageReference = false;
    }
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    onChange(true);
    const opener = entry && referencesNode.parentElement === referenceRail ? referenceAdd : mention;
    opener.focus({ preventScroll: true });
  }

  function referenceChip(draft, label, entry, editEntry) {
    const text = labels();
    const chip = make("div", entry ? "reference-chip" : "reference-pending-chip");
    chip.dataset.referenceLabel = label;
    chip.dataset.referenceState = entry ? "bound" : "missing";
    const summary = entry ? action("", (button) => {
      const state = context(button);
      if (state?.draft !== draft || !draft.references.includes(entry)) return;
      openReferencePreview(state.scope, entry.assets, button, () => {
        if (!current(state)) return;
        return referencesNode.querySelector(`[data-reference-label="${CSS.escape(label)}"] [data-reference-preview]`) ?? prompt;
      });
    }, "reference-preview") : chip;
    if (entry) {
      summary.dataset.referencePreview = "";
      summary.setAttribute("aria-label", `${text.preview} @${label}`);
      summary.setAttribute("aria-haspopup", "dialog");
      chip.append(summary);
    }
    const first = entry?.assets[0];
    if (first?.kind === "image") {
      const image = make("img", "reference-chip-thumb");
      image.alt = "";
      image.src = first.url;
      image.draggable = false;
      summary.append(image);
    } else if (first) {
      summary.append(make("span", "reference-chip-kind", text[`${first.kind}Kind`]));
    }
    const isEditSource = entry && editEntry === entry;
    const prefix = isEditSource ? text.sourceRole + " · " : "";
    const count = entry?.assets.length ?? 0;
    const title = make("span", "reference-chip-title", `${prefix}@${label}${count > 1 ? ` · ${count}` : ""}`);
    title.title = isEditSource ? first.name : entry?.sourceName ?? first?.name ?? label;
    summary.append(title);
    const bindable = label === label.trim() && /^[^\][@\p{Cc}]{1,80}$/u.test(label);
    if (bindable && !isEditSource) {
      const replace = action(text[entry ? "replaceReference" : "bindReference"], (button) => chooseReplacement(button, label), "reference-choice");
      replace.dataset.referenceReplace = "";
      replace.setAttribute("aria-label", `${replace.textContent} @${label}`);
      replace.setAttribute("aria-haspopup", "menu");
      replace.setAttribute("aria-controls", menu.id);
      chip.append(replace);
    }
    const remove = action("×", () => removeReference(draft, label, entry), "reference-remove");
    remove.dataset.referenceRemove = "";
    remove.setAttribute("aria-label", `${text.remove} ${label}`);
    chip.append(remove);
    return chip;
  }

  function paintReferences(draft, editEntry, template) {
    const missing = missingMentionLabels(draft);
    const missingKey = JSON.stringify(missing);
    const text = labels();
    const sameDraft = previousView?.draft === draft && previousView.text === text;
    if (!sameDraft || previousView.entries !== draft.references ||
        previousView.editEntry !== editEntry || previousView.template !== template) {
      const bound = draft.references.filter((entry) => entry !== template);
      referencesNode.replaceChildren(...bound.map((entry) => referenceChip(draft, entry.label, entry, editEntry)));
      referencesNode.hidden = !bound.length;
    }
    if (!sameDraft || previousView.missingKey !== missingKey) {
      repairsNode.replaceChildren(...missing.map((label) => referenceChip(draft, label)));
      repairsNode.hidden = !missing.length;
    }
    previousView = { draft, entries: draft.references, editEntry, template, text, missingKey };
  }

  function typedMention(event) {
    if (visibleReferences) {
      const { draft, editEntry, template } = visibleReferences;
      paintReferences(draft, editEntry, template);
    }
    if (event.isComposing || composing || mention.hidden) return;
    if (event.data !== "@") {
      if (selection?.trigger !== prompt || !referenceMenuIsCurrent(selection)) return;
      const end = prompt.selectionStart;
      const query = prompt.value.slice(selection.start + 1, end);
      if (prompt.value[selection.start] !== "@" || end <= selection.start || end !== prompt.selectionEnd ||
          /[\s@\[\]]/u.test(query) || query.length > 100) {
        closeMenu(menu);
        return;
      }
      selection.end = end;
      selection.promptVersion = promptVersion;
      selection.query = query;
      filterMenuEntries(selection);
      return;
    }
    const state = context(prompt, true);
    if (!state || prompt.selectionEnd !== state.end || prompt.value[state.start] !== "@") return;
    setMenuEntries(state);
    if (menu.matches(":popover-open")) positionMenu(menu);
    else menu.showPopover({ source: prompt });
  }

  function paint(draft, { enabled, inline, tiles, editEntry, template }) {
    mention.hidden = !enabled;
    promptTargets.update(enabled ? draft : null);
    referenceRail.hidden = !inline;
    const destination = tiles ? referenceRail : workflowSetup;
    if (referencesNode.parentElement !== destination) destination.prepend(referencesNode);
    const addLabel = labels()[getMode() === "image" ? "addImageReference" : "addReference"];
    byId("reference-add-label").textContent = addLabel;
    referenceAdd.setAttribute("aria-label", addLabel);
    if (!enabled) {
      closeMenu(menu);
      visibleReferences = null;
      previousView = null;
      referencesNode.hidden = repairsNode.hidden = true;
      referencesNode.replaceChildren();
      repairsNode.replaceChildren();
      return;
    }
    if (referenceMenuIsCurrent(selection) && selection.projectAvailable !== (selection.scope.projectAvailable === true)) {
      setMenuEntries(selection);
      positionMenu(menu);
    }
    visibleReferences = { draft, editEntry, template, tiles };
    paintReferences(draft, editEntry, template);
  }

  return {
    context, current, selectLocal, openLibrary, typedMention, paint,
    cancel() {
      selection = null;
      localSelection = null;
      composing = false;
      referenceEdits = [];
      freshReferenceEnd = -1;
      promptTargets.update(null);
      visibleReferences = null;
      previousView = null;
      closeMenu(menu);
      referencesNode.hidden = repairsNode.hidden = true;
      referencesNode.replaceChildren();
      repairsNode.replaceChildren();
    },
  };
}
