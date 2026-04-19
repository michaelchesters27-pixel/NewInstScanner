# EUR/USD Institutional Scanner

This is a deploy-ready Netlify project built around the project briefing.

## What it does

- Pulls EUR/USD candle data from Twelve Data
- Recalculates the scanner from scratch on each 15-minute cycle
- Tracks a progression bar for the strategy criteria
- Only issues Buy / Sell ideas when the full criteria chain passes
- Stores past ideas in Supabase
- Updates idea outcomes to Won / Lost / Expired / Invalidated / Passed
- Includes a manual refresh button and a 15-minute aligned auto-refresh in the frontend
- Includes a scheduled Netlify function to keep scanning every 15 minutes even when the page is closed

## Files

- `public/index.html` - private dashboard frontend
- `netlify/functions/scanner.js` - on-demand scanner endpoint
- `netlify/functions/scheduled-scan.js` - background 15-minute scheduled scan
- `netlify/functions/lib/scanner-engine.js` - full scanner logic
- `supabase/sql/schema.sql` - required database schema
- `.env.example` - environment variable names to add in Netlify

## Required Netlify environment variables

Add these in Netlify > Site configuration > Environment variables:

- `TWELVEDATA_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `APP_TIMEZONE` = `Europe/London`

## Supabase setup

1. Open your Supabase project.
2. Go to SQL Editor.
3. Paste the contents of `supabase/sql/schema.sql` and run it.

## Deploy

1. Upload this project to GitHub.
2. Connect the repo to Netlify.
3. Add the environment variables.
4. Deploy.

## Notes on logic

The scanner uses a hard-gate model:

A Buy or Sell idea only appears when all of these are satisfied:

- 1H bias confirmed
- price at key level
- liquidity sweep
- reclaim / rejection
- displacement
- valid session
- trade still actionable
- RR >= 1:2

Otherwise it stays on No Trade / We Are Close / Trade Passed.

## Important

This package is designed to work with live Twelve Data and Supabase credentials. Without real keys it cannot be live-tested inside ChatGPT, but the full project structure and code are included here.
