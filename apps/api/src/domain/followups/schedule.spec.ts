import { adjustToSendWindow, decideFollowup, FollowupCheckInput, planFollowups, rescheduleAfter } from './schedule';

const DAY = 86_400_000;

describe('follow-up scheduling', () => {
  it('uses the default 4 → 5 → 7 day cadence relative to the previous email', () => {
    const sent = new Date('2026-10-05T05:00:00Z');
    const plan = planFollowups(sent, [4, 5, 7]);
    expect(plan.map((p) => p.sequence)).toEqual([1, 2, 3]);
    expect(plan[0].scheduledAt.getTime() - sent.getTime()).toBe(4 * DAY);
    expect(plan[1].scheduledAt.getTime() - plan[0].scheduledAt.getTime()).toBe(5 * DAY);
    expect(plan[2].scheduledAt.getTime() - plan[1].scheduledAt.getTime()).toBe(7 * DAY);
  });

  it('supports custom cadences, including none', () => {
    expect(planFollowups(new Date(), [])).toEqual([]);
    expect(planFollowups(new Date('2026-01-01T00:00:00Z'), [2, 3])).toHaveLength(2);
  });

  it('anchors every follow-up to the first email so weekend shifts do not accumulate', () => {
    const window = { timezone: 'Asia/Kolkata', startHour: 9, endHour: 19, skipWeekends: true };
    const sent = new Date('2026-10-06T08:00:00Z'); // Tue 13:30 IST
    const days = planFollowups(sent, [4, 5, 7], window).map((p) => (p.scheduledAt.getTime() - sent.getTime()) / DAY);
    // Day 4 = Sat → Mon (≈5.8); day 9 = Thu (9); day 16 = Thu (16)
    expect(days[0]).toBeGreaterThan(4);
    expect(days[0]).toBeLessThan(6);
    expect(Math.round(days[1])).toBe(9);
    expect(Math.round(days[2])).toBe(16);
  });

  it('keeps a minimum gap when the previous follow-up went out late', () => {
    const first = new Date('2026-10-01T05:00:00Z');
    const lateSent = new Date('2026-10-09T05:00:00Z'); // follow-up #1 sent on day 8
    const next = rescheduleAfter(first, 9, lateSent);
    expect((next.getTime() - lateSent.getTime()) / DAY).toBeGreaterThanOrEqual(2);
    expect(rescheduleAfter(first, 9, new Date('2026-10-05T05:00:00Z')).getTime()).toBe(first.getTime() + 9 * DAY);
  });

  it('moves follow-ups into the send window and off weekends', () => {
    const window = { timezone: 'Asia/Kolkata', startHour: 9, endHour: 19, skipWeekends: true };
    // Saturday 2026-10-10 02:00 IST
    const sat = new Date('2026-10-09T20:30:00Z');
    const adjusted = adjustToSendWindow(sat, window);
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(adjusted);
    expect(local.find((p) => p.type === 'weekday')?.value).toBe('Mon');
    expect(Number(local.find((p) => p.type === 'hour')?.value)).toBeGreaterThanOrEqual(9);
  });
});

describe('follow-up send decision (cancellation)', () => {
  const base: FollowupCheckInput = {
    threadState: 'WAITING_FOR_REPLY',
    followupStatus: 'APPROVED',
    scheduledAt: new Date('2026-10-01T00:00:00Z'),
    now: new Date('2026-10-06T00:00:00Z'),
    replyDetected: false,
    suppressed: false,
    previousSequenceSent: true,
  };

  it('sends when due and no reply', () => {
    expect(decideFollowup(base)).toEqual({ action: 'send' });
  });

  it('cancels when the recipient replied (live check)', () => {
    expect(decideFollowup({ ...base, replyDetected: true })).toEqual({ action: 'cancel', reason: 'Recipient replied' });
  });

  it('cancels when the thread is already marked replied', () => {
    expect(decideFollowup({ ...base, threadState: 'REPLIED' }).action).toBe('cancel');
  });

  it('cancels on bounce, closed thread or suppression', () => {
    expect(decideFollowup({ ...base, threadState: 'BOUNCED' }).action).toBe('cancel');
    expect(decideFollowup({ ...base, threadState: 'CLOSED' }).action).toBe('cancel');
    expect(decideFollowup({ ...base, suppressed: true }).action).toBe('cancel');
  });

  it('never re-sends a follow-up that was sent or cancelled', () => {
    expect(decideFollowup({ ...base, followupStatus: 'SENT' }).action).toBe('cancel');
    expect(decideFollowup({ ...base, followupStatus: 'CANCELLED' }).action).toBe('cancel');
  });

  it('waits when not due or when the previous follow-up is pending', () => {
    expect(decideFollowup({ ...base, scheduledAt: new Date('2026-10-07T00:00:00Z') }).action).toBe('wait');
    expect(decideFollowup({ ...base, previousSequenceSent: false }).action).toBe('wait');
  });

  it('reply check wins over everything else', () => {
    expect(decideFollowup({ ...base, replyDetected: true, scheduledAt: new Date('2030-01-01'), previousSequenceSent: false }).action).toBe('cancel');
  });
});
