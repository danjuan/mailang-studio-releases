"use strict";

const legacySubjectKinds = ["character", "scene", "prop"];
const projectSubjectKinds = [...legacySubjectKinds, "product", "style", "other"];
const defaultCatalogOptions = { category: "all", filter: "all", period: "all", sort: "newest" };

function subjectKinds(scope) {
  return scope.projectSubjectCategories ? projectSubjectKinds : legacySubjectKinds;
}

function filterLibraryCatalog(items, options, subjects, locale) {
  const { category, filter, period, sort } = options;
  const cutoff = period === "all" ? null : Date.now() - Number(period) * 86_400_000;
  const dated = (item) => Number.isSafeInteger(item.createdAt);
  const matchesFilter = (item) => filter === "all" ||
    (subjects ? (item.assetIds.length === 1 ? "single" : "multiple") === filter : item.kind === filter);
  const filtered = items.filter((item) => (category === "all" || item.kind === category) &&
    matchesFilter(item) && (cutoff === null || dated(item) && item.createdAt >= cutoff));
  if (sort === "name") {
    const byName = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    return filtered.sort((a, b) => byName.compare(a.name, b.name));
  }
  const direction = sort === "oldest" ? 1 : -1;
  return filtered.sort((a, b) => {
    if (dated(a) !== dated(b)) return dated(a) ? -1 : 1;
    return dated(a) ? (a.createdAt - b.createdAt) * direction : 0;
  });
}

function createLibraryCatalogControls(labels, onChange) {
  const controls = byId("library-catalog-controls");
  const categoryGroup = byId("library-categories");
  const categories = ["all", ...projectSubjectKinds].map((value) => {
    const button = action("", () => onChange("category", value), "catalog-category");
    button.dataset.subjectCategory = value;
    categoryGroup.append(button);
    return button;
  });
  const menus = [
    { key: "filter", label: "catalogFilter" },
    { key: "period", label: "catalogTime", choices: { all: "catalogAnyTime", 7: "catalogSevenDays", 30: "catalogThirtyDays" } },
    { key: "sort", label: "catalogSort", choices: { newest: "catalogNewest", oldest: "catalogOldest", name: "catalogByName" } },
  ].map((entry) => ({ ...entry, trigger: byId(`library-${entry.key}`), menu: byId(`library-${entry.key}-menu`) }));

  return (state, options, visible) => {
    controls.hidden = !visible;
    if (!visible) return;
    const text = labels();
    const subjects = state.tab === "subjects";
    categoryGroup.hidden = !subjects;
    for (const button of categories) {
      const value = button.dataset.subjectCategory;
      button.hidden = value !== "all" && !subjectKinds(state.scope).includes(value);
      button.textContent = text[value === "all" ? "allReferences" : value];
      button.setAttribute("aria-pressed", String(value === options.category));
    }
    const filterChoices = subjects
      ? { all: "catalogAnySubject", single: "catalogSingleImage", multiple: "catalogMultipleImages" }
      : { all: "catalogAnyMedia", image: "imageKind", video: "videoKind" };
    for (const { key, label, trigger, menu, choices = filterChoices } of menus) {
      trigger.dataset.active = String(options[key] !== defaultCatalogOptions[key]);
      trigger.setAttribute("aria-label", `${text[label]} · ${text[choices[options[key]]]}`);
      menu.replaceChildren(...Object.entries(choices).sort(([a], [b]) => Number(b === "all") - Number(a === "all"))
        .map(([value, option]) => {
          const button = action(text[option], () => {
            closeMenu(menu, trigger);
            onChange(key, value);
          });
          button.dataset.catalogValue = value;
          button.setAttribute("role", "menuitemradio");
          button.setAttribute("aria-checked", String(value === options[key]));
          button.tabIndex = -1;
          return button;
        }));
    }
  };
}
