import type { JobProviderKind } from '@prisma/client';

export interface DefaultSource {
  provider: JobProviderKind;
  name: string;
  config: { boardToken?: string; companyName?: string; domain?: string };
}

/**
 * Sources seeded automatically so discovery works out of the box.
 * Public aggregator feeds + company job boards (Greenhouse/Ashby public APIs)
 * that were verified (Oct 2026) to list backend roles open in India or remote.
 * Users can disable any of them or add their own in Settings.
 */
export const DEFAULT_SOURCES: DefaultSource[] = [
  // Public aggregator feeds
  { provider: 'HN_HIRING', name: 'Hacker News — Who is hiring', config: {} },
  { provider: 'WWR', name: 'We Work Remotely', config: {} },
  { provider: 'REMOTIVE', name: 'Remotive', config: {} },
  { provider: 'HIMALAYAS', name: 'Himalayas', config: {} },
  { provider: 'JOBICY', name: 'Jobicy', config: {} },
  { provider: 'REMOTEOK', name: 'Remote OK', config: {} },
  { provider: 'ARBEITNOW', name: 'Arbeitnow', config: {} },

  // Company boards — India offices / India-friendly remote
  ...(
    [
      ['GREENHOUSE', 'coinbase', 'Coinbase', 'coinbase.com'],
      ['GREENHOUSE', 'okta', 'Okta', 'okta.com'],
      ['GREENHOUSE', 'databricks', 'Databricks', 'databricks.com'],
      ['GREENHOUSE', 'stripe', 'Stripe', 'stripe.com'],
      ['GREENHOUSE', 'mongodb', 'MongoDB', 'mongodb.com'],
      ['GREENHOUSE', 'twilio', 'Twilio', 'twilio.com'],
      ['GREENHOUSE', 'samsara', 'Samsara', 'samsara.com'],
      ['GREENHOUSE', 'airbnb', 'Airbnb', 'airbnb.com'],
      ['GREENHOUSE', 'rubrik', 'Rubrik', 'rubrik.com'],
      ['GREENHOUSE', 'druva', 'Druva', 'druva.com'],
      ['GREENHOUSE', 'newrelic', 'New Relic', 'newrelic.com'],
      ['GREENHOUSE', 'elastic', 'Elastic', 'elastic.co'],
      ['GREENHOUSE', 'affirm', 'Affirm', 'affirm.com'],
      ['GREENHOUSE', 'razorpaysoftwareprivatelimited', 'Razorpay', 'razorpay.com'],
      ['GREENHOUSE', 'groww', 'Groww', 'groww.in'],
      ['GREENHOUSE', 'inmobi', 'InMobi', 'inmobi.com'],
      ['GREENHOUSE', 'hackerrank', 'HackerRank', 'hackerrank.com'],
      ['ASHBY', 'sarvam', 'Sarvam AI', 'sarvam.ai'],
      ['ASHBY', 'plane', 'Plane', 'plane.so'],
      ['ASHBY', 'atlan', 'Atlan', 'atlan.com'],
      ['ASHBY', 'composio', 'Composio', 'composio.dev'],
      // Remote-first / global remote
      ['GREENHOUSE', 'gitlab', 'GitLab', 'gitlab.com'],
      ['GREENHOUSE', 'canonical', 'Canonical', 'canonical.com'],
      ['GREENHOUSE', 'grafanalabs', 'Grafana Labs', 'grafana.com'],
      ['GREENHOUSE', 'circleci', 'CircleCI', 'circleci.com'],
      ['GREENHOUSE', 'sumologic', 'Sumo Logic', 'sumologic.com'],
      ['ASHBY', 'clickhouse', 'ClickHouse', 'clickhouse.com'],
      ['ASHBY', 'supabase', 'Supabase', 'supabase.com'],
      ['ASHBY', 'sentry', 'Sentry', 'sentry.io'],
      ['ASHBY', 'temporal', 'Temporal', 'temporal.io'],
      ['ASHBY', 'render', 'Render', 'render.com'],
      ['ASHBY', 'resend', 'Resend', 'resend.com'],
      ['ASHBY', 'replit', 'Replit', 'replit.com'],
      ['ASHBY', 'deepgram', 'Deepgram', 'deepgram.com'],
      ['ASHBY', 'elevenlabs', 'ElevenLabs', 'elevenlabs.io'],
      ['ASHBY', 'railway', 'Railway', 'railway.com'],
      ['ASHBY', 'ramp', 'Ramp', 'ramp.com'],
      ['ASHBY', 'notion', 'Notion', 'notion.so'],
      ['ASHBY', 'linear', 'Linear', 'linear.app'],
    ] as Array<[JobProviderKind, string, string, string]>
  ).map(([provider, boardToken, companyName, domain]) => ({ provider, name: companyName, config: { boardToken, companyName, domain } })),
];

/**
 * HARD title exclusions: the wrong function (sales, design, recruiting, support, management) or a level
 * that cannot fit a senior engineer (intern, new-grad, junior), or a discipline that is not backend
 * (frontend, mobile, embedded, QA, game, research), or a non-software engineering field (mechanical,
 * electrical, civil...). These are categorical, so they reject.
 */
export const DEFAULT_EXCLUDE_TITLES = [
  'frontend', 'front-end', 'front end', 'ios', 'android', 'mobile', 'intern', 'internship', 'designer', 'sales', 'marketing', 'recruiter',
  'data scientist', 'qa', 'test engineer', 'in test', 'sdet', 'test automation', 'quality engineer',
  'support engineer', 'solutions engineer', 'solution architect', 'solutions architect', 'sales engineer', 'customer engineer', 'customer success', 'consultant', 'consulting', 'presales', 'pre-sales', 'developer advocate', 'developer relations', 'devrel', 'technical writer', 'gtm', 'technical account',
  'manager', 'director', 'head of', 'vp', 'vice president', 'leader',
  'mechanical', 'electrical', 'electronics', 'electronic', 'civil', 'chemical', 'manufacturing', 'optical', 'aerospace', 'mechatronics', 'thermal', 'structural', 'industrial', 'materials', 'process engineer', 'field engineer', 'validation', 'asic', 'fpga', 'analog', 'pcb',
  'new grad', 'new-grad', 'newgrad', 'graduate', 'early career', 'early-career', 'junior', 'jr', 'entry level', 'entry-level', 'fresher', 'university', 'campus',
  'research', 'firmware', 'embedded', 'hardware', 'game', 'unity', 'salesforce', 'sap', 'flutter', 'swift',
];

/**
 * SOFT title signals: kept, but flagged so ranking can weigh them instead of the filter guessing.
 * Staff/Principal roles are common stretch targets at Indian startups; a stack mismatch is the scorer's call.
 */
export const FLAG_TITLES: Record<string, string[]> = {
  'seniority': ['staff', 'principal', 'distinguished'],
  'stack': ['java', '.net', 'golang', 'rust', 'c++', 'php', 'ruby', 'scala', 'kotlin'],
  'adjacent': ['machine learning', 'ml engineer', 'data engineer', 'analytics engineer', 'security engineer', 'forward deployed', 'site reliability', 'sre', 'devops'],
};
