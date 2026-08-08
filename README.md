# Job Application Tracker

A personal Job Application Tracker & Command Center: dashboard, table/Kanban application views,
status tracking with a task checklist, an Industry Target Directory, a Document Vault (links to
CVs/cover letters/portfolios), and an AI Smart Extractor that pulls structured fields out of a
pasted or uploaded job posting.

The app is a single static page ([index.html](index.html)) with one small server-side API route
([api/extract-job.js](api/extract-job.js)) that proxies requests to the Gemini API so the API key
never reaches the browser.

## Architecture

- **Frontend**: `index.html` — vanilla JS, Tailwind CSS, Chart.js, Lucide icons, and PDF.js, all
  loaded from CDNs. No build step, no framework.
- **Backend**: `api/extract-job.js` — a single Vercel serverless function. It's the only piece of
  server-side code in the project.
- **Persistence**: browser `localStorage` only (see below). There is no database in this phase.

## Local development

You need [Node.js 18+](https://nodejs.org/) and the [Vercel CLI](https://vercel.com/cli) to run
the serverless API route locally (`npx vercel` works too, no global install required).

1. Copy the environment template and fill in your Gemini API key:
   ```
   cp .env.example .env
   ```
2. Edit `.env`:
   ```
   GEMINI_API_KEY=your-real-key-here
   GEMINI_MODEL=gemini-2.0-flash
   ```
3. Run the dev server (serves `index.html` and `/api/extract-job` together):
   ```
   npm run dev
   ```
   or
   ```
   npx vercel dev
   ```
4. Open the printed local URL (typically `http://localhost:3000`).

If you only need to work on the UI and don't need live AI extraction, you can also just open
`index.html` directly in a browser — the AI Smart Extractor will fail to reach `/api/extract-job`
and automatically fall back to the built-in rule-based parser.

## Environment variables

| Variable         | Required | Description                                                                 |
|-------------------|----------|-------------------------------------------------------------------------------|
| `GEMINI_API_KEY`  | Yes      | Your Gemini API key. Used server-side only, never sent to the browser.        |
| `GEMINI_MODEL`    | No       | Gemini model name to call (e.g. `gemini-2.0-flash`). Defaults to a built-in model if unset. |

Never commit a real `.env` file — it's excluded via `.gitignore`. `.env.example` contains only
placeholder variable names.

## Deploying to Vercel

1. Push this repository to GitHub (already done if you're reading this from the deployed repo).
2. In the [Vercel dashboard](https://vercel.com/new), import the repository. No build command or
   output directory overrides are needed — it's a zero-config static + serverless-function project.
3. Under **Project Settings → Environment Variables**, add:
   - `GEMINI_API_KEY` — your Gemini API key
   - `GEMINI_MODEL` — optional, e.g. `gemini-2.0-flash`
4. Deploy. The app will be served at your Vercel URL, and the AI extractor will call
   `/api/extract-job` on the same domain.

## Data persistence (important)

This app currently stores **all data in your browser's `localStorage`** under these keys:

- `job_tracker_apps`
- `job_tracker_docs`
- `job_tracker_industries`
- `job_tracker_active_ind`

This means:

- Your data lives in one browser, on one device. It is **not** synced across devices or browsers.
- Clearing your browser's site data (or using a different browser/incognito window) will show an
  empty tracker.
- Vercel redeploys do **not** affect your data — it never leaves your browser.

**Back up regularly** using the Export JSON button (top-right download icon) and keep the file
somewhere safe. Use the Import JSON button to restore a backup or move your data to another
browser/device.

## Planned Phase 2

A future phase will migrate persistence from `localStorage` to a real database (e.g. Postgres via
Vercel, Supabase, or similar) so data can sync across devices and survive browser data clearing.
This is intentionally out of scope for the current deployment.
