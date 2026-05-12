import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditAction, UserStatus } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../common/services/audit.service';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { AuthenticatedUser, JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmailWithSecret(dto.email);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User is not active');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches)
      throw new UnauthorizedException('Invalid credentials');

    const [roles, permissions] = await Promise.all([
      this.usersService.getRoleCodes(user.id),
      this.usersService.getPermissionCodes(user.id),
    ]);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      branchId: user.branchId,
    };
    const accessToken = await this.jwtService.signAsync(payload);
    await this.audit.record({
      actorUserId: user.id,
      branchId: user.branchId,
      entityType: 'AuthSession',
      entityId: user.id,
      action: AuditAction.LOGIN,
      payload: {
        email: user.email,
      },
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        title: user.title,
        firstName: user.firstName,
        middleName: user.middleName,
        lastName: user.lastName,
        // `fullName` is kept on the response for back-compat; the split
        // fields above are the ones the frontend should bind to going
        // forward (the column is auto-derived in `UsersService`).
        fullName: user.fullName,
        roles,
        permissions,
      },
    };
  }

  async getProfile(user: AuthenticatedUser) {
    const [profile, permissions] = await Promise.all([
      this.usersService.findOne(user, user.id),
      this.usersService.getPermissionCodes(user.id),
    ]);
    return {
      ...profile,
      permissions,
    };
  }
}
