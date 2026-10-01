# Kalo — Netlify deploy

1. Push this folder to GitHub (or use the Netlify CLI).
2. In Netlify: Add new site → Import from Git → pick the repo. No build command needed.
3. Site settings → Environment variables → add `ANTHROPIC_API_KEY` (from console.anthropic.com).
   Optional: `ANTHROPIC_MODEL` to change the model (default `claude-sonnet-5-5`).
4. Deploy. Open the site and try a meal description and a photo scan.

CLI alternative: `npm i -g netlify-cli && netlify login && netlify deploy --prod`

Keep the API key ONLY in Netlify's environment variables. Never put it in index.html.
Before going public, set a monthly spend limit on your Anthropic account, since anyone can call the function.
