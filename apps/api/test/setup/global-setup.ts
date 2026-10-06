import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { testDatabaseUrl } from './urls';

/** Apply migrations to the test database once before the suite. */
export default async function globalSetup(): Promise<void> {
  // Pick up DATABASE_URL from the repo .env when running locally.
  const envFile = path.resolve(__dirname, '../../../../.env');
  if (!process.env.DATABASE_URL && fs.existsSync(envFile)) {
    const line = fs.readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='));
    if (line) process.env.DATABASE_URL = line.slice('DATABASE_URL='.length).trim();
  }
  const url = testDatabaseUrl();
  process.env.TEST_DATABASE_URL = url;
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
