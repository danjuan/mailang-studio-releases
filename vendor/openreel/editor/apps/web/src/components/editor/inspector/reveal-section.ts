export function revealInspectorSection(root: Document | HTMLElement, id: string): HTMLElement | null {
  const section = root.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
  if (!section) return null;

  const header = section.querySelector<HTMLElement>('[data-slot="toolcraft-panel-section-header"]');
  if (header?.getAttribute("aria-expanded") === "false") header.click();
  header?.focus({ preventScroll: true });
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  return section;
}
