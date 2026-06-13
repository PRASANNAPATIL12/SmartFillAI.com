import { AIProviderFactory } from '@/ai-providers';
import type { ProfileEntry } from '@shared/types';
import { getAllEntries } from './profile-store';

const ESSAY_SYSTEM = `You are helping a job applicant write clear, professional responses to application questions. Write in first person. Be specific, genuine, and appropriately concise. Do not use hollow filler phrases. Output only the response text.`;

function buildContextBlock(entries: ProfileEntry[]): string {
  const pick = (key: string) => entries.find(e => e.canonical_key === key)?.value;

  const name       = pick('full_name');
  const jobTitle   = pick('job_title');
  const company    = pick('company');
  const university = pick('university');
  const degree     = pick('degree');
  const skills     = pick('skills');
  const summary    = pick('personal_statement');

  const lines = [
    name       && `Applicant name: ${name}`,
    jobTitle   && `Current/target role: ${jobTitle}`,
    company    && `Current/target company: ${company}`,
    degree     && university && `Education: ${degree} from ${university}`,
    skills     && `Skills: ${skills}`,
    summary    && `Background summary: ${summary}`,
  ].filter(Boolean) as string[];

  return lines.length > 0 ? `\nApplicant context:\n${lines.join('\n')}\n` : '';
}

export async function generateEssay(question: string, domain: string): Promise<string> {
  const [provider, entries] = await Promise.all([
    AIProviderFactory.getProvider(),
    getAllEntries(),
  ]);

  const context = buildContextBlock(entries);

  const userMessage =
    `You are writing an application response for ${domain}.\n\n` +
    `Question: "${question}"` +
    context +
    `\nWrite only the response. Aim for 150–300 words unless the question clearly warrants more or less. Be professional and specific.`;

  const response = await provider.chat({
    messages:   [{ role: 'user', content: userMessage }],
    system:     ESSAY_SYSTEM,
    temperature: 0.75,
    maxTokens:   600,
  });

  return response.content.trim();
}
