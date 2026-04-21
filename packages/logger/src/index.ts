import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level,
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }),
});

export type Logger = typeof logger;

/**
 * Set up error emission on a pino logger instance.
 * Monkey-patches logger.error to also call emitFirmError for any logged error.
 * Call this once at startup after creating the logger.
 *
 * The patch extracts `service` from obj.component || obj.service (falls back to 'unknown').
 * It also looks for obj.scriptKeyHint and obj.area to pass self-heal hints to the COO.
 */
export function setupErrorEmitter(logger: Logger): void {
  // Dynamic import to avoid circular deps and keep this module usable standalone
  import('./error-emitter.js').then(({ emitFirmError }) => {
    const origError = logger.error.bind(logger);
    // pino's error overloads: (obj, msg?) and (obj, msg, ...args)
    // We widen to the base Logger['error'] signature to avoid TS overload fatigue.
    logger.error = (obj: unknown, ...args: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (origError as (...a: unknown[]) => void)(obj, ...(args as [string?, ...unknown[]]));
      const o = obj as Record<string, unknown> | undefined;
      if (o == null) return;
      const service = (o['component'] as string | undefined)
        ?? (o['service'] as string | undefined)
        ?? 'unknown';
      const err = o['err'] as unknown;
      if (err === undefined || err === null) return;
      const hint: { scriptKey?: string; area?: string } = {};
      if (o['scriptKeyHint']) hint.scriptKey = o['scriptKeyHint'] as string;
      if (o['area']) hint.area = o['area'] as string;
      if (hint.scriptKey || hint.area) {
        emitFirmError(service, err, hint);
      } else {
        emitFirmError(service, err);
      }
    };
  });
}
