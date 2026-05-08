import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';

/**
 * Global cache module so feature modules can inject CacheService without
 * each having to re-import. The service degrades to an in-memory store
 * when REDIS_HOST is unset, so this module is safe to load in dev/test.
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
