"use strict";

function localPreviewSource({ kind, url }) {
  const prefix = typeof url === "string" && /^data:(image\/(?:jpeg|png|webp)|video\/mp4|audio\/(?:mpeg|wav));base64,/.exec(url);
  if (!prefix || !prefix[1].startsWith(kind + "/")) return null;
  const limit = videoInputLimits[kind];
  const offset = prefix[0].length;
  const size = url.length - offset;
  if (!size || size % 4 || size > Math.ceil(limit / 3) * 4) return null;
  if (kind === "image") return { url };
  const bytes = Uint8Array.fromBase64(url.slice(offset), { lastChunkHandling: "strict" });
  if (!bytes.length || bytes.length > limit) return null;
  const localUrl = URL.createObjectURL(new Blob([bytes], { type: prefix[1] }));
  return { url: localUrl, release: () => URL.revokeObjectURL(localUrl) };
}

function createMediaPreview({ getScope, labels, onLayer }) {
  const dialog = byId("preview");
  const title = byId("preview-title");
  const container = byId("preview-media");
  const previous = byId("preview-previous");
  const next = byId("preview-next");
  let active;

  const textKey = { image: "imagePreview", video: "videoPreview", audio: "audioPreview" };
  const caption = (item) => item.prompt ?? item.name ?? "";
  const isCurrent = (state) => active === state && state.scope === getScope() && dialog.open;

  function clearMedia(state) {
    const player = container.querySelector("video, audio");
    if (player) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    container.replaceChildren();
    state?.release?.();
    if (state) state.release = null;
  }

  function paint() {
    if (!active) return;
    const { items, index } = active;
    title.textContent = labels()[textKey[items[index].kind]];
    feedback(byId("preview-caption"), caption(items[index]));
    byId("preview-pages").hidden = items.length <= 1;
    byId("preview-position").textContent = `${index + 1} / ${items.length}`;
    previous.setAttribute("aria-disabled", String(index === 0));
    next.setAttribute("aria-disabled", String(index === items.length - 1));
  }

  function close(restoreFocus = true) {
    const view = active;
    active = null;
    clearMedia(view);
    if (dialog.open) dialog.close();
    dialog.hidden = true;
    onLayer();
    if (restoreFocus && view && view.scope === getScope()) {
      const opener = view.trigger?.isConnected ? view.trigger : view.restoreTrigger?.();
      opener?.focus({ preventScroll: true });
    }
  }

  async function render(state) {
    const ticket = Symbol();
    state.ticket = ticket;
    clearMedia(state);
    paint();
    container.append(make("p", "empty", labels().loading));
    const item = state.items[state.index];
    const isCurrentItem = () => isCurrent(state) && state.ticket === ticket;
    const showFailure = () => {
      if (!isCurrentItem()) return;
      clearMedia(state);
      container.append(make("p", "empty", labels().previewError));
    };
    try {
      const source = await state.readSource(item);
      if (!isCurrentItem()) {
        source?.release?.();
        return;
      }
      if (!source?.url) {
        showFailure();
        return;
      }
      state.release = source.release;
      const media = make(item.kind === "image" ? "img" : item.kind);
      media.addEventListener("error", showFailure, { once: true });
      if (item.kind === "image") {
        media.alt = caption(item).slice(0, 160);
      } else {
        media.controls = true;
        media.preload = "metadata";
        media.setAttribute("aria-label", labels()[textKey[item.kind]]);
      }
      media.src = source.url;
      container.replaceChildren(media);
      if (state.autoplay && item.kind === "video") {
        void media.play().catch(() => { /* Playback controls remain available. */ });
      }
    } catch {
      showFailure();
    }
  }

  function open(scope, items, trigger, readSource, { autoplay = false, restoreTrigger } = {}) {
    if (!scope || scope !== getScope() || !items.length) return;
    close(false);
    active = { scope, items, trigger, readSource, autoplay, restoreTrigger, index: 0 };
    dialog.hidden = false;
    dialog.showModal();
    void render(active);
    title.focus();
    onLayer();
  }

  function move(offset) {
    if (!active) return;
    const index = active.index + offset;
    if (index < 0 || index >= active.items.length) return;
    active.index = index;
    void render(active);
  }

  previous.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));
  byId("close-preview").addEventListener("click", () => close());
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    if (!dialog.open && active) close();
  });

  return { open, close, paint, isOpen: () => dialog.open };
}
