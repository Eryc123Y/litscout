// The hash permits only the static OAuth consent and status-page stylesheet.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'sha256-LOeA3s+0leXX3QGVzeiBxEpF1PnNBhvTb9EC4qHsM7Q='",
  "frame-src https://arxiv.org",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function setSecurityHeaders(headers: Headers) {
  headers.set("Content-Security-Policy", contentSecurityPolicy);
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
}
