"use strict";

const byId = (id) => document.getElementById(id);
const frameMime = new Set(["image/jpeg", "image/png", "image/webp"]);
const frameLimit = 5 * 1024 * 1024;
const frameDataHeader = /^data:image\/(?:jpeg|png|webp);base64,/;
const isMediaUrl = (url) => typeof url === "string" && url.startsWith("pi-plugin-media://");

function make(tag, className, label) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (label) element.textContent = label;
  return element;
}

function action(label, run, className = "text-button") {
  const button = make("button", className, label);
  button.type = "button";
  button.addEventListener("click", () => void run(button));
  return button;
}

function feedback(element, value, error = false) {
  if (element.textContent !== value) element.textContent = value;
  element.hidden = !value;
  element.dataset.error = String(error);
}

function errorText(error, labels, fallback = labels.errorDefault) {
  const code = error instanceof Error ? error.message : String(error);
  const marker = code.match(/\b[A-Z][A-Z_]{2,}\b/g)?.find((token) => Object.hasOwn(labels.errors, token));
  return marker ? labels.errors[marker] : fallback;
}

function bindTabs(bar, dataset, selected, select) {
  const tabs = [...bar.querySelectorAll(`[data-${dataset}]`)];
  const value = (tab) => tab.getAttribute(`data-${dataset}`);
  for (const tab of tabs) tab.addEventListener("click", () => select(value(tab)));
  bar.addEventListener("keydown", (event) => {
    const visible = tabs.filter((tab) => !tab.hidden);
    const current = visible.findIndex((tab) => value(tab) === selected());
    const target = {
      ArrowLeft: (current + visible.length - 1) % visible.length,
      ArrowRight: (current + 1) % visible.length,
      Home: 0,
      End: visible.length - 1,
    }[event.key];
    if (target === undefined || !visible.length) return;
    event.preventDefault();
    select(value(visible[target]));
    visible[target].focus();
  });
  return () => {
    for (const tab of tabs) {
      const active = value(tab) === selected();
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
  };
}

function mediaCover(label, kind, open) {
  const cover = action("", open, "media-cover");
  cover.dataset.video = String(kind === "video");
  cover.setAttribute("aria-label", label);
  cover.append(make("span", "", label));
  return cover;
}

function readVideoPoster(url, signal) {
  if (signal.aborted) return Promise.resolve(null);
  const video = make("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  let paintFrame;

  return new Promise((resolve) => {
    const timeout = setTimeout(stop, 8000);
    function stop(image = null) {
      clearTimeout(timeout);
      if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
      signal.removeEventListener("abort", abort);
      video.removeEventListener("error", abort);
      video.removeEventListener("loadeddata", loaded);
      video.pause();
      video.removeAttribute("src");
      video.load();
      resolve(image);
    }
    function abort() { stop(); }
    function loaded() {
      const { videoWidth: width, videoHeight: height } = video;
      if (!width || !height) return stop();
      const scale = Math.min(1, 320 / Math.max(width, height));
      const canvas = make("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) return stop();

      // Chromium can report data before a paused decoder exposes the pixels.
      const deadline = performance.now() + 500;
      function draw() {
        try {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          if (!context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3]) {
            if (performance.now() < deadline) paintFrame = requestAnimationFrame(draw);
            else stop();
            return;
          }
          const image = canvas.toDataURL("image/jpeg", 0.78);
          stop(image.startsWith("data:image/jpeg;base64,") && image.length <= 180_000 ? image : null);
        } catch {
          stop();
        }
      }
      paintFrame = requestAnimationFrame(draw);
    }
    signal.addEventListener("abort", abort, { once: true });
    video.addEventListener("error", abort, { once: true });
    video.addEventListener("loadeddata", loaded, { once: true });
    video.src = url;
  });
}

// Hold a slot until a visible video produces a still or its decoder is
// released. Pause new grants while a full-size preview covers the list.
function thumbnailLoader(container) {
  const visible = new Set();
  const active = new Map();
  let entries = new WeakMap();
  let enabled = false;
  const observer = new IntersectionObserver((updates) => {
    for (const { target, isIntersecting } of updates) {
      if (isIntersecting && entries.has(target)) {
        visible.add(target);
      } else {
        visible.delete(target);
        active.get(target)?.controller?.abort();
      }
    }
    drain();
  }, { root: container });

  async function load(cover, entry) {
    const controller = entry.kind === "video" ? new AbortController() : null;
    active.set(cover, { controller });
    const current = () => cover.isConnected && entries.get(cover) === entry && !controller?.signal.aborted;
    try {
      const url = await entry.source();
      if (!current() || !isMediaUrl(url)) return;
      const src = controller ? await readVideoPoster(url, controller.signal) : url;
      if (!current() || !src) return;
      const image = make("img");
      image.alt = "";
      image.decoding = "async";
      image.addEventListener("load", () => { cover.dataset.loaded = "true"; }, { once: true });
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = src;
      cover.append(image);
    } catch {
      // Leave the affordance available so the user can try opening the preview.
    } finally {
      active.delete(cover);
      if (!controller?.signal.aborted && entries.get(cover) === entry) unobserve(cover);
      drain();
    }
  }

  function drain() {
    if (!enabled) return;
    for (const cover of visible) {
      if (active.size >= 3) break;
      const entry = entries.get(cover);
      if (entry && cover.isConnected && !active.has(cover)) void load(cover, entry);
    }
  }

  function unobserve(cover) {
    entries.delete(cover);
    visible.delete(cover);
    observer.unobserve(cover);
    active.get(cover)?.controller?.abort();
  }

  function abortDecoders() {
    for (const { controller } of active.values()) controller?.abort();
  }

  return {
    observe(cover, source, kind = "image") {
      entries.set(cover, { source, kind });
      observer.observe(cover);
    },
    unobserve,
    setEnabled(value) {
      enabled = value;
      if (enabled) drain();
      else abortDecoders();
    },
    reset() {
      entries = new WeakMap();
      visible.clear();
      observer.disconnect();
      abortDecoders();
    },
  };
}

function frameFailure(code) {
  return new Error(code);
}

async function readLocalFrame(file) {
  if (file.size > frameLimit) throw frameFailure("FRAME_TOO_LARGE");
  const nameSuffix = file.name.toLowerCase().split(".").at(-1);
  const mime = file.type || ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" })[nameSuffix];
  if (!frameMime.has(mime)) throw frameFailure("INVALID_FRAME");
  const blob = new Blob([file], { type: mime });
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(frameFailure("INVALID_FRAME"));
    reader.readAsDataURL(blob);
  });
  return { name: file.name, url };
}

async function validateFrame(frame) {
  const { url } = frame;
  const header = frameDataHeader.exec(url);
  if (!header) throw frameFailure("INVALID_FRAME");
  const encodedLength = url.length - header[0].length;
  const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  if (encodedLength / 4 * 3 - padding > frameLimit) throw frameFailure("FRAME_TOO_LARGE");
  const image = new Image();
  image.src = url;
  await image.decode().catch(() => { throw frameFailure("INVALID_FRAME"); });
  const { naturalWidth: width, naturalHeight: height } = image;
  if (width < 256 || width > 5760 || height < 256 || height > 5760 || width / height < 0.4 || width / height > 2.5) {
    throw frameFailure("INVALID_FRAME_DIMENSIONS");
  }
  return frame;
}

function createLocalMp4ObjectUrl(source) {
  const prefix = "data:video/mp4;base64,";
  if (typeof source !== "string" || !source.startsWith(prefix)) throw new Error("Invalid local video");
  const bytes = Uint8Array.fromBase64(source.slice(prefix.length));
  if (!bytes.length) throw new Error("Empty local video");
  return URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
}

const menuAnchors = new WeakMap();
let menuPositionFrame = null;

function withTextareaLayout(field, measure) {
  const { clientWidth: width, clientHeight: height, scrollLeft, scrollTop } = field;
  if (!width || !height) return;

  // Textarea contents are not DOM nodes. Lay out the same text in a hidden
  // element so Range can measure ranges across wraps.
  const style = getComputedStyle(field);
  const mirror = document.createElement("div");
  for (const property of [
    "font", "fontKerning", "fontFeatureSettings", "fontVariationSettings", "letterSpacing", "lineHeight",
    "wordSpacing", "textAlign", "textIndent", "textTransform", "direction", "tabSize", "whiteSpace",
    "overflowWrap", "wordBreak", "padding",
  ]) mirror.style[property] = style[property];
  const text = document.createTextNode(field.value);
  mirror.append(text);
  Object.assign(mirror.style, {
    position: "fixed", left: "0", top: "0", visibility: "hidden", boxSizing: "border-box", width: `${width}px`,
  });
  document.body.append(mirror);
  const range = document.createRange();
  const outer = field.getBoundingClientRect();
  const originX = outer.left + field.clientLeft;
  const originY = outer.top + field.clientTop;
  const measureRange = (start, end) => {
    if (start < 0 || end > text.length || start >= end) return [];
    range.setStart(text, start);
    range.setEnd(text, end);
    const clipped = [];
    for (const rect of range.getClientRects()) {
      const left = Math.max(0, rect.left - scrollLeft);
      const top = Math.max(0, rect.top - scrollTop);
      const right = Math.min(width, rect.right - scrollLeft);
      const bottom = Math.min(height, rect.bottom - scrollTop);
      if (left < right && top < bottom) {
        clipped.push(new DOMRect(originX + left, originY + top, right - left, bottom - top));
      }
    }
    return clipped;
  };
  try {
    return measure(measureRange);
  } finally {
    mirror.remove();
  }
}

function textareaCharacterBounds(field, indices) {
  return withTextareaLayout(field, (rects) => {
    for (const index of indices) {
      const [visible] = rects(index, index + 1);
      if (visible) return visible;
    }
    return null;
  }) ?? null;
}

function positionMenu(menu) {
  const { trigger: defaultTrigger, resolvePlacement } = menuAnchors.get(menu);
  const placement = resolvePlacement?.();
  const trigger = placement?.trigger ?? defaultTrigger;
  if (placement === null || !trigger.getClientRects().length) {
    closeMenu(menu);
    return false;
  }
  const padding = 8;
  const composer = trigger.closest(".composer");
  const gap = placement?.gap ?? (composer ? 8 : 5);
  const { left, right, top, bottom } = placement?.anchor ?? trigger.getBoundingClientRect();
  const { clientWidth: width, clientHeight: height } = document.documentElement;
  const clip = (composer ?? trigger.closest(".history-scroll"))?.getBoundingClientRect();
  const rail = trigger.closest("#composer-options");
  const attachments = trigger.closest("#reference-rail > #reference-bindings");
  const timeline = trigger.closest(".keyframe-sequence");
  const railBounds = (rail ?? attachments ?? timeline)?.getBoundingClientRect();
  const clipLeft = Math.max(0, clip?.left ?? 0, railBounds?.left ?? 0);
  const clipRight = Math.min(width, clip?.right ?? width, railBounds?.right ?? width);
  if (right <= clipLeft || left >= clipRight ||
      bottom <= Math.max(0, clip?.top ?? 0, railBounds?.top ?? 0) ||
      top >= Math.min(height, clip?.bottom ?? height, railBounds?.bottom ?? height)) {
    if (rail && (menu.contains(document.activeElement) || document.activeElement === trigger)) {
      const visible = [...rail.querySelectorAll(":scope > button:not([hidden]):not(:disabled)")].find((button) => {
        const bounds = button.getBoundingClientRect();
        return bounds.right > clipLeft && bounds.left < clipRight;
      });
      (visible ?? rail.parentElement.querySelector(".composer-scroll:not([hidden])"))?.focus({ preventScroll: true });
    } else if (attachments && (menu.contains(document.activeElement) || document.activeElement === trigger)) {
      byId("reference-add").focus({ preventScroll: true });
    } else if (timeline && (menu.contains(document.activeElement) || document.activeElement === trigger)) {
      const visible = [...timeline.querySelectorAll(".keyframe-image")].find((tile) => {
        const bounds = tile.getBoundingClientRect();
        const overlap = Math.min(bounds.right, clipRight) - Math.max(bounds.left, clipLeft);
        return overlap >= Math.min(bounds.width, 20);
      });
      closeMenu(menu, visible ?? timeline);
      return false;
    }
    closeMenu(menu);
    return false;
  }
  const below = height - bottom - gap - padding;
  const aboveAnchorTop = placement?.aboveAnchorTop ?? top;
  const above = aboveAnchorTop - gap - padding;
  const menuHeight = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
  const fitsPreferredSide = composer && above >= (placement?.preferredAboveRoom ?? Math.min(menuHeight, 96));
  const openAbove = fitsPreferredSide || (below < menuHeight && above > below);
  menu.style.setProperty("--menu-height", `${Math.max(30, openAbove ? above : below)}px`);
  const rect = menu.getBoundingClientRect();
  const x = menu.classList.contains("result-menu") ? right - rect.width : Math.max(left, railBounds?.left ?? left) + (placement?.offsetX ?? 0);
  const y = openAbove ? aboveAnchorTop - rect.height - gap : bottom + gap;
  menu.style.setProperty("--menu-left", `${Math.max(padding, Math.min(x, width - rect.width - padding))}px`);
  menu.style.setProperty("--menu-top", `${Math.max(padding, Math.min(y, height - rect.height - padding))}px`);
  menu.dataset.positioned = "";
  return placement ?? {};
}

function menuButtons(menu) {
  return [...menu.querySelectorAll("button:not(:disabled)")].filter((button) => button.getClientRects().length);
}

function focusMenuOption(menu, option) {
  if (!option) return;
  option.focus({ preventScroll: true });
  const area = option.closest("[data-menu-scroll-area]");
  if (area && area.scrollHeight > area.clientHeight && getComputedStyle(area).overflowY === "auto") {
    revealMenuOption(area, option);
  }
  revealMenuOption(menu, option);
}

function revealMenuOption(scroller, option) {
  const top = scroller.getBoundingClientRect().top + scroller.clientTop;
  const bottom = top + scroller.clientHeight;
  const bounds = option.getBoundingClientRect();
  if (bounds.top < top) scroller.scrollTop += bounds.top - top;
  else if (bounds.bottom > bottom) scroller.scrollTop += bounds.bottom - bottom;
}

function focusMenuEdge(menu, key) {
  focusMenuOption(menu, menuButtons(menu).at(key === "ArrowUp" ? -1 : 0));
}

function bindMenu(trigger, menu) {
  menuAnchors.set(menu, { trigger });
  trigger.setAttribute("aria-expanded", "false");
  for (const button of menu.querySelectorAll("button")) button.tabIndex = -1;
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!menu.matches(":popover-open")) menu.showPopover({ source: trigger });
  });
  menu.addEventListener("beforetoggle", (event) => {
    if (event.newState === "open") delete menu.dataset.positioned;
  });
  menu.addEventListener("toggle", (event) => {
    const open = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const placement = positionMenu(menu);
    if (!placement || placement.keepFocus) return;
    const options = menuButtons(menu);
    const initial = menu.querySelector("[autofocus]:not(:disabled)")
      ?? options.find((item) => item.getAttribute("aria-checked") === "true") ?? options[0]
      ?? menu.querySelector("input:not(:disabled)");
    focusMenuOption(menu, initial);
  });
  menu.addEventListener("keydown", (event) => {
    const editing = event.target instanceof HTMLInputElement;
    if (event.key === "Escape" || (event.key === "Tab" && !editing)) {
      menu.hidePopover();
      trigger.focus({ preventScroll: true });
      if (event.key === "Escape") event.preventDefault();
      return;
    }
    if (editing) return;
    const options = menuButtons(menu);
    const current = options.indexOf(document.activeElement);
    const horizontal = menu.dataset.menuLayout === "choices";
    const index = {
      ArrowDown: (current + 1) % options.length,
      ArrowUp: (current + options.length - 1) % options.length,
      ArrowRight: horizontal ? (current + 1) % options.length : undefined,
      ArrowLeft: horizontal ? (current + options.length - 1) % options.length : undefined,
      Home: 0,
      End: options.length - 1,
    }[event.key];
    if (index === undefined) return;
    event.preventDefault();
    focusMenuOption(menu, options[index]);
  });
}

function closeMenu(menu, focus) {
  if (menu.matches(":popover-open")) menu.hidePopover();
  focus?.focus({ preventScroll: true });
}

function scheduleMenuReposition() {
  if (menuPositionFrame !== null) return;
  menuPositionFrame = requestAnimationFrame(() => {
    menuPositionFrame = null;
    const menu = document.querySelector(".composer-menu:popover-open");
    if (menu) positionMenu(menu);
  });
}

function setMenuPlacement(menu, resolvePlacement) {
  menuAnchors.get(menu).resolvePlacement = resolvePlacement;
}

function initializeMenus() {
  for (const trigger of document.querySelectorAll("[popovertarget]")) bindMenu(trigger, trigger.popoverTargetElement);
  window.addEventListener("resize", scheduleMenuReposition);
  document.addEventListener("scroll", scheduleMenuReposition, true);
}

function bindHorizontalScrollButtons(track, previous, next) {
  for (const [button, direction] of [[previous, -1], [next, 1]]) {
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      track.scrollBy({ left: direction * Math.max(55, Math.floor(track.clientWidth * 0.72)) });
    });
  }
  return () => {
    const atStart = track.scrollLeft <= 1;
    const atEnd = track.scrollLeft >= track.scrollWidth - track.clientWidth - 1;
    for (const [button, disabled] of [[previous, atStart], [next, atEnd]]) {
      button.setAttribute("aria-disabled", String(disabled));
      button.tabIndex = disabled ? -1 : 0;
    }
  };
}

function initializeComposerOptions() {
  const track = byId("composer-options");
  const shell = track.parentElement;
  const previous = byId("composer-scroll-prev");
  const next = byId("composer-scroll-next");
  const updateButtons = bindHorizontalScrollButtons(track, previous, next);

  function update() {
    // Compare to the full shell, including navigation space. Otherwise the
    // navigation controls could keep themselves visible after a resize.
    const overflow = track.scrollWidth > shell.clientWidth + 1;
    const focusedArrow = document.activeElement === previous || document.activeElement === next;
    previous.hidden = next.hidden = !overflow;
    updateButtons();
    if (!overflow && focusedArrow) track.querySelector("button:not([hidden])")?.focus({ preventScroll: true });
    scheduleMenuReposition();
  }

  track.addEventListener("focusin", ({ target }) => {
    if (target.parentElement !== track || !target.matches("button:focus-visible")) return;
    const rail = track.getBoundingClientRect();
    const item = target.getBoundingClientRect();
    // Native Tab scrolling can leave the focused button partly clipped.
    if (item.left < rail.left) track.scrollLeft += Math.floor(item.left - rail.left);
    else if (item.right > rail.right) track.scrollLeft += Math.ceil(item.right - rail.right);
  });
  track.addEventListener("scroll", update);
  const observer = new ResizeObserver(update);
  observer.observe(shell);
  for (const child of track.children) {
    if (child.matches("button, span, output")) observer.observe(child);
  }
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  update();
}

function setMenuValue(menu, attribute, value) {
  for (const option of menu.querySelectorAll(`[${attribute}]`)) {
    option.setAttribute("aria-checked", String(option.getAttribute(attribute) === String(value)));
  }
}
