/** Test infrastructure URLs. Override with TEST_DATABASE_URL / TEST_REDIS_URL. */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL ?? 'postgresql://jobhunter:jobhunter@localhost:5432/job_hunter?schema=public';
  const u = new URL(base);
  u.pathname = '/job_hunter_test';
  return u.toString();
}

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
}
