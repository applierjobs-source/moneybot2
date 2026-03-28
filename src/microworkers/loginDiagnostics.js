const { trimText } = require("../utils/playwrightHelpers");

/**
 * Emit detailed login failure context (no screenshots): URL, title, captcha signals, page text snippet.
 */
async function emitLoginAnalysis(bus, page, tag) {
  const url = page.url();
  const title = await page.title().catch(() => "");

  let htmlHead = "";
  try {
    htmlHead = await page.content();
  } catch {
    htmlHead = "";
  }
  htmlHead = htmlHead.slice(0, 8000);

  let bodyText = "";
  try {
    bodyText = await page.locator("body").innerText();
  } catch {
    bodyText = "";
  }

  const flags = await page.evaluate(() => ({
    pwd: document.querySelectorAll('input[type="password"]').length,
    turnstile: !!document.querySelector('[data-sitekey^="0x"], [data-sitekey^="0X"], iframe[src*="challenges.cloudflare"]'),
    recaptcha: !!document.querySelector('.g-recaptcha, iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net/recaptcha"]'),
    hcaptcha: !!document.querySelector('iframe[src*="hcaptcha.com"]'),
  }));

  const cfLike = /just a moment|checking your browser|cf-mitigated|attention required|cloudflare/i.test(
    `${title}\n${htmlHead}`,
  );

  const hints = [];
  if (cfLike) hints.push("Cloudflare-style interstitial or check (use CAPSOLVER_CLOUDFLARE_PROXY, or ENABLE_VNC=true and finish in Live browser)");
  if (flags.turnstile) hints.push("Turnstile widget present (CAPSOLVER_API_KEY)");
  if (flags.recaptcha) hints.push("reCAPTCHA present (CAPSOLVER_API_KEY)");
  if (flags.hcaptcha) hints.push("hCaptcha present (CAPSOLVER_API_KEY)");
  if (flags.pwd > 0 && !cfLike) hints.push("Password field still visible — wrong credentials, blocked login, or JS error");

  bus.emit("event", {
    type: "LOGIN_ANALYSIS",
    label: `[${tag}] ${hints.length ? hints.join(" · ") : "No captcha/CF pattern matched — see PAGE_SNIPPET and LOGIN_STATE"}`,
  });
  bus.emit("event", {
    type: "LOGIN_STATE",
    label: `[${tag}] url=${url} | title=${title} | pwdFields=${flags.pwd} turnstile=${flags.turnstile} recaptcha=${flags.recaptcha} hcaptcha=${flags.hcaptcha} cfLikePage=${cfLike}`,
  });
  bus.emit("event", {
    type: "PAGE_SNIPPET",
    label: `[${tag}] ${trimText(bodyText.replace(/\s+/g, " ").trim(), 1200)}`,
  });
}

module.exports = { emitLoginAnalysis };
