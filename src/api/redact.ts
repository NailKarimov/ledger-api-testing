/**
 * Hides the API key wherever a URL or message is written to logs or reports.
 * The Allure report is published on GitHub Pages, so this must never leak the key.
 */
export function redact(text: string, secret?: string): string {
  let out = text.replace(/([?&]appid=)[^&\s"']*/gi, '$1***');
  if (secret) out = out.split(secret).join('***');
  return out;
}

/**
 * OAuth material in reports: a JWT keeps its header and claims (useful to read) but loses the signature, so
 * the attached text is never a working token; codes, verifiers, refresh tokens and secrets are masked.
 */
export function redactTokens(text: string): string {
  return text
    .replace(/(eyJ[\w-]*\.eyJ[\w-]*\.)[\w-]+/g, '$1***')
    .replace(/((?:refresh_token|client_secret|code_verifier|code)["']?\s*[:=]\s*["']?)[\w\-.~%]+/gi, '$1***');
}

/** Request headers for the report: credentials masked, the scheme kept. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /^authorization$/i.test(k) ? v.replace(/^(\S+\s+).+$/, '$1***') : v;
  }
  return out;
}
