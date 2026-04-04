export const logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  debug: (msg: string) => console.debug(`[DEBUG] ${msg}`),
  withAccount: (accountId: string) => ({
    info: (msg: string) => console.log(`[INFO:${accountId}] ${msg}`),
    error: (msg: string) => console.error(`[ERROR:${accountId}] ${msg}`),
    warn: (msg: string) => console.warn(`[WARN:${accountId}] ${msg}`),
    debug: (msg: string) => console.debug(`[DEBUG:${accountId}] ${msg}`),
  }),
};
