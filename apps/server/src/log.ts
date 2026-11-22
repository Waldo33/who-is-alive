/** Логи — строки JSON в stdout (их собирает Vector). Без токенов и IP в открытом виде. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  (level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
}

export function jsonLogger(minLevel: LogLevel = 'info'): Logger {
  const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const min = order.indexOf(minLevel);
  return (level, msg, fields) => {
    if (order.indexOf(level) < min) return;
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + '\n');
  };
}

export const silentLogger: Logger = () => {};
