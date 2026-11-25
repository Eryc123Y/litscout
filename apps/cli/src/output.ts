/** The only module that writes command output to process streams. */
export const stdout = (text: string) => {
  process.stdout.write(text);
};
export const stderr = (text: string) => {
  process.stderr.write(text);
};
export const print = (text: string) => stdout(text + "\n");
export function output(
  sink: (text: string) => void,
  json: boolean,
  data: unknown,
  success = true,
  meta?: Readonly<{ configPath: string | null }>,
) {
  if (!json && data && typeof data === "object") {
    for (const key of ["messages", "commands"]) {
      const lines = (data as Record<string, unknown>)[key];
      if (
        Array.isArray(lines) &&
        lines.every((line) => typeof line === "string")
      ) {
        sink(lines.join("\n"));
        return;
      }
    }
  }
  sink(
    json
      ? JSON.stringify({ success, data, ...(meta ? { meta } : {}) })
      : typeof data === "string"
        ? data
        : JSON.stringify(data, null, 2),
  );
}
/** Legacy parser code 2 means invalid input; the public CLI reserves 2 for no work. */
export function streamExitCode(code: number, wrote: boolean, help: boolean) {
  return code === 0 && help
    ? 0
    : code === 2
      ? 1
      : code === 0 && !wrote
        ? 2
        : code;
}
