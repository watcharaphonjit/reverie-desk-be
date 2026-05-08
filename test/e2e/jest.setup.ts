/**
 * Per-spec setup. Bumps default jest timeout (Nest context boot + a
 * Postgres round-trip routinely exceeds the 5s default) and silences
 * console noise unless DEBUG_E2E=1.
 */
jest.setTimeout(60_000);

if (!process.env.DEBUG_E2E) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  global.console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  global.console.info = () => {};
}
