import type { Plugin } from "vite";
import ts from "typescript";
import catalog from "./pi-editor-zh-CN.json";
import presets from "./pi-editor-presets-zh-CN.json";

const visibleProps = new Set([
  "alt", "aria-description", "aria-label", "aria-valuetext", "ariaLabel", "description", "emptyText", "hint",
  "label", "message", "placeholder", "subtitle", "text", "title", "tooltip",
]);

const propertyFiles = /\/(components|editor|export|export-formats|export-codecs|media|transition|effects|animation)\//;
const namingFiles = /\/(?:EffectsTransitionsPanel|noise-reduction-presets|clip-tabs\.config|EmphasisAnimationSection|AdjustmentLayerSection|keyboard-shortcuts)\./;
const copyName = /(?:[Tt]itle|[Ll]abel|[Mm]essage|[Dd]escription|[Tt]ooltip|[Hh]int|[Pp]laceholder|[Cc]opy)$/;
const candidateText = /[A-Za-z]/;
const translations: Readonly<Record<string, string>> = { ...catalog, ...presets };

function isEditorModule(id: string): boolean {
  if (id.endsWith("/apps/web/src/motion/components/primitives.tsx")) return true;
  return /\/(?:apps\/web\/src\/(?:components|hooks|services|stores|utils)|packages\/ui\/src)\/[^?]+\.tsx?$/.test(id)
    && !/\.(?:test|spec|stories)\.tsx?$/.test(id);
}

export type CopyOccurrence = {
  start: number;
  end: number;
  text: string;
  render: (text: string) => string;
  kind: string;
  name?: string;
  component?: ts.FunctionLikeDeclaration;
  moduleValue: boolean;
  expression: string;
  node: ts.Node;
};

function quote(text: string): string {
  // Avoid HTML-significant characters even in JSX attributes.
  return JSON.stringify(text);
}

function clean(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function displayContext(node: ts.Node, id: string): string | undefined {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) {
      const name = parent.name.getText();
      return visibleProps.has(name) || name.startsWith("data-tip") ? "attribute" : undefined;
    }
    if (ts.isJsxExpression(parent)) {
      if (ts.isJsxAttribute(parent.parent)) continue;
      return "jsx";
    }
    if (ts.isConditionalExpression(parent)) {
      if (parent.condition !== child) continue;
      return undefined;
    }
    if (ts.isBinaryExpression(parent)) {
      if (
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === child
      ) continue;
      return undefined;
    }
    if (ts.isParenthesizedExpression(parent)) continue;
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression.getText();
      const index = parent.arguments.findIndex((argument) => argument === child);
      if (/^(?:window\.)?(?:confirm|alert)$/.test(callee)) return index === 0 ? "dialog" : undefined;
      if (callee === "ctx.fillText") return index === 0 ? "canvas" : undefined;
      if (/^toast\.(?:success|error|warning|info)$/.test(callee)) return index < 2 && index >= 0 ? "toast" : undefined;
      if (callee === "setStatus" && id.endsWith("/MultiCameraPanel.tsx")) return index === 1 ? "status" : undefined;
      if (/^set(?:Error|InitStatus|ExportError|ImportError|RecorderError|LocalError|ErrorMessage|StatusMessage)$/.test(callee)) {
        return index === 0 ? "status" : undefined;
      }
      return undefined;
    }
    if (ts.isPropertyAssignment(parent)) {
      if (parent.initializer !== child) return undefined;
      const name = parent.name.getText().replace(/^['"]|['"]$/g, "");
      if ((name !== "text" && visibleProps.has(name)) || (name === "name" && namingFiles.test(id))
        || (name === "desc" && id.endsWith("/Toolbar.tsx"))) return "presentation data";
      return copyName.test(name) && propertyFiles.test(id) ? "presentation data" : undefined;
    }
    if (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) {
      if (parent.initializer !== child) return undefined;
      return copyName.test(parent.name.getText()) ? "presentation data" : undefined;
    }
    return undefined;
  }
  return undefined;
}

function componentOwner(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current) && !ts.isFunctionDeclaration(current)) continue;
    let parent = current.parent;
    if (ts.isCallExpression(parent) && /(?:^|\.)(?:memo|forwardRef)$/.test(parent.expression.getText())) parent = parent.parent;
    const declaredName = (ts.isArrowFunction(current) ? undefined : current.name?.getText()) ??
      (ts.isVariableDeclaration(parent) ? parent.name.getText() : "");
    if (/^[A-Z][a-zA-Z0-9]*$/.test(declaredName)) return current;
  }
  return undefined;
}

function isModuleValue(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return false;
  }
  return true;
}

export function findPiEditorCopy(id: string, code: string): CopyOccurrence[] {
  if (!isEditorModule(id)) return [];
  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
  const occurrences: CopyOccurrence[] = [];

  function add(node: ts.Node, original: string, kind: string, render: (text: string) => string): void {
    const text = clean(original);
    if (!candidateText.test(text)) return;
    if ((kind === "status" || kind === "presentation data") && /^[a-z][a-z0-9-]*$/.test(text)) return;
    occurrences.push({
      start: ts.isJsxText(node) ? node.pos : node.getStart(source),
      end: node.end,
      text,
      render,
      kind,
      name: ts.isPropertyAssignment(node.parent) ? node.parent.name.getText(source) : undefined,
      component: componentOwner(node),
      moduleValue: isModuleValue(node),
      expression: node.getText(source),
      node,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      add(node, node.text, "jsx", (text) => `{${quote(text)}}`);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const kind = displayContext(node, id);
      if (kind) {
        if (ts.isTemplateExpression(node)) {
          const parts = node.templateSpans;
          const original = node.head.text + parts.map((part, index) => `{#${index}}${part.literal.text}`).join("");
          add(node, original, kind, (text) => {
            const placeholders = [...text.matchAll(/\{#(\d+)\}/g)].map((match) => Number(match[1]));
            const required = parts.flatMap((part, index) => {
              const expression = part.expression;
              const pluralSuffix = ts.isConditionalExpression(expression) &&
                ts.isStringLiteral(expression.whenTrue) && expression.whenTrue.text === "s" &&
                ts.isStringLiteral(expression.whenFalse) && expression.whenFalse.text === "";
              return pluralSuffix ? [] : [index];
            });
            if (new Set(placeholders).size !== placeholders.length ||
                placeholders.some((index) => index >= parts.length) ||
                required.some((index) => !placeholders.includes(index))) {
              throw new Error(`Invalid Pi localization placeholders for "${clean(original)}"`);
            }
            return `\`${text.replace(/[\\`]|\$\{/g, "\\$&").replace(/\{#(\d+)\}/g, (_, index) => `\${${parts[Number(index)].expression.getText(source)}}`)}\``;
          });
        } else {
          const inAttribute = ts.isJsxAttribute(node.parent);
          add(node, node.text, kind, (text) => inAttribute ? `{${quote(text)}}` : quote(text));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return occurrences;
}

export function localizePiEditor(id: string, code: string): string | null {
  const copies = findPiEditorCopy(id, code).filter(item => Object.hasOwn(translations, item.text));
  if (copies.length === 0) return null;
  const substitutions: Array<{ start: number; end: number; value: string }> = [];
  const components = new Set<ts.FunctionLikeDeclaration>();
  for (const item of copies) {
    if (item.moduleValue && !item.name) continue;
    const { node } = item;
    let expression = `__piEditorLabel(${quote(item.text)})`;
    if (ts.isTemplateExpression(node)) {
      expression = `(__piEditorChinese() ? ${item.render(translations[item.text])} : ${item.expression})`;
    }
    if (item.moduleValue && item.name && ts.isPropertyAssignment(node.parent)) {
      // Module-level preset and menu descriptions are read in the active
      // locale. Their IDs and values remain the original data.
      substitutions.push({ start: node.parent.getStart(), end: node.parent.end, value: `get ${item.name}() { return ${expression}; }` });
    } else {
      const value = ts.isJsxText(node) || ts.isJsxAttribute(node.parent) ? `{${expression}}` : expression;
      substitutions.push({ start: item.start, end: item.end, value });
    }
    if (item.component?.body) components.add(item.component);
  }
  if (substitutions.length === 0) return null;

  for (const component of components) {
    const body = component.body!;
    const start = body.getStart();
    if (ts.isBlock(body)) {
      substitutions.push({ start: start + 1, end: start + 1, value: "\n__usePiEditorCopy();\n" });
    } else {
      substitutions.push({ start, end: start, value: "{ __usePiEditorCopy(); return " });
      substitutions.push({ start: body.end, end: body.end, value: "; }" });
    }
  }
  const result = substitutions.sort((left, right) => right.start - left.start || right.end - left.end)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.value + text.slice(edit.end), code);
  return 'import { piEditorLabel as __piEditorLabel, usesChinesePiEditorCopy as __piEditorChinese, usePiEditorCopy as __usePiEditorCopy } from "@/pi/editor-copy";\n'
    + result;
}

export function piEditorCopyPlugin(enabled: boolean): Plugin {
  return {
    name: "pi-editor-zh-CN",
    enforce: "pre",
    transform(code, id) {
      if (!enabled) return null;
      const translated = localizePiEditor(id, code);
      return translated === null ? null : { code: translated, map: null };
    },
  };
}
