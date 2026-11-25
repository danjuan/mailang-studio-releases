import {
  OPENREEL_EXPERT_PLUGIN_ID,
  parseSubagentDefinition,
  SUBAGENT_INHERIT_TOKEN,
  type PluginSummary,
  type UserSubagentInput,
  type UserSubagentRecord,
} from "@pi-desktop/shared";

export function openReelSubagentTemplate(
  markdown: string,
  plugins: readonly PluginSummary[],
  owned: readonly Pick<UserSubagentRecord, "id" | "name">[],
): UserSubagentInput | null {
  if (owned.some(({ id, name }) => id === "openreel" || name === "openreel")) return null;
  const plugin = plugins.find(({ id }) => id === OPENREEL_EXPERT_PLUGIN_ID);
  if (!plugin?.bundled || !plugin.enabled || plugin.status !== "ready" ||
      !plugin.permissions.includes("agent.tool.register") || !plugin.permissions.includes("ui.view")) {
    return null;
  }

  const parsed = parseSubagentDefinition(markdown, { source: "user" });
  if (!parsed.ok || parsed.warnings.length || parsed.definition.name !== "openreel" ||
      !parsed.definition.inheritTools || parsed.definition.tools.length) {
    return null;
  }
  const { name, description, prompt } = parsed.definition;
  return { name, description, body: prompt, tools: [SUBAGENT_INHERIT_TOKEN], enabled: true };
}
