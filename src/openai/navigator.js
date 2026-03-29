const OpenAI = require("openai");
const { z } = require("zod");
const { trimText } = require("../utils/playwrightHelpers");
const { trySolveCaptchasOnPage } = require("../capsolver/trySolve");

const DecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("CLICK"), index: z.number().int().min(0), reason: z.string().min(1) }),
  z.object({ action: z.literal("NAVIGATE"), url: z.string().url(), reason: z.string().min(1) }),
  z.object({ action: z.literal("DONE"), reason: z.string().min(1) }),
  z.object({ action: z.literal("SKIP_STEP"), reason: z.string().min(1) }),
]);

function isAllowedNavigateUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    if (host === "microworkers.com" || host.endsWith(".microworkers.com")) return true;
    return false;
  } catch {
    return false;
  }
}

async function gatherInteractiveElements(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (r.bottom < -200 || r.top > window.innerHeight + 800) return false;
      return true;
    };

    const sel = 'a[href], button, input[type="submit"], input[type="button"]';
    const out = [];
    document.querySelectorAll(sel).forEach((el) => {
      if (!isVisible(el)) return;
      const tag = el.tagName;
      const href = el.getAttribute("href") || "";
      if (tag === "A" && (href === "#" || href.startsWith("javascript:"))) return;
      const text = (
        el.innerText ||
        el.value ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 180);
      out.push({
        tag,
        text: text || "(no visible text)",
        href: href.slice(0, 280),
      });
    });
    return out.slice(0, 100);
  });
}

async function clickGatheredIndex(page, index) {
  return page.evaluate((i) => {
    const isVisible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (r.bottom < -200 || r.top > window.innerHeight + 800) return false;
      return true;
    };
    const sel = 'a[href], button, input[type="submit"], input[type="button"]';
    const els = [...document.querySelectorAll(sel)].filter((el) => {
      if (!isVisible(el)) return false;
      const tag = el.tagName;
      const href = el.getAttribute("href") || "";
      if (tag === "A" && (href === "#" || href.startsWith("javascript:"))) return false;
      return true;
    });
    const el = els[i];
    if (!el) return { ok: false, error: "index out of range" };
    el.click();
    return { ok: true };
  }, index);
}

async function askNavigatorDecision({ page, bus, cfg, bodyExcerpt, elements, jobsDone, jobsQuota }) {
  if (!cfg.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required for navigator");

  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  const url = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "";
  }

  const lines = elements.map((e, i) => `[${i}] <${e.tag}> "${e.text}"${e.href ? ` href=${e.href}` : ""}`);

  const system = [
    "You are a browser automation planner for Microworkers (worker side).",
    "Pick ONE next step as strict JSON only (no markdown).",
    "Goals: reach available jobs, open a suitable job, avoid phone/SMS/OTP/voice verification tasks.",
    "Prefer actions that clearly start or accept work: Accept, Apply, Participate, View job, Start, Continue, etc.",
    "Avoid: Logout, Login (user is already logged in), Blog, social, Terms/Privacy unless needed to unblock.",
    "If the list has no good option, return SKIP_STEP with a short reason.",
    "If enough jobs have been handled for this session or the page has no work left, return DONE.",
    "For NAVIGATE, only use URLs on microworkers.com (e.g. https://www.microworkers.com/jobs.php).",
    "Schema:",
    '{"action":"CLICK","index":number,"reason":"string"}',
    '{"action":"NAVIGATE","url":"string","reason":"string"}',
    '{"action":"DONE","reason":"string"}',
    '{"action":"SKIP_STEP","reason":"string"}',
  ].join(" ");

  const user = [
    `Current URL: ${url}`,
    `Title: ${title}`,
    `Jobs handled this run (opened + classified): ${jobsDone} / quota ${jobsQuota}`,
    "",
    "Page text excerpt:",
    trimText(bodyExcerpt, 3500),
    "",
    "Interactive elements (indices are stable for CLICK):",
    lines.join("\n") || "(none)",
  ].join("\n");

  bus.emit("event", { type: "OPENAI_NAV_ASK", label: `Model=${cfg.OPENAI_MODEL} elements=${elements.length}` });

  const resp = await client.chat.completions.create({
    model: cfg.OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.1,
  });

  const content = resp?.choices?.[0]?.message?.content ?? "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  }
  const decision = DecisionSchema.parse(parsed);
  bus.emit("event", { type: "OPENAI_NAV_DECISION", label: `${decision.action}: ${decision.reason}` });
  return decision;
}

/**
 * OpenAI-driven job discovery + open; then caller runs completeTask per opened job.
 */
async function runOpenAINavigatorJobLoop({
  page,
  context,
  bus,
  cfg,
  completeTaskFn,
  jobsQuota,
  manualGate,
}) {
  const maxSteps = cfg.OPENAI_NAVIGATOR_MAX_STEPS;
  let completed = 0;
  let skippedPhone = 0;
  let needsManual = 0;
  /** Count every job page we attempted (complete or skip) toward quota */
  let jobsHandled = 0;
  let step = 0;

  while (jobsHandled < jobsQuota && step < maxSteps) {
    step++;
    await page.waitForTimeout(400).catch(() => {});

    const elements = await gatherInteractiveElements(page);
    if (elements.length === 0) {
      bus.emit("event", { type: "OPENAI_NAV_EMPTY_UI", label: "No interactive elements found; try NAVIGATE to jobs.php" });
    }

    const bodyExcerpt = await page.locator("body").innerText().catch(() => "");
    let decision;
    try {
      decision = await askNavigatorDecision({
        page,
        bus,
        cfg,
        bodyExcerpt,
        elements,
        jobsDone: jobsHandled,
        jobsQuota,
      });
    } catch (err) {
      bus.emit("event", { type: "OPENAI_NAV_ERROR", label: trimText(String(err?.message || err), 300) });
      break;
    }

    if (decision.action === "DONE") break;
    if (decision.action === "SKIP_STEP") {
      await page.waitForTimeout(1200).catch(() => {});
      continue;
    }

    if (decision.action === "NAVIGATE") {
      if (!isAllowedNavigateUrl(decision.url)) {
        bus.emit("event", { type: "OPENAI_NAV_REJECTED", label: `Blocked URL: ${decision.url}` });
        continue;
      }
      await page.goto(decision.url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await trySolveCaptchasOnPage(page, cfg, bus, "openai nav");
      continue;
    }

    if (decision.action === "CLICK") {
      if (decision.index >= elements.length) {
        bus.emit("event", { type: "OPENAI_NAV_BAD_INDEX", label: `index ${decision.index} max ${elements.length - 1}` });
        continue;
      }

      const prevUrl = page.url();
      const popupPromise = context.waitForEvent("page", { timeout: 4500 }).catch(() => null);
      const clickRes = await clickGatheredIndex(page, decision.index);
      if (!clickRes?.ok) {
        bus.emit("event", { type: "OPENAI_NAV_CLICK_FAIL", label: clickRes?.error || "click failed" });
        await popupPromise.catch(() => {});
        continue;
      }

      const popupPage = await popupPromise;
      await page.waitForTimeout(600).catch(() => {});
      let navigatedSameTab = false;
      if (!popupPage) {
        try {
          await page.waitForURL((u) => u.href !== prevUrl, { timeout: 5000 });
          navigatedSameTab = true;
        } catch {
          navigatedSameTab = false;
        }
      }

      const taskPage = popupPage || page;
      const onTaskLike =
        popupPage != null ||
        navigatedSameTab ||
        /job|task|campaign|worker_start|basic|ttv/i.test(taskPage.url());

      if (onTaskLike) {
        const taskLabel = trimText(`OpenAI step ${step}: ${decision.reason}`, 120);
        bus.emit("event", { type: "TASK_START_ATTEMPT", label: taskLabel });
        const result = await completeTaskFn({
          taskPageOrMain: taskPage,
          pageMain: page,
          context,
          bus,
          cfg,
          taskLabel,
        });
        jobsHandled++;
        if (result.status === "completed") completed++;
        if (result.status === "skipped_phone") skippedPhone++;
        if (result.status === "needs_manual") {
          needsManual++;
          if (cfg.SAFE_MANUAL_PAUSE) {
            bus.emit("event", { type: "MANUAL_PAUSE", label: "OpenAI/task flow needs manual help; use Live browser then Resume." });
            await manualGate.waitForResume();
          }
        }
        if (popupPage) await popupPage.close().catch(() => {});
        await page.bringToFront().catch(() => {});
        try {
          await page.goto(`${new URL(cfg.MICROWORKERS_BASE_URL).origin}/jobs.php`, { waitUntil: "domcontentloaded" });
        } catch {
          // ignore
        }
      }
    }
  }

  return { completed, skippedPhone, needsManual };
}

module.exports = {
  runOpenAINavigatorJobLoop,
  gatherInteractiveElements,
  DecisionSchema,
  isAllowedNavigateUrl,
};
