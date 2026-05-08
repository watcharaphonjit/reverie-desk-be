/**
 * Jest globalTeardown. Currently a no-op — each test owns its data and
 * cleans up after itself, and ephemeral CI databases are torn down by
 * the GitHub Actions service container.
 *
 * If you switch to a long-lived test DB add `truncate everything` here.
 */
export default async function globalTeardown(): Promise<void> {
  // intentionally empty
}
