/**
 * Per-spec setup. Bumps default jest timeout (Nest context boot + a
 * Postgres round-trip routinely exceeds the 5s default) and silences
 * console noise unless DEBUG_E2E=1.
 */
jest.setTimeout(60_000);

if (!process.env.DEBUG_E2E) {
  global.console.log = () => {};

  global.console.info = () => {};
}
