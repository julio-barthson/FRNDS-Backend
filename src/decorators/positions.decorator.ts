import { SetMetadata } from '@nestjs/common';
import type { AdminPosition } from '../generated/prisma/enums';

export const POSITIONS_KEY = 'requiredPositions';

/**
 * Narrows an admin route to particular positions.
 *
 * Usage: `@Positions('SUPER_ADMIN')`. Without it, a route guarded by
 * `AdminGuard` is open to every admin — which is the right default for reading
 * things, and the wrong one for creating admins or changing what they can do.
 */
export const Positions = (...positions: AdminPosition[]) =>
  SetMetadata(POSITIONS_KEY, positions);
