// Vercel serverless function: server-side Gemini job-posting extractor.
// Keeps the Gemini API key out of the browser entirely.

const MAX_INPUT_CHARS = 15000;
const DEFAULT_MODEL = "gemini-3.5-flash";

const SYSTEM_PROMPT = `You are a smart job application parser. Analyze the given job posting text and extract structured key fields.
Return STRICT JSON format with keys:
- company (string)
- title (string)
- city (string, e.g. Amsterdam, Den Haag, Remote, etc.)
- lang (string, EN or NL or ID)
- source (string: Linkedin, Indeed, Glassdoor, or Career Site)
- salary (string, salary range if found, else empty string)
- summary (string, 1-2 sentence summary of requirements)
`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    company: { type: "STRING" },
    title: { type: "STRING" },
    city: { type: "STRING" },
    lang: { type: "STRING" },
    source: { type: "STRING" },
    salary: { type: "STRING" },
    summary: { type: "STRING" }
  },
  required: ["company", "title", "city", "lang"]
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is not configured with a Gemini API key." });
  }

  const body = req.body || {};
  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!text) {
    return res.status(400).json({ error: "Missing required field: text" });
  }
  if (text.length > MAX_INPUT_CHARS) {
    return res.status(413).json({ error: `Input text too large. Limit is ${MAX_INPUT_CHARS} characters.` });
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA
    }
  };

  let geminiResponse;
  try {
    geminiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return res.status(502).json({ error: "Failed to reach Gemini API." });
  }

  if (!geminiResponse.ok) {
    return res.status(502).json({ error: `Gemini API request failed with status ${geminiResponse.status}.` });
  }

  let data;
  try {
    data = await geminiResponse.json();
  } catch (err) {
    return res.status(502).json({ error: "Gemini API returned an invalid response." });
  }

  const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!jsonText) {
    return res.status(502).json({ error: "Gemini API response did not contain extracted data." });
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return res.status(502).json({ error: "Gemini API returned malformed JSON." });
  }

  return res.status(200).json({
    company: parsed.company || "",
    title: parsed.title || "",
    city: parsed.city || "",
    lang: parsed.lang || "",
    source: parsed.source || "",
    salary: parsed.salary || "",
    summary: parsed.summary || ""
  });
};
