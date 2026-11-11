import type { JobProviderKind } from '../../types';
import type { WorkdayConfig } from './workday';

export interface DefaultSource {
  provider: JobProviderKind;
  name: string;
  config: { boardToken?: string; companyName?: string; domain?: string; teamSize?: number; workday?: WorkdayConfig };
}

/**
 * Sources seeded automatically so discovery works out of the box.
 * Company job boards (Greenhouse/Ashby/Lever public APIs)
 * that were verified (Oct 2026) to list backend roles open in India or remote.
 * Users can disable any of them or add their own in Settings.
 */
export const DEFAULT_SOURCES: DefaultSource[] = [

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

      // Added Nov 2026: boards verified to name the company and to list jobs in India / open to India.
      ['GREENHOUSE', 'zscaler', 'Zscaler', 'zscaler.com'],
      ['GREENHOUSE', 'datadog', 'Datadog', 'datadoghq.com'],
      ['GREENHOUSE', 'fivetran', 'Fivetran', 'fivetran.com'],
      ['GREENHOUSE', 'highradius', 'HighRadius', 'highradius.com'],
      ['GREENHOUSE', 'sigmoid', 'Sigmoid', 'sigmoid.com'],
      ['GREENHOUSE', 'devrev', 'DevRev', 'devrev.ai'],
      ['GREENHOUSE', 'neo4j', 'Neo4j', 'neo4j.com'],
      ['GREENHOUSE', 'netskope', 'Netskope', 'netskope.com'],
      ['GREENHOUSE', 'jfrog', 'JFrog', 'jfrog.com'],
      ['GREENHOUSE', 'agoda', 'Agoda', 'agoda.com'],
      ['GREENHOUSE', 'commvault', 'Commvault', 'commvault.com'],
      ['GREENHOUSE', 'pagerduty', 'PagerDuty', 'pagerduty.com'],
      ['GREENHOUSE', 'singlestore', 'SingleStore', 'singlestore.com'],
      ['GREENHOUSE', 'observeai', 'Observe.AI', 'observe.ai'],
      ['GREENHOUSE', 'yugabyte', 'YugabyteDB', 'yugabyte.com'],
      ['GREENHOUSE', 'fastly', 'Fastly', 'fastly.com'],
      ['GREENHOUSE', 'intercom', 'Intercom', 'intercom.com'],
      ['GREENHOUSE', 'cockroachlabs', 'Cockroach Labs', 'cockroachlabs.com'],
      ['GREENHOUSE', 'slice', 'Slice', 'sliceit.com'],
      ['ASHBY', 'snowflake', 'Snowflake', 'snowflake.com'],
      ['ASHBY', 'tekion', 'Tekion', 'tekion.com'],
      ['ASHBY', 'redis', 'Redis', 'redis.io'],
      ['ASHBY', 'spotdraft', 'SpotDraft', 'spotdraft.com'],
      ['ASHBY', 'airbyte', 'Airbyte', 'airbyte.com'],
    ] as Array<[JobProviderKind, string, string, string]>
  ).map(([provider, boardToken, companyName, domain]) => ({ provider, name: companyName, config: { boardToken, companyName, domain } })),

  // Company career sites on Workday (no Greenhouse/Lever/Ashby). Verified Nov 2026 to list backend jobs in India.
  ...(
    [
      ['salesforce', 'wd12', 'External_Career_Site', 'Salesforce', 'salesforce.com'],
      ['adobe', 'wd5', 'external_experienced', 'Adobe', 'adobe.com'],
      ['paypal', 'wd1', 'jobs', 'PayPal', 'paypal.com'],
      ['nvidia', 'wd5', 'NVIDIAExternalCareerSite', 'NVIDIA', 'nvidia.com'],
      ['mastercard', 'wd1', 'CorporateCareers', 'Mastercard', 'mastercard.com'],
      ['intel', 'wd1', 'External', 'Intel', 'intel.com'],
      ['target', 'wd5', 'targetcareers', 'Target', 'target.com'],
      ['broadcom', 'wd1', 'External_Career', 'Broadcom', 'broadcom.com'],
      ['hp', 'wd5', 'ExternalCareerSite', 'HP', 'hp.com'],
      ['citi', 'wd5', '2', 'Citi', 'citi.com'],
      ['db', 'wd3', 'DBWebsite', 'Deutsche Bank', 'db.com'],
    ] as Array<[string, string, string, string, string]>
  ).map(([tenant, wd, site, companyName, domain]): DefaultSource => ({
    provider: 'WORKDAY',
    name: companyName,
    config: { companyName, domain, workday: { host: `https://${tenant}.${wd}.myworkdayjobs.com`, tenant, site } },
  })),
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
  'customer experience', 'interviewer', 'netsuite', 'security engineer', 'technical services', 'new grads', 'product engineer (pm)', 'quality assurance',
  'devops', 'site reliability', 'sre', 'service desk', 'solution engineer', 'architect', 'field service', 'controls engineer', 'data engineer', 'spark developer', 'c++', 'rust', 'physical design',
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
