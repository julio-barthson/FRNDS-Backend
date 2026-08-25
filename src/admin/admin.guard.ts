import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { POSITIONS_KEY } from '../decorators/positions.decorator';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { AdminPosition } from '../generated/prisma/enums';

/**
 * The gate on everything under `/admin`.
 *
 * Two checks, because two things can be true separately: the account is an
 * admin at all, and the admin holds a position the route asks for. A route with
 * no `@Positions()` is open to every admin, which suits reading; anything that
 * changes who can do what should name the positions allowed.
 *
 * No database query. `JwtStrategy.validate` already loads the admin row on
 * every request — along with session revocation and account status — so the
 * position is sitting on `request.user` by the time this runs.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user || user.role !== 'ADMIN') {
      // Deliberately says nothing about the route existing. An artist token
      // poking at /admin learns only that it cannot have it.
      throw new ForbiddenException('Administrator access required');
    }

    const required = this.reflector.getAllAndOverride<AdminPosition[]>(
      POSITIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) return true;

    // An ADMIN row is created alongside the user, so a null position here means
    // the two are out of step rather than that the admin is unprivileged.
    if (!user.adminPosition || !required.includes(user.adminPosition)) {
      throw new ForbiddenException(
        `This action is restricted to ${required.join(' or ')}`,
      );
    }

    return true;
  }
}
