/**
 * Minimal seed: just enough to boot the app and authenticate.
 *   - one branch (HQ), one CENTRAL_HUB warehouse + HQ branch warehouse
 *   - role + permission catalog
 *   - default admin user (admin@reverie.local)
 *
 * Use this in CI / smoke environments where the test runs are
 * responsible for creating their own fixtures (the existing scripts/
 * smoke-* files all do).
 *
 * Also runs when `prisma db seed` is invoked without a profile flag —
 * the existing prisma/seed.ts is a thin re-export of this module.
 */
import 'dotenv/config';
import { runMinimalSeed } from './shared';

void runMinimalSeed()
  .then(() => {
    console.log('✅ Minimal seed completed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
