import * as fs from 'fs';
import * as path from 'path';
import { parseProfileMarkdown, CandidateProfile } from '../profile/profile';

export const PROFILE_PATH = path.resolve(__dirname, '../../../../../candidate/candidate-profile.example.md');

export function loadProfile(now = new Date('2026-10-06T00:00:00Z')): CandidateProfile {
  return parseProfileMarkdown(fs.readFileSync(PROFILE_PATH, 'utf8'), now);
}

export const BACKEND_JD = `
About the role
We're hiring a Senior Backend Engineer to join our platform team. You'll build APIs and backend services that power our commerce platform.

Requirements:
- 3+ years of experience building backend systems
- Strong experience with Node.js and TypeScript
- Experience with PostgreSQL and Redis
- Experience with AWS (EC2, RDS, S3)
- Experience designing REST APIs and working with message queues

Nice to have:
- Kafka
- Experience with Kubernetes
- GraphQL

This is a fully remote role. Compensation: ₹35-45 LPA.
`;

export const JAVA_JD = `
Requirements:
- 6+ years of experience with Java and Spring Boot
- Experience with Kafka and Cassandra
- Experience with Kubernetes and Terraform
Location: Berlin, Germany. Must be located in the EU. We are unable to sponsor visas.
`;

export const FRONTEND_JD = `
We're looking for a Senior Frontend Engineer.
Requirements:
- 5+ years with React, Next.js and TypeScript
- Strong HTML/CSS and design systems experience
Remote (US only).
`;
