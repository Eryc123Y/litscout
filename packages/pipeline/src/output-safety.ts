import type { SummaryPaper } from "./blocks";
import { parseAgentJson } from "./agent-chain";
/** Test complete output, including ignored text and failed attempts, before parsing or uploading. */
export function secretOutsideInput(
  output: string,
  papers: readonly SummaryPaper[],
) {
  const input = papers
    .map((p) => `${p.paperId}\n${p.title}\n${p.abstract}`)
    .join("\n");
  const patterns = [
    /lsk_[A-Za-z0-9_-]+/g,
    /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
    /-----BEGIN(?:[A-Z ]+)?/g,
    /(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-[A-Za-z0-9-]+|sk-(?:ssh|ecdsa)-[A-Za-z0-9@._-]+)/g,
    /---- (?:BEGIN|END) SSH2 (?:PUBLIC|ENCRYPTED PRIVATE) KEY ----/g,
    /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
    /[A-Z2-7]{32,}/gi,
    /[a-f0-9]{32,}/gi,
  ];
  const containsSecret = (text: string) =>
    patterns.some((pattern) =>
      [...text.matchAll(pattern)].some((m) => !input.includes(m[0])),
    );
  if (containsSecret(output)) return true;
  const decoded = output.includes("\\") ? parseAgentJson(output) : null;
  return decoded !== null && containsSecret(JSON.stringify(decoded));
}
