import type { JobProviderKind } from '@prisma/client';

export interface DefaultSource {
  provider: JobProviderKind;
  name: string;
  config: { boardToken?: string; companyName?: string; domain?: string; url?: string; paths?: string[] };
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
  { provider: 'YC_JOBS', name: 'YC — Work at a Startup', config: {} },

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

/** Title keywords never worth discovering: other stacks/disciplines and levels outside the target (new-grad, junior, staff+, management). */
export const DEFAULT_EXCLUDE_TITLES = [
  'frontend', 'front-end', 'front end', 'ios', 'android', 'mobile', 'intern', 'designer', 'sales', 'marketing', 'recruiter',
  'data scientist', 'qa', 'test engineer', 'in test', 'sdet', 'test automation', 'quality engineer', 'support engineer', 'solutions engineer', 'sales engineer', 'customer engineer',
  'manager', 'director', 'head of', 'vp', 'vice president', 'principal', 'distinguished', 'staff', 'new grad', 'new-grad', 'newgrad', 'graduate', 'early career', 'early-career', 'junior', 'jr', 'entry level', 'entry-level', 'fresher', 'university', 'campus', 'machine learning', 'ml engineer',
  'research', 'firmware', 'embedded', 'hardware', 'security engineer', 'data engineer', 'analytics engineer', 'game', 'unity',
  'salesforce', 'sap', '.net', 'java', 'golang', 'rust', 'c++', 'php', 'ruby', 'scala', 'kotlin', 'swift', 'flutter',
];
