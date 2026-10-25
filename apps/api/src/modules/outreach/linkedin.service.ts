import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { buildTemplateNote, checkLinkedInNote, LINKEDIN_NOTE_LIMIT, linkedinNoteInputSchema, LinkedInNoteInput } from '../../domain/linkedin/note';
import { MatchResult } from '../../domain/matching/scorer';
import { extractJob, JobExtraction } from '../../domain/skills/extract';
import { AiService } from '../ai/ai.service';
import { CompanyFact } from '../companies/companies.service';
import { ProfileService } from '../profile/profile.service';

export interface LinkedInNoteResult {
  note: string;
  length: number;
  limit: number;
  provider: string;
  /** The AI model's note was not usable, so the plain template note is shown. */
  fallback: boolean;
  warnings: string[];
  contact: { id: string; name: string; role: string | null; linkedinUrl: string | null } | null;
  /** People at this company who could receive the note. */
  contacts: Array<{ id: string; name: string; role: string | null; linkedinUrl: string | null }>;
}

/**
 * Prepares a short LinkedIn connection note for a job. It only writes text: nothing is sent, and the app has
 * no LinkedIn access. The person copies it and pastes it into LinkedIn themselves.
 */
@Injectable()
export class LinkedInService {
  private readonly logger = new Logger(LinkedInService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly profiles: ProfileService,
  ) {}

  async note(userId: string, jobId: string, opts: { contactId?: string; regenerate?: boolean } = {}): Promise<LinkedInNoteResult> {
    const job = await this.prisma.job.findFirst({ where: { id: jobId, userId }, include: { company: true, application: true } });
    if (!job) throw new NotFoundException('Job not found');
    const people = await this.prisma.contact.findMany({ where: { userId, companyId: job.companyId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    const pick = opts.contactId ?? job.application?.contactId ?? people[0]?.id;
    const contact = people.find((c) => c.id === pick) ?? null;
    if (opts.contactId && !contact) throw new NotFoundException('Contact not found at this company');

    const profile = await this.profiles.get();
    const extraction = (job.extracted as unknown as JobExtraction | null) ?? extractJob({ title: job.title, description: job.description, location: job.location, companyName: job.company.name });
    const match = job.scoreBreakdown as unknown as MatchResult | null;
    const jobSkills = [...extraction.requiredSkills, ...extraction.preferredSkills];
    const overlap = (match?.strong ?? jobSkills.filter((s) => profile.strongSkills.includes(s))).slice(0, 6);
    const facts = ((job.company.research as unknown as CompanyFact[] | null) ?? []).slice(0, 3);
    const input: LinkedInNoteInput = linkedinNoteInputSchema.parse({
      jobTitle: job.title,
      companyName: job.company.name,
      recipientName: contact?.name,
      recipientRole: contact?.role,
      overlapSkills: overlap,
      companyFacts: facts.map((f) => ({ text: f.text })),
      jobSummary: job.description.slice(0, 4000),
    });
    const allowed = [...overlap, ...profile.strongSkills];

    let problems: string[] | undefined;
    let note = '';
    let provider = this.ai.template.name;
    let fallback = false;
    for (let attempt = 0; attempt < 2 && this.ai.usesLlm; attempt++) {
      const r = await this.ai.run<{ note: string }>(userId, 'EMAIL', { linkedin: input, problems, attempt }, (p) => p.generateLinkedInNote({ profile, input, previousProblems: problems }), { force: !!opts.regenerate || attempt > 0 });
      const check = checkLinkedInNote(r.output.note, allowed, `${job.title} ${job.company.name}`, job.company.name);
      if (check.ok) {
        note = r.output.note.trim();
        provider = r.provider;
        fallback = r.fallback;
        break;
      }
      problems = check.problems;
      this.logger.warn({ msg: 'LinkedIn note failed checks', attempt, problems });
      if (r.provider === 'template') break;
    }
    const warnings: string[] = [];
    if (!note) {
      note = buildTemplateNote(input);
      fallback = this.ai.usesLlm;
      if (problems) warnings.push(`The AI note was rejected (${problems.join('; ')}), so a plain note is shown.`);
    }
    if (!contact) warnings.push('No contact is saved for this company yet, so the greeting is general. Add the person’s name in Contacts for a personal one.');
    if (!contact?.linkedinUrl && contact) warnings.push(`Add ${contact.name.split(' ')[0]}’s LinkedIn profile link in Contacts to open it from here.`);

    const brief = (c: { id: string; name: string; role: string | null; linkedinUrl: string | null }) => ({ id: c.id, name: c.name, role: c.role, linkedinUrl: c.linkedinUrl });
    return { note, length: note.length, limit: LINKEDIN_NOTE_LIMIT, provider, fallback, warnings, contact: contact ? brief(contact) : null, contacts: people.map(brief) };
  }
}
