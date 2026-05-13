export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, payload } = req.body;

  const JSEARCH_KEY = process.env.JSEARCH_KEY;
  const GROQ_KEY    = process.env.GROQ_KEY;

  async function groq(system, user, maxTokens = 400) {
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
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user   }
        ]
      })
    });
    const data = await r.json();
    if (!data.choices?.[0]) throw new Error('Groq API error: ' + JSON.stringify(data));
    return data.choices[0].message.content;
  }

  function parseJSON(raw) {
    const clean = raw.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{');
    const end   = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON in response');
    return JSON.parse(clean.slice(start, end + 1));
  }

  try {

    // SEARCH
    if (action === 'search') {
      const { roles, cities } = payload;

      const searches = roles.slice(0, 4).map(role => {
        const q = encodeURIComponent(`${role} India`);
        return fetch(
          `https://jsearch.p.rapidapi.com/search?query=${q}&num_pages=2&date_posted=week&country=in&language=en`,
          {
            headers: {
              'x-rapidapi-key': JSEARCH_KEY,
              'x-rapidapi-host': 'jsearch.p.rapidapi.com'
            }
          }
        ).then(r => r.json()).catch(() => ({ data: [] }));
      });

      const results = await Promise.all(searches);

      const seen = new Set();
      let allJobs = [];
      for (const result of results) {
        for (const job of (result.data || [])) {
          if (!seen.has(job.job_id)) {
            seen.add(job.job_id);
            allJobs.push(job);
          }
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
      return res.status(200).json({ jobs: filtered.slice(0, 25), total: allJobs.length });
    }

    // SCORE
    if (action === 'score') {
      const { resume, job, sectors } = payload;
      const jd = `Title: ${job.job_title}\nCompany: ${job.employer_name}\nLocation: ${job.job_city || ''}, ${job.job_state || ''}\nDescription: ${(job.job_description || '').slice(0, 1800)}`;
      const system = `You are a career analyst. Score how well this candidate matches this job.\nReturn ONLY valid JSON, nothing else, no markdown:\n{"score":<integer 0-100>,"match_tags":["tag 1","tag 2","tag 3"],"reason":"One honest specific sentence about the match or gap."}\nScoring: 90-100=near-perfect. 75-89=strong. 60-74=decent. Below 60=weak. Be honest, do not inflate.`;
      const raw = await groq(system, `RESUME:\n${resume}\n\nJOB:\n${jd}\n\nPreferred sectors: ${sectors}`, 250);
      return res.status(200).json(parseJSON(raw));
    }

    // DRAFT
    if (action === 'draft') {
      const { resume, job, tone } = payload;
      const system = `You are an expert career copywriter. Write a cold outreach email from this candidate to the hiring manager.\nTone: ${tone}.\nRules:\n- Exactly 3 short paragraphs\n- Open with something specific to this company/role — NEVER "I am writing to express my interest"\n- Para 2: cite 1-2 specific quantified achievements from the resume relevant to THIS role\n- Para 3: one clear low-friction ask like "Would you have 20 minutes this week?"\n- Sign off with candidate name, phone, LinkedIn URL\n- Subject line: specific and compelling, under 10 words\n- Sound like a sharp human, not a template\n\nReturn ONLY valid JSON, nothing else, no markdown:\n{"subject":"subject here","email":"full email body with real newlines"}`;
      const user = `RESUME:\n${resume}\n\nJOB:\nTitle: ${job.job_title}\nCompany: ${job.employer_name}\nLocation: ${job.job_city || ''}, ${job.job_state || ''}\nDescription: ${(job.job_description || '').slice(0, 1200)}`;
      const raw = await groq(system, user, 700);
      return res.status(200).json(parseJSON(raw));
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
