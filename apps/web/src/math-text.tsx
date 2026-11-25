import { Fragment } from "react";

/**
 * Inline TeX in paper titles and abstracts ("A$^3$", "$\ell_p$", "CO$_2$"),
 * shown as text with sup and sub instead of raw dollars. Follows the TeX
 * convention that an opening `$` is not followed by a space and a closing
 * `$` is not preceded by one, so prices such as "$5 and $10" stay as written.
 * A span using a command this module does not know (\frac, \sqrt, …) stays
 * exactly as written. No markup is ever produced from the input itself, and
 * the scanner uses no lookbehind, which older Safari versions cannot parse.
 */
type Node = { kind: "text" | "sup" | "sub"; value: string };
type Segment =
  { kind: "text"; value: string } | { kind: "math"; nodes: Node[] };

const maxSpan = 200;

const symbols: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  ell: "ℓ",
  infty: "∞",
  times: "×",
  cdot: "·",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  approx: "≈",
  sim: "∼",
  pm: "±",
  partial: "∂",
  nabla: "∇",
  sum: "∑",
  prod: "∏",
  in: "∈",
  ldots: "…",
  dots: "…",
  cdots: "⋯",
  mid: "|",
  prime: "′",
  circ: "∘",
  star: "⋆",
  ast: "∗",
  emptyset: "∅",
  forall: "∀",
  exists: "∃",
  top: "⊤",
  perp: "⊥",
  langle: "⟨",
  rangle: "⟩",
  log: "log",
  exp: "exp",
};
const blackboard: Record<string, string> = {
  R: "ℝ",
  N: "ℕ",
  Z: "ℤ",
  Q: "ℚ",
  C: "ℂ",
  E: "𝔼",
  P: "ℙ",
};
const spacing: Record<string, string> = {
  ",": " ",
  ";": " ",
  ":": " ",
  "!": "",
  " ": " ",
  "\\": "",
  "%": "%",
  "&": "&",
  _: "_",
  "#": "#",
  "{": "{",
  "}": "}",
  $: "$",
};
const styled = new Set([
  "mathrm",
  "mathbf",
  "mathit",
  "mathsf",
  "mathtt",
  "mathcal",
  "text",
  "textrm",
  "textbf",
  "textit",
  "operatorname",
  "boldsymbol",
  "bm",
]);
const withArgument = (name: string) =>
  name === "unicode" || name === "mathbb" || styled.has(name);
const letters = /^[A-Za-z]+/;
// Bidirectional controls could reorder the surrounding title.
const bidi = (point: number) =>
  (point >= 0x202a && point <= 0x202e) ||
  (point >= 0x2066 && point <= 0x2069) ||
  point === 0x200e ||
  point === 0x200f ||
  point === 0x061c;

/** One braced group, one command, or one code point starting at `at`. */
function group(source: string, at: number): [string, number] {
  if (source[at] === "{") {
    let depth = 0;
    for (let i = at; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0)
        return [source.slice(at + 1, i), i + 1];
    }
    return [source.slice(at + 1), source.length];
  }
  if (source[at] === "\\") {
    const name = letters.exec(source.slice(at + 1))?.[0];
    if (!name) return [source.slice(at, at + 2), at + 2];
    const end = at + 1 + name.length;
    if (!withArgument(name)) return [source.slice(at, end), end];
    const [, close] = group(source, end);
    return [source.slice(at, close), close];
  }
  const point = source.codePointAt(at);
  if (point === undefined) return ["", at];
  const char = String.fromCodePoint(point);
  return [char, at + char.length];
}

/** False when the span uses a command or code point this module does not render. */
function renderable(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "\\") continue;
    const next = source[i + 1] ?? "";
    if (next in spacing) {
      i++;
      continue;
    }
    const name = letters.exec(source.slice(i + 1))?.[0];
    if (!name) return false;
    if (name === "unicode") {
      const [code] = group(source, i + 1 + name.length);
      const point = Number(code);
      if (
        !/^\d{1,7}$/.test(code) ||
        point < 32 ||
        point > 0x10ffff ||
        bidi(point)
      )
        return false;
    } else if (!(name in symbols) && !withArgument(name)) return false;
    i += name.length;
  }
  return true;
}

/** Commands and braces to text; scripts inside a script stay inline. */
function flat(source: string): string {
  let out = "";
  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    if (char !== "\\") {
      if (char !== "{" && char !== "}") out += char;
      i++;
      continue;
    }
    const next = source[i + 1] ?? "";
    if (next in spacing) {
      out += spacing[next];
      i += 2;
      continue;
    }
    const name = letters.exec(source.slice(i + 1))?.[0] ?? "";
    i += 1 + name.length;
    if (!withArgument(name)) {
      out += symbols[name] ?? name;
      continue;
    }
    const [inner, end] = group(source, i);
    i = end;
    out +=
      name === "unicode"
        ? String.fromCodePoint(Number(inner))
        : name === "mathbb"
          ? (blackboard[inner] ?? inner)
          : flat(inner);
  }
  return out;
}

function mathNodes(source: string): Node[] {
  const nodes: Node[] = [];
  let text = "";
  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    if (char === "^" || char === "_") {
      if (text) nodes.push({ kind: "text", value: flat(text) });
      text = "";
      const [inner, end] = group(source, i + 1);
      nodes.push({ kind: char === "^" ? "sup" : "sub", value: flat(inner) });
      i = end;
    } else if (char === "\\") {
      const [command, end] = group(source, i);
      text += command;
      i = end;
    } else {
      text += char;
      i++;
    }
  }
  if (text) nodes.push({ kind: "text", value: flat(text) });
  return nodes;
}

const escaped = (text: string, at: number) => {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
};
const space = (char: string | undefined) => !char || /\s/.test(char);

/** The closing `$` for an opening one at `open`, or -1. */
function closing(text: string, open: number): number {
  for (let i = open + 1; i < text.length && i <= open + maxSpan; i++) {
    const char = text[i];
    if (char === "\n") return -1;
    if (char !== "$" || escaped(text, i)) continue;
    return i > open + 1 && !space(text[i - 1]) && text[i + 1] !== "$" ? i : -1;
  }
  return -1;
}

export function parseInlineMath(text: string): Segment[] {
  const segments: Segment[] = [];
  let plain = "";
  for (let i = 0; i < text.length;) {
    const opens =
      text[i] === "$" &&
      !escaped(text, i) &&
      text[i - 1] !== "$" &&
      text[i + 1] !== "$" &&
      !space(text[i + 1]);
    const close = opens ? closing(text, i) : -1;
    const body = close > i ? text.slice(i + 1, close) : "";
    if (close < 0 || !renderable(body)) {
      plain += text[i];
      i++;
      continue;
    }
    if (plain) segments.push({ kind: "text", value: plain });
    plain = "";
    segments.push({ kind: "math", nodes: mathNodes(body) });
    i = close + 1;
  }
  if (plain) segments.push({ kind: "text", value: plain });
  return segments;
}

const superscript: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
  T: "ᵀ",
  R: "ᴿ",
  A: "ᴬ",
  B: "ᴮ",
  D: "ᴰ",
  E: "ᴱ",
  G: "ᴳ",
  H: "ᴴ",
  I: "ᴵ",
  J: "ᴶ",
  K: "ᴷ",
  L: "ᴸ",
  M: "ᴹ",
  N: "ᴺ",
  O: "ᴼ",
  P: "ᴾ",
  U: "ᵁ",
  V: "ⱽ",
  W: "ᵂ",
  d: "ᵈ",
  k: "ᵏ",
};
const subscript: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  n: "ₙ",
  m: "ₘ",
  p: "ₚ",
  t: "ₜ",
  x: "ₓ",
};
function script(value: string, map: Record<string, string>, mark: string) {
  const chars = [...value];
  return chars.every((c) => c in map)
    ? chars.map((c) => map[c]).join("")
    : mark + (chars.length === 1 ? value : "(" + value + ")");
}

/** The same text for attributes, labels and the document title. */
export function plainMath(text: string): string {
  return parseInlineMath(text)
    .map((segment) =>
      segment.kind === "text"
        ? segment.value
        : segment.nodes
            .map((node) =>
              node.kind === "sup"
                ? script(node.value, superscript, "^")
                : node.kind === "sub"
                  ? script(node.value, subscript, "_")
                  : node.value,
            )
            .join(""),
    )
    .join("");
}

export function MathText({ text }: { text: string }) {
  return (
    <>
      {parseInlineMath(text).map((segment, index) =>
        segment.kind === "text" ? (
          <Fragment key={index}>{segment.value}</Fragment>
        ) : (
          <Fragment key={index}>
            {segment.nodes.map((node, at) =>
              node.kind === "sup" ? (
                <sup key={at}>{node.value}</sup>
              ) : node.kind === "sub" ? (
                <sub key={at}>{node.value}</sub>
              ) : (
                <Fragment key={at}>{node.value}</Fragment>
              ),
            )}
          </Fragment>
        ),
      )}
    </>
  );
}

/** Plain-text abstracts: paragraphs at blank lines, inline math kept. */
export function MathParagraphs({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  return (
    <div className="markdown">
      {paragraphs.map((part, index) => (
        <p key={index}>
          <MathText text={part} />
        </p>
      ))}
    </div>
  );
}
