import { defaultSchema, type Options as Schema } from "rehype-sanitize";
import type { RenderMath } from "./math-render";

/**
 * Math in Markdown, in three steps around react-markdown:
 * 1. remark-math finds `$...$` and `$$...$$` (code spans and fences are
 *    never math), then `remarkMathSpans` applies the TeX convention also used
 *    by `math-text.tsx`: an opening `$` is not followed by a space, a closing
 *    `$` is not preceded by one or followed by a digit, and digits alone are
 *    not math, so "$5 and $10" stays text. Each kept span becomes an element
 *    holding its raw source, dollars included.
 * 2. `rehypeMathML`, once Temml has loaded, swaps that source for MathML.
 *    TeX that does not parse keeps its source.
 * 3. rehype-sanitize runs last with `markdownSchema`, which admits only the
 *    MathML elements and attributes Temml emits (no style, no href).
 */

type Text = { type: "text"; value: string };
type Parent = { type: string; children?: Node[] };
type Node = Parent & {
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: Record<string, unknown>;
};

/** A cheap test for anything that could be math, before loading Temml. */
const mathLike =
  /\$\$[^$]*[^\s$][^$]*\$\$|\$(?!\d+(?:[.,]\d+)*\$)[^\s$](?:[^$\n]*[^\s$\\])?\$(?!\d)/;
export const hasMath = (text: string) =>
  text.includes("$") && mathLike.test(text);

const digitsOnly = /^[\d\s.,]*$/;

function inlineSpan(node: Node, source: string): Node {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const raw =
    start !== undefined && end !== undefined
      ? source.slice(start, end)
      : "$" + (node.value ?? "") + "$";
  const display = raw.startsWith("$$");
  const tex = node.value ?? "";
  const after = end !== undefined ? source[end] : undefined;
  const isMath =
    display ||
    (tex.length > 0 &&
      !/^\s/.test(tex) &&
      !/\s$/.test(tex) &&
      !digitsOnly.test(tex) &&
      !(after && /\d/.test(after)));
  if (!isMath) return { type: "text", value: raw };
  return mathNode(node, "span", display, raw);
}

function mathNode(node: Node, tag: string, display: boolean, raw: string) {
  return {
    ...node,
    data: {
      hName: tag,
      hProperties: {
        className: ["math", display ? "math-display" : "math-inline"],
      },
      hChildren: [{ type: "text", value: raw } satisfies Text],
    },
  };
}

function mapTree(node: Node, source: string): Node {
  if (node.type === "inlineMath") return inlineSpan(node, source);
  if (node.type === "math")
    return mathNode(node, "div", true, "$$\n" + (node.value ?? "") + "\n$$");
  if (!node.children) return node;
  return { ...node, children: node.children.map((c) => mapTree(c, source)) };
}

/** Runs after remark-math; see the module comment. */
export function remarkMathSpans() {
  return (tree: Node, file: { value: unknown }) =>
    mapTree(tree, String(file.value ?? ""));
}

const textOf = (node: Node): string =>
  node.type === "text"
    ? (node.value ?? "")
    : (node.children ?? []).map(textOf).join("");

/** Strip the delimiters that the source kept for the fallback. */
function texOf(raw: string, display: boolean): string {
  const trimmed = raw.trim();
  return display && trimmed.startsWith("$$")
    ? trimmed.slice(2, -2).trim()
    : trimmed.slice(1, -1);
}

/** DOM from the HTML parser to hast; `class` becomes `className`. */
function toHast(dom: globalThis.Node): Node | null {
  if (dom.nodeType === 3)
    return { type: "text", value: dom.nodeValue ?? "" } as Node;
  if (dom.nodeType !== 1) return null;
  const element = dom as Element;
  const properties: Record<string, unknown> = {};
  for (const { name, value } of Array.from(element.attributes))
    properties[name === "class" ? "className" : name] =
      name === "class" ? value.split(/\s+/).filter(Boolean) : value;
  return {
    type: "element",
    tagName: element.localName,
    properties,
    children: Array.from(element.childNodes)
      .map(toHast)
      .filter((child): child is Node => child !== null),
  };
}

function mathML(render: RenderMath, tex: string, display: boolean) {
  try {
    const doc = new DOMParser().parseFromString(
      render(tex, display),
      "text/html",
    );
    const math = doc.body.querySelector("math");
    return math ? toHast(math) : null;
  } catch {
    return null;
  }
}

function isMathElement(node: Node) {
  const className = node.properties?.className;
  return (
    node.type === "element" &&
    Array.isArray(className) &&
    className.includes("math")
  );
}

function renderTree(node: Node, render: RenderMath): Node {
  if (isMathElement(node)) {
    const display = (node.properties!.className as string[]).includes(
      "math-display",
    );
    const math = mathML(render, texOf(textOf(node), display), display);
    return math ? { ...node, children: [math] } : node;
  }
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.map((child) => renderTree(child, render)),
  };
}

/** Runs before rehype-sanitize, only once Temml has loaded. */
export function rehypeMathML(render: RenderMath) {
  return (tree: Node) => renderTree(tree, render);
}

const mathTags = [
  "math",
  "mrow",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "mspace",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mover",
  "munder",
  "munderover",
  "mmultiscripts",
  "mprescripts",
  "none",
  "mtable",
  "mtr",
  "mtd",
  "mlabeledtr",
  "mpadded",
  "mphantom",
  "menclose",
  "mstyle",
  "merror",
  "semantics",
];
const mathAttributes = [
  "display",
  "displaystyle",
  "scriptlevel",
  "mathvariant",
  "mathsize",
  "dir",
  "fence",
  "form",
  "separator",
  "stretchy",
  "symmetric",
  "largeop",
  "movablelimits",
  "lspace",
  "rspace",
  "minsize",
  "maxsize",
  "accent",
  "accentunder",
  "linethickness",
  "width",
  "height",
  "depth",
  "voffset",
  "notation",
  "columnalign",
  "rowalign",
  "columnspan",
  "rowspan",
  "columnspacing",
  "rowspacing",
  "columnlines",
  "rowlines",
  "frame",
  "framespacing",
  "align",
  ["className", /^tml-[\w-]+$/, /^wbk-[\w-]+$/, "mathcal", "mathscr"],
] satisfies NonNullable<Schema["attributes"]>[string];

/** The default GitHub-like schema plus the MathML Temml emits. */
export const markdownSchema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...mathTags],
  attributes: {
    ...defaultSchema.attributes,
    ...Object.fromEntries(mathTags.map((tag) => [tag, mathAttributes])),
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", "math", "math-inline", "math-display"],
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ["className", "math", "math-display"],
    ],
  },
};
