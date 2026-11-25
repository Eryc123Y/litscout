import { expect, it } from "vitest";
import { parseAgentJson } from "../src/agent-chain";
import { digestSchema } from "../src/contracts/index";

const draft = {
  day: "2026-11-17",
  lang: "en",
  other: [{ paperId: "pap_one", gist: "A finding {with braces}" }],
};
const json = JSON.stringify(draft);

it("reads a bare answer or one inside a whole-answer code fence, as before", () => {
  expect(parseAgentJson(json)).toEqual(draft);
  expect(parseAgentJson("```json\n" + json + "\n```")).toEqual(draft);
  expect(parseAgentJson('"a string"')).toBe("a string");
});

it("reads the draft when the client adds prose around its code fence", () => {
  // Claude Code on a full-size day (2026-11-22): the draft, then notes.
  const answer =
    "Here is the digest.\n```json\n" +
    json +
    "\n```\n\nNotes on this output:\n- Radar grading is `borrow`.";
  expect(parseAgentJson(answer)).toEqual(draft);
  expect(parseAgentJson("Draft: " + json + " Done.")).toEqual(draft);
});

it("takes the first balanced object that parses, skipping brace groups in prose", () => {
  const answer = `I used {the supplied topics} and {notes. Draft:\n${json}\nEnd.`;
  expect(parseAgentJson(answer)).toEqual(draft);
  // Braces inside JSON strings do not end the object early.
  const nested = JSON.stringify({ ...draft, note: 'a "}" and a "{"' });
  expect(parseAgentJson("Answer: " + nested)).toEqual(JSON.parse(nested));
  expect(
    parseAgentJson(`${json}\n${JSON.stringify({ day: "other" })}`),
  ).toEqual(draft);
});

it("still finds nothing in prose without a complete object", () => {
  expect(parseAgentJson("I cannot write the digest.")).toBeNull();
  expect(parseAgentJson("```json\n" + json.slice(0, -10) + "\n```")).toBeNull();
  expect(parseAgentJson("")).toBeNull();
});

it("leaves validation strict: a copied $schema key or an echoed schema is not a draft", () => {
  const copied = parseAgentJson(
    "```json\n" +
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...draft,
      }) +
      "\n```",
  );
  expect(copied).toHaveProperty("$schema");
  expect(digestSchema.safeParse(copied).success).toBe(false);
  const echoed = parseAgentJson(JSON.stringify(digestSchema.toJSONSchema()));
  expect(echoed).toHaveProperty("properties");
  expect(digestSchema.safeParse(echoed).success).toBe(false);
});
