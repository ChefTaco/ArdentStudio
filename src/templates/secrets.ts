// Templates and agent definitions are shared and copied, so they must never carry credentials. This is
// a guard for obvious mistakes (pasted keys and tokens), not a substitute for keeping secrets in Magnus.
// The same patterns guard hive-agent-definition/1 in @hivemagnus/magnus-contracts (Magnus 3.3.0).
const PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/u,
  /\bnpm_[A-Za-z0-9]{36,}\b/u,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/iu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu,
];

/** JSON paths (`$.persona.soul_md`) of strings, and object keys (`$.a[key]`), that look like credentials. */
export function credentialLikePaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return PATTERNS.some(pattern => pattern.test(value)) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => credentialLikePaths(item, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(PATTERNS.some(pattern => pattern.test(key)) ? [`${path}[key]`] : []),
      ...credentialLikePaths(item, `${path}.${key}`),
    ]);
  }
  return [];
}
