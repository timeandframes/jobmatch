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

  // Aggressively clean text for JSON safety
  function sanitize(text, maxLen) {
    if (!text) return '';
    return text
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ') // control chars
      .replace(/\\/g, ' ')           // backslashes break JSON
      .replace(/"/g, "'")            // double quotes break JSON
      .replace(/\n/g, ' ')           // flatten newlines
      .replace(/\r/g, ' ')
      .replace(/\t/g, ' ')
      .replace(/\s{2,}/g, ' ')       // collapse whitespace
      .trim()
      .slice(0, maxLen);
  }

  // Call Groq with retry on rate limit
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
        if (msg.includes('Rate limit') || msg.includes('rate_limit')) {
          const waitMs = attempt === 0 ? 5000 : attempt === 1 ? 10000 : 20000;
          console.log(`Rate limit hit, waiting ${waitMs}ms...`);
          await sleep(waitMs);
          continue;
        }
        throw new Error('Groq error: ' + msg);
      }

      if (!data.choices?.[0]?.message?.content) {
        throw new Error('Groq returned empty response');
      }

      return data.choices[0].message.content;
    }
    throw new Error('Groq rate limit: too many retries. Wait 1 minute and try again.');
  }

  // Extract JSON robustly — handles preamble, markdown fences, trailing text
  function extractJSON(raw) {
    if (!raw) throw new Error('Empty response from AI');
    // Strip markdown fences
    let text = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    // Find first { and last }
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('No JSON object found in: ' + text.slice(0, 150));
    }
    const jsonStr = text.slice(start, end + 1);
    try {
      return JSON.parse(jsonStr);
    } catch(e) {
      // Try to fix common issues: unescaped quotes inside values
      const fixed = jsonStr
        .replace(/:\s*"([\s\S]*?)"\s*([,}])/g, (match, val, end) => {
          const safeVal = val.replace(/"/g, "'").replace(/\n/g, ' ');
          return `: "${safeVal}"${end}`;
        });
      try {
        return JSON.parse(fixed);
      } catch(e2) {
        throw new Error('Could not parse JSON: ' + jsonStr.slice(0, 200));
      }
    }
  }

  try {

    // ── SEARCH ────────────────────────────────────────────────────────
    if (action === 'search') {
      const { roles, cities, watchlist } = payload;

      // Search top 3 roles in parallel
      const roleSearches = roles.slice(0, 3).map(role => {
        const q = encodeURIComponent(`${role} India`);
        return fetch(
          `https://jsearch.p.rapidapi.com/search?query=${q}&num_pages=2&date_posted=week&country=in&language=en`,
          { headers: { 'x-rapidapi-key': JSEARCH_KEY, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' } }
        ).then(r => r.json()).catch(() => ({ data: [] }));
      });

      // Search watchlist companies
      const watchSearches = (watchlist || []).slice(0, 3).map(company => {
        const q = encodeURIComponent(`${company} creative jobs India`);
        return fetch(
          `https://jsearch.p.rapidapi.com/search?query=${q}&num_pages=1&date_posted=week&country=in&language=en`,
          { headers: { 'x-rapidapi-key': JSEARCH_KEY, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' } }
        ).then(r => r.json()).catch(() => ({ data: [] }));
      });

      const allResults = await Promise.all([...roleSearches, ...watchSearches]);

      // Deduplicate
      const seen = new Set();
      let allJobs = [];
      for (const result of allResults) {
        for (const job of (result.data || [])) {
          if (job.job_id && !seen.has(job.job_id)) {
            seen.add(job.job_id);
            allJobs.push(job);
          }
        }
      }

      // Mark watchlist hits
      const watchLower = (watchlist || []).map(c => c.toLowerCase());
      allJobs = allJobs.map(job => ({
        ...job,
        isWatchlist: watchLower.some(w => (job.employer_name || '').toLowerCase().includes(w))
      }));

      // City filter — keep if no city info, or city matches
      const cityLower = cities.map(c => c.toLowerCase());
      const filtered = allJobs.filter(job => {
        if (cities.includes('Remote') && job.job_is_remote) return true;
        const loc = [job.job_city || '', job.job_state || '', job.job_country || ''].join(' ').toLowerCase().trim();
        if (!loc || loc === 'india') return true;
        return cityLower.some(c => {
          if (c === 'delhi' && (loc.includes('delhi') || loc.includes('ncr') || loc.includes('gurugram') || loc.includes('noida'))) return true;
          if (c === 'bengaluru' && (loc.includes('bengaluru') || loc.includes('bangalore'))) return true;
          return loc.includes(c);
        });
      });

      // Watchlist first, then newest
      filtered.sort((a, b) => {
        if (a.isWatchlist && !b.isWatchlist) return -1;
        if (!a.isWatchlist && b.isWatchlist) return 1;
        return (b.job_posted_at_timestamp || 0) - (a.job_posted_at_timestamp || 0);
      });

      // Only send fields we need to keep payload small
      const slim = filtered.slice(0, 20).map(j => ({
        job_id: j.job_id,
        job_title: j.job_title,
        employer_name: j.employer_name,
        job_city: j.job_city,
        job_state: j.job_state,
        job_country: j.job_country,
        job_is_remote: j.job_is_remote,
        job_description: (j.job_description || '').slice(0, 1500),
        job_apply_link: j.job_apply_link,
        job_posted_at_datetime_utc: j.job_posted_at_datetime_utc,
        isWatchlist: j.isWatchlist
      }));

      return res.status(200).json({ jobs: slim });
    }

    // ── SCORE ─────────────────────────────────────────────────────────
    if (action === 'score') {
      const { resume, job, sectors, targetCompanies } = payload;

      const isTarget = (targetCompanies || []).some(c =>
        (job.employer_name || '').toLowerCase().includes(c.toLowerCase())
      );

      const prompt = `Score how well this candidate matches this job. Reply with ONLY a JSON object, no other text.

Candidate resume summary:
${sanitize(resume, 1200)}

Job details:
Title: ${sanitize(job.job_title, 80)}
Company: ${sanitize(job.employer_name, 80)}
Location: ${sanitize(job.job_city, 60)}, ${sanitize(job.job_state, 60)}
Description: ${sanitize(job.job_description, 700)}
${isTarget ? 'This is a target company the candidate specifically wants to work at.' : ''}

Preferred sectors: ${sanitize(sectors, 150)}

Reply with ONLY this JSON (integers only for score, no quotes around numbers):
{"score": 85, "match_tags": ["Creative Direction", "Brand Strategy", "Team Leadership"], "reason": "One honest sentence about the match."}`;

      await sleep(800);
      const raw = await groq(prompt, 150);
      const parsed = extractJSON(raw);
      // Validate
      if (typeof parsed.score !== 'number') parsed.score = parseInt(parsed.score) || 0;
      if (!Array.isArray(parsed.match_tags)) parsed.match_tags = [];
      if (!parsed.reason) parsed.reason = '';
      return res.status(200).json(parsed);
    }

    // ── DRAFT ─────────────────────────────────────────────────────────
    if (action === 'draft') {
      const { resume, job, tone } = payload;

      // Use a simpler prompt structure to avoid JSON parsing issues
      const prompt = `Write a cold job application email. Reply with ONLY a JSON object, no other text before or after.

Candidate:
${sanitize(resume, 1000)}

Applying for:
Title: ${sanitize(job.job_title, 80)}
Company: ${sanitize(job.employer_name, 80)}
Location: ${sanitize(job.job_city, 60)}, ${sanitize(job.job_state, 60)}
About the role: ${sanitize(job.job_description, 500)}

Email requirements:
- Tone: ${tone}
- 3 short paragraphs only
- Para 1: specific opening about this role at this company, never "I am writing to express"
- Para 2: 1-2 achievements with numbers from the candidate resume that match this role
- Para 3: simple ask - Would you have 20 minutes this week?
- End with: candidate name, phone, LinkedIn
- Subject line: specific and compelling, max 8 words

Reply with ONLY this JSON, use single quotes inside strings to avoid escaping:
{"subject": "subject line here", "email": "Para 1 text. Para 2 text. Para 3 text. Sign off."}`;

      await sleep(3000); // 3s gap before draft to respect rate limits
      const raw = await groq(prompt, 500);
      let parsed = extractJSON(raw);

      // Validate fields exist
      if (!parsed.subject) parsed.subject = `Application — ${job.job_title}`;
      if (!parsed.email) parsed.email = 'Could not generate email body.';

      // Convert \n literals to actual newlines for display
      if (parsed.email) parsed.email = parsed.email.replace(/\\n/g, '\n');

      return res.status(200).json(parsed);
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Error in /api/jobs:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
