const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const TELEGRAM_BOT_TOKEN = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;
const JWT_TOKEN = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g;
const PREFIXED_SECRET = /\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs]|supabase|vercel)[A-Za-z0-9_\-:.]{16,}\b/gi;
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]{2,})\s*=\s*("[^"\n]{8,}"|'[^'\n]{8,}'|[^\s"'`]{8,})/g;
const LONG_SECRET_LIKE = /\b[A-Za-z0-9_+/=-]{48,}\b/g;

const looksSecretLike = (value: string): boolean => {
  const hasLetter = /[A-Za-z]/.test(value);
  const hasDigit = /\d/.test(value);
  const hasSymbol = /[_+/=-]/.test(value);
  return hasLetter && (hasDigit || hasSymbol);
};

export const redactSensitiveText = (input: string): string =>
  input
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED_PRIVATE_KEY]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(TELEGRAM_BOT_TOKEN, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(JWT_TOKEN, '[REDACTED_JWT]')
    .replace(PREFIXED_SECRET, '[REDACTED_SECRET]')
    .replace(ENV_ASSIGNMENT, '$1=[REDACTED]')
    .replace(LONG_SECRET_LIKE, (value) => (looksSecretLike(value) ? '[REDACTED_SECRET]' : value));
