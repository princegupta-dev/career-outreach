import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { hashObject } from '../../common/crypto';
import { PrismaService } from '../../common/prisma.service';
import { DomainError } from '../../common/http';
import { resolveSettings, SEND_MODE_CONFIRMATION, settingsSchema, UserSettings } from '../../domain/settings';

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(userId: string): Promise<UserSettings> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { settings: true } });
    return resolveSettings(user.settings);
  }

  async hash(userId: string): Promise<string> {
    return hashObject((await this.get(userId)).matching);
  }

  /**
   * Partial update. Turning on AUTO_SEND requires `confirmation` to equal SEND_MODE_CONFIRMATION —
   * automatic sending is never enabled implicitly (defaults, imports or a stray UI click).
   */
  async update(userId: string, rawPatch: Record<string, unknown>): Promise<UserSettings> {
    const { confirmation, ...patch } = rawPatch;
    const current = await this.get(userId);
    const merged = settingsSchema.parse(deepMerge(current as unknown as Record<string, unknown>, patch));
    if (merged.outreach.sendMode === 'AUTO_SEND' && current.outreach.sendMode !== 'AUTO_SEND' && confirmation !== SEND_MODE_CONFIRMATION) {
      throw new DomainError(`Automatic sending must be confirmed explicitly. Send confirmation: "${SEND_MODE_CONFIRMATION}".`, 400, {
        requiredConfirmation: SEND_MODE_CONFIRMATION,
      });
    }
    if (merged.followups.sendWindowEndHour <= merged.followups.sendWindowStartHour) {
      merged.followups.sendWindowEndHour = Math.min(24, merged.followups.sendWindowStartHour + 1);
    }
    if (merged.outreach.dailyInitialLimit > merged.outreach.dailyLimit) merged.outreach.dailyInitialLimit = merged.outreach.dailyLimit;
    await this.prisma.user.update({ where: { id: userId }, data: { settings: merged as unknown as Prisma.InputJsonValue } });
    await this.audit.log('settings.updated', { userId, metadata: { keys: Object.keys(patch), sendMode: merged.outreach.sendMode } });
    if (merged.outreach.sendMode !== current.outreach.sendMode) {
      await this.audit.log('settings.send_mode_changed', { userId, metadata: { from: current.outreach.sendMode, to: merged.outreach.sendMode } });
    }
    return merged;
  }
}
