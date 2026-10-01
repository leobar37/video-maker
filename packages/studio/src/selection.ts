/**
 * Selection policy of contracts.md §4: regenerable dependencies/caches are
 * pruned during directory expansion, while known secret file patterns are
 * REJECTED explicitly (never omitted silently). This is a bounded, documented
 * filename policy — not a content audit.
 */

interface SecretRule {
  pattern: RegExp;
  reason: string;
}

const SECRET_RULES: SecretRule[] = [
  { pattern: /^\.env(\..+)?$/i, reason: 'archivo de entorno con posibles secretos' },
  { pattern: /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)([-.].+)?$/i, reason: 'llave privada ssh' },
  { pattern: /\.(pem|key|p12|pfx)$/i, reason: 'material de llave privada' },
  { pattern: /\.(token|secret)$/i, reason: 'token o secreto' },
  { pattern: /^\.(npmrc|netrc|htpasswd|git-credentials)$/i, reason: 'credencial de herramienta' },
  { pattern: /^[\w.-]*cookies\.txt$/i, reason: 'cookies de sesión' },
  { pattern: /^secrets?\.(json|ya?ml|txt)$/i, reason: 'archivo de secretos' },
  { pattern: /credentials\.(json|ya?ml|txt)$/i, reason: 'archivo de credenciales' },
];

/** Why `relPath` looks like a secret, or `null` when it does not. */
export function secretPathReason(relPath: string): string | null {
  const base = relPath.split('/').pop() ?? relPath;
  for (const rule of SECRET_RULES) {
    if (rule.pattern.test(base)) return rule.reason;
  }
  return null;
}
