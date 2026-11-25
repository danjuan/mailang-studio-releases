"use strict";

function createKeyframeNavigation(track) {
  const controls = byId("keyframe-navigation");
  const updateButtons = bindHorizontalScrollButtons(track, byId("keyframe-scroll-prev"), byId("keyframe-scroll-next"));

  function update() {
    const overflow = !track.hidden && track.scrollWidth > track.clientWidth + 1;
    if (!overflow && !track.hidden && controls.contains(document.activeElement)) {
      track.focus({ preventScroll: true });
    }
    controls.hidden = !overflow;
    updateButtons();
    scheduleMenuReposition();
  }

  track.addEventListener("scroll", update, { passive: true });
  const observer = new ResizeObserver(update);
  observer.observe(track);
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  return update;
}

// The track owns the pointer only after movement crosses the drag threshold.
// Ordinary clicks still open the thumbnail preview or the empty slot picker.
function createKeyframeReorder(track, canMove, move) {
  let drag = null;
  let marker = null;
  let scrollFrame = 0;

  function mark(card, edge) {
    if (marker !== card) {
      if (marker) delete marker.dataset.dropEdge;
      marker = card;
    }
    if (card) card.dataset.dropEdge = edge;
  }

  function reset() {
    if (!drag) return;
    const { pointer, card } = drag;
    drag = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    delete card.dataset.dragging;
    mark(null);
    if (track.hasPointerCapture(pointer)) track.releasePointerCapture(pointer);
  }

  function inTrack(x, y) {
    return document.elementFromPoint(x, y)?.closest(".keyframe-sequence") === track;
  }

  function locate(x) {
    const cards = [...track.querySelectorAll('.keyframe-card[data-append="false"]')];
    const next = cards.findIndex((card) => {
      const rect = card.getBoundingClientRect();
      return x < rect.left + rect.width / 2;
    });
    const insertion = next < 0 ? cards.length : next;
    const source = cards.indexOf(drag.card);
    const index = insertion > source ? insertion - 1 : insertion;
    return source < 0 || index === source ? null : {
      index,
      card: next < 0 ? cards.at(-1) : cards[next],
      edge: next < 0 ? "after" : "before",
    };
  }

  function update() {
    scrollFrame = 0;
    if (!drag?.started || drag.canceled) return;
    const { x, y } = drag;
    if (!inTrack(x, y)) {
      mark(null);
      return;
    }
    const target = locate(x);
    mark(target?.card ?? null, target?.edge);
    const bounds = track.getBoundingClientRect();
    const distance = Math.min(x - bounds.left, bounds.right - x);
    if (distance >= 28) return;
    const direction = x < bounds.left + bounds.width / 2 ? -1 : 1;
    const previous = track.scrollLeft;
    track.scrollLeft += direction * Math.ceil((28 - distance) / 3);
    if (track.scrollLeft !== previous) scrollFrame = requestAnimationFrame(update);
  }

  track.addEventListener("pointerdown", (event) => {
    if (drag || event.button !== 0 || !event.isPrimary || !canMove()) return;
    const grip = event.target.closest(".keyframe-grip");
    const source = grip ?? (event.pointerType !== "touch" && event.target.closest(".keyframe-image"));
    const card = source && source.closest('.keyframe-card[data-append="false"]');
    if (!card || !grip && card.dataset.empty === "true") return;
    const { pointerId, clientX: x, clientY: y } = event;
    drag = { pointer: pointerId, card, startX: x, startY: y, x, y, started: false, canceled: false };
  });

  track.addEventListener("pointermove", (event) => {
    if (drag?.pointer !== event.pointerId || drag.canceled) return;
    const { clientX: x, clientY: y } = event;
    if (!drag.started) {
      if (Math.hypot(x - drag.startX, y - drag.startY) < 6) return;
      drag.started = true;
      drag.card.dataset.dragging = "";
      track.setPointerCapture(event.pointerId);
    }
    drag.x = x;
    drag.y = y;
    if (!scrollFrame) scrollFrame = requestAnimationFrame(update);
  });

  track.addEventListener("pointerup", (event) => {
    if (drag?.pointer !== event.pointerId) return;
    const target = drag.started && !drag.canceled && canMove() && inTrack(event.clientX, event.clientY)
      && locate(event.clientX);
    const source = Number(drag.card.dataset.keyframeIndex);
    reset();
    if (target) move(source, target.index);
  });

  track.addEventListener("pointerleave", () => {
    if (drag && !drag.started) reset();
  });
  track.addEventListener("pointercancel", (event) => {
    if (drag?.pointer === event.pointerId) reset();
  });
  track.addEventListener("lostpointercapture", (event) => {
    if (event.target === track && drag?.pointer === event.pointerId) reset();
  });
  document.addEventListener("keydown", (event) => {
    if (!drag?.started || event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    drag.canceled = true;
    delete drag.card.dataset.dragging;
    mark(null);
  }, { capture: true });
  window.addEventListener("blur", reset);
  return reset;
}
