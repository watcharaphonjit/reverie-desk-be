/**
 * Compose a person's display name from the split-name fields used on
 * `User`, `Customer`, and `Lead`. The schema keeps a denormalized
 * `fullName` (or `Lead.name`) column for back-compat with code that
 * snapshots names into history tables (commissions, audit logs); this
 * helper is the single source of truth for that derivation.
 *
 * Empty / whitespace-only parts are skipped so we never emit double
 * spaces, and a leading title is preserved if present (e.g. "Dr. Jane Doe").
 */
export interface NameParts {
  title?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
}

export function composeFullName(parts: NameParts): string {
  return [parts.title, parts.firstName, parts.middleName, parts.lastName]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p): p is string => p.length > 0)
    .join(' ');
}
