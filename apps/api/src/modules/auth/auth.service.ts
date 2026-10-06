import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ENV, Env } from '../../config/env';
import { ProfileService } from '../profile/profile.service';

export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

@Injectable()
export class AuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly profiles: ProfileService,
  ) {}

  async registrationOpen(): Promise<boolean> {
    return this.env.ALLOW_REGISTRATION || (await this.prisma.user.count()) === 0;
  }

  /** Personal app: the first account is created on first run; more only if explicitly allowed. */
  async register(email: string, password: string, name: string) {
    if (!(await this.registrationOpen())) throw new ForbiddenException('Registration is closed');
    const normalized = email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.prisma.user.create({ data: { email: normalized, passwordHash, name: name.trim() } });
    await this.profiles.syncToDb(user.id).catch(() => undefined);
    await this.audit.log('auth.registered', { userId: user.id });
    return user;
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Constant-ish time: always run bcrypt.
    const ok = await bcrypt.compare(password, user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok) {
      await this.audit.log('auth.login_failed', { metadata: { email: email.trim().toLowerCase().slice(0, 100) } });
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.audit.log('auth.login', { userId: user.id });
    return user;
  }

  async issueSession(user: { id: string; email: string }): Promise<string> {
    return this.jwt.signAsync({ sub: user.id, email: user.email }, { expiresIn: SESSION_TTL_SECONDS });
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(current, user.passwordHash))) throw new UnauthorizedException('Current password is incorrect');
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(next, 12) } });
    await this.audit.log('auth.password_changed', { userId });
  }
}
