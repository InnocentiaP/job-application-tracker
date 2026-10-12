// Vercel serverless function: compiles a single, self-contained LaTeX document to PDF.
// The browser inlines all \input{} files from the user's template before sending, so we only
// forward one document.tex to the public TeX Live service at texlive.net (no CORS there,
// hence this proxy). Success returns the PDF bytes; failure returns the LaTeX log as JSON.

const COMPILE_URL = "https://texlive.net/cgi-bin/latexcgi";
const MAX_SOURCE_CHARS = 300000;
const MAX_LOG_CHARS = 100000;
const ALLOWED_ENGINES = ["pdflatex", "xelatex", "lualatex"];

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const source = typeof body.source === "string" ? body.source : "";
  const engine = ALLOWED_ENGINES.includes(body.engine) ? body.engine : "pdflatex";

  if (!source.trim()) {
    return res.status(400).json({ error: "Missing required field: source" });
  }
  if (source.length > MAX_SOURCE_CHARS) {
    return res.status(413).json({ error: `LaTeX source too large. Limit is ${MAX_SOURCE_CHARS} characters.` });
  }

  const form = new FormData();
  form.append("filecontents[]", source);
  form.append("filename[]", "document.tex");
  form.append("engine", engine);
  form.append("return", "pdf");

  let compileResponse;
  try {
    // texlive.net answers with a redirect to either document.pdf (success) or document.log (failure).
    compileResponse = await fetch(COMPILE_URL, { method: "POST", body: form, redirect: "follow" });
  } catch (err) {
    return res.status(502).json({ error: "Failed to reach the LaTeX compile service." });
  }

  if (!compileResponse.ok) {
    return res.status(502).json({ error: `LaTeX compile service failed with status ${compileResponse.status}.` });
  }

  const contentType = compileResponse.headers.get("content-type") || "";
  if (contentType.includes("application/pdf")) {
    const pdf = Buffer.from(await compileResponse.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(pdf);
  }

  const log = await compileResponse.text();
  return res.status(422).json({
    error: "LaTeX compilation failed.",
    log: log.length > MAX_LOG_CHARS ? log.slice(-MAX_LOG_CHARS) : log
  });
};
