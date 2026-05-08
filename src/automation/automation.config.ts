/**
 * Backwards-compatible shim. The implementation moved to src/config/.
 * Existing imports from `../automation/automation.config` keep working
 * via this re-export.
 */
export { AutomationConfigService } from '../config/automation.config';
