import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '../auth/token.service';
import type { AdminPosition } from '../generated/prisma/enums';

/** What JwtStrategy.validate() puts on the request. */
export interface AuthenticatedUser extends JwtPayload {
  adminPosition: AdminPosition | null;
}

/**
 * Usage: `@CurrentUser() user: AuthenticatedUser` or `@CurrentUser('sub') id: string`.
 * Note `sub` is the user id — it is the JWT's own field name, kept as-is.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    return data ? user?.[data] : user;
  },
);
