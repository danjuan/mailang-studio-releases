"use strict";

function createMediaLibrary({ bridge, getScope, labels, onAvailability, onLayer, openPreview, saveCreationSelection }) {
  const dialog = byId("library");
  const page = byId("library-page");
  const content = byId("library-content");
  const workbench = page.parentElement;
  const back = byId("close-library");
  const body = byId("library-body");
  const message = byId("library-message");
  const primary = byId("library-primary");
  const search = byId("library-search");
  const thumbs = thumbnailLoader(body);
  let view = null;
  let focusFrame;

  const surfaceOpen = (surface) => surface === page ? !page.hidden : dialog.open;
  const isCurrent = (state) => view === state && surfaceOpen(state.surface) && getScope() === state.scope;
  const invoke = (state, method, args) => bridge.invoke(`projectMedia.${method}`, { sessionId: state.scope.id, ...args });
  const projectAvailable = () => getScope()?.projectAvailable === true;
  const isPicker = (state) => Boolean(state.pick);
  const isFramePicker = (state) => state.pick?.kind === "frame";
  const assetNote = (asset) => asset.kind === "image" ? labels().imageKind : labels().videoKind;
  const normalizedName = (name) => name.normalize("NFKC").trim().toLocaleLowerCase();
  const paintCatalogControls = createLibraryCatalogControls(labels, (key, value) => {
    const state = view;
    if (!state || !isCurrent(state) || state.busy || state.pick || state.screen) return;
    const options = state.catalog[state.tab];
    if (options[key] === value) return;
    options[key] = value;
    body.scrollTop = 0;
    render();
  });

  function setBusy(state, busy) {
    state.busy = busy;
    if (view === state) search.disabled = busy;
  }

  async function check(scope) {
    if (!scope.projectPath) {
      scope.projectAvailable = false;
      return;
    }
    let result;
    try {
      result = await bridge.invoke("projectMedia.capabilities", { sessionId: scope.id, imageImport: true, subjectCategories: true });
    } catch {
      result = { available: false };
    }
    if (getScope() !== scope) return;
    scope.projectAvailable = result?.available === true;
    scope.projectImageImport = scope.projectAvailable && result?.imageImport === true;
    scope.projectSubjectCategories = scope.projectAvailable && result?.subjectCategories === true;
    onAvailability(scope);
    if (view?.scope === scope) void refresh(view);
  }

  function cancelFocusReturn() {
    if (focusFrame === undefined) return;
    cancelAnimationFrame(focusFrame);
    focusFrame = undefined;
  }

  function close(restoreFocus = false) {
    cancelFocusReturn();
    if (!view) return;
    const { scope, surface, trigger, onRestoreFocus, restoreCreationSelection } = view;
    view = null;
    for (const menu of content.querySelectorAll(".composer-menu:popover-open")) closeMenu(menu);
    thumbs.setEnabled(false);
    thumbs.reset();
    body.replaceChildren();
    if (surface === page) {
      page.hidden = true;
      delete workbench.dataset.workbenchView;
    } else {
      if (dialog.open) dialog.close();
      delete dialog.dataset.picker;
    }
    onLayer();
    if (!restoreFocus) return;
    const restore = () => {
      focusFrame = undefined;
      if (view || scope !== getScope()) return;
      if (trigger?.isConnected) {
        trigger.focus({ preventScroll: true });
        onRestoreFocus?.();
      }
      restoreCreationSelection?.();
    };
    // Let the Back click finish and the revealed workbench lay out before restoring its textarea selection.
    if (surface === page) focusFrame = requestAnimationFrame(restore);
    else restore();
  }

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (view?.surface === dialog) close(true);
  });
  dialog.addEventListener("close", () => {
    if (!dialog.open && view?.surface === dialog) close(true);
  });
  page.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || view?.surface !== page ||
        document.querySelector("dialog[open], :popover-open")) return;
    event.preventDefault();
    close(true);
  });
  back.addEventListener("click", () => close(true));
  byId("open-library").addEventListener("click", (event) => open({ trigger: event.currentTarget }));

  function open({ tab = "assets", trigger = document.activeElement, pick = null, onSubjectCreated, onRestoreFocus } = {}) {
    const scope = getScope();
    if (!scope || view) return;
    cancelFocusReturn();
    const surface = pick || onSubjectCreated ? dialog : page;
    const state = {
      scope, surface, tab, trigger, pick, onSubjectCreated, onRestoreFocus, data: null, screen: null, busy: false,
      restoreCreationSelection: surface === page ? saveCreationSelection() : null,
      queries: { assets: "", subjects: "" },
      catalog: { assets: { ...defaultCatalogOptions }, subjects: { ...defaultCatalogOptions } },
    };
    if (onSubjectCreated) state.screen = { type: "subject", subject: null };
    view = state;
    content.dataset.mode = isPicker(state) ? "picker" : onSubjectCreated ? "create-subject" : "manage";
    // Move the shared catalog controls without recreating the workbench.
    surface.append(content);
    feedback(message, "");
    if (surface === page) {
      for (const menu of workbench.querySelectorAll(".composer-menu:popover-open")) closeMenu(menu);
      workbench.dataset.workbenchView = "library";
      page.hidden = false;
    } else {
      if (pick?.kind) dialog.dataset.picker = pick.kind;
      dialog.showModal();
    }
    byId("library-title").focus();
    onLayer();
    render();
    void refresh(state).then(() => {
      if (onSubjectCreated && isCurrent(state) && document.activeElement === byId("library-title")) {
        body.querySelector('input[type="text"]')?.focus();
      }
    });
  }

  function openFrame({ tab, trigger, title, select }) {
    open({ tab, trigger, pick: { kind: "frame", title, select, kinds: ["image"] } });
  }

  async function readCatalog(scope) {
    const data = await invoke({ scope }, "list");
    if (!Array.isArray(data?.assets) || !Array.isArray(data?.subjects)) throw new Error("UNAVAILABLE");
    return data;
  }

  function readAssetSource(scope, id) {
    if (getScope() !== scope || !projectAvailable()) return null;
    return invoke({ scope }, "source", { id });
  }

  async function refresh(state) {
    if (!isCurrent(state) || !projectAvailable()) return;
    try {
      const data = await readCatalog(state.scope);
      if (!isCurrent(state)) return;
      state.data = data;
      render();
    } catch (error) {
      if (!isCurrent(state)) return;
      feedback(message, errorText(error, labels()), true);
      if (!state.data) {
        body.replaceChildren(action(labels().loadRetry, () => {
          feedback(message, "");
          void refresh(state);
        }, "secondary"));
      }
    }
  }

  function selectTab(tab) {
    if (!view || view.busy || (tab === "subjects" && view.pick?.subjects === false) || view.tab === tab && !view.screen) return;
    view.tab = tab;
    view.screen = null;
    feedback(message, "");
    body.scrollTop = 0;
    render();
  }

  search.addEventListener("input", () => {
    const state = view;
    if (!state || !isCurrent(state) || state.busy || state.screen) return;
    state.queries[state.tab] = search.value;
    body.scrollTop = 0;
    render();
  });

  const paintTabs = bindTabs(byId("library-tabs"), "library-tab", () => view?.tab, selectTab);
  primary.addEventListener("click", () => {
    const state = view;
    if (!state || state.busy || state.tab !== "assets") return;
    void mutate(state, primary, "import", {}, labels().imported);
  });

  async function mutate(state, button, method, args, confirmation, reload = true) {
    if (!isCurrent(state) || state.busy) return;
    setBusy(state, true);
    button.disabled = true;
    feedback(message, "");
    try {
      const result = await invoke(state, method, args);
      if (!isCurrent(state)) return;
      if (result !== false && (!Array.isArray(result) || result.length)) feedback(message, confirmation);
      if (reload) {
        state.screen = null;
        await refresh(state);
        if (isCurrent(state) && !button.isConnected && !body.contains(document.activeElement)) {
          byId(state.tab === "assets" ? "tab-assets" : "tab-subjects").focus();
        }
      }
      return result;
    } catch (error) {
      if (isCurrent(state)) feedback(message, errorText(error, labels()), true);
    } finally {
      setBusy(state, false);
      button.disabled = false;
    }
  }

  function openScreen(state, screen) {
    if (!isCurrent(state) || state.busy) return;
    if (!screen && state.onSubjectCreated) {
      close(true);
      return;
    }
    const previous = state.screen;
    state.screen = screen?.type === "select" ? { ...screen, returnScrollTop: body.scrollTop } : screen;
    feedback(message, "");
    body.scrollTop = 0;
    render();
    if (!screen) {
      const tab = byId(state.tab === "assets" ? "tab-assets" : "tab-subjects");
      const subject = previous?.type === "select"
        ? body.querySelector(`[data-subject-id="${CSS.escape(previous.subject.id)}"] .media-cover`)
        : null;
      if (subject) body.scrollTop = previous.returnScrollTop;
      const create = previous?.type === "subject" && !previous.subject ? byId("library-new-subject") : null;
      (subject ?? create ?? tab).focus({ preventScroll: true });
    } else if (screen.type === "delete") {
      body.querySelector(".editor-form button[type=button]")?.focus();
    } else {
      body.querySelector("input[type=text], .subject-header button")?.focus();
    }
  }

  function showAsset(state, asset, trigger) {
    if (!isCurrent(state) || state.busy) return;
    openPreview(state.scope, asset, trigger, "projectMedia.source");
  }

  async function chooseFrame(state, asset, button) {
    if (!isCurrent(state) || state.busy) return;
    setBusy(state, true);
    button.disabled = true;
    feedback(message, "");
    try {
      const url = await invoke(state, "readFrame", { id: asset.id });
      if (!isCurrent(state)) return;
      const frame = await validateFrame({ name: asset.name, url });
      if (!isCurrent(state)) return;
      const finish = state.pick.select(frame);
      close(!finish);
      finish?.();
    } catch (error) {
      if (isCurrent(state)) {
        feedback(message, errorText(error, labels()), true);
        button.disabled = false;
        if (button.isConnected) button.focus({ preventScroll: true });
      }
    } finally {
      setBusy(state, false);
      button.disabled = false;
    }
  }

  async function readReferences(scope, selected, stillCurrent) {
    if (!selected.length || selected.length > 9) throw new Error("REFERENCE_LIMIT");
    const references = [];
    for (const asset of selected) {
      if (!stillCurrent()) return null;
      const result = await invoke({ scope }, "readReference", { id: asset.id });
      if (!stillCurrent()) return null;
      if (!result || result.kind !== asset.kind || typeof result.url !== "string") throw new Error("INVALID_REFERENCE");
      references.push({ name: asset.name, kind: asset.kind, url: result.url });
    }
    return references;
  }

  async function chooseReference(state, name, selected, button, subject) {
    if (!isCurrent(state) || state.busy) return;
    setBusy(state, true);
    button.disabled = true;
    feedback(message, "");
    try {
      const assets = await readReferences(state.scope, selected, () => isCurrent(state));
      if (!assets || !isCurrent(state)) return;
      // Adding a subject can exceed the draft limit. Keep this picker open on
      // validation errors so another source can be selected without losing focus.
      const finish = state.pick.select(name, assets, subject);
      close(!finish);
      finish?.();
    } catch (error) {
      if (isCurrent(state)) feedback(message, errorText(error, labels()), true);
    } finally {
      setBusy(state, false);
      button.disabled = false;
    }
  }

  function assetCard(state, asset) {
    const text = labels();
    const card = make("li", "asset-card");
    card.dataset.assetId = asset.id;
    const framePicker = isFramePicker(state);
    const title = framePicker ? text.useFrame : state.pick ? text.useReference : text.preview;
    const select = framePicker ? (button) => chooseFrame(state, asset, button)
      : state.pick ? (button) => chooseReference(state, asset.name, [asset], button) : (button) => showAsset(state, asset, button);
    const cover = mediaCover(isPicker(state) ? title : assetNote(asset), asset.kind, select);
    cover.setAttribute("aria-label", `${title} ${asset.name}`);
    thumbs.observe(cover, () => invoke(state, "source", { id: asset.id }), asset.kind);
    const info = make("div", "asset-body");
    info.append(make("h3", "", asset.name), make("p", "asset-note", assetNote(asset)));
    const actions = make("div", "small-actions");
    if (isPicker(state)) {
      const use = action(title, select, "secondary compact");
      use.dataset.assetUse = "";
      use.setAttribute("aria-label", `${title} ${asset.name}`);
      actions.append(use);
    }
    const preview = action(text.preview, (button) => showAsset(state, asset, button), "secondary compact");
    preview.dataset.assetPreview = "";
    preview.setAttribute("aria-label", `${text.preview} ${asset.name}`);
    preview.setAttribute("aria-haspopup", "dialog");
    actions.append(preview);
    if (!isPicker(state)) {
      actions.append(
        action(text.rename, () => openScreen(state, { type: "rename", asset })),
        action(text.saveAs, (button) => mutate(state, button, "export", { id: asset.id }, text.exportSuccess, false)),
        action(text.delete, () => openScreen(state, { type: "delete", item: asset, method: "deleteAsset" }), "text-button danger"),
      );
    }
    info.append(actions);
    card.append(cover, info);
    return card;
  }

  function subjectCard(state, subject, assets) {
    const text = labels();
    const card = make("li", "asset-card");
    card.dataset.subjectId = subject.id;
    const cover = assets.get(subject.coverId);
    const framePicker = isFramePicker(state);
    const label = framePicker ? text.selectImage : state.pick ? text.useSubject : text.preview;
    const select = framePicker ? () => openScreen(state, { type: "select", subject })
      : state.pick ? (button) => chooseReference(
        state, subject.name, subject.assetIds.map((id) => assets.get(id)).filter(Boolean), button,
        { subjectId: subject.id, subjectKind: subject.kind },
      )
        : (button) => showAsset(state, cover, button);
    if (cover || isPicker(state)) {
      const coverButton = mediaCover(label, "image", select);
      coverButton.setAttribute("aria-label", `${label} ${subject.name}`);
      if (cover) thumbs.observe(coverButton, () => invoke(state, "source", { id: cover.id }));
      card.append(coverButton);
    }
    const info = make("div", "asset-body");
    info.append(make("h3", "", subject.name), make("p", "asset-note", text[subject.kind]));
    if (!isPicker(state)) {
      const actions = make("div", "small-actions");
      actions.append(
        action(text.edit, () => openScreen(state, { type: "subject", subject })),
        action(text.delete, () => openScreen(state, { type: "delete", item: subject, method: "deleteSubject" }), "text-button danger"),
      );
      info.append(actions);
    }
    card.append(info);
    return card;
  }

  function editorField(label, input) {
    const wrapper = make("label");
    wrapper.append(make("span", "", label), input);
    return wrapper;
  }

  function nameInput(name) {
    const input = make("input");
    input.type = "text";
    input.maxLength = 200;
    input.required = true;
    input.value = name;
    return input;
  }

  function editorActions(state, form, submitLabel) {
    const text = labels();
    const row = make("div", "small-actions");
    const button = make("button", "primary", submitLabel);
    button.type = "submit";
    row.append(button, action(text.cancel, () => openScreen(state, null), "secondary"));
    form.append(row);
    return button;
  }

  function renderEditor(state) {
    const text = labels();
    const { screen } = state;
    const form = make("form", "editor-form");
    body.append(form);
    if (screen.type === "delete") {
      const asset = screen.method === "deleteAsset";
      form.append(make("h3", "", `${text.delete} ${screen.item.name}`));
      form.append(make("p", "empty", asset ? text.deleteAssetHint : text.deleteSubjectHint));
      const submit = editorActions(state, form, text.delete);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void mutate(state, submit, screen.method, { id: screen.item.id }, text.deleted);
      });
      return;
    }

    if (screen.type === "rename") {
      const input = nameInput(screen.asset.name);
      form.append(editorField(text.name, input));
      const submit = editorActions(state, form, text.saveChanges);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (name) void mutate(state, submit, "renameAsset", { id: screen.asset.id, name }, text.changed);
      });
      return;
    }

    const subject = screen.subject;
    const name = nameInput(subject?.name ?? "");
    const kind = make("select");
    for (const value of subjectKinds(state.scope)) kind.add(new Option(text[value], value));
    kind.value = subject?.kind ?? screen.defaultKind ?? "character";
    form.append(editorField(text.name, name), editorField(text.subjectType, kind));
    const selected = new Set(subject?.assetIds);
    const images = state.data.assets.filter((asset) => asset.kind === "image");
    const fields = make("fieldset", "subject-images");
    fields.append(make("legend", "", text.subjectImages));
    const cover = make("select");
    function paintCover(preferred) {
      cover.replaceChildren(...images.filter((asset) => selected.has(asset.id)).map((asset) => new Option(asset.name, asset.id)));
      if (selected.has(preferred)) cover.value = preferred;
      cover.disabled = !selected.size;
    }
    let submit;
    function appendImage(image) {
      const check = make("input");
      check.type = "checkbox";
      check.value = image.id;
      check.checked = selected.has(image.id);
      check.addEventListener("change", () => {
        if (check.checked) selected.add(image.id);
        else selected.delete(image.id);
        paintCover(cover.value);
        submit.disabled = state.busy || !selected.size;
      });
      const label = make("label");
      const thumbnail = make("span", "media-cover");
      thumbnail.setAttribute("aria-hidden", "true");
      thumbs.observe(thumbnail, () => invoke(state, "source", { id: image.id }));
      label.append(check, thumbnail, make("span", "", image.name));
      fields.append(label);
    }

    if (state.scope.projectImageImport) {
      const importButton = action(text.subjectImport, async () => {
        const current = () => isCurrent(state) && state.screen === screen && form.isConnected;
        if (!current() || state.busy) return;
        setBusy(state, true);
        importButton.disabled = true;
        submit.disabled = true;
        feedback(message, "");
        try {
          const imported = await invoke(state, "import", { kind: "image" });
          if (!current()) return;
          if (!Array.isArray(imported) || imported.some((image) => image?.kind !== "image" ||
              typeof image.id !== "string" || typeof image.name !== "string")) throw new Error("INVALID_MEDIA");
          if (!imported.length) return;
          const currentCover = cover.value;
          for (const image of imported) {
            selected.add(image.id);
            images.push(image);
            appendImage(image);
          }
          state.data = { ...state.data, assets: [...state.data.assets, ...imported] };
          paintCover(currentCover);
          feedback(message, text.subjectImagesImported);
        } catch (error) {
          if (current()) feedback(message, errorText(error, labels()), true);
        } finally {
          setBusy(state, false);
          if (current()) {
            importButton.disabled = false;
            submit.disabled = !selected.size;
            if ([document.body, dialog, importButton].includes(document.activeElement)) {
              importButton.focus({ preventScroll: true });
            }
          }
        }
      }, "secondary compact");
      importButton.dataset.subjectImport = "";
      const hint = make("p", "hint subject-import-hint", text.subjectImportHint);
      hint.id = "subject-import-hint";
      importButton.setAttribute("aria-describedby", hint.id);
      const controls = make("div", "subject-import");
      controls.append(importButton, hint);
      form.append(controls);
    }
    for (const image of images) appendImage(image);
    form.append(fields, editorField(text.cover, cover));
    paintCover(subject?.coverId);
    submit = editorActions(state, form, text.saveChanges);
    submit.disabled = !selected.size;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = name.value.trim();
      if (!title || !selected.size || !cover.value) return;
      const saved = await mutate(state, submit, "saveSubject", {
        ...(subject ? { id: subject.id } : {}), name: title, kind: kind.value, assetIds: [...selected], coverId: cover.value,
      }, text.changed, !state.onSubjectCreated);
      if (typeof saved?.id === "string" && state.onSubjectCreated && isCurrent(state)) {
        close(true);
        state.onSubjectCreated();
      }
    });
  }

  function render() {
    if (!view || !isCurrent(view)) return;
    const state = view;
    const text = labels();
    const creatingSubject = Boolean(state.onSubjectCreated);
    byId("library-title").textContent = creatingSubject ? text.createReferenceSubject : state.pick?.title ?? text.library;
    back.dataset.text = state.surface === page ? "backToCreation" : isPicker(state) ? "cancel" : "close";
    back.textContent = text[back.dataset.text];
    byId("tab-subjects").hidden = state.pick?.subjects === false;
    paintTabs();
    body.setAttribute("role", creatingSubject ? "region" : "tabpanel");
    body.setAttribute("aria-labelledby", creatingSubject ? "library-title" : `tab-${state.tab}`);
    thumbs.reset();
    body.replaceChildren();
    const available = projectAvailable();
    const browsing = available && Boolean(state.data) && !state.pick && !state.screen;
    content.dataset.browsing = String(browsing);
    content.dataset.tab = state.tab;
    const options = state.catalog[state.tab];
    paintCatalogControls(state, options, browsing);
    byId("library-controls").hidden = !available || creatingSubject;
    search.hidden = !available || Boolean(state.screen) || !state.data;
    search.disabled = state.busy;
    search.placeholder = text.librarySearch;
    search.setAttribute("aria-label", text.librarySearch);
    if (search.value !== state.queries[state.tab]) search.value = state.queries[state.tab];
    primary.hidden = !browsing || state.tab !== "assets";
    primary.textContent = text.importAssets;
    if (!available || !state.data) {
      body.append(make("p", "empty", state.scope.projectAvailable === false ? text.projectUnavailable : text.loading));
      return;
    }
    if (state.screen && state.screen.type !== "select") {
      renderEditor(state);
      return;
    }
    const assets = new Map(state.data.assets.map((asset) => [asset.id, asset]));
    const query = normalizedName(state.queries[state.tab]);
    const matches = ({ name }) => !query || normalizedName(name).includes(query);
    let cards;
    if (state.screen?.type === "select") {
      const header = make("header", "subject-header");
      const back = action(text.back, () => openScreen(state, null), "secondary compact");
      back.dataset.subjectBack = "";
      header.append(back, make("h3", "", state.screen.subject.name));
      body.append(header);
      cards = state.screen.subject.assetIds.map((id) => assets.get(id))
        .filter((asset) => asset?.kind === "image").map((asset) => assetCard(state, asset));
    } else if (state.tab === "subjects") {
      const subjects = state.data.subjects.filter(matches);
      cards = (browsing ? filterLibraryCatalog(subjects, options, true, document.documentElement.lang) : subjects)
        .map((subject) => subjectCard(state, subject, assets));
    } else {
      const filtered = state.data.assets.filter((asset) => matches(asset) && (!state.pick || state.pick.kinds.includes(asset.kind)));
      cards = (browsing ? filterLibraryCatalog(filtered, options, false, document.documentElement.lang) : filtered)
        .map((asset) => assetCard(state, asset));
    }
    const list = make("ul", "library-grid");
    let create;
    if (browsing && state.tab === "subjects") {
      const createCard = make("li", "subject-create-card");
      const defaultKind = subjectKinds(state.scope).includes(options.category) ? options.category : "character";
      create = action("", () => openScreen(state, { type: "subject", subject: null, defaultKind }), "subject-create-action");
      create.id = "library-new-subject";
      create.disabled = !state.scope.projectImageImport && !state.data.assets.some((asset) => asset.kind === "image");
      const icon = make("span", "subject-create-icon", "+");
      icon.setAttribute("aria-hidden", "true");
      create.append(icon, make("span", "", text.newSubject));
      createCard.append(create);
      list.append(createCard);
    }
    list.append(...cards);
    if (list.childElementCount) body.append(list);
    if (!cards.length) {
      const narrowed = browsing && (options.category !== "all" || options.filter !== "all" || options.period !== "all");
      if (create && !create.disabled && !query && !narrowed) return;
      const note = narrowed ? text.catalogNoMatches : query && !state.screen ? text.libraryNoMatches :
        state.tab === "subjects" ? text.noSubjects : text.noAssets;
      body.append(make("p", "empty", note));
    }
  }

  return {
    open, openFrame, close, check, readCatalog, readAssetSource, readReferences,
    isOpen: () => Boolean(view && surfaceOpen(view.surface)),
    setThumbnails: (active) => thumbs.setEnabled(active),
  };
}
