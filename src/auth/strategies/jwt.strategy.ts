import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { RoleCode, UserStatus } from '@prisma/client';
import { ExtractJwt, Strategy, StrategyOptions } from 'passport-jwt';
import { UsersService } from '../../users/users.service';

export interface JwtPayload {
  sub: string;
  email: string;
  branchId: string | null;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  branchId: string | null;
  roles: RoleCode[];
  /**
   * Effective permission codes for the user (union across all assigned
   * roles). Populated lazily on each authenticated request by
   * {@link JwtStrategy.validate}.
   */
  permissions: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) throw new Error('JWT_SECRET is not set');

    const options: StrategyOptions = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    };
    super(options);
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.usersService.findByEmailWithSecret(payload.email);
    if (!user || user.id !== payload.sub) {
      throw new UnauthorizedException('Invalid token');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User is not active');
    }

    const [roles, permissions] = await Promise.all([
      this.usersService.getRoleCodes(user.id),
      this.usersService.getPermissionCodes(user.id),
    ]);
    return {
      id: user.id,
      email: user.email,
      branchId: user.branchId,
      roles,
      permissions,
    };
  }
}
