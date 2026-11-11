/* eslint-disable no-console -- terminal output is this file's job */
import * as readline from 'readline';
import { answersFile, loadAnswers, saveAnswer, unansweredQuestions } from './apply/answers';
import { loadProfile } from './search';

/**
 * `npm run answers` — asks you, in the terminal, every application question the tool could not answer, and saves
 * your answers so they are filled in automatically from then on. `--list` only shows all current answers.
 */
async function main(): Promise<void> {
  const profile = loadProfile();
  const answers = loadAnswers(profile);
  if (process.argv.includes('--list')) {
    for (const a of answers) console.log(`${(a.source ?? '').padEnd(8)} ${a.match.join(' + ').padEnd(40)} → ${a.answer}`);
    console.log(`\n${answers.length} answers. Edit them in ${answersFile()}`);
    return;
  }
  const open = unansweredQuestions(answers, profile.strongSkills);
  if (!open.length) {
    console.log(`No unanswered questions. All ${answers.length} answers: npm run answers -- --list`);
    return;
  }
  console.log(`${open.length} questions from applications need your answer. Press Enter to skip one.\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
  let saved = 0;
  for (const q of open) {
    const a = await ask(`[${q.site}, ${q.job.slice(0, 40)}${q.times > 1 ? `, asked ${q.times}×` : ''}]\n${q.question}\n> `);
    if (a.trim()) {
      saveAnswer(q.question, a);
      saved++;
    }
    console.log('');
  }
  rl.close();
  console.log(`Saved ${saved} answers. They will be filled in automatically from now on.`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
