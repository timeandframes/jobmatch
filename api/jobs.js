export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, payload } = req.body;

  const JSEARCH_KEY = process.env.JSEARCH_KEY;
  const CLAUDE_KEY  = process.env.CLAUDE_KEY;

  try {

    // ── Search jobs via JSearch ────────────────────────────────────
    if (action === 'search') {
      const { query, cities } = payload;
      const q = encodeURIComponent(query);
      const url = `https://jsearch.p.rapidapi.com/search?query=${q}&num_pages=3&date_posted=today&country=in&language=en`;

      const r = await fetch(url, {
        headers: {
          'x-rapidapi-key': JSEARCH_KEY,
          'x-rapidapi-host': 'jsearch.p.rapidapi.com'
        }
      });

      const data = await r.json();
      if (!data.data) return res.status(200).json({ jobs: [] });

      const cityLower = cities.map(c => c.toLowerCase());
      const filtered = data.data.filter(job => {
        const loc = [job.job_city, job.job_state, job.job_country].join(' ').toLowerCase();
        if (cities.includes('Remote') && job.job_is_remote) return true;
        return cityLower.some(c => loc.includes(c));
      });

      return res.status(200).json({ jobs: filtered.slice(0, 20) });
    }

    // ── Score a job via Claude ─────────────────────────────────────
    if (action === 'score') {
      const { resume, job, sectors } = payload;
      const jd = `Title: ${job.job_title}\nCompany: ${job.employer_name}\nLocation: ${job.job_city||''}, ${job.job_state||''}\nDescription: ${(job.job_description||'').slice(0, 1800)}`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          system: `Score how well this candidate's resume matches the job. Return ONLY valid JSON, no markdown:
{"score":<0-100>,"match_tags":["tag1","tag2","tag3"],"reason":"One honest sentence."}
90-100=near-perfect. 75-89=strong. 60-74=decent. Below 60=weak. Be honest, don't inflate.`,
          messages: [{ role: 'user', content: `RESUME:\n${resume}\n\nJOB:\n${jd}\n\nPreferred sectors: ${sectors}` }]
        })
      });

      const data = await r.json();
      const text = data.content?.[0]?.text || '{}';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return res.status(200).json(parsed);
    }

    // ── Draft email via Claude ─────────────────────────────────────
    if (action === 'draft') {
      const { resume, job, tone } = payload;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          system: `Write a cold outreach email from this candidate to the hiring manager. Tone: ${tone}.
Rules: 3 tight paragraphs. Open specifically about THIS role/company — NOT "I am writing to express my interest". Para 2: cite 1-2 specific achievements from the resume relevant to THIS role. Para 3: clear low-friction ask. Sign off with name and contact. Sound human, not templated. Subject: compelling, under 10 words.
Return ONLY valid JSON: {"subject":"...","email":"full body with real newlines"}`,
          messages: [{ role: 'user', content: `RESUME:\n${resume}\n\nJOB:\nTitle: ${job.job_title}\nCompany: ${job.employer_name}\nLocation: ${job.job_city||''}, ${job.job_state||''}\nDescription: ${(job.job_description||'').slice(0, 1000)}` }]
        })
      });

      const data = await r.json();
      const text = data.content?.[0]?.text || '{}';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return res.status(200).json(parsed);
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
