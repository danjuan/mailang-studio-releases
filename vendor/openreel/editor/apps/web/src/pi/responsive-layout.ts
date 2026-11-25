import { useLayoutEffect, useState, type RefObject } from "react";

const WIDE_EDITOR_WIDTH = 1100;

interface Size {
  width: number;
  height: number;
}

export function isWidePiEditor(width: number): boolean {
  return width >= WIDE_EDITOR_WIDTH;
}

export function fitPreviewFrame(
  viewport: Size,
  project: Size,
  zoom: number,
) {
  const scale = Math.min(viewport.width / project.width, viewport.height / project.height) * zoom;
  return { width: project.width * scale, height: project.height * scale };
}

export function observePiBox(
  element: Element,
  onResize: (size: Size) => void,
  box: "content-box" | "border-box" = "content-box",
): () => void {
  let frame: number | undefined;
  let next: Size | undefined;
  let delivered: Size | undefined;

  // Layout derived from a measurement may resize other observed elements.
  // Publish the latest value on a new frame, outside ResizeObserver delivery.
  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const border = box === "border-box" ? entry.borderBoxSize?.[0] : undefined;
    next = border
      ? { width: border.inlineSize, height: border.blockSize }
      : { width: entry.contentRect.width, height: entry.contentRect.height };
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!next || (next.width === delivered?.width && next.height === delivered.height)) return;
      delivered = next;
      onResize(next);
    });
  });
  observer.observe(element, { box });
  return () => {
    observer.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}

export function useObservedWidth<T extends HTMLElement>(
  ref: RefObject<T | null>,
  enabled: boolean,
): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof ResizeObserver === "undefined") return;
    setWidth(element.getBoundingClientRect().width);
    return observePiBox(element, (size) => setWidth(size.width), "border-box");
  }, [enabled, ref]);
  return width;
}
