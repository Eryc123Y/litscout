import { errorDiagnostic, redactDiagnostic } from "@litscout/core";
export function crawlLog(
  env: Readonly<Record<string, string | undefined>>,
  sink: (text: string) => void,
) {
  const warnings: string[] = [],
    diagnostics: {
      source: string;
      name: string;
      message: string;
      stack: string;
    }[] = [];
  return {
    warnings,
    diagnostics,
    report: (source: string, error: unknown, context?: string) => {
      const detail = errorDiagnostic(error, env),
        message =
          `${source} ${detail.name}: ${detail.message}${context ? `; ${redactDiagnostic(context, env)}` : ""}`.slice(
            0,
            5000,
          );
      warnings.push(message);
      diagnostics.push({ source, ...detail });
      sink(message);
    },
  };
}
