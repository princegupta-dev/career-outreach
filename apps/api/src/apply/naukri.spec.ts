import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { openBrowser } from '../browser/runner';
import { parseProfileMarkdown } from '../domain/profile/profile';
import { applyNaukri } from './naukri';
import type { Answer } from './answers';

const profile = parseProfileMarkdown(`---
name: Sample Engineer
location: Gurugram
contact:
  email: sample@example.com
skills:
  strong: [Node.js, TypeScript, Redis]
  partial: [Kafka]
---
`);
const answers: Answer[] = [
  { match: ['current', 'location'], answer: 'Gurugram', source: 'you' },
  { match: ['years', 'node.js'], answer: '3.5', source: 'you' },
  { match: ['notice', 'period'], answer: '30 days', source: 'you' },
  { match: ['worked', 'employee', 'examplecorp'], answer: 'No', source: 'you' },
  { match: ['production', 'technologies'], answer: 'Node.js, Redis', source: 'you' },
];
const confirmation = `<title>Apply Confirmation</title><div class="acp-header-container"><div class="job-title-text">Applied to <span class="job-title">"Backend Engineer"</span></div></div>`;
const hasChrome = fs.existsSync('/Applications/Google Chrome.app') || fs.existsSync('/usr/bin/google-chrome');
(hasChrome ? describe : describe.skip)('Naukri application forms in Chrome (intercepted fixtures only)', () => {
  let dir: string, context: BrowserContext, page: Page;
  const submitted: string[] = [], sent: string[] = [], pageErrors: string[] = [];
  const original = { snapshots: process.env.JOB_HUNTER_SNAPSHOTS, questions: process.env.JOB_HUNTER_QUESTIONS };
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naukri-forms-'));
    process.env.JOB_HUNTER_SNAPSHOTS = path.join(dir, 'snapshots'); process.env.JOB_HUNTER_QUESTIONS = path.join(dir, 'questions.json');
    context = await openBrowser(true, path.join(dir, 'chrome'));
    await context.route('https://www.naukri.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/submitted') { submitted.push(url.searchParams.get('name')!); await route.fulfill({ body: confirmation, contentType: 'text/html' }); return; }
      if (url.pathname === '/answer') { sent.push(url.searchParams.get('value')!); await route.fulfill({ body: '{}' }); return; }
      const name = url.pathname.match(/job-listings-(.*)-1234567890/)?.[1];
      const complete = `fetch('/submitted?name=${name}');document.body.innerHTML=${JSON.stringify(confirmation)}`;
      let html = `<title>Job</title><button id="apply-button" onclick="${complete.replace(/"/g, '&quot;')}">Apply</button>`;
      if (name === 'already') html = '<title>Job</title><span id="already-applied">Applied</span>';
      if (name === 'external') html = '<title>Job</title><button id="company-site-button">Apply on company site</button>';
      if (name === 'captcha') html = '<title>CAPTCHA</title><button id="apply-button">Apply</button>';
      if (name === 'redirect') html = '<title>Job</title><script>setTimeout(()=>location.replace("https://www.naukri.com/search-jobs"),1)</script>';
      if (url.pathname === '/search-jobs') html = '<title>Search jobs</title><button id="apply-button" onclick="fetch(\'/submitted?name=WRONG\')">Apply</button>';
      if (name === 'uncertain') html = '<title>Job</title><button id="apply-button">Apply</button>';
      if (name === 'chat' || name === 'unknown') {
        const questions = name === 'unknown' ? ['Have you worked as a full-time employee with UnknownCorp?'] : ['Current Location', 'Experience in Node.js and TypeScript?', 'Have you worked as a full-time employee with ExampleCorp?', 'How many years of experience do you have in Node.js?', 'What is your notice period?'];
        html = `<title>Job</title><button id="apply-button" onclick="document.querySelector('.chatbot_DrawerContentWrapper').hidden=false;render()">Apply</button><div class="chatbot_DrawerContentWrapper" hidden></div><script>
        let n=0; const qs=${JSON.stringify(questions)};
        function render(){ const root=document.querySelector('.chatbot_DrawerContentWrapper'); const q=qs[n]; if(!q){fetch('/submitted?name=${name}');document.body.innerHTML=${JSON.stringify(confirmation)};return;}
          let input='<div id="answer" contenteditable="true"></div>';
          if(q.includes('Experience in')||q.includes('employee')) input='<div class="singleselect-radiobutton"><input type="radio" id="yes" name="choice" value="Yes"><label for="yes">Yes</label><input type="radio" id="no" name="choice" value="No"><label for="no">No</label></div>';
          if(q.includes('notice')) input='<select id="answer"><option value="">Select</option><option>15 days</option><option>30 days</option><option>60 days</option></select>';
          root.innerHTML='<div class="botItem"><div class="botMsg">'+q+'</div></div>'+input+'<div id="sendMsg__test"><div class="sendMsg" tabindex="0" onclick="save()">Save</div></div>';
        }
        function save(){ const el=document.querySelector('#answer');const value=el?(el.value||el.innerText):document.querySelector('input:checked')?.value;fetch('/answer?value='+encodeURIComponent(value));n++;render();}
        </script>`;
      }
      if (name === 'form') html = `<title>Job</title><button id="apply-button" onclick="document.querySelector('form').hidden=false">Apply</button><form hidden onsubmit="event.preventDefault();fetch('/answer?value='+encodeURIComponent([...this.querySelectorAll('input:checked')].map(e=>e.value).join(', ')+'|'+this.querySelector('input[type=file]').files[0].name));fetch('/submitted?name=form');document.body.innerHTML=${JSON.stringify(confirmation).replace(/"/g, '&quot;')}">
        <label>Full name<input id="name"></label><label>Email<input id="email" type="email"></label><label>Notice period in days<input id="notice" type="number"></label>
        <fieldset><legend>Which production technologies have you used?</legend><input id="native-node" type="checkbox" value="Node.js" style="display:none"><label for="native-node">Node.js</label><input id="native-redis" type="checkbox" value="Redis" style="display:none"><label for="native-redis">Redis</label></fieldset>
        <label for="native-resume">Upload resume</label><input id="native-resume" type="file" style="display:none"><button>Submit application</button></form>`;
      if (name === 'advanced') html = `<title>Job</title><button id="apply-button" onclick="document.querySelector('.chatbot_DrawerContentWrapper').hidden=false;render()">Apply</button><div class="chatbot_DrawerContentWrapper" hidden></div><script>
        let n=0; function render(){const root=document.querySelector('.chatbot_DrawerContentWrapper');
          if(n===0)root.innerHTML='<div class="botItem"><div class="botMsg">Current Location</div></div><input id="answer" role="combobox" oninput="suggest()"><div id="options"></div>';
          if(n===1)root.innerHTML='<div class="botItem"><div class="botMsg">Which production technologies have you used?</div></div><label><input type="checkbox" value="Node.js">Node.js</label><label><input type="checkbox" value="Redis">Redis</label><label><input type="checkbox" value="Kafka">Kafka</label>';
          if(n===2)root.innerHTML='<div class="botItem"><div class="botMsg">Upload your resume</div></div><input id="answer" type="file" style="display:none">';
          if(n===3){fetch('/submitted?name=advanced');document.body.innerHTML=${JSON.stringify(confirmation)};return;}
          root.insertAdjacentHTML('beforeend','<div id="sendMsg__test"><div class="sendMsg" tabindex="0" onclick="save()">Save</div></div>');
        }
        function suggest(){const box=document.querySelector('#options');box.innerHTML='';const option=document.createElement('div');option.setAttribute('role','option');option.textContent='Gurugram';option.onclick=()=>{document.querySelector('#answer').value='Gurugram';box.innerHTML='';};box.appendChild(option);}
        function save(){const el=document.querySelector('#answer');const value=n===1?[...document.querySelectorAll('input:checked')].map(e=>e.value).join(', '):n===2?el.files[0].name:el.value;fetch('/answer?value='+encodeURIComponent(value));n++;render();}
        </script>`;
      await route.fulfill({ contentType: 'text/html', body: html });
    });
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
  }, 60000);
  afterAll(async () => { await context?.close(); if (original.snapshots === undefined) delete process.env.JOB_HUNTER_SNAPSHOTS; else process.env.JOB_HUNTER_SNAPSHOTS = original.snapshots; if (original.questions === undefined) delete process.env.JOB_HUNTER_QUESTIONS; else process.env.JOB_HUNTER_QUESTIONS = original.questions; if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { submitted.length = 0; sent.length = 0; pageErrors.length = 0; });
  const apply = (name: string, dryRun = false, resumeFile?: string) => applyNaukri(page, { id: name, title: 'Backend Engineer', url: `https://www.naukri.com/job-listings-${name}-1234567890` }, { profile, answers, resumeText: '', resumeFile, dryRun, waitMs: 1500 });
  it('recognizes Naukri quick-apply confirmation and never clicks during a dry run', async () => {
    expect((await apply('quick', true)).status).toBe('dry-run'); expect(submitted).toEqual([]);
    expect((await apply('quick')).status).toBe('applied'); expect(submitted).toEqual(['quick']);
  }, 20000);
  it('completes actual-style chatbot text, skill-presence radio, employment radio, exact years and select questions', async () => {
    expect(await apply('chat')).toMatchObject({ status: 'applied' });
    expect(sent).toEqual(['Gurugram', 'Yes', 'No', '3.5', '30 days']); expect(submitted).toEqual(['chat']);
  }, 30000);
  it('fills a standard multi-field application form, hidden checkbox group and PDF upload', async () => {
    const file = path.join(dir, 'native.pdf'); fs.writeFileSync(file, '%PDF-1.4\nfixture');
    const result = await apply('form', false, file); expect(result.note).toBe('Naukri confirmed this application.'); expect(result.status).toBe('applied'); expect(submitted).toEqual(['form']); expect(sent).toEqual(['Node.js, Redis|native.pdf']);
  }, 20000);
  it('handles autocomplete, a confirmed checkbox group and a hidden PDF upload', async () => {
    const file = path.join(dir, 'application.pdf'); fs.writeFileSync(file, '%PDF-1.4\nfixture');
    const result = await apply('advanced', false, file); expect(pageErrors).toEqual([]); expect(result.note).toBe('Naukri confirmed this application.'); expect(result.status).toBe('applied');
    expect(sent).toEqual(['Gurugram', 'Node.js, Redis', 'application.pdf']); expect(submitted).toEqual(['advanced']);
  }, 20000);
  it('stops for an unknown employment question without guessing Yes or No', async () => { expect((await apply('unknown')).status).toBe('needs-answers'); expect(sent).toEqual([]); expect(submitted).toEqual([]); }, 20000);
  it('does not apply to already-applied, external, CAPTCHA or redirected jobs', async () => {
    expect((await apply('already')).status).toBe('already-applied'); expect((await apply('external')).status).toBe('external'); expect((await apply('captcha')).status).toBe('failed');
    const redirected = await apply('redirect'); expect({ status: redirected.status, title: await page.title(), url: page.url() }).toEqual({ status: 'no-button', title: 'Search jobs', url: 'https://www.naukri.com/search-jobs' }); expect(submitted).toEqual([]);
  }, 20000);
  it('blocks retries when Apply has no verifiable outcome', async () => { expect((await apply('uncertain')).status).toBe('verification-required'); }, 10000);
});
