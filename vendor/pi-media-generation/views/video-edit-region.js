function createVideoEditRegion({ labels, onLayer }) {
  const dialog = byId("video-edit-region");
  const stage = byId("video-edit-stage");
  const video = byId("video-edit-source");
  const overlay = byId("video-edit-overlay");
  const box = byId("video-edit-box");
  const scrub = byId("video-edit-scrub");
  const play = byId("video-edit-play");
  const clock = byId("video-edit-time");
  const clear = byId("video-edit-clear");
  const cancel = byId("video-edit-cancel");
  const apply = byId("video-edit-apply");
  const message = byId("video-edit-error");
  const axes = ["x", "y", "width", "height"];
  const fields = axes.map((axis) => byId(`video-edit-${axis}`));
  const observer = new ResizeObserver(fitOverlay);
  let active;
  let drag;

  function stagePoint(event) {
    const bounds = overlay.getBoundingClientRect();
    return {
      x: Math.round(100 * Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))),
      y: Math.round(100 * Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))),
    };
  }

  function fitOverlay() {
    if (!active?.loaded) return;
    const stageBounds = stage.getBoundingClientRect();
    const bounds = video.getBoundingClientRect();
    const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    Object.assign(overlay.style, {
      left: `${bounds.left - stageBounds.left - stage.clientLeft + (bounds.width - width) / 2}px`,
      top: `${bounds.top - stageBounds.top - stage.clientTop + (bounds.height - height) / 2}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }

  function formatTime(seconds) {
    const centiseconds = Math.round(seconds * 100);
    const minutes = Math.floor(centiseconds / 6000);
    const remainder = ((centiseconds % 6000) / 100).toFixed(2).padStart(5, "0");
    return `${minutes}:${remainder}`;
  }

  function updateClock() {
    if (!active?.loaded) {
      scrub.value = "0";
      clock.textContent = "";
      return;
    }
    scrub.value = String(video.currentTime);
    clock.textContent = `${formatTime(video.currentTime)} / ${formatTime(active.limit)}`;
  }

  function draw(region) {
    box.hidden = !region || overlay.dataset.ready !== "true";
    if (box.hidden) return;
    Object.assign(box.style, {
      left: `${Math.round(region.x * 100)}%`,
      top: `${Math.round(region.y * 100)}%`,
      width: `${Math.round(region.width * 100)}%`,
      height: `${Math.round(region.height * 100)}%`,
    });
  }

  function paint() {
    const loaded = Boolean(active?.loaded);
    const ready = loaded && !video.seeking;
    overlay.dataset.ready = String(ready);
    play.disabled = !loaded;
    play.textContent = labels()[video.paused ? "videoEditPlay" : "videoEditPause"];
    scrub.disabled = !loaded;
    for (const field of fields) field.disabled = !ready;
    clear.disabled = !loaded || (!active.region && !active.invalid);
    apply.disabled = !ready || active.invalid;
    const marked = active?.region;
    const sameFrame = marked && Math.abs(video.currentTime - marked.atSeconds) <= 0.05;
    draw(!active?.invalid && sameFrame ? marked : null);
  }

  function setRegion(region, preserveFields = false) {
    active.region = region;
    active.invalid = false;
    if (!preserveFields) {
      axes.forEach((axis, index) => {
        fields[index].value = region ? String(Math.round(region[axis] * 100)) : "";
      });
    }
    feedback(message, "");
    paint();
  }

  function regionFromPercent(x, y, width, height, atSeconds) {
    if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
        x + width > 100 || y + height > 100) return null;
    return { x: x / 100, y: y / 100, width: width / 100, height: height / 100, atSeconds };
  }

  function useFieldValues() {
    if (overlay.dataset.ready !== "true") return;
    video.pause();
    const values = fields.map((field) => field.valueAsNumber);
    const region = regionFromPercent(...values, markTime());
    if (region) {
      setRegion(region, true);
      return;
    }
    active.invalid = true;
    const complete = values.every(Number.isFinite);
    feedback(message, complete ? labels().videoEditInvalidRegion : "", complete);
    paint();
  }

  function markTime() {
    return Math.round(Math.min(video.currentTime, active.limit) * 100) / 100;
  }

  function regionFromDrag(event) {
    const point = stagePoint(event);
    const { anchor, atSeconds } = drag;
    return regionFromPercent(Math.min(anchor.x, point.x), Math.min(anchor.y, point.y),
      Math.abs(anchor.x - point.x), Math.abs(anchor.y - point.y), atSeconds);
  }

  function resetDrag(event) {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    paint();
  }

  overlay.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || overlay.dataset.ready !== "true") return;
    event.preventDefault();
    video.pause();
    overlay.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, anchor: stagePoint(event), atSeconds: markTime() };
  });
  overlay.addEventListener("pointermove", (event) => {
    if (drag?.id === event.pointerId) draw(regionFromDrag(event));
  });
  overlay.addEventListener("pointerup", (event) => {
    if (drag?.id !== event.pointerId) return;
    const region = regionFromDrag(event);
    drag = null;
    if (region) setRegion(region);
    else paint();
  });
  overlay.addEventListener("pointercancel", resetDrag);
  overlay.addEventListener("lostpointercapture", resetDrag);
  for (const field of fields) field.addEventListener("input", useFieldValues);

  function showUnavailable() {
    if (!active) return;
    active.loaded = false;
    feedback(message, labels().videoEditUnavailable, true);
    updateClock();
    paint();
  }

  video.addEventListener("loadeddata", () => {
    if (!active || video.currentSrc !== active.url) return;
    if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration <= 0) {
      showUnavailable();
      return;
    }
    active.loaded = true;
    active.limit = Math.floor(Math.min(video.duration, 15) * 100) / 100;
    scrub.max = String(active.limit);
    if (active.region) video.currentTime = Math.min(active.region.atSeconds, active.limit);
    fitOverlay();
    updateClock();
    paint();
  });
  video.addEventListener("error", () => { if (video.error) showUnavailable(); });
  video.addEventListener("resize", fitOverlay);
  for (const event of ["seeking", "seeked", "play", "pause", "timeupdate"]) {
    video.addEventListener(event, () => {
      if (active?.loaded && video.currentTime > active.limit && !video.paused) {
        video.pause();
        video.currentTime = active.limit;
      }
      updateClock();
      if (!drag) paint();
    });
  }
  scrub.addEventListener("input", () => {
    if (!active?.loaded) return;
    video.pause();
    video.currentTime = scrub.valueAsNumber;
    updateClock();
    paint();
  });
  play.addEventListener("click", async () => {
    const state = active;
    if (!state?.loaded) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    if (video.currentTime >= state.limit) video.currentTime = 0;
    try {
      await video.play();
    } catch (error) {
      if (active === state && error.name !== "AbortError") feedback(message, labels().videoEditUnavailable, true);
    }
  });

  function close({ restoreFocus = true } = {}) {
    const state = active;
    if (!state) return;
    active = null;
    drag = null;
    observer.disconnect();
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (state.url) URL.revokeObjectURL(state.url);
    if (dialog.open) dialog.close();
    onLayer();
    if (restoreFocus && state.trigger?.isConnected && state.trigger.checkVisibility() && !state.trigger.disabled) {
      state.trigger.focus({ preventScroll: true });
    }
  }

  function open({ source, region = null, trigger, apply: accept }) {
    if (active) close({ restoreFocus: false });
    active = { trigger, accept, url: null, region, invalid: false, loaded: false };
    setRegion(region);
    updateClock();
    dialog.showModal();
    onLayer();
    try {
      active.url = createLocalMp4ObjectUrl(source);
      observer.observe(stage);
      observer.observe(video);
      video.src = active.url;
    } catch {
      showUnavailable();
    }
  }

  clear.addEventListener("click", () => { if (active?.loaded) setRegion(null); });
  cancel.addEventListener("click", () => close());
  apply.addEventListener("click", () => {
    if (!active?.loaded || apply.disabled) return;
    const { accept, region } = active;
    close();
    accept(region);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => { if (!dialog.open) close(); });
  return { open, close, isOpen: () => dialog.open };
}
