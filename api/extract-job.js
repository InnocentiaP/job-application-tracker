// Vercel serverless function: server-side job-posting extractor.
// Accepts pasted/uploaded text, a job posting URL, or both. URLs are fetched here (the browser
// can't, because of CORS), and the page text goes to Gemini. Keeps the Gemini API key out of the
// browser entirely. If Gemini fails, schema.org JobPosting data embedded in the page is used.

const dns = require("dns").promises;
const net = require("net");

const MAX_INPUT_CHARS = 15000;
const DEFAULT_MODEL = "gemini-3.5-flash";
const DEFAULT_FALLBACK_MODELS = "gemini-3.5-flash-lite,gemini-flash-latest";
const PAGE_TIMEOUT_MS = 10000;
const GEMINI_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 4;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const JOB_BOARDS = [
  [/(^|\.)linkedin\./i, "Linkedin"],
  [/(^|\.)indeed\./i, "Indeed"],
  [/(^|\.)glassdoor\./i, "Glassdoor"]
];

const SYSTEM_PROMPT = `You are a smart job application parser. Analyze the given job posting and extract structured key fields.
Return STRICT JSON format with keys:
- company (string, the hiring company, not the job board)
- title (string, the job title only)
- city (string, just the city name, e.g. Amsterdam, Den Haag, or "Remote")
- lang (string, the language the posting is written in or requires: EN or NL or ID)
- source (string: Linkedin, Indeed, Glassdoor, or Career Site)
- salary (string, the salary or salary range exactly as stated, including currency and period such as per month or per year, else empty string)
- summary (string, 1-2 sentence summary of requirements)
- url (string, the job posting URL if it appears in the text, e.g. in a printed page header or footer, else empty string)
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
    summary: { type: "STRING" },
    url: { type: "STRING" }
  },
  required: ["company", "title", "city", "lang", "salary", "summary", "url"]
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function boardFor(hostname) {
  const match = JOB_BOARDS.find(([re]) => re.test(hostname));
  return match ? match[1] : null;
}

// LinkedIn job pages need a login, but the guest endpoint serves the same posting publicly.
function linkedinJobId(url) {
  if (!/(^|\.)linkedin\./i.test(url.hostname)) return null;
  const fromPath = url.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})/);
  return (fromPath && fromPath[1]) || url.searchParams.get("currentJobId") || null;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

// Only fetch public http(s) hosts, so the function can't be pointed at internal addresses.
async function assertPublicUrl(url) {
  if (!["http:", "https:"].includes(url.protocol)) throw new HttpError(400, "Only http(s) links are supported.");
  if (url.port && !["80", "443"].includes(url.port)) throw new HttpError(400, "That link uses an unsupported port.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch (err) {
    throw new HttpError(400, `Couldn't find the website ${url.hostname}.`);
  }
  if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) {
    throw new HttpError(400, "That link points to a private address.");
  }
}

async function fetchPage(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    let response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en,nl;q=0.8" }
      });
    } catch (err) {
      throw new HttpError(502, "Couldn't open that link (the site didn't respond).");
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = new URL(response.headers.get("location"), url);
      continue;
    }
    if (!response.ok) {
      throw new HttpError(502, `The site refused the request (HTTP ${response.status}). It probably blocks bots — save the page as PDF and upload it instead.`);
    }
    return await response.text();
  }
  throw new HttpError(502, "That link redirected too many times.");
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function metaContent(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i");
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : "";
}

// Most career sites embed a schema.org JobPosting for Google Jobs; it's the most reliable source.
function findJobPosting(html) {
  const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const block of blocks) {
    let data;
    try { data = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/gi, "")); } catch (err) { continue; }
    const queue = [data];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) { queue.push(...node); continue; }
      const type = [].concat(node["@type"] || []);
      if (type.includes("JobPosting")) return node;
      if (node["@graph"]) queue.push(node["@graph"]);
    }
  }
  return null;
}

function jobPostingFields(jp) {
  const org = [].concat(jp.hiringOrganization || [])[0];
  const loc = [].concat(jp.jobLocation || [])[0];
  const address = loc && loc.address;
  const remote = /TELECOMMUTE/i.test(jp.jobLocationType || "");
  const salary = jp.baseSalary && jp.baseSalary.value;
  let salaryText = "";
  if (salary && typeof salary === "object") {
    const range = [salary.minValue, salary.maxValue].filter(v => v != null).join(" - ") || salary.value || "";
    if (range) salaryText = `${jp.baseSalary.currency || ""} ${range}${salary.unitText ? ` per ${salary.unitText.toLowerCase()}` : ""}`.trim();
  }
  return {
    title: typeof jp.title === "string" ? decodeEntities(jp.title).trim() : "",
    company: (typeof org === "string" ? org : (org && org.name)) || "",
    city: (address && typeof address === "object" && address.addressLocality) || (remote ? "Remote" : ""),
    salary: salaryText,
    description: typeof jp.description === "string" ? htmlToText(jp.description) : ""
  };
}

async function readPage(url) {
  const jobId = linkedinJobId(url);
  const pageUrl = jobId ? new URL(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`) : url;
  const html = await fetchPage(pageUrl);
  const jp = findJobPosting(html);
  const structured = jp ? jobPostingFields(jp) : null;
  const header = [
    `Page URL: ${url.href}`,
    metaContent(html, "og:site_name") && `Site: ${metaContent(html, "og:site_name")}`,
    (metaContent(html, "og:title") || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]) &&
      `Page title: ${decodeEntities(metaContent(html, "og:title") || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)[1]).trim()}`,
    structured && `Structured data: title=${structured.title}; company=${structured.company}; city=${structured.city}; salary=${structured.salary}`
  ].filter(Boolean).join("\n");
  const body = structured && structured.description ? structured.description : htmlToText(html);
  return {
    text: `${header}\n\n${body}`.slice(0, MAX_INPUT_CHARS),
    structured,
    canonicalUrl: jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : url.href
  };
}

// Busy/rate-limited models (503/429) are common, so retry once and then try the fallback models.
const RETRYABLE = [429, 500, 503];

function geminiModels() {
  const clean = v => v.trim().replace(/^"|"$/g, "");
  const primary = clean(process.env.GEMINI_MODEL || DEFAULT_MODEL);
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS || DEFAULT_FALLBACK_MODELS).split(",").map(clean).filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

async function callGemini(model, apiKey, text) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA }
      })
    });
  } catch (err) {
    const e = new HttpError(502, `Failed to reach Gemini (${model}).`);
    e.retryable = true;
    throw e;
  }
  if (!response.ok) {
    let detail = "";
    try { detail = ((await response.json()).error || {}).message || ""; } catch (err) { /* keep generic */ }
    const e = new HttpError(502, `Gemini (${model}) failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    // 404 = model retired by Google; move on to the next model instead of failing
    e.retryable = RETRYABLE.includes(response.status) || response.status === 404;
    throw e;
  }
  const data = await response.json().catch(() => null);
  const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!jsonText) throw new HttpError(502, "Gemini API response did not contain extracted data.");
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    throw new HttpError(502, "Gemini API returned malformed JSON.");
  }
}

async function askGemini(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new HttpError(500, "Server is not configured with a Gemini API key.");
  const models = geminiModels();
  const attempts = [models[0], ...models];
  let lastError;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return await callGemini(attempts[i], apiKey, text);
    } catch (err) {
      lastError = err;
      if (!err.retryable) throw err;
      if (i === 0) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastError;
}

function parseUrl(value) {
  if (!value) return null;
  try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); } catch (err) { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  let text = typeof body.text === "string" ? body.text.trim() : "";
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  const inputUrl = parseUrl(rawUrl);

  if (!text && !rawUrl) {
    return res.status(400).json({ error: "Paste a job link or job text, or upload a file." });
  }
  if (rawUrl && !inputUrl) {
    return res.status(400).json({ error: "That doesn't look like a valid link." });
  }
  if (text.length > MAX_INPUT_CHARS) {
    return res.status(413).json({ error: `Input text too large. Limit is ${MAX_INPUT_CHARS} characters.` });
  }

  try {
    let structured = null;
    let linkUrl = inputUrl ? inputUrl.href : "";
    // Text (pasted or from an uploaded PDF) wins over fetching; the link is then only recorded.
    if (!text) {
      const page = await readPage(inputUrl);
      text = page.text;
      structured = page.structured;
      linkUrl = page.canonicalUrl;
    }

    let parsed;
    let via = "gemini";
    let warning = "";
    try {
      parsed = await askGemini(text);
    } catch (err) {
      if (!(structured && structured.title)) throw err;
      parsed = { ...structured, summary: structured.description.slice(0, 220) };
      via = "structured";
      warning = err.message;
    }

    // A URL printed in the text is taken verbatim; Gemini's copy can pick up neighbouring text
    if (!linkUrl) {
      const candidate = (text.match(/https?:\/\/[^\s"'<>]+/g) || [])
        .map(u => u.replace(/[).,;]+$/, ""))
        .find(u => /job|vacanc|vacature|career/i.test(u)) || String(parsed.url || "").split(/\s/)[0];
      const found = parseUrl(candidate);
      if (found && /^https?:$/.test(found.protocol)) linkUrl = found.href;
    }
    const board = linkUrl ? boardFor(new URL(linkUrl).hostname) : null;
    const source = board || (linkUrl ? "Career Site" : (parsed.source || ""));

    return res.status(200).json({
      company: parsed.company || "",
      title: parsed.title || "",
      city: parsed.city || "",
      lang: parsed.lang || "",
      source,
      salary: parsed.salary || "",
      summary: parsed.summary || "",
      postingUrl: board ? linkUrl : "",
      careerSiteUrl: linkUrl && !board ? linkUrl : "",
      via,
      warning
    });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return res.status(status).json({ error: err.message || "Extraction failed." });
  }
};
