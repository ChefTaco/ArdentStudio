// Templates are shared and copied, so they must never carry credentials. This is a guard for
// obvious mistakes (pasted keys and tokens), not a substitute for keeping secrets in Magnus.
const PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/,
  /\bnpm_[A-Za-z0-9]{36,}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

/** JSON paths of strings that look like credentials. */
export function credentialLikePaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return PATTERNS.some(pattern => pattern.test(value)) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => credentialLikePaths(item, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => credentialLikePaths(item, `${path}.${key}`));
  return [];
}
