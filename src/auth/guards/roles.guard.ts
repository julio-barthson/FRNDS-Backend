import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../decorators/roles.decorator';
import type { Role } from '../../generated/prisma/enums';

/**
 * Restricts a route to given account roles. Nothing in this phase needs it —
 * every signed-in account is an ARTIST — but LABEL and ADMIN routes land on
 * the same API, and the guard is three lines cheaper than retrofitting one.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ user?: { role?: Role } }>();
    const role = request.user?.role;

    if (!role || !required.includes(role)) {
      throw new ForbiddenException(
        'You do not have permission to perform this action',
      );
    }

    return true;
  }
}
