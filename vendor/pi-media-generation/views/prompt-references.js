"use strict";

function createPromptReferenceTargets({ prompt, pattern, labels, open }) {
  const layer = byId("prompt-reference-targets");
  const targets = new Map();
  let draft;
  let frame;
  let layout;
  let pointer;
  let pendingMove;
  let composing = false;

  function selection() {
    return [prompt.selectionStart, prompt.selectionEnd, prompt.selectionDirection];
  }

  function layoutIsCurrent() {
    return !composing && layout && layout.draft === draft && layout.value === prompt.value &&
      layout.width === prompt.clientWidth && layout.height === prompt.clientHeight &&
      layout.top === prompt.scrollTop && layout.left === prompt.scrollLeft;
  }

  function referenceAt(event) {
    if (!layoutIsCurrent() || !targets.size) return;
    const origin = layer.getBoundingClientRect();
    const field = prompt.getBoundingClientRect();
    if (field.left - origin.left !== layout.x || field.top - origin.top !== layout.y) return;
    const x = event.clientX - origin.left;
    const y = event.clientY - origin.top;
    for (const reference of targets.values()) {
      if (reference.rects.some((rect) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)) return reference;
    }
  }

  function canOpen(reference) {
    return reference && !composing && draft === reference.draft && draft.references.includes(reference.entry) &&
      prompt.value.slice(reference.start, reference.end) === reference.token;
  }

  function clearPointer() {
    pointer = undefined;
    if (pendingMove !== undefined) cancelAnimationFrame(pendingMove);
    pendingMove = undefined;
    prompt.classList.remove("over-prompt-reference", "dragging-prompt-reference");
  }

  function hasModifier(event) {
    return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
  }

  function crossedDragThreshold(gesture, event) {
    return Math.abs(event.clientX - gesture.x) > 4 || Math.abs(event.clientY - gesture.y) > 4;
  }

  function moveReference(gesture) {
    const { draft: originalDraft, value, reference } = gesture;
    if (originalDraft !== draft || composing || document.activeElement !== prompt || value !== prompt.value ||
        !draft.references.includes(reference.entry)) return;
    const originalSelection = selection();
    const [start, end] = originalSelection;
    // Chromium can report a mouse selection's direction as "none". The
    // source endpoint is the one still inside the reference that was grabbed.
    const startsInReference = start >= reference.start && start <= reference.end;
    const endsInReference = end >= reference.start && end <= reference.end;
    if (startsInReference === endsInReference) return;
    let destination = startsInReference ? end : start;
    for (const match of value.matchAll(pattern)) {
      if (destination > match.index && destination < match.index + match[0].length) {
        destination = destination < reference.start ? match.index : match.index + match[0].length;
        break;
      }
    }
    const result = movePromptMention(value, reference, destination);
    if (!result) return;
    prompt.setSelectionRange(result.start, result.end);
    // Chromium's editing command records the move in the native undo stack.
    // Assigning textarea.value or setRangeText would bypass that edit history.
    if (document.execCommand("insertText", false, result.text)) {
      prompt.setSelectionRange(result.destination, result.destination + reference.token.length);
    } else {
      prompt.setSelectionRange(...originalSelection);
    }
  }

  function position(node, rect, origin) {
    Object.assign(node.style, {
      left: `${rect.left - origin.left}px`,
      top: `${rect.top - origin.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function addTarget(key) {
    const target = action("", () => {
      const reference = targets.get(key);
      if (!canOpen(reference)) return;
      open(reference, target);
    }, "prompt-reference-target");
    target.setAttribute("aria-haspopup", "dialog");
    target.setAttribute("aria-controls", "preview");
    target.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      prompt.focus({ preventScroll: true });
    });
    return target;
  }

  function render() {
    frame = undefined;
    if (!draft || composing) return;
    const value = prompt.value;
    const entries = new Map(draft.references.map((entry) => [entry.label, entry]));
    const mentions = entries.size ? [...value.matchAll(pattern)].filter((match) => entries.has(match[1])) : [];
    const origin = layer.getBoundingClientRect();
    const field = prompt.getBoundingClientRect();
    layout = {
      draft, value, x: field.left - origin.left, y: field.top - origin.top,
      width: prompt.clientWidth, height: prompt.clientHeight, top: prompt.scrollTop, left: prompt.scrollLeft,
    };
    const used = new Set();
    // Collect all ranges before changing the overlay. Separate fragments keep
    // the whitespace next to a wrapped token available for normal editing.
    const visible = mentions.length ? withTextareaLayout(prompt, (rects) => mentions.flatMap((match) => {
      const [token, label] = match;
      const start = match.index;
      const end = start + token.length;
      const [first, ...rest] = rects(start, end);
      return first ? [{ token, label, start, end, first, rest }] : [];
    })) ?? [] : [];

    let previous = null;
    for (const { token, label, start, end, first, rest } of visible) {
      const key = `${start}:${label}`;
      const target = targets.get(key)?.target ?? addTarget(key);
      const title = `${labels().preview} @${label}`;
      target.dataset.promptReferenceLabel = label;
      target.dataset.promptReferenceStart = String(start);
      target.setAttribute("aria-label", title);
      target.title = title;
      position(target, first, origin);
      target.replaceChildren(...rest.map((rect) => {
        const fragment = make("span", "prompt-reference-fragment");
        fragment.setAttribute("aria-hidden", "true");
        position(fragment, rect, first);
        return fragment;
      }));
      const next = previous ? previous.nextElementSibling : layer.firstElementChild;
      if (next !== target) layer.insertBefore(target, next);
      previous = target;
      used.add(key);
      const rects = [first, ...rest].map((rect) =>
        new DOMRect(rect.left - origin.left, rect.top - origin.top, rect.width, rect.height));
      targets.set(key, { target, token, start, end, rects, draft, entry: entries.get(label) });
    }
    for (const [key, { target }] of targets) {
      if (used.has(key)) continue;
      if (target === document.activeElement) prompt.focus({ preventScroll: true });
      target.remove();
      targets.delete(key);
    }
  }

  function schedule() {
    if (draft && frame === undefined && !composing) frame = requestAnimationFrame(render);
  }

  const observer = new ResizeObserver(schedule);
  observer.observe(prompt);
  observer.observe(layer);
  prompt.addEventListener("input", () => {
    clearPointer();
    schedule();
  });
  prompt.addEventListener("scroll", schedule);
  prompt.addEventListener("pointerdown", (event) => {
    clearPointer();
    if (!event.isPrimary || event.button !== 0 || hasModifier(event)) return;
    const reference = referenceAt(event);
    if (!canOpen(reference)) return;
    pointer = {
      draft, value: prompt.value, reference, id: event.pointerId, x: event.clientX, y: event.clientY,
      selection: selection(), top: prompt.scrollTop, left: prompt.scrollLeft, dragging: false,
    };
    const [start, end] = pointer.selection;
    if (start !== end && start < reference.end && reference.start < end) {
      // A selected mention should still move as a unit on the next drag.
      prompt.setSelectionRange(reference.end, reference.end);
    }
  });
  document.addEventListener("pointermove", (event) => {
    if (pointer?.id === event.pointerId && (event.buttons & 1) && crossedDragThreshold(pointer, event)) {
      pointer.dragging = true;
      prompt.classList.add("dragging-prompt-reference");
    }
    if (!event.buttons) {
      const hover = event.target === prompt && event.pointerType === "mouse" && Boolean(referenceAt(event));
      prompt.classList.toggle("over-prompt-reference", hover);
    }
  }, { passive: true });
  document.addEventListener("pointerup", (event) => {
    if (pointer?.id !== event.pointerId) return;
    const gesture = pointer;
    if (gesture.dragging || crossedDragThreshold(gesture, event)) {
      clearPointer();
      if (event.target === prompt && !hasModifier(event)) {
        pendingMove = requestAnimationFrame(() => {
          pendingMove = undefined;
          moveReference(gesture);
        });
      }
    } else if (event.target !== prompt) {
      clearPointer();
    }
  });
  prompt.addEventListener("click", (event) => {
    const gesture = pointer;
    if (!gesture) return;
    clearPointer();
    if (event.detail !== 1 || hasModifier(event) || crossedDragThreshold(gesture, event)) return;
    const reference = referenceAt(event);
    if (!canOpen(reference) || reference.target !== gesture.reference.target ||
        gesture.draft !== draft || gesture.value !== prompt.value) return;
    prompt.setSelectionRange(...gesture.selection);
    prompt.scrollTop = gesture.top;
    prompt.scrollLeft = gesture.left;
    reference.target.focus({ preventScroll: true });
    open(reference, reference.target);
  });
  document.addEventListener("pointercancel", clearPointer);
  document.addEventListener("dragstart", clearPointer);
  document.addEventListener("wheel", clearPointer, { passive: true });
  window.addEventListener("blur", clearPointer);
  prompt.addEventListener("keydown", (event) => {
    if (event.key === "Escape") clearPointer();
  });
  prompt.addEventListener("compositionstart", () => {
    clearPointer();
    composing = true;
    layer.hidden = true;
  });
  prompt.addEventListener("compositionend", () => {
    composing = false;
    layer.hidden = false;
    schedule();
  });

  return {
    update(next) {
      if (next !== draft) {
        clearPointer();
        layout = undefined;
        targets.clear();
        layer.replaceChildren();
        layer.hidden = false;
        composing = false;
      }
      draft = next;
      schedule();
    },
  };
}

function movePromptMention(value, { start, end, token }, destination) {
  if (destination < start) {
    return { start: destination, end, text: token + value.slice(destination, start), destination };
  }
  if (destination > end) {
    return { start, end: destination, text: value.slice(end, destination) + token, destination: destination - token.length };
  }
  return null;
}
