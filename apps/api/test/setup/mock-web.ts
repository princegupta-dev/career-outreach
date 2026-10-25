/**
 * Offline "internet" for discovery tests: realistic payloads for the public sources,
 * and TLS-interception errors for feeds that are blocked (like a firewall would).
 */
const JD_NODE = `<p>We build payment infrastructure.</p><p><strong>Requirements</strong></p><ul><li>3+ years building backend systems</li><li>Node.js and TypeScript</li><li>PostgreSQL, Redis and AWS</li><li>Message queues and REST APIs</li></ul><p>Nice to have: Kafka</p>`;

export const HN_STORY = { hits: [{ objectID: '9001', title: 'Ask HN: Who is hiring? (October 2026)' }] };
export const HN_COMMENTS = {
  hits: [
    {
      objectID: '9101',
      parent_id: 9001,
      created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      comment_text:
        'Paylane (<a href="https:&#x2F;&#x2F;paylane.dev">https:&#x2F;&#x2F;paylane.dev</a>) | Senior Backend Engineer | REMOTE (Worldwide) | Full-time<p>I&#x27;m the CTO. We build payment APIs with Node.js, TypeScript, PostgreSQL, Redis and AWS. 3+ years of experience building backend systems; message queues and REST APIs.<p>Email me: cto [at] paylane [dot] dev',
    },
    {
      objectID: '9102',
      parent_id: 9001,
      created_at: new Date().toISOString(),
      comment_text: 'Northwind | Senior Backend Engineer (Go) | REMOTE (US only) | Full-time<p>Go, Kubernetes, gRPC. Email jobs@northwind.io',
    },
    { objectID: '9103', parent_id: 9001, created_at: new Date().toISOString(), comment_text: 'Glow Studio | Senior Frontend Engineer | Remote<p>React, CSS' },
    { objectID: '9104', parent_id: 9102, created_at: new Date().toISOString(), comment_text: 'Is this still open?' },
  ],
};

export const WWR_RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Ledgerly: Senior Node.js Backend Engineer</title><region>Anywhere in the World</region><type>Full-Time</type><skills>Node.js, TypeScript, AWS</skills>
<description>&lt;p&gt;&lt;strong&gt;URL:&lt;/strong&gt; &lt;a href="https://ledgerly.io"&gt;https://ledgerly.io&lt;/a&gt;&lt;/p&gt;${JD_NODE.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</description>
<pubDate>${new Date(Date.now() - 86_400_000).toUTCString()}</pubDate><link>https://weworkremotely.com/remote-jobs/ledgerly-node</link></item>
</channel></rss>`;

export const GH_LIST = {
  jobs: [
    { id: 11, title: 'Senior Software Engineer, Backend', absolute_url: 'https://boards.greenhouse.io/acmecorp/jobs/11', location: { name: 'Bengaluru, India' }, updated_at: new Date().toISOString() },
    { id: 12, title: 'Senior Software Engineer, Backend', absolute_url: 'https://boards.greenhouse.io/acmecorp/jobs/12', location: { name: 'San Francisco, CA' }, updated_at: new Date().toISOString() },
    { id: 13, title: 'Product Designer', absolute_url: 'https://boards.greenhouse.io/acmecorp/jobs/13', location: { name: 'Bengaluru, India' }, updated_at: new Date().toISOString() },
  ],
};
export const GH_JOB_11 = { ...GH_LIST.jobs[0], content: JD_NODE.replace(/</g, '&lt;').replace(/>/g, '&gt;') };

export interface MockWebCalls {
  urls: string[];
}

export function installMockWeb(): MockWebCalls & { restore: () => void } {
  const calls: string[] = [];
  const spy = jest.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
    if (url.includes('yc-oss.github.io')) return json([]); // startup directory: empty unless a test supplies one
    if (url.includes('hn.algolia.com') && url.includes('author_whoishiring')) return json(HN_STORY);
    if (url.includes('hn.algolia.com') && url.includes('story_9001')) return json(HN_COMMENTS);
    if (url.includes('weworkremotely.com') && url.includes('back-end')) return new Response(WWR_RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    if (url.includes('weworkremotely.com')) return new Response('<rss><channel></channel></rss>', { status: 200 });
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acmecorp') return json({ name: 'AcmeCorp' });
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acmecorp/jobs') return json(GH_LIST);
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acmecorp/jobs/11') return json(GH_JOB_11);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /admin', { status: 200 });
    if (url.startsWith('https://acmecorp.com/careers')) return html('<a href="mailto:careers@acmecorp.com">Join us</a> <a href="mailto:jane.doe@acmecorp.com">Jane</a>');
    if (/^https:\/\/(paylane\.dev|ledgerly\.io|acmecorp\.com)/.test(url)) return html('<html><body>Welcome</body></html>');
    if (/remotive|himalayas|jobicy|arbeitnow|remoteok|lever\.co/.test(url)) {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
    }
    if (url.includes('greenhouse.io') || url.includes('ashbyhq.com')) return json({ jobs: [] }, 404);
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  return { urls: calls, restore: () => spy.mockRestore() };
}
