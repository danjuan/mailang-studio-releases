"use strict";

function carriesLocalFiles(event) {
  return event.dataTransfer?.types.includes("Files") === true;
}

function bindLocalMediaDrop(root, targetFor, receive) {
  let active = null;

  function highlight(target) {
    if (active === target) return;
    if (active) delete active.dataset.fileDropActive;
    active = target;
    if (active) active.dataset.fileDropActive = "";
  }

  function targetOf(event) {
    return event.target instanceof Element ? targetFor(event.target) : null;
  }

  function aim(event) {
    if (!carriesLocalFiles(event)) return;
    const target = targetOf(event);
    highlight(target);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  root.addEventListener("dragenter", aim);
  root.addEventListener("dragover", aim);
  root.addEventListener("dragleave", (event) => {
    if (active && !(event.relatedTarget instanceof Node && active.contains(event.relatedTarget))) highlight(null);
  });
  root.addEventListener("drop", (event) => {
    highlight(null);
    if (!carriesLocalFiles(event)) return;
    const target = targetOf(event);
    if (!target) return;
    event.preventDefault();
    const files = [...event.dataTransfer.files];
    if (files.length) receive(target, files);
  });
}

// Dropping outside a media target must not navigate the work panel away.
for (const name of ["dragover", "drop"]) {
  document.addEventListener(name, (event) => {
    if (!event.defaultPrevented && carriesLocalFiles(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "none";
    }
  });
}
