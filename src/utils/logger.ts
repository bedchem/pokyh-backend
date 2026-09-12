import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';

const transport = new (winston.transports as any).DailyRotateFile({
  dirname: path.join(process.cwd(), 'logs'),
  filename: 'app-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '90d',
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
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    transport,
    new winston.transports.Console({
      silent: process.env.NODE_ENV === 'production',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} [${level}] ${message}${extra}`;
        })
      ),
    }),
  ],
});
