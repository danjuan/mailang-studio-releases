import React, { useState, useEffect, useMemo } from "react";
import { Search, Layout, Clock } from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@openreel/ui";
import { ToolcraftDialog as Dialog, ToolcraftDialogHeader as DialogHeader } from "@openreel/ui";
import { ToolcraftSelectableCard as SelectableCard } from "@openreel/ui";
import { ToolcraftTextInputControl } from "@openreel/ui";
import { useEngineStore } from "../../../stores/engine-store";
import { useProjectStore } from "../../../stores/project-store";
import { capturePiDraftTarget } from "../../../pi/environment";
import { usePiEditorCopy, type PiEditorTranslator } from "../../../pi/editor-copy";
import { applyPiProjectTemplate } from "../../../pi/template-project";
import { syncPiTimeline } from "../../../pi/pi-timeline";
import { toast } from "../../../stores/notification-store";
import { useUIStore } from "../../../stores/ui-store";
import type {
  TemplateSummary,
  TemplateCategory,
} from "@openreel/core";
import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from "@openreel/core";
import "./templates-tab.css";

const builtinIds = new Set(BUILTIN_TEMPLATES.map((template) => template.id));

function templateName(template: TemplateSummary, translate: PiEditorTranslator): string {
  return builtinIds.has(template.id) ? translate(template.name) : template.name;
}

function templateCategory(category: TemplateCategory, translate: PiEditorTranslator): string {
  return translate(TEMPLATE_CATEGORIES.find((entry) => entry.id === category)?.name ?? category);
}

export const TemplatesTab: React.FC = () => {
  const t = usePiEditorCopy();
  const getTemplateEngine = useEngineStore((s) => s.getTemplateEngine);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<
    "all" | TemplateCategory
  >("all");
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    template: TemplateSummary;
    runForDraft: NonNullable<ReturnType<typeof capturePiDraftTarget>>;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const engine = await getTemplateEngine();
        await engine.initialize();
        const list = await engine.listTemplates();
        if (!cancelled) setTemplates(list);
      } catch (error) {
        console.error("Failed to load templates", error);
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [getTemplateEngine]);

  const filteredTemplates = useMemo(() => {
    let result = templates;
    if (selectedCategory !== "all") {
      result = result.filter((t) => t.category === selectedCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((template) =>
        template.name.toLowerCase().includes(q) || templateName(template, t).toLowerCase().includes(q),
      );
    }
    return result;
  }, [templates, selectedCategory, searchQuery, t]);

  const selectTemplate = (template: TemplateSummary): void => {
    const runForDraft = capturePiDraftTarget();
    if (runForDraft) setConfirmation({ template, runForDraft });
  };

  const applyConfirmedTemplate = async (): Promise<void> => {
    if (!confirmation || applying) return;
    const { template: { id }, runForDraft } = confirmation;
    setConfirmation(null);
    setApplying(id);
    try {
      const engine = await getTemplateEngine();
      const template = await engine.loadTemplate(id);
      if (!template) throw new Error("Local template was unavailable");
      const applied = await runForDraft(() => {
        const store = useProjectStore.getState();
        const project = applyPiProjectTemplate(engine, template, store.project);
        store.loadProject(project);
        syncPiTimeline(project.timeline.duration, true);
        useUIStore.getState().clearSelection();
      });
      if (!applied) {
        toast.warning("Draft changed. Open the template again.");
      }
    } catch (error) {
      console.error("Failed to apply template", error);
      toast.error("Failed to apply template");
    } finally {
      setApplying(null);
    }
  };

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (mins > 0) return `${mins}:${secs.toString().padStart(2, "0")}`;
    return `${secs}${t(" sec")}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-text-muted text-xs">
        Loading templates...
      </div>
    );
  }
  if (loadFailed) {
    return <p role="alert" className="p-3 text-xs text-text-muted">Failed to load templates</p>;
  }

  return (
    <div
      data-pi-template-browser
      className="px-5 py-4 space-y-3 flex-1 min-h-0 h-full overflow-y-auto bg-background-secondary"
    >
      <div className="relative">
        <Search
          size={14}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
        />
        <ToolcraftTextInputControl
          label="Search templates"
          isLabelHidden
          placeholder="Search templates..."
          value={searchQuery}
          onChange={setSearchQuery}
          className="w-full pl-8 pr-3 py-2 text-xs bg-background-secondary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary/50"
        />
      </div>

      <div className="flex gap-1.5 flex-wrap">
        <SelectableCard
          label="All"
          isSelected={selectedCategory === "all"}
          onChange={() => setSelectedCategory("all")}
          onClick={() => setSelectedCategory("all")}
          padding={1}
          variant={selectedCategory === "all" ? "green" : "muted"}
          className={`px-2.5 py-1 text-[10px] rounded-full border transition-colors ${
            selectedCategory === "all"
              ? "bg-primary/20 border-primary text-primary"
              : "bg-background-tertiary border-border text-text-muted hover:border-primary/50"
          }`}
        >
          All
        </SelectableCard>
        {TEMPLATE_CATEGORIES.filter((entry) => templates.some((template) => template.category === entry.id)).map((cat) => (
          <SelectableCard
            key={cat.id}
            label={t(cat.name)}
            isSelected={selectedCategory === cat.id}
            onChange={() => setSelectedCategory(cat.id)}
            onClick={() => setSelectedCategory(cat.id)}
            padding={1}
            variant={selectedCategory === cat.id ? "green" : "muted"}
            className={`px-2.5 py-1 text-[10px] rounded-full border transition-colors ${
              selectedCategory === cat.id
                ? "bg-primary/20 border-primary text-primary"
                : "bg-background-tertiary border-border text-text-muted hover:border-primary/50"
            }`}
          >
            {t(cat.name)}
          </SelectableCard>
        ))}
      </div>

      {filteredTemplates.length === 0 ? (
        <div className="text-center py-8 text-text-muted text-xs">
          No templates found
        </div>
      ) : (
        <div data-pi-template-grid className="grid grid-cols-2 gap-2">
          {filteredTemplates.map((template) => (
            <Button
              key={template.id}
              label={templateName(template, t)}
              data-pi-template-id={template.id}
              variant="ghost"
              onClick={() => selectTemplate(template)}
              isDisabled={applying !== null}
              className="group relative flex flex-col p-3 bg-background-tertiary border border-border rounded-lg hover:border-primary/50 transition-all text-left disabled:opacity-50"
            >
              <div className="pi-template-thumbnail w-full aspect-video bg-background-secondary rounded mb-2 flex items-center justify-center" aria-hidden="true">
                {template.thumbnailUrl ? (
                  <img
                    src={template.thumbnailUrl}
                    alt=""
                    className="w-full h-full object-cover rounded"
                  />
                ) : (
                  <Layout size={20} className="text-text-muted" />
                )}
              </div>
              <div className="pi-template-details min-w-0 w-full">
                <span className="pi-template-name block text-[10px] font-medium text-text-primary truncate w-full">
                  {templateName(template, t)}
                </span>
                <div className="pi-template-meta flex items-center gap-2 mt-1">
                  <span className="text-[9px] text-text-muted capitalize">
                    {templateCategory(template.category, t)}
                  </span>
                  <span className="flex items-center gap-0.5 text-[9px] text-text-muted whitespace-nowrap">
                    <Clock size={8} aria-hidden="true" />
                    {formatDuration(template.duration)}
                  </span>
                </div>
              </div>
              {applying === template.id && (
                <div className="absolute inset-0 bg-background-primary/80 rounded-lg flex items-center justify-center">
                  <span className="text-[10px] text-primary">Applying...</span>
                </div>
              )}
            </Button>
          ))}
        </div>
      )}
      <Dialog className="pi-template-dialog" isOpen={confirmation !== null} onOpenChange={(open) => !open && setConfirmation(null)} width={420}>
        <DialogHeader
          title="Apply Project Template"
          subtitle="Replace this draft’s timeline and project settings? Imported media stays in the library. Add local media to empty source tracks after applying."
        />
        <div data-pi-template-confirm className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
          <Button label="Cancel" onClick={() => setConfirmation(null)} />
          <Button label="Apply Template" variant="primary" onClick={() => void applyConfirmedTemplate()} />
        </div>
      </Dialog>
    </div>
  );
};
