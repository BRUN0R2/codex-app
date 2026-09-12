export const DEFAULT_DEVELOPMENT_PORT = 1420;

const MINIMUM_PORT = 1;
const MAXIMUM_PORT = 65_535;

export function resolveDevelopmentPort(configured: string | undefined): number {
  if (configured === undefined) {
    return DEFAULT_DEVELOPMENT_PORT;
  }
  const port = Number(configured);
  if (!Number.isInteger(port) || port < MINIMUM_PORT || port > MAXIMUM_PORT) {
    throw new Error(
      `CODEX_DESKTOP_DEV_PORT and VITE_PORT must be integers between ${MINIMUM_PORT} and ${MAXIMUM_PORT}; received ${JSON.stringify(configured)}.`,
    );
  }
  return port;
}
