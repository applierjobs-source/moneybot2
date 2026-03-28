const { solveTask } = require("./client");

function cookieDomainForHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  const parts = h.split(".").filter(Boolean);
  if (parts.length >= 2) return `.${parts.slice(-2).join(".")}`;
  return h || "localhost";
}

/**
 * @returns {Promise<Array<{ kind: string, sitekey: string, isInvisible?: boolean, action?: string, cdata?: string }>>}
 */
async function extractCaptchaWidgets(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();

    function add(obj) {
      const k = `${obj.kind}:${obj.sitekey}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(obj);
    }

    document.querySelectorAll("[data-sitekey]").forEach((el) => {
      const sitekey = el.getAttribute("data-sitekey");
      if (!sitekey) return;
      const sk = sitekey.trim();
      if (/^0x[0-9a-fA-F]+/.test(sk) || sk.startsWith("0x4")) {
        add({
          kind: "turnstile",
          sitekey: sk,
          action: el.getAttribute("data-action") || undefined,
          cdata: el.getAttribute("data-cdata") || undefined,
        });
      }
    });

    document.querySelectorAll(".g-recaptcha[data-sitekey]").forEach((el) => {
      const sitekey = el.getAttribute("data-sitekey");
      if (!sitekey) return;
      const invisible =
        el.getAttribute("data-size") === "invisible" ||
        (el.getAttribute("data-badge") && el.getAttribute("data-badge") !== "inline");
      add({ kind: "recaptcha_v2", sitekey: sitekey.trim(), isInvisible: !!invisible });
    });

    document.querySelectorAll('iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net/recaptcha"]').forEach((iframe) => {
      const src = iframe.getAttribute("src") || "";
      const m = src.match(/[?&]k=([^&]+)/);
      if (m) add({ kind: "recaptcha_v2", sitekey: decodeURIComponent(m[1]) });
    });

    document.querySelectorAll('iframe[src*="hcaptcha.com"]').forEach((iframe) => {
      const src = iframe.getAttribute("src") || "";
      const m = src.match(/[?&]sitekey=([^&]+)/);
      if (m) add({ kind: "hcaptcha", sitekey: decodeURIComponent(m[1]) });
    });

    document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').forEach((iframe) => {
      const src = iframe.getAttribute("src") || "";
      const m = src.match(/[?&]k=([^&]+)/) || src.match(/[?&]sitekey=([^&]+)/);
      if (m) add({ kind: "turnstile", sitekey: decodeURIComponent(m[1]) });
    });

    return out;
  });
}

async function injectTurnstileToken(page, token) {
  await page.evaluate((t) => {
    const fields = document.querySelectorAll(
      'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name="g-recaptcha-response"]',
    );
    fields.forEach((el) => {
      el.value = t;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }, token);
}

async function injectRecaptchaV2Token(page, token) {
  await page.evaluate((t) => {
    document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach((el) => {
      el.value = t;
      el.innerHTML = t;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const holder = document.querySelector(".g-recaptcha[data-callback]");
    const cb = holder?.getAttribute("data-callback");
    if (cb && typeof window[cb] === "function") window[cb](t);
  }, token);
}

async function injectHcaptchaToken(page, token) {
  await page.evaluate((t) => {
    document.querySelectorAll('textarea[name="h-captcha-response"]').forEach((el) => {
      el.value = t;
      el.innerHTML = t;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }, token);
}

async function looksLikeCloudflareInterstitial(page) {
  const title = await page.title().catch(() => "");
  const html = await page.content().catch(() => "");
  return /just a moment/i.test(title) || /cf-challenge|challenges\.cloudflare\.com|cf-browser-verification/i.test(html);
}

/**
 * AntiCloudflareTask requires a static/sticky proxy per CapSolver docs.
 */
async function trySolveCloudflareInterstitial(page, cfg, emit) {
  if (!cfg.CAPSOLVER_API_KEY || !cfg.CAPSOLVER_CLOUDFLARE_PROXY) return false;
  if (!(await looksLikeCloudflareInterstitial(page))) return false;

  emit({ type: "CAPSOLVER_CF_INTERSTITIAL", label: "Detected Cloudflare interstitial; using AntiCloudflareTask (proxy required)" });
  const ua = await page.evaluate(() => navigator.userAgent);
  const html = await page.content();
  const task = {
    type: "AntiCloudflareTask",
    websiteURL: page.url(),
    proxy: cfg.CAPSOLVER_CLOUDFLARE_PROXY,
    userAgent: ua,
    html: html.slice(0, 450_000),
  };

  const solution = await solveTask(cfg.CAPSOLVER_API_KEY, task, { emit });
  const clearance = solution?.cookies?.cf_clearance || solution?.token;
  if (!clearance) {
    emit({ type: "CAPSOLVER_CF_NO_CLEARANCE", label: "AntiCloudflareTask returned no cf_clearance" });
    return false;
  }

  const host = new URL(page.url()).hostname;
  const domain = cookieDomainForHost(host);
  await page.context().addCookies([
    {
      name: "cf_clearance",
      value: clearance,
      domain,
      path: "/",
      httpOnly: true,
      secure: page.url().startsWith("https"),
      sameSite: "Lax",
    },
  ]);
  emit({ type: "CAPSOLVER_CF_COOKIE_SET", label: "Applied cf_clearance; reloading" });
  await page.reload({ waitUntil: "domcontentloaded" });
  return true;
}

/**
 * Solve visible widget captchas (Turnstile, reCAPTCHA v2, hCaptcha) and inject tokens.
 */
async function trySolveWidgetCaptchas(page, cfg, emit) {
  const widgets = await extractCaptchaWidgets(page);
  if (widgets.length === 0) return false;

  const url = page.url();
  for (const w of widgets) {
    emit({ type: "CAPSOLVER_WIDGET", label: `${w.kind} sitekey=${w.sitekey.slice(0, 16)}…` });
    let task;
    if (w.kind === "turnstile") {
      const metadata = {
        ...(w.action ? { action: w.action } : {}),
        ...(w.cdata ? { cdata: w.cdata } : {}),
      };
      task = {
        type: "AntiTurnstileTaskProxyLess",
        websiteURL: url,
        websiteKey: w.sitekey,
        ...(Object.keys(metadata).length ? { metadata } : {}),
      };
    } else if (w.kind === "recaptcha_v2") {
      task = {
        type: "ReCaptchaV2TaskProxyLess",
        websiteURL: url,
        websiteKey: w.sitekey,
        isInvisible: !!w.isInvisible,
      };
    } else if (w.kind === "hcaptcha") {
      task = {
        type: "HCaptchaTaskProxyLess",
        websiteURL: url,
        websiteKey: w.sitekey,
      };
    } else continue;

    const solution = await solveTask(cfg.CAPSOLVER_API_KEY, task, { emit });
    if (w.kind === "turnstile") {
      const token = solution?.token;
      if (!token) throw new Error("CapSolver Turnstile: no token in solution");
      await injectTurnstileToken(page, token);
    } else if (w.kind === "recaptcha_v2") {
      const token = solution?.gRecaptchaResponse;
      if (!token) throw new Error("CapSolver reCAPTCHA v2: no gRecaptchaResponse");
      await injectRecaptchaV2Token(page, token);
    } else if (w.kind === "hcaptcha") {
      const token = solution?.gRecaptchaResponse || solution?.token;
      if (!token) throw new Error("CapSolver hCaptcha: no token in solution");
      await injectHcaptchaToken(page, token);
    }
    emit({ type: "CAPSOLVER_INJECTED", label: `Injected token for ${w.kind}` });
  }
  return true;
}

/**
 * @param {import('playwright').Page} page
 * @param {object} cfg
 * @param {import('events').EventEmitter} bus
 * @param {string} tag
 */
async function trySolveCaptchasOnPage(page, cfg, bus, tag) {
  if (!cfg.CAPSOLVER_API_KEY || !cfg.CAPSOLVER_ENABLED) return;

  const emit = (e) => bus.emit("event", { type: e.type, label: `[CapSolver:${tag}] ${e.label}` });

  try {
    await trySolveCloudflareInterstitial(page, cfg, emit);
    await trySolveWidgetCaptchas(page, cfg, emit);
    await page.waitForTimeout(400).catch(() => {});
  } catch (err) {
    emit({ type: "CAPSOLVER_ERROR", label: err?.message || String(err) });
  }
}

module.exports = {
  trySolveCaptchasOnPage,
  extractCaptchaWidgets,
  trySolveCloudflareInterstitial,
};
