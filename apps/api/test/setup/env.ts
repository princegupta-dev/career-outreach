import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { testDatabaseUrl, testRedisUrl } from './urls';

/**
 * Test environment: isolated database + Redis DB, sandbox email, template AI,
 * and a temporary copy of the real candidate profile (tests may edit it).
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl();
process.env.REDIS_URL = testRedisUrl();
process.env.SESSION_SECRET = 'test-session-secret-test-session-secret-0123456789';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.AI_PROVIDER = 'template';
process.env.EMAIL_PROVIDER = 'sandbox';
process.env.LOG_LEVEL = 'silent';
process.env.APP_URL = 'http://localhost:3000';
process.env.HUNTER_API_KEY = '';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/email/gmail/callback';

const source = path.resolve(__dirname, '../../../../candidate/candidate-profile.example.md');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-profile-'));
const target = path.join(dir, 'candidate-profile.md');
fs.copyFileSync(source, target);
process.env.CANDIDATE_PROFILE_PATH = target;
