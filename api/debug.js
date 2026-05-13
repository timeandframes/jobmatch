export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const SERP_KEY = process.env.SERP_KEY;
  const GROQ_KEY = process.env.GROQ_KEY;

  // Test 1: Check keys exist
  const keysPresent = {
    SERP_KEY: !!SERP_KEY,
    GROQ_KEY: !!GROQ_KEY,
    SERP_KEY_length: SERP_KEY?.length || 0,
    GROQ_KEY_length: GROQ_KEY?.length || 0
  };

  // Test 2: Hit SerpAPI
  let serpTest = {};
  try {
    const url = `https://serpapi.com/search?api_key=${SERP_KEY}&engine=google_jobs&q=Creative+Director+Mumbai&hl=en&gl=in&num=3`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) {
      serpTest = { ok: false, error: data.error };
    } else {
      serpTest = {
        ok: true,
        jobsFound: data.jobs_results?.length || 0,
        firstJob: data.jobs_results?.[0]?.title || 'none',
        credits: data.search_metadata?.status
      };
    }
  } catch(e) {
    serpTest = { ok: false, error: e.message };
  }

  // Test 3: Hit Groq
  let groqTest = {};
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say OK' }]
      })
    });
    const data = await r.json();
    groqTest = data.error
      ? { ok: false, error: data.error.message }
      : { ok: true, response: data.choices?.[0]?.message?.content };
  } catch(e) {
    groqTest = { ok: false, error: e.message };
  }

  return res.status(200).json({ keysPresent, serpTest, groqTest });
}
