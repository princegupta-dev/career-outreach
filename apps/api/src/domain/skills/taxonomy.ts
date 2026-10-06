/**
 * Deterministic skill taxonomy used for JD extraction and candidate matching.
 *
 * - `aliases` are matched case-insensitively on token boundaries.
 * - `caseSensitive` aliases are matched exactly (for ambiguous words like "Go", "Express").
 * - `impliedBy`: if the candidate has any of these skills, this one counts as a STRONG match
 *   (e.g. "SQL" is implied by MySQL). Only use for genuine supersets.
 * - `relatedTo`: if the candidate has any of these, this skill is a PARTIAL match
 *   (adjacent experience, honestly not the same thing).
 */
export type SkillCategory =
  | 'language'
  | 'runtime'
  | 'framework'
  | 'orm'
  | 'database'
  | 'cache'
  | 'queue'
  | 'cloud'
  | 'devops'
  | 'observability'
  | 'concept'
  | 'frontend'
  | 'mobile'
  | 'data'
  | 'ai'
  | 'domain';

export interface SkillDef {
  name: string;
  category: SkillCategory;
  aliases: string[];
  caseSensitive?: string[];
  impliedBy?: string[];
  relatedTo?: string[];
  /** Core backend skills weigh more in the technical score. */
  core?: boolean;
}

export const SKILLS: SkillDef[] = [
  // Languages / runtimes
  { name: 'Node.js', category: 'runtime', aliases: ['node.js', 'nodejs', 'node js', 'node'], core: true },
  { name: 'TypeScript', category: 'language', aliases: ['typescript', 'ts'], core: true },
  { name: 'JavaScript', category: 'language', aliases: ['javascript', 'ecmascript', 'es6'], impliedBy: ['TypeScript'], core: true },
  { name: 'Python', category: 'language', aliases: ['python'] },
  { name: 'Java', category: 'language', aliases: ['java'] },
  { name: 'Go', category: 'language', aliases: ['golang'], caseSensitive: ['Go'] },
  { name: 'Rust', category: 'language', aliases: ['rust'] },
  { name: 'Ruby', category: 'language', aliases: ['ruby'] },
  { name: 'PHP', category: 'language', aliases: ['php'] },
  { name: 'C#', category: 'language', aliases: ['c#', 'csharp'] },
  { name: '.NET', category: 'framework', aliases: ['.net', 'dotnet', 'asp.net'] },
  { name: 'Kotlin', category: 'language', aliases: ['kotlin'] },
  { name: 'Scala', category: 'language', aliases: ['scala'] },
  { name: 'Elixir', category: 'language', aliases: ['elixir'] },
  { name: 'C++', category: 'language', aliases: ['c++', 'cpp'] },
  { name: 'Bun', category: 'runtime', aliases: ['bun.js', 'bunjs'], relatedTo: ['Node.js'] },
  { name: 'Deno', category: 'runtime', aliases: ['deno'], relatedTo: ['Node.js'] },

  // Backend frameworks
  { name: 'NestJS', category: 'framework', aliases: ['nestjs', 'nest.js', 'nest js'], core: true },
  { name: 'Express', category: 'framework', aliases: ['express.js', 'expressjs'], caseSensitive: ['Express'], relatedTo: ['Node.js', 'NestJS'] },
  { name: 'Fastify', category: 'framework', aliases: ['fastify'], relatedTo: ['Node.js', 'NestJS'] },
  { name: 'Koa', category: 'framework', aliases: ['koa', 'koa.js'], relatedTo: ['Node.js'] },
  { name: 'Django', category: 'framework', aliases: ['django'] },
  { name: 'FastAPI', category: 'framework', aliases: ['fastapi'] },
  { name: 'Flask', category: 'framework', aliases: ['flask'] },
  { name: 'Spring', category: 'framework', aliases: ['spring boot', 'springboot', 'spring'] },
  { name: 'Rails', category: 'framework', aliases: ['ruby on rails', 'rails'] },
  { name: 'Laravel', category: 'framework', aliases: ['laravel'] },

  // APIs
  { name: 'REST APIs', category: 'concept', aliases: ['restful', 'rest api', 'rest apis', 'restful apis', 'restful services'], caseSensitive: ['REST'], core: true },
  { name: 'GraphQL', category: 'concept', aliases: ['graphql', 'apollo'], core: true },
  { name: 'gRPC', category: 'concept', aliases: ['grpc', 'protobuf', 'protocol buffers'], relatedTo: ['REST APIs'] },
  { name: 'WebSockets', category: 'concept', aliases: ['websocket', 'websockets', 'socket.io'] },
  { name: 'API Design', category: 'concept', aliases: ['api design', 'designing apis', 'api development', 'api architecture'], core: true },

  // ORMs
  { name: 'Sequelize', category: 'orm', aliases: ['sequelize'] },
  { name: 'TypeORM', category: 'orm', aliases: ['typeorm'] },
  { name: 'Prisma', category: 'orm', aliases: ['prisma'], relatedTo: ['TypeORM', 'Sequelize'] },
  { name: 'Mongoose', category: 'orm', aliases: ['mongoose'] },

  // Databases
  { name: 'SQL', category: 'database', aliases: ['sql', 'relational database', 'relational databases', 'rdbms'], impliedBy: ['MySQL', 'PostgreSQL'], core: true },
  { name: 'MySQL', category: 'database', aliases: ['mysql', 'mariadb', 'aurora mysql'], core: true },
  { name: 'PostgreSQL', category: 'database', aliases: ['postgresql', 'postgres', 'psql', 'aurora postgres'], core: true },
  { name: 'MongoDB', category: 'database', aliases: ['mongodb', 'mongo'] },
  { name: 'DynamoDB', category: 'database', aliases: ['dynamodb', 'dynamo db'], relatedTo: ['AWS'] },
  { name: 'Cassandra', category: 'database', aliases: ['cassandra', 'scylladb'] },
  { name: 'Elasticsearch', category: 'database', aliases: ['elasticsearch', 'elastic search', 'opensearch'] },
  { name: 'ClickHouse', category: 'database', aliases: ['clickhouse'] },
  { name: 'NoSQL', category: 'database', aliases: ['nosql'], relatedTo: ['Redis'] },
  { name: 'Database Design', category: 'concept', aliases: ['database design', 'data modeling', 'data modelling', 'schema design'], core: true },
  { name: 'Database Migrations', category: 'concept', aliases: ['database migrations', 'schema migrations', 'db migrations'] },

  // Cache / queues / messaging
  { name: 'Redis', category: 'cache', aliases: ['redis', 'elasticache'], core: true },
  { name: 'Caching', category: 'concept', aliases: ['caching', 'cache', 'memcached'], impliedBy: ['Redis'], core: true },
  { name: 'BullMQ', category: 'queue', aliases: ['bullmq', 'bull queue', 'bull'] },
  { name: 'Queue Systems', category: 'concept', aliases: ['message queue', 'message queues', 'queues', 'queueing', 'queuing', 'job queues', 'background jobs', 'async processing', 'asynchronous processing'], impliedBy: ['BullMQ'], core: true },
  { name: 'Kafka', category: 'queue', aliases: ['kafka', 'apache kafka', 'msk'], relatedTo: ['BullMQ', 'Queue Systems'] },
  { name: 'RabbitMQ', category: 'queue', aliases: ['rabbitmq', 'amqp'], relatedTo: ['BullMQ', 'Queue Systems'] },
  { name: 'SQS', category: 'queue', aliases: ['sqs', 'amazon sqs', 'aws sqs'], relatedTo: ['BullMQ', 'Queue Systems', 'AWS'] },
  { name: 'SNS', category: 'queue', aliases: ['sns', 'amazon sns'], relatedTo: ['AWS'] },
  { name: 'Event-Driven Architecture', category: 'concept', aliases: ['event-driven', 'event driven', 'event sourcing', 'pub/sub', 'pubsub'], relatedTo: ['Queue Systems', 'BullMQ'] },

  // Cloud
  { name: 'AWS', category: 'cloud', aliases: ['aws', 'amazon web services'], core: true },
  { name: 'EC2', category: 'cloud', aliases: ['ec2'] },
  { name: 'RDS', category: 'cloud', aliases: ['rds', 'amazon rds', 'aurora'] },
  { name: 'IAM', category: 'cloud', aliases: ['iam'] },
  { name: 'CloudWatch', category: 'observability', aliases: ['cloudwatch'] },
  { name: 'S3', category: 'cloud', aliases: ['s3', 'amazon s3'], relatedTo: ['AWS'] },
  { name: 'Lambda', category: 'cloud', aliases: ['aws lambda', 'lambda functions', 'lambda'], relatedTo: ['AWS'] },
  { name: 'ECS', category: 'cloud', aliases: ['ecs', 'fargate'], relatedTo: ['AWS', 'Docker'] },
  { name: 'Serverless', category: 'cloud', aliases: ['serverless'], relatedTo: ['AWS'] },
  { name: 'GCP', category: 'cloud', aliases: ['gcp', 'google cloud', 'google cloud platform'], relatedTo: ['AWS'] },
  { name: 'Azure', category: 'cloud', aliases: ['azure', 'microsoft azure'], relatedTo: ['AWS'] },

  // DevOps
  { name: 'Docker', category: 'devops', aliases: ['docker', 'containers', 'containerization', 'containerisation'], core: true },
  { name: 'Kubernetes', category: 'devops', aliases: ['kubernetes', 'k8s', 'eks', 'gke', 'aks', 'helm'], relatedTo: ['Docker'] },
  { name: 'Terraform', category: 'devops', aliases: ['terraform', 'infrastructure as code', 'iac', 'pulumi', 'cloudformation', 'cdk'] },
  { name: 'CI/CD', category: 'devops', aliases: ['ci/cd', 'ci cd', 'continuous integration', 'continuous deployment', 'github actions', 'gitlab ci', 'jenkins', 'circleci'] },
  { name: 'Linux', category: 'devops', aliases: ['linux', 'unix'] },
  { name: 'Nginx', category: 'devops', aliases: ['nginx'] },

  // Observability
  { name: 'Observability', category: 'observability', aliases: ['observability', 'monitoring', 'logging', 'alerting', 'tracing'], impliedBy: ['CloudWatch'], core: true },
  { name: 'Prometheus', category: 'observability', aliases: ['prometheus'], relatedTo: ['Observability'] },
  { name: 'Grafana', category: 'observability', aliases: ['grafana'], relatedTo: ['Observability'] },
  { name: 'Datadog', category: 'observability', aliases: ['datadog'], relatedTo: ['Observability', 'CloudWatch'] },
  { name: 'OpenTelemetry', category: 'observability', aliases: ['opentelemetry', 'otel'], relatedTo: ['Observability'] },
  { name: 'Sentry', category: 'observability', aliases: ['sentry'], relatedTo: ['Observability'] },
  { name: 'Production Debugging', category: 'concept', aliases: ['production debugging', 'debugging', 'troubleshooting', 'incident response', 'on-call', 'on call', 'root cause analysis'], core: true },

  // Architecture / concepts
  { name: 'Distributed Systems', category: 'concept', aliases: ['distributed systems', 'distributed system', 'distributed computing'], core: true },
  { name: 'Microservices', category: 'concept', aliases: ['microservices', 'micro-services', 'microservice', 'service-oriented', 'soa'], relatedTo: ['Distributed Systems', 'Backend Architecture'] },
  { name: 'Backend Architecture', category: 'concept', aliases: ['backend architecture', 'back-end architecture', 'server-side architecture', 'software architecture'], core: true },
  { name: 'System Design', category: 'concept', aliases: ['system design', 'systems design', 'scalable systems', 'scalability', 'high availability', 'high-throughput'], relatedTo: ['Backend Architecture', 'Distributed Systems'] },
  { name: 'Performance Optimization', category: 'concept', aliases: ['performance optimization', 'performance tuning', 'query optimization', 'low latency'], relatedTo: ['Database Design', 'Caching'] },
  { name: 'Third-party Integrations', category: 'concept', aliases: ['third-party integrations', 'third party integrations', 'third-party apis', 'external apis', 'integrations', 'webhooks'], core: true },
  { name: 'Payment Integrations', category: 'domain', aliases: ['payment integrations', 'payment gateway', 'payment gateways', 'payments'], core: true },
  { name: 'Stripe', category: 'domain', aliases: ['stripe'], relatedTo: ['Payment Integrations'] },
  { name: 'Razorpay', category: 'domain', aliases: ['razorpay'], relatedTo: ['Payment Integrations'] },
  { name: 'Authentication', category: 'concept', aliases: ['authentication', 'authorization', 'auth', 'sso', 'rbac'], core: true },
  { name: 'OAuth', category: 'concept', aliases: ['oauth', 'oauth2', 'openid connect', 'oidc'], relatedTo: ['Authentication'] },
  { name: 'JWT', category: 'concept', aliases: ['jwt', 'json web token'], relatedTo: ['Authentication'] },
  { name: 'OTP Systems', category: 'concept', aliases: ['otp', 'one-time password', '2fa', 'mfa', 'two-factor'] },
  { name: 'Shopify', category: 'domain', aliases: ['shopify'] },
  { name: 'Security', category: 'concept', aliases: ['application security', 'appsec', 'owasp', 'secure coding'] },
  { name: 'Multi-tenancy', category: 'concept', aliases: ['multi-tenant', 'multi tenant', 'multitenancy', 'multi-tenancy'] },
  { name: 'Testing', category: 'concept', aliases: ['unit testing', 'integration testing', 'tdd', 'test-driven', 'jest', 'mocha', 'automated testing'] },
  { name: 'Git', category: 'devops', aliases: ['git', 'github', 'gitlab', 'bitbucket'] },

  // Frontend / mobile (to recognise non-backend roles)
  { name: 'React', category: 'frontend', aliases: ['react', 'react.js', 'reactjs'] },
  { name: 'Next.js', category: 'frontend', aliases: ['next.js', 'nextjs'] },
  { name: 'Vue', category: 'frontend', aliases: ['vue', 'vue.js', 'vuejs', 'nuxt'] },
  { name: 'Angular', category: 'frontend', aliases: ['angular', 'angularjs'] },
  { name: 'HTML/CSS', category: 'frontend', aliases: ['html', 'css', 'tailwind', 'sass'] },
  { name: 'React Native', category: 'mobile', aliases: ['react native'] },
  { name: 'iOS', category: 'mobile', aliases: ['ios', 'swift', 'swiftui', 'objective-c'] },
  { name: 'Android', category: 'mobile', aliases: ['android', 'jetpack compose'] },
  { name: 'Flutter', category: 'mobile', aliases: ['flutter', 'dart'] },

  // Data / AI
  { name: 'Spark', category: 'data', aliases: ['spark', 'pyspark', 'apache spark'] },
  { name: 'Airflow', category: 'data', aliases: ['airflow'] },
  { name: 'Snowflake', category: 'data', aliases: ['snowflake'] },
  { name: 'BigQuery', category: 'data', aliases: ['bigquery'] },
  { name: 'ETL', category: 'data', aliases: ['etl', 'elt', 'data pipelines', 'data pipeline'], relatedTo: ['Queue Systems'] },
  { name: 'LLMs', category: 'ai', aliases: ['llm', 'llms', 'large language models', 'genai', 'generative ai', 'openai', 'anthropic', 'claude', 'gpt'] },
  { name: 'RAG', category: 'ai', aliases: ['rag', 'retrieval augmented generation', 'retrieval-augmented'] },
  { name: 'LangChain', category: 'ai', aliases: ['langchain', 'llamaindex'] },
  { name: 'Vector Databases', category: 'ai', aliases: ['vector database', 'vector databases', 'pgvector', 'pinecone', 'weaviate', 'qdrant', 'embeddings'] },
  { name: 'Machine Learning', category: 'ai', aliases: ['machine learning', 'ml models', 'pytorch', 'tensorflow', 'scikit-learn'] },

  // Domains
  { name: 'E-commerce', category: 'domain', aliases: ['e-commerce', 'ecommerce', 'commerce platform'] },
  { name: 'Loyalty Platforms', category: 'domain', aliases: ['loyalty', 'rewards program', 'loyalty program'] },
  { name: 'Fintech', category: 'domain', aliases: ['fintech', 'banking', 'lending'] },
  { name: 'SaaS', category: 'domain', aliases: ['saas', 'b2b saas'] },
];

const BY_NAME = new Map(SKILLS.map((s) => [s.name.toLowerCase(), s]));

export function getSkill(name: string): SkillDef | undefined {
  return BY_NAME.get(name.toLowerCase());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Token-boundary matcher that works for names like "node.js", "c#", "ci/cd", ".net". */
function boundaryRegex(alias: string, flags: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9+#])${escapeRegex(alias)}(?![A-Za-z0-9+#]|\\.[A-Za-z])`, flags);
}

interface CompiledSkill {
  def: SkillDef;
  patterns: RegExp[];
}

const COMPILED: CompiledSkill[] = SKILLS.map((def) => ({
  def,
  patterns: [
    ...def.aliases.map((a) => boundaryRegex(a, 'gi')),
    // "Go" alone is ambiguous in English: exclude common phrases.
    ...(def.caseSensitive ?? []).map((a) =>
      a === 'Go'
        ? /(?<![A-Za-z0-9])Go(?![A-Za-z0-9])(?!\s+(?:to|ahead|live|beyond|further|through|above|deep|out|back|after|for|with)\b)(?!-to)/g
        : boundaryRegex(a, 'g'),
    ),
  ],
}));

/** Return canonical skill names found in text, with occurrence counts. */
export function findSkills(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const { def, patterns } of COMPILED) {
    let count = 0;
    for (const re of patterns) {
      re.lastIndex = 0;
      const matches = text.match(re);
      if (matches) count += matches.length;
    }
    if (count > 0) found.set(def.name, count);
  }
  // "React Native" also matches "React": drop React when every React hit is React Native.
  if (found.has('React Native') && found.get('React') === found.get('React Native')) found.delete('React');
  // "Spring" in "spring boot" is fine; plain season usage is rare in JDs.
  return found;
}

/** Map a free-form skill string (from the profile) to a canonical taxonomy name. */
export function canonicalizeSkill(raw: string): string {
  const trimmed = raw.trim();
  const direct = getSkill(trimmed);
  if (direct) return direct.name;
  const hits = [...findSkills(trimmed).keys()];
  return hits.length === 1 ? hits[0] : trimmed;
}
