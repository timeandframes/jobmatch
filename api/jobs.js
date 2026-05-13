export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, payload } = req.body;
  const JSEARCH_KEY = process.env.JSEARCH_KEY;
  const GROQ_KEY    = process.env.GROQ_KEY;

  async function groq(messages, maxTokens = 500) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: maxTokens,
        temperature: 0.4,
        messages
      })
    });
    const data = await r.json();
    if (data.error) throw new Error('Groq: ' + data.error.message);
    if (!data.choices?.[0]) throw new Error('Groq returned no choices');
    return data.choices[0].message.content;
  }

  function parseJSON(raw) {
    const clean = raw.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{');
    const end   = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON in Groq response: ' + clean.slice(0, 200));
    return JSON.parse(clean.slice(start, end + 1));
  }

  // Trim resume to first 2000 chars to stay within token limits
  function trimResume(text) {
    return (text || '').slice(0, 2000);
  }

  try {

    // ── SEARCH ────────────────────────────────────────────────────────
    if (action === 'search') {
      const { roles, cities } = payload;

      const searches = roles.slice(0, 4).map(role => {
        const q = encodeURIComponent(`${role} India`);
        return fetch(
          `https://jsearch.p.rapidapi.com/search?query=${q}&num_pages=2&date_posted=week&country=in&language=en`,
          { headers: { 'x-rapidapi-key': JSEARCH_KEY, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' } }
        ).then(r => r.json()).catch(() => ({ data: [] }));
      });

      const results = await Promise.all(searches);

      const seen = new Set();
      let allJobs = [];
      for (const result of results) {
        for (const job of (result.data || [])) {
          if (!seen.has(job.job_id)) { seen.add(job.job_id); allJobs.push(job); }
        }
      }

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

      filtered.sort((a, b) => (b.job_posted_at_timestamp || 0) - (a.job_posted_at_timestamp || 0));
      return res.status(200).json({ jobs: filtered.slice(0, 25) });
    }

    // ── SCORE ─────────────────────────────────────────────────────────
    if (action === 'score') {
      const { resume, job, sectors } = payload;

      const prompt = `RESUME (summary):
${trimResume(resume)}

JOB:
Title: ${job.job_title}
Company: ${job.employer_name}
Location: ${job.job_city || ''}, ${job.job_state || ''}
Description: ${(job.job_description || '').slice(0, 1000)}

Preferred sectors: ${sectors}

Score this match and return ONLY this JSON, nothing else:
{"score":<0-100>,"match_tags":["tag1","tag2","tag3"],"reason":"One honest sentence."}`;

      const raw = await groq([{ role: 'user', content: prompt }], 200);
      return res.status(200).json(parseJSON(raw));
    }

    // ── DRAFT ─────────────────────────────────────────────────────────
    if (action === 'draft') {
      const { resume, job, tone } = payload;

      const prompt = `You are writing a cold outreach email. Tone: ${tone}.

CANDIDATE RESUME:
${trimResume(resume)}

JOB THEY ARE APPLYING TO:
Title: ${job.job_title}
Company: ${job.employer_name}
Location: ${job.job_city || ''}, ${job.job_state || ''}
Description: ${(job.job_description || '').slice(0, 800)}

Write the email following these rules:
1. Exactly 3 short paragraphs
2. First line must be specific to this company and role — never "I am writing to express my interest"
3. Paragraph 2: mention 1-2 specific achievements with numbers from the resume relevant to this role
4. Paragraph 3: simple ask — "Would you have 20 minutes this week?"
5. Sign off: candidate name, phone number, LinkedIn URL from resume
6. Subject line: compelling, specific, under 10 words

Return ONLY this JSON and nothing else:
{"subject":"subject line","email":"full email body"}`;

      const raw = await groq([{ role: 'user', content: prompt }], 600);
      return res.status(200).json(parseJSON(raw));
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Error in /api/jobs:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
