export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, payload } = req.body;
  const SERP_KEY  = process.env.SERP_KEY;
  const GROQ_KEY  = process.env.GROQ_KEY;

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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_KEY}`
        },
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
    if (start === -1 || end === -1) throw new Error('No JSON in: ' + text.slice(0, 200));
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

  // ── Search Google Jobs via SerpAPI ─────────────────────────────────
  async function searchGoogleJobs(query, location, chips) {
    const params = new URLSearchParams({
      api_key:  SERP_KEY,
      engine:   'google_jobs',
      q:        query,
      location: location || 'India',
      hl:       'en',
      gl:       'in',
    });
    if (chips) params.set('chips', chips); // e.g. "date_posted:week"

    const url = `https://serpapi.com/search?${params.toString()}`;
    const r   = await fetch(url);
    const data = await r.json();

    if (data.error) throw new Error('SerpAPI: ' + data.error);

    return (data.jobs_results || []).map(job => ({
      job_id:                     job.job_id || sanitize(job.title + job.company_name, 40),
      job_title:                  job.title || '',
      employer_name:              job.company_name || '',
      job_city:                   (job.location || '').split(',')[0]?.trim() || '',
      job_state:                  (job.location || '').split(',')[1]?.trim() || '',
      job_country:                'India',
      job_description:            (job.description || ''),
      job_apply_link:             job.related_links?.[0]?.link || job.share_link || '',
      job_posted_at_datetime_utc: job.detected_extensions?.posted_at
                                    ? new Date(job.detected_extensions.posted_at).toISOString()
                                    : null,
      job_posted_at_timestamp:    job.detected_extensions?.posted_at
                                    ? new Date(job.detected_extensions.posted_at).getTime() / 1000
                                    : 0,
      job_is_remote:              /remote/i.test(job.title + (job.location || '')),
      job_highlights:             job.job_highlights || [],
      via:                        job.via || '',
      source:                     job.via || 'Google Jobs',
      isWatchlist:                false
    }));
  }

  // ── Scrape a job URL ───────────────────────────────────────────────
  async function scrapeURL(url) {
    // Use SerpAPI to scrape structured data from the URL
    const params = new URLSearchParams({
      api_key: SERP_KEY,
      engine:  'google_jobs_listing',
      q:       url
    });

    try {
      const r    = await fetch(`https://serpapi.com/search?${params.toString()}`);
      const data = await r.json();
      if (data.jobs_results?.[0]) return data.jobs_results[0];
    } catch(e) {}

    // Fallback: fetch the page directly and extract text
    const r    = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobBot/1.0)', 'Accept': 'text/html' }
    });
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, ' ').trim();

    const titleM = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
                   html.match(/<title[^>]*>([^<|–-]+)/i);

    return {
      title:        (titleM?.[1] || '').replace(/\s*[-|–].*$/, '').trim(),
      company_name: '',
      location:     'India',
      description:  text.slice(0, 3000)
    };
  }

  try {

    // ── SEARCH ──────────────────────────────────────────────────────────
    if (action === 'search') {
      const { roles, cities, watchlist, targetCompanies } = payload;

      // Build search queries — role combinations + city
      const queries = [];

      // Top 3 roles × top 2 cities
      for (const role of roles.slice(0, 3)) {
        for (const city of cities.slice(0, 2)) {
          queries.push({ q: `${role} ${city} India`, loc: city });
        }
      }

      // Target companies — search each directly
      for (const company of (targetCompanies || []).slice(0, 4)) {
        queries.push({ q: `jobs at ${company} India`, loc: 'India' });
      }

      // Watchlist companies
      for (const company of (watchlist || []).slice(0, 3)) {
        queries.push({ q: `${company} India jobs`, loc: 'India' });
      }

      // Run all searches in parallel (SerpAPI handles rate limits)
      const results = await Promise.all(
        queries.map(({ q, loc }) =>
          searchGoogleJobs(q, loc, 'date_posted:week').catch(e => {
            console.log(`Search failed for "${q}":`, e.message);
            return [];
          })
        )
      );

      // Deduplicate
      const seen    = new Set();
      let   allJobs = [];
      for (const batch of results) {
        for (const job of batch) {
          const key = job.job_id || (job.job_title + job.employer_name);
          if (!seen.has(key)) {
            seen.add(key);
            allJobs.push(job);
          }
        }
      }

      // Mark watchlist + target company hits
      const watchLower  = (watchlist || []).map(c => c.toLowerCase());
      const targetLower = (targetCompanies || []).map(c => c.toLowerCase());
      allJobs = allJobs.map(job => ({
        ...job,
        isWatchlist:  watchLower.some(w  => (job.employer_name || '').toLowerCase().includes(w)),
        isTarget:     targetLower.some(t => (job.employer_name || '').toLowerCase().includes(t))
      }));

      // City filter
      const cityLower = cities.map(c => c.toLowerCase());
      const filtered  = allJobs.filter(job => {
        if (cities.includes('Remote') && job.job_is_remote) return true;
        const loc = [job.job_city, job.job_state, job.job_country].join(' ').toLowerCase().trim();
        if (!loc || loc === 'india') return true;
        return cityLower.some(c => {
          if (c === 'delhi'     && (loc.includes('delhi') || loc.includes('ncr') || loc.includes('gurugram') || loc.includes('noida'))) return true;
          if (c === 'bengaluru' && (loc.includes('bengaluru') || loc.includes('bangalore'))) return true;
          return loc.includes(c);
        });
      });

      // Sort: watchlist → target → newest
      filtered.sort((a, b) => {
        if (a.isWatchlist && !b.isWatchlist) return -1;
        if (!a.isWatchlist && b.isWatchlist) return 1;
        if (a.isTarget && !b.isTarget) return -1;
        if (!a.isTarget && b.isTarget) return 1;
        return (b.job_posted_at_timestamp || 0) - (a.job_posted_at_timestamp || 0);
      });

      // Slim + send
      const slim = filtered.slice(0, 30).map(j => ({
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
        isTarget:                   j.isTarget,
        source:                     j.source || 'Google Jobs',
        via:                        j.via || ''
      }));

      return res.status(200).json({ jobs: slim, total: allJobs.length });
    }

    // ── SCRAPE URL ──────────────────────────────────────────────────────
    if (action === 'scrape') {
      const { url } = payload;
      const raw = await scrapeURL(url);

      // Extract structured data using Groq
      const prompt = `Extract job details from this content. Return ONLY JSON, no other text.

Title hint: ${sanitize(raw.title || '', 150)}
Company hint: ${sanitize(raw.company_name || '', 100)}
Content: ${sanitize(raw.description || '', 2000)}
URL: ${url}

Return ONLY this JSON:
{"job_title": "job title", "employer_name": "company", "job_city": "city", "job_state": "state", "job_description": "description in 3-5 sentences summarizing responsibilities and requirements"}`;

      const groqRaw = await groq(prompt, 300);
      const parsed  = extractJSON(groqRaw);
      parsed.job_apply_link             = url;
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

      const prompt = `Score candidate-job match. Reply with ONLY JSON.

Candidate:
${sanitize(resume, 1000)}

Job:
Title: ${sanitize(job.job_title, 80)}
Company: ${sanitize(job.employer_name, 80)} ${isTarget ? '(priority target company)' : ''}
Location: ${sanitize(job.job_city, 60)}, ${sanitize(job.job_state, 60)}
Description: ${sanitize(job.job_description, 600)}
Preferred sectors: ${sanitize(sectors, 150)}

Reply ONLY with this JSON (score is a number 0-100):
{"score": 85, "match_tags": ["Tag 1", "Tag 2", "Tag 3"], "reason": "One honest specific sentence."}`;

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

      const prompt = `Write a cold job application email. Reply with ONLY JSON, nothing else before or after.

Candidate:
${sanitize(resume, 900)}

Role: ${sanitize(job.job_title, 80)} at ${sanitize(job.employer_name, 80)}, ${sanitize(job.job_city, 60)}
Role description: ${sanitize(job.job_description, 400)}

Email rules:
- Tone: ${tone}
- Exactly 3 short paragraphs
- Para 1: specific to this company and role, never starts with 'I am writing'
- Para 2: 1-2 achievements with numbers from candidate that match this role
- Para 3: asks for 20 minutes this week
- Ends with: name, phone number, LinkedIn URL
- Subject: specific and compelling, max 8 words

Reply ONLY with this JSON:
{"subject": "compelling subject line", "email": "para 1 text. para 2 text. para 3 text. sign off with name and contact"}`;

      await sleep(3000);
      const raw    = await groq(prompt, 500);
      const parsed = extractJSON(raw);
      if (!parsed.subject) parsed.subject = `Application — ${job.job_title}`;
      if (!parsed.email)   parsed.email   = 'Click Rewrite to regenerate.';
      parsed.email = parsed.email.replace(/\\n/g, '\n');
      return res.status(200).json(parsed);
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
