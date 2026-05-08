/**
 * Application-level permission codes — the wide, opaque strings stored in
 * `Permission.code`. We define them as a const tuple instead of a TS enum
 * so they round-trip cleanly to JSON, can be used as union types, and can
 * grow without a schema migration.
 *
 * To add a new permission:
 *   1. Append the literal here.
 *   2. Add it to `prisma/seed.ts` so it lands in the DB on next seed.
 *   3. Optionally grant it to default roles in `seed.ts`.
 */
export const PERMISSION_CODES = [
  'REPORT_VIEW',
  'DASHBOARD_VIEW',
  'AUDIT_VIEW',
  'NOTIFICATION_VIEW',
  'NOTIFICATION_MANAGE',
  'AUTOMATION_MANAGE',
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];
