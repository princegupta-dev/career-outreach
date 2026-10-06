import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { detectRoleFamily } from '../../domain/skills/extract';

export interface Bucket {
  key: string;
  sent: number;
  replied: number;
  positive: number;
  interviews: number;
  replyRate: number;
}

export interface AnalyticsReport {
  generatedAt: string;
  totals: {
    jobsDiscovered: number;
    strongMatches: number;
    emailsSent: number;
    followupsSent: number;
    replies: number;
    replyRate: number;
    positiveReplies: number;
    interviews: number;
    offers: number;
    pendingFollowups: number;
    aiCalls: number;
    zeroCostGenerations: number;
  };
  breakdowns: Record<'companySize' | 'companyType' | 'location' | 'role' | 'contactType' | 'matchScore' | 'emailStyle' | 'aiGenerated', Bucket[]>;
  insights: string[];
  weekly: Array<{ week: string; sent: number; replied: number }>;
}

const CACHE_KEY = (userId: string) => `analytics:${userId}`;

function rate(replied: number, sent: number): number {
  return sent ? Math.round((replied / sent) * 1000) / 10 : 0;
}

function scoreBucket(score: number | null): string {
  if (score == null) return 'unscored';
  if (score >= 80) return '80-100';
  if (score >= 65) return '65-79';
  if (score >= 50) return '50-64';
  return '<50';
}

function locationBucket(location: string | null, remote: boolean | null): string {
  const l = (location ?? '').toLowerCase();
  if (remote || /remote|anywhere/.test(l)) return 'Remote';
  if (/india|bangalore|bengaluru|gurgaon|gurugram|noida|delhi|pune|hyderabad|mumbai|chennai/.test(l)) return 'India';
  if (!l) return 'Unknown';
  return 'International';
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async get(userId: string, fresh = false): Promise<AnalyticsReport> {
    if (!fresh) {
      const cached = await this.redis.getJson<AnalyticsReport>(CACHE_KEY(userId));
      if (cached) return cached;
    }
    const report = await this.compute(userId);
    await this.redis.setJson(CACHE_KEY(userId), report, 120);
    return report;
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.client.del(CACHE_KEY(userId));
  }

  async compute(userId: string): Promise<AnalyticsReport> {
    const [jobsDiscovered, strongMatches, roots, followupsSent, offers, interviews, pendingFollowups, aiCalls, zeroCostGenerations] = await Promise.all([
      this.prisma.job.count({ where: { userId, deletedAt: null } }),
      this.prisma.job.count({ where: { userId, deletedAt: null, recommendation: { in: ['STRONG_APPLY', 'APPLY'] } } }),
      this.prisma.outreach.findMany({
        where: { userId, kind: 'INITIAL', status: 'SENT' },
        select: {
          sentAt: true,
          threadState: true,
          style: true,
          aiGenerated: true,
          contact: { select: { roleCategory: true } },
          application: { select: { status: true, replySentiment: true, job: { select: { title: true, location: true, remote: true, score: true, company: { select: { size: true, companyType: true } } } } } },
        },
      }),
      this.prisma.outreach.count({ where: { userId, kind: 'FOLLOWUP', status: 'SENT' } }),
      this.prisma.application.count({ where: { userId, status: 'OFFER' } }),
      this.prisma.application.count({ where: { userId, status: { in: ['INTERVIEW', 'OFFER'] } } }),
      this.prisma.followup.count({ where: { userId, status: { in: ['SCHEDULED', 'DRAFT_READY', 'APPROVED'] } } }),
      this.prisma.aiGeneration.count({ where: { userId, provider: { not: 'template' } } }),
      this.prisma.aiGeneration.count({ where: { userId, provider: 'template' } }),
    ]);

    const rows = roots.map((r) => {
      const job = r.application.job;
      const replied = r.threadState === 'REPLIED';
      return {
        sentAt: r.sentAt!,
        replied,
        positive: replied && r.application.replySentiment === 'positive',
        interview: ['INTERVIEW', 'OFFER'].includes(r.application.status),
        dims: {
          companySize: job.company.size.replace(/_/g, ' ').toLowerCase(),
          companyType: job.company.companyType ?? 'unknown',
          location: locationBucket(job.location, job.remote),
          role: detectRoleFamily(job.title),
          contactType: r.contact.roleCategory.replace(/_/g, ' ').toLowerCase(),
          matchScore: scoreBucket(job.score),
          emailStyle: r.style,
          aiGenerated: r.aiGenerated ? 'AI-written' : 'template',
        },
      };
    });

    const breakdown = (dim: keyof (typeof rows)[number]['dims']): Bucket[] => {
      const map = new Map<string, Bucket>();
      for (const r of rows) {
        const key = r.dims[dim];
        const b = map.get(key) ?? { key, sent: 0, replied: 0, positive: 0, interviews: 0, replyRate: 0 };
        b.sent++;
        if (r.replied) b.replied++;
        if (r.positive) b.positive++;
        if (r.interview) b.interviews++;
        map.set(key, b);
      }
      return [...map.values()].map((b) => ({ ...b, replyRate: rate(b.replied, b.sent) })).sort((a, b) => b.sent - a.sent);
    };

    const breakdowns = {
      companySize: breakdown('companySize'),
      companyType: breakdown('companyType'),
      location: breakdown('location'),
      role: breakdown('role'),
      contactType: breakdown('contactType'),
      matchScore: breakdown('matchScore'),
      emailStyle: breakdown('emailStyle'),
      aiGenerated: breakdown('aiGenerated'),
    };

    const replies = rows.filter((r) => r.replied).length;
    const overall = rate(replies, rows.length);
    const insights: string[] = [];
    const MIN_SAMPLE = 3;
    for (const [dim, buckets] of Object.entries(breakdowns)) {
      const eligible = buckets.filter((b) => b.sent >= MIN_SAMPLE);
      if (eligible.length < 2) continue;
      const best = [...eligible].sort((a, b) => b.replyRate - a.replyRate)[0];
      if (best.replyRate > overall) {
        insights.push(`${dim.replace(/([A-Z])/g, ' $1').toLowerCase()}: "${best.key}" replies at ${best.replyRate}% (${best.replied}/${best.sent}) vs ${overall}% overall.`);
      }
    }
    if (!rows.length) insights.push('No emails sent yet — insights appear after a few sends.');
    else if (!insights.length) insights.push(`Need at least ${MIN_SAMPLE} sends per segment to compare outreach types.`);

    const weeklyMap = new Map<string, { sent: number; replied: number }>();
    for (const r of rows) {
      const d = new Date(r.sentAt);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const week = d.toISOString().slice(0, 10);
      const w = weeklyMap.get(week) ?? { sent: 0, replied: 0 };
      w.sent++;
      if (r.replied) w.replied++;
      weeklyMap.set(week, w);
    }

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        jobsDiscovered,
        strongMatches,
        emailsSent: rows.length,
        followupsSent,
        replies,
        replyRate: overall,
        positiveReplies: rows.filter((r) => r.positive).length,
        interviews,
        offers,
        pendingFollowups,
        aiCalls,
        zeroCostGenerations,
      },
      breakdowns,
      insights,
      weekly: [...weeklyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v })),
    };
  }
}
