export function redactDiagnostic(
  text: string,
  _env: Readonly<Record<string, string | undefined>> = {},
) {
  // Keep the optional environment argument for callers; only S1 patterns redact.
  // Arbitrary environment values may be digits used in stack coordinates.
  const patterns = [
    /lsk_[A-Za-z0-9_-]+/g,
    /-----BEGIN(?:[A-Z ]+)?/g,
    /(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-[A-Za-z0-9-]+|sk-(?:ssh|ecdsa)-[A-Za-z0-9@._-]+)/g,
    /---- (?:BEGIN|END) SSH2 (?:PUBLIC|ENCRYPTED PRIVATE) KEY ----/g,
    /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
    /[A-Z2-7]{32,}/gi,
    /[a-f0-9]{32,}/gi,
  ];
  return patterns.reduce(
    (safe, pattern) => safe.replace(pattern, "[redacted]"),
    text,
  );
}

export function errorDiagnostic(
  error: unknown,
  env: Readonly<Record<string, string | undefined>> = {},
) {
  const failure =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : "Unknown failure");
  const name =
    failure.name === "Error" ? failure.constructor.name : failure.name;
  const stack =
    failure.stack?.replace(/^Error:/, `${name}:`) ??
    `${name}: ${failure.message}`;
  return {
    name: redactDiagnostic(name, env).slice(0, 128),
    message: redactDiagnostic(failure.message, env).slice(0, 2000),
    stack: redactDiagnostic(stack, env).slice(0, 5000),
  };
}
