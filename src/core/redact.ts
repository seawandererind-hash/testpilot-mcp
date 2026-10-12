/**
 * Secret redaction for logs, audit entries and imported content.
 * No tool returns a secret value; this is the second line of defence.
 */

// Whole words only, so counters such as `passed`, `passes` and `passRate` and fields such as `author` stay readable.
const SECRET_KEY = /(password|passwd|passphrase|^(pass|pwd|auth)$|secret|token|api[-_]?key|access[-_]?key|authorization|credential|private[-_]?key|cookie|^session([-_]?(id|key))?$)/i;
/** Keys that name a secret without holding one: TestPilot's own confirm tokens and lists of env-variable names. */
const SAFE_KEY = /^(confirmToken|[A-Za-z]*Env|[A-Za-z]*Names)$/;
const SECRET_PAIR = /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)\s*([=:])\s*("?)([^\s",;]+)\3/gi;
/** Values that point at a secret instead of holding it: ${{ secrets.X }}, $(X), $X, process.env.X, credentials('X'). */
const REFERENCE = /^(\$\{\{|\$\(|\$\{?[A-Z_][A-Z0-9_]*$|\$\{?[A-Z_][A-Z0-9_]*\}|process\.env\.|credentials\(|secrets\.|vars\.)/;

const SECRET_VALUE_PATTERNS: RegExp[] = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, // HTTP bearer tokens
    /\bBasic\s+[A-Za-z0-9+/=]{8,}/g, // HTTP basic auth
    /\bATATT[A-Za-z0-9_=-]{20,}/g, // Atlassian API tokens
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
    /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g // user:password@ inside URLs
];

export const REDACTED = '[REDACTED]';

export function redactString(value: string): string {
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
    // key=value or "key": "value" pairs whose key looks secret
    out = out.replace(SECRET_PAIR, (match, key, sep, quote, value) => (REFERENCE.test(value) ? match : `${key}${sep}${quote}${REDACTED}${quote}`));
    return out;
}

/** Deep-copies `value`, replacing anything that looks like a secret. */
export function redact<T>(value: T, depth = 0): T {
    if (depth > 12) return value;
    if (typeof value === 'string') return redactString(value) as T;
    if (Array.isArray(value)) return value.map(item => redact(item, depth + 1)) as T;
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[key] = SECRET_KEY.test(key) && !SAFE_KEY.test(key) && item !== undefined && item !== null && typeof item !== 'boolean' ? REDACTED : redact(item, depth + 1);
        }
        return out as T;
    }
    return value;
}
