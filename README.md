# moneybot2 (Microworkers automation with live streaming)

This is a starter agent that:

- Opens a **visible** Playwright browser window locally (headful).
- Streams the agent’s actions to a small web dashboard via **Server-Sent Events** (no screenshots).
- Tries to log into `microworkers.com` using env-provided credentials (or pauses for manual login).
- Attempts to skip tasks that appear to involve **phone/SMS/OTP** (heuristic).
- Pauses for manual interaction when the flow isn’t understood safely.

## Important note (safety / ToS)

Microworkers may restrict automated browsing and may require phone/SMS verification for account actions. This repo is a technical starter; you must ensure your automation complies with Microworkers’ Terms of Service and applicable laws. The “avoid phone” logic is best-effort and not a guarantee.

## Local setup

1. Install dependencies:

```bash
npm install
npm run playwright:install
```

2. Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

3. Start the agent + dashboard:

```bash
npm run start
```

Open `http://localhost:3000` in your browser to watch the streamed logs.

## Required environment variables

- `MICROWORKERS_USERNAME`
- `MICROWORKERS_PASSWORD`

Optional but recommended:

- `BROWSER_HEADLESS=false` (so you can watch the browser window)
- `MAX_TASKS_PER_RUN=5`
- `SAFE_MANUAL_PAUSE=true`

## Pausing / resuming

When the agent can’t safely continue (login selector mismatch, unknown flow, phone-like fields detected), it will pause and you’ll see a `Manual action required` event in the dashboard. Use the **Resume** button after you finish the manual step in the visible browser.

## Next steps

This is a first-run scaffold. After you do one run and share the streamed output/errors (especially around login/task selectors), we’ll tune:

- the exact navigation selectors for the Microworkers task page
- the click-through strategy per task type
- the phone-related skip detection (keywords + form detection)

## CapSolver (optional)

If you set `CAPSOLVER_API_KEY`, the agent will try to solve **Cloudflare Turnstile**, **reCAPTCHA v2**, and **hCaptcha** when they appear (login and task steps). Events are streamed as `CAPSOLVER_*` on the dashboard.

For Cloudflare’s **“Just a moment…”** interstitial, CapSolver’s **AntiCloudflareTask** requires a **static/sticky proxy**. Set `CAPSOLVER_CLOUDFLARE_PROXY` in the format CapSolver documents (e.g. `ip:port:user:pass`). Without a proxy, use `ENABLE_VNC=true` and complete the challenge manually.

Using third-party captcha-solving services may **violate the terms** of the site you automate. You are responsible for compliance with Microworkers’ rules and applicable law.

## Railway: realtime virtual display (noVNC)

Railway containers don’t have a real desktop, so “headful” needs a virtual display.
This repo can optionally expose a live browser view using **noVNC**.

1. Set `ENABLE_VNC=true` in Railway environment variables.
2. Ensure the Railway service exposes port `6080` (the noVNC web port).
3. Open the Railway service URL for `6080` and watch the headed browser live.

