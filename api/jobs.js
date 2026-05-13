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
    if (start === -1 || end === -1) throw new Error('No JSON found in response');
    return JSON.parse(clean.slice(start, end + 1));
  }

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

    // ── Score job ─────────────────────────────────────────────────────
    if (action === 'score') {
      const { resume, job, sectors } = payload;
      const jd = `Title: ${job.job_title}
Company: ${job.employer_name}
Location: ${job.job_city || ''}, ${job.job_state || ''}
Description: ${(job.job_description || '').slice(0, 1800)}`;

      const system = `You are a career analyst. Score how well this candidate's resume matches the job posting.
Return ONLY valid JSON with no extra text, no markdown, no explanation:
{"score":<integer 0-100>,"match_tags":["short tag","short tag","short tag"],"reason":"One honest sentence explaining the match or gap."}
Scoring guide: 90-100=near-perfect match. 75-89=strong match. 60-74=decent match. Below 60=weak match. Be honest and specific, do not inflate scores.`;

      const user = `RESUME:\n${resume}\n\nJOB:\n${jd}\n\nCandidate's preferred sectors: ${sectors}`;
      const raw  = await groq(system, user, 300);
      const parsed = parseJSON(raw);
      return res.status(200).json(parsed);
    }

    // ── Draft email ───────────────────────────────────────────────────
    if (action === 'draft') {
      const { resume, job, tone } = payload;

      const system = `You are an expert career copywriter. Write a cold outreach email from this candidate to the hiring manager.
Tone: ${tone}.
Rules:
- Exactly 3 short paragraphs
- Opening must be specific to this company and role — never start with "I am writing to express my interest"
- Paragraph 2: mention 1-2 specific, quantified achievements from the resume that directly apply to this role
- Paragraph 3: one clear, low-friction ask — e.g. "Would you have 20 minutes this week?"
- Sign off: candidate name, phone, LinkedIn
- Subject line: compelling and specific, under 10 words
- Sound like a real person, not a template

Return ONLY valid JSON with no extra text, no markdown:
{"subject":"subject line here","email":"full email body here with real newlines"}`;

      const user = `RESUME:\n${resume}\n\nJOB:\nTitle: ${job.job_title}\nCompany: ${job.employer_name}\nLocation: ${job.job_city || ''}, ${job.job_state || ''}\nDescription: ${(job.job_description || '').slice(0, 1200)}`;

      const raw    = await groq(system, user, 700);
      const parsed = parseJSON(raw);
      return res.status(200).json(parsed);
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
