export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, payload } = req.body;
  const JSEARCH_KEY = process.env.JSEARCH_KEY;
  const GROQ_KEY    = process.env.GROQ_KEY;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function sanitize(text, maxLen) {
    if (!text) return '';
    return text
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ')
      .replace(/\\/g, ' ')
      .replace(/"/g, "'")
      .replace(/\n|\r|\t/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, maxLen);
  }

  async function groq(prompt, maxTokens = 300) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: maxTokens,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await r.json();
      if (data.error) {
        const msg = data.error.message || '';
        if (msg.includes('rate_limit') || msg.includes('Rate limit')) {
          await sleep([5000, 10000, 20000][attempt] || 20000);
          continue;
        }
        throw new Error('Groq: ' + msg);
      }
      if (!data.choices?.[0]?.message?.content) throw new Error('Groq empty response');
      return data.choices[0].message.content;
    }
    throw new Error('Rate limit: please wait 1 minute and try again.');
  }

  function extractJSON(raw) {
    if (!raw) throw new Error('Empty AI response');
    let text = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON found in: ' + text.slice(0, 200));
    const jsonStr = text.slice(start, end + 1);
    try { return JSON.parse(jsonStr); }
    catch(e) {
      const fixed = jsonStr.replace(/:\s*"([\s\S]*?)"\s*([,}])/g, (m, val, ending) =>
        `: "${val.replace(/"/g, "'").replace(/\n/g, ' ')}"${ending}`
      );
      try { return JSON.parse(fixed); }
      catch(e2) { throw new Error('JSON parse failed: ' + jsonStr.slice(0, 300)); }
    }
  }

  // ── Parse LinkedIn RSS ────────────────────────────────────────────────
  function parseRSSItems(xml, source) {
    const items = [];
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    for (const item of itemMatches) {
      const get = (tag) => {
        const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`));
        return m ? (m[1] || m[2] || '').trim() : '';
      };
      const title    = get('title');
      const link     = get('link') || get('guid');
      const company  = get('source') || get('author') || '';
      const location = get('location') || '';
      const pubDate  = get('pubDate');
      const desc     = get('description').replace(/<[^>]+>/g, ' ').trim();
      if (!title) continue;
      // Extract company from title if format is "Role at Company"
      let companyName = company;
      const atMatch = title.match(/\s+at\s+(.+)$/i);
      if (!companyName && atMatch) companyName = atMatch[1].trim();

      items.push({
        job_id: `${source}_${Buffer.from(link || title).toString('base64').slice(0, 20)}`,
        job_title: title.replace(/\s+at\s+.+$/i, '').trim(),
        employer_name: companyName || 'Unknown',
        job_city: location.split(',')[0]?.trim() || '',
        job_state: location.split(',')[1]?.trim() || '',
        job_country: 'India',
        job_description: desc,
        job_apply_link: link,
        job_posted_at_datetime_utc: pubDate ? new Date(pubDate).toISOString() : null,
        job_posted_at_timestamp: pubDate ? new Date(pubDate).getTime() / 1000 : 0,
        job_is_remote: /remote/i.test(title + location),
        isWatchlist: false,
        source
      });
    }
    return items;
  }

  // ── Fetch LinkedIn RSS ────────────────────────────────────────────────
  async function fetchLinkedInRSS(role, location) {
    const keywords = encodeURIComponent(role);
    const loc      = encodeURIComponent(location || 'India');
    // LinkedIn job search RSS — last 7 days
    const url = `https://www.linkedin.com/jobs/search/?keywords=${keywords}&location=${loc}&f_TPR=r604800&f_WT=1,2,3&sortBy=DD`;
    // LinkedIn doesn't serve RSS directly anymore but we can use their jobs feed
    // Use a reliable public RSS bridge
    const rssUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${keywords}&location=${loc}&f_TPR=r604800&start=0`;

    try {
      const r = await fetch(rssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; JobBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml'
        }
      });
      const html = await r.text();
      // Parse LinkedIn job cards from HTML
      const jobs = [];
      const cardMatches = html.match(/<li[^>]*>([\s\S]*?)<\/li>/g) || [];
      for (const card of cardMatches) {
        const titleM   = card.match(/class="[^"]*job-result-card__title[^"]*"[^>]*>([^<]+)</i) ||
                         card.match(/<h3[^>]*>([^<]+)<\/h3>/i);
        const companyM = card.match(/class="[^"]*job-result-card__subtitle[^"]*"[^>]*>([^<]+)</i) ||
                         card.match(/class="[^"]*result-card__subtitle[^"]*"[^>]*>([^<]+)</i);
        const linkM    = card.match(/href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"]+)"/i);
        const locM     = card.match(/class="[^"]*job-result-card__location[^"]*"[^>]*>([^<]+)</i);
        const dateM    = card.match(/<time[^>]*datetime="([^"]+)"/i);

        if (!titleM) continue;
        jobs.push({
          job_id: `li_${(linkM?.[1] || titleM[1]).slice(-20)}`,
          job_title: titleM[1].trim(),
          employer_name: companyM?.[1]?.trim() || '',
          job_city: locM?.[1]?.split(',')[0]?.trim() || '',
          job_state: '',
          job_country: 'India',
          job_description: '',
          job_apply_link: linkM?.[1] || url,
          job_posted_at_datetime_utc: dateM?.[1] || null,
          job_posted_at_timestamp: dateM?.[1] ? new Date(dateM[1]).getTime()/1000 : 0,
          job_is_remote: /remote/i.test(titleM[1] + (locM?.[1] || '')),
          isWatchlist: false,
          source: 'LinkedIn'
        });
      }
      return jobs;
    } catch(e) {
      console.log('LinkedIn fetch failed:', e.message);
      return [];
    }
  }

  // ── Fetch Indeed RSS ──────────────────────────────────────────────────
  async function fetchIndeedRSS(role, cities) {
    const q   = encodeURIComponent(`"${role}"`);
    const loc = encodeURIComponent(cities[0] || 'India');
    const url = `https://in.indeed.com/rss?q=${q}&l=${loc}&sort=date&fromage=7`;
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobBot/1.0)' }
      });
      const xml = await r.text();
      return parseRSSItems(xml, 'Indeed');
    } catch(e) {
      console.log('Indeed RSS failed:', e.message);
      return [];
    }
  }

  // ── Fetch JSearch ────────────────────────────────────────────────────
  async function fetchJSearch(role) {
    const q = encodeURIComponent(`${role} India`);
    try {
      const r = await fetch(
        `https://jsearch.p.rapidapi.com/search?query=${q}&num_pages=2&date_posted=week&country=in&language=en`,
        { headers: { 'x-rapidapi-key': JSEARCH_KEY, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' } }
      );
      const data = await r.json();
      return (data.data || []).map(j => ({ ...j, source: 'JSearch' }));
    } catch(e) {
      console.log('JSearch failed:', e.message);
      return [];
    }
  }

  // ── Scrape a single job URL (for manual paste) ───────────────────────
  async function scrapeJobURL(url) {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const html = await r.text();

    // Extract text content — strip all HTML tags
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Try to extract job title from meta/title tags
    const titleM   = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const ogTitleM = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    const ogDescM  = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i);

    return {
      pageTitle: (ogTitleM?.[1] || titleM?.[1] || '').replace(/\s*[-|].*$/, '').trim(),
      pageDesc:  ogDescM?.[1] || '',
      fullText:  text.slice(0, 4000)
    };
  }

  try {

    // ── SEARCH ──────────────────────────────────────────────────────────
    if (action === 'search') {
      const { roles, cities, watchlist } = payload;
      const topRoles = roles.slice(0, 3);

      // Fire all sources in parallel
      const [jsearchResults, ...indeedResults] = await Promise.all([
        // JSearch for all roles combined
        ...topRoles.map(role => fetchJSearch(role)),
        // Indeed RSS per role
        ...topRoles.slice(0, 2).map(role => fetchIndeedRSS(role, cities)),
        // LinkedIn for top role
        fetchLinkedInRSS(topRoles[0], cities[0] || 'India'),
        // Watchlist company searches via JSearch
        ...(watchlist || []).slice(0, 3).map(company => {
          const q = encodeURIComponent(`${company} India`);
          return fetch(
            `https://jsearch.p.rapidapi.com/search?query=${q}&num_pages=1&date_posted=week&country=in`,
            { headers: { 'x-rapidapi-key': JSEARCH_KEY, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' } }
          ).then(r => r.json()).then(d => (d.data || []).map(j => ({...j, source:'JSearch'}))).catch(() => []);
        })
      ]);

      // Flatten and deduplicate
      const allRaw = [jsearchResults, ...indeedResults].flat();
      const seen   = new Set();
      let allJobs  = [];
      for (const job of allRaw) {
        const key = job.job_id || job.job_title + job.employer_name;
        if (!seen.has(key)) {
          seen.add(key);
          allJobs.push(job);
        }
      }

      // Mark watchlist hits
      const watchLower = (watchlist || []).map(c => c.toLowerCase());
      allJobs = allJobs.map(job => ({
        ...job,
        isWatchlist: watchLower.some(w => (job.employer_name || '').toLowerCase().includes(w))
      }));

      // City filter
      const cityLower = cities.map(c => c.toLowerCase());
      const filtered  = allJobs.filter(job => {
        if (cities.includes('Remote') && job.job_is_remote) return true;
        const loc = [job.job_city || '', job.job_state || '', job.job_country || ''].join(' ').toLowerCase().trim();
        if (!loc || loc === 'india') return true;
        return cityLower.some(c => {
          if (c === 'delhi'     && (loc.includes('delhi') || loc.includes('ncr') || loc.includes('gurugram') || loc.includes('noida'))) return true;
          if (c === 'bengaluru' && (loc.includes('bengaluru') || loc.includes('bangalore'))) return true;
          return loc.includes(c);
        });
      });

      // Sort: watchlist → newest
      filtered.sort((a, b) => {
        if (a.isWatchlist && !b.isWatchlist) return -1;
        if (!a.isWatchlist && b.isWatchlist) return 1;
        return (b.job_posted_at_timestamp || 0) - (a.job_posted_at_timestamp || 0);
      });

      // Slim down for response
      const slim = filtered.slice(0, 25).map(j => ({
        job_id:                     j.job_id,
        job_title:                  j.job_title,
        employer_name:              j.employer_name,
        job_city:                   j.job_city,
        job_state:                  j.job_state,
        job_country:                j.job_country,
        job_is_remote:              j.job_is_remote,
        job_description:            (j.job_description || '').slice(0, 1200),
        job_apply_link:             j.job_apply_link,
        job_posted_at_datetime_utc: j.job_posted_at_datetime_utc,
        job_posted_at_timestamp:    j.job_posted_at_timestamp,
        isWatchlist:                j.isWatchlist,
        source:                     j.source || 'JSearch'
      }));

      return res.status(200).json({ jobs: slim, total: allJobs.length });
    }

    // ── SCRAPE URL ──────────────────────────────────────────────────────
    if (action === 'scrape') {
      const { url } = payload;
      const scraped = await scrapeJobURL(url);

      // Use Groq to extract structured job info from the scraped text
      const prompt = `Extract job details from this webpage text. Return ONLY JSON, no other text.

Page title: ${sanitize(scraped.pageTitle, 200)}
Page description: ${sanitize(scraped.pageDesc, 300)}
Page content: ${sanitize(scraped.fullText, 2000)}

Return ONLY this JSON:
{"job_title": "exact job title", "employer_name": "company name", "job_city": "city", "job_state": "state", "job_description": "full job description in 3-4 sentences", "job_apply_link": "${url}"}`;

      const raw    = await groq(prompt, 300);
      const parsed = extractJSON(raw);
      parsed.job_apply_link = url;
      parsed.job_posted_at_datetime_utc = new Date().toISOString();
      parsed.source = 'Manual';
      return res.status(200).json({ job: parsed });
    }

    // ── SCORE ───────────────────────────────────────────────────────────
    if (action === 'score') {
      const { resume, job, sectors, targetCompanies } = payload;
      const isTarget = (targetCompanies || []).some(c =>
        (job.employer_name || '').toLowerCase().includes(c.toLowerCase())
      );

      const prompt = `Score how well this candidate matches this job. Reply with ONLY a JSON object.

Candidate:
${sanitize(resume, 1000)}

Job:
Title: ${sanitize(job.job_title, 80)}
Company: ${sanitize(job.employer_name, 80)}
Location: ${sanitize(job.job_city, 60)}, ${sanitize(job.job_state, 60)}
Description: ${sanitize(job.job_description, 600)}
Preferred sectors: ${sanitize(sectors, 150)}
${isTarget ? 'This is a priority target company.' : ''}

Reply ONLY with this JSON (score must be a number):
{"score": 85, "match_tags": ["Tag 1", "Tag 2", "Tag 3"], "reason": "One honest sentence about fit or gap."}`;

      await sleep(800);
      const raw    = await groq(prompt, 150);
      const parsed = extractJSON(raw);
      if (typeof parsed.score !== 'number') parsed.score = parseInt(parsed.score) || 0;
      if (!Array.isArray(parsed.match_tags)) parsed.match_tags = [];
      return res.status(200).json(parsed);
    }

    // ── DRAFT ───────────────────────────────────────────────────────────
    if (action === 'draft') {
      const { resume, job, tone } = payload;

      const prompt = `Write a cold job application email. Reply with ONLY a JSON object, nothing else.

Candidate:
${sanitize(resume, 900)}

Role: ${sanitize(job.job_title, 80)} at ${sanitize(job.employer_name, 80)}, ${sanitize(job.job_city, 60)}
About the role: ${sanitize(job.job_description, 400)}

Rules: tone is ${tone}. 3 short paragraphs. Para 1 opens specifically about this company and role, never starts with 'I am writing'. Para 2 cites 1-2 achievements with numbers from candidate background. Para 3 asks for 20 minutes. Ends with name, phone, LinkedIn.

Subject line: specific, max 8 words.

Reply ONLY with this JSON:
{"subject": "subject line", "email": "paragraph 1. paragraph 2. paragraph 3. sign off"}`;

      await sleep(3000);
      const raw    = await groq(prompt, 450);
      const parsed = extractJSON(raw);
      if (!parsed.subject) parsed.subject = `Application — ${job.job_title}`;
      if (!parsed.email)   parsed.email   = 'Email generation failed. Click Rewrite to retry.';
      if (parsed.email)    parsed.email   = parsed.email.replace(/\\n/g, '\n');
      return res.status(200).json(parsed);
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
