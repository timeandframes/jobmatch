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

  // Sanitize text — remove control characters that break JSON
  function clean(text, maxLen) {
    return (text || '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
      .replace(/\\/g, ' ')
      .replace(/"/g, "'")
      .slice(0, maxLen)
      .trim();
  }

  async function groq(prompt, maxTokens = 400, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_KEY}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            max_tokens: maxTokens,
            temperature: 0.3,
            messages: [{ role: 'user', content: prompt }]
          })
        });
        const data = await r.json();
        if (data.error) {
          if (data.error.message && data.error.message.includes('Rate limit') && i < retries - 1) {
            await sleep(4000); // wait 4s then retry
            continue;
          }
          throw new Error('Groq: ' + data.error.message);
        }
        if (!data.choices?.[0]) throw new Error('Groq returned no choices');
        return data.choices[0].message.content;
      } catch (err) {
        if (i === retries - 1) throw err;
        await sleep(3000);
      }
    }
  }

  function parseJSON(raw) {
    const clean2 = raw.replace(/```json|```/g, '').trim();
    const start = clean2.indexOf('{');
    const end   = clean2.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON in response');
    return JSON.parse(clean2.slice(start, end + 1));
  }

  try {

    // ── SEARCH ────────────────────────────────────────────────────────
    if (action === 'search') {
      const { roles, cities, watchlist } = payload;

      // Search by role
      const roleSearches = roles.slice(0, 4).map(role => {
        const q = encodeURIComponent(`${role} India`);
        return fetch(
          `https://jsearch.p.rapidapi.com/search?query=${q}&num_pages=2&date_posted=week&country=in&language=en`,
          { headers: { 'x-rapidapi-key': JSEARCH_KEY, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' } }
        ).then(r => r.json()).catch(() => ({ data: [] }));
      });

      // Also search by watchlist company names
      const watchSearches = (watchlist || []).slice(0, 3).map(company => {
        const q = encodeURIComponent(`${company} India jobs`);
        return fetch(
          `https://jsearch.p.rapidapi.com/search?query=${q}&num_pages=1&date_posted=week&country=in&language=en`,
          { headers: { 'x-rapidapi-key': JSEARCH_KEY, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' } }
        ).then(r => r.json()).catch(() => ({ data: [] }));
      });

      const allResults = await Promise.all([...roleSearches, ...watchSearches]);

      const seen = new Set();
      let allJobs = [];
      for (const result of allResults) {
        for (const job of (result.data || [])) {
          if (!seen.has(job.job_id)) { seen.add(job.job_id); allJobs.push(job); }
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
      const filtered = allJobs.filter(job => {
        if (cities.includes('Remote') && job.job_is_remote) return true;
        const loc = [job.job_city || '', job.job_state || '', job.job_country || ''].join(' ').toLowerCase();
        if (!loc.trim() || loc.trim() === 'india') return true;
        return cityLower.some(c => {
          if (c === 'delhi' && (loc.includes('delhi') || loc.includes('ncr') || loc.includes('gurugram') || loc.includes('noida'))) return true;
          if (c === 'bengaluru' && (loc.includes('bengaluru') || loc.includes('bangalore'))) return true;
          return loc.includes(c);
        });
      });

      // Sort: watchlist first, then by date
      filtered.sort((a, b) => {
        if (a.isWatchlist && !b.isWatchlist) return -1;
        if (!a.isWatchlist && b.isWatchlist) return 1;
        return (b.job_posted_at_timestamp || 0) - (a.job_posted_at_timestamp || 0);
      });

      return res.status(200).json({ jobs: filtered.slice(0, 25) });
    }

    // ── SCORE ─────────────────────────────────────────────────────────
    if (action === 'score') {
      const { resume, job, sectors, targetCompanies } = payload;

      const isTarget = (targetCompanies || []).some(c =>
        (job.employer_name || '').toLowerCase().includes(c.toLowerCase())
      );

      const prompt = `Score how well this candidate matches this job. Return ONLY valid JSON, no other text.

CANDIDATE:
${clean(resume, 1500)}

JOB:
Title: ${clean(job.job_title, 100)}
Company: ${clean(job.employer_name, 100)}
Location: ${clean(job.job_city, 80)}, ${clean(job.job_state, 80)}
Description: ${clean(job.job_description, 800)}
Preferred sectors: ${clean(sectors, 200)}
${isTarget ? 'NOTE: This is a target company the candidate specifically wants to work at.' : ''}

Return ONLY this JSON:
{"score":<integer 0-100>,"match_tags":["tag1","tag2","tag3"],"reason":"One honest specific sentence."}`;

      await sleep(500); // small buffer between calls
      const raw = await groq(prompt, 180);
      return res.status(200).json(parseJSON(raw));
    }

    // ── DRAFT ─────────────────────────────────────────────────────────
    if (action === 'draft') {
      const { resume, job, tone } = payload;

      const prompt = `Write a cold outreach email. Tone: ${tone}. Return ONLY valid JSON, no other text.

CANDIDATE RESUME:
${clean(resume, 1200)}

JOB:
Title: ${clean(job.job_title, 100)}
Company: ${clean(job.employer_name, 100)}
Location: ${clean(job.job_city, 80)}, ${clean(job.job_state, 80)}
Description: ${clean(job.job_description, 600)}

EMAIL RULES:
1. Exactly 3 short paragraphs
2. First sentence must be specific to this company and role - NEVER start with "I am writing"
3. Para 2: 1-2 specific achievements with numbers from the resume relevant to this role
4. Para 3: ask "Would you have 20 minutes this week?"
5. Sign off with name, phone, LinkedIn from resume
6. Subject: compelling, specific, under 10 words

Return ONLY this JSON:
{"subject":"subject line here","email":"full email body here"}`;

      await sleep(2000); // wait 2s before draft to avoid rate limit
      const raw = await groq(prompt, 550);
      return res.status(200).json(parseJSON(raw));
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Error in /api/jobs:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
