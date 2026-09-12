import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';

const logRetentionDays = Math.max(1, Math.min(365, Number.parseInt(process.env.LOG_FILE_RETENTION_DAYS ?? '30', 10) || 30));
const redacted = '[REDACTED]';
const maxLogStringLength = 4_096;
const maxLogCollectionEntries = 100;

// This is a defense-in-depth guard, not a substitute for call sites avoiding
// request bodies and credentials altogether. It keeps structured stdout and
// rotated files useful during incidents without making an accidental secret
// interpolation durable or visible to the container log collector.
const sensitiveKeyPattern = /(?:authorization|cookie|password|secret|token|api[_-]?key|credential|private[_-]?key|database[_-]?url|connection[_-]?string)/i;
const sensitiveAssignmentPattern = /(\b(?:authorization|cookie|password|secret|token|api[_-]?key|credential|private[_-]?key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const bearerTokenPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const basicAuthPattern = /\bBasic\s+[A-Za-z0-9+/=]+/gi;
const credentialUrlPattern = /\b((?:mysql|postgres(?:ql)?|redis|rediss):\/\/)[^/\s@]+@/gi;

function redactString(value: string): string {
  const sanitized = value
    .replace(credentialUrlPattern, '$1[REDACTED]@')
    .replace(bearerTokenPattern, 'Bearer [REDACTED]')
    .replace(basicAuthPattern, 'Basic [REDACTED]')
    .replace(sensitiveAssignmentPattern, '$1[REDACTED]');

  return sanitized.length > maxLogStringLength
    ? `${sanitized.slice(0, maxLogStringLength)}… [TRUNCATED]`
    : sanitized;
}

function redactLogValue(value: unknown, key?: string, depth = 0, seen = new WeakSet<object>()): unknown {
  if (key && sensitiveKeyPattern.test(key)) return redacted;
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return undefined;
  if (depth >= 5) return '[TRUNCATED_OBJECT]';

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, maxLogCollectionEntries).map((entry) => redactLogValue(entry, undefined, depth + 1, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    const output: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      output[nestedKey] = redactLogValue(nestedValue, nestedKey, depth + 1, seen);
    }
    return output;
  }

  return `[${typeof value}]`;
}

const redactLogData = winston.format((info) => {
  for (const key of Object.keys(info)) {
    info[key] = redactLogValue(info[key], key);
  }
  return info;
});

const transport = new (winston.transports as any).DailyRotateFile({
  dirname: path.join(process.cwd(), 'logs'),
  filename: 'app-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: `${logRetentionDays}d`,
  zippedArchive: false,
});

// DEBUG=true raises the level so logger.debug(...) calls (verbose per-request
// tracing) actually emit; otherwise they're silently dropped by Winston's
// level filter, same as before this was gated purely by config.debug checks
// around console.log calls.
const level = process.env.DEBUG === 'true' ? 'debug' : 'info';

export const logger = winston.createLogger({
  level,
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp(),
    redactLogData(),
    winston.format.json()
  ),
  defaultMeta: {
    service: 'pokyh-api',
    environment: process.env.NODE_ENV ?? 'development',
  },
  transports: [
    transport,
    // Containers need a newline-delimited JSON stream on stdout so Docker,
    // the tunnel host, and a future log collector can observe production
    // events. Do not colourise or pretty-print this transport: both corrupt
    // machine-readable logs and made production output silent before now.
    new winston.transports.Console({
      stderrLevels: ['error'],
    }),
  ],
});
