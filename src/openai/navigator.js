const OpenAI = require("openai");
const { z } = require("zod");
const { trimText } = require("../utils/playwrightHelpers");
const { trySolveCaptchasOnPage } = require("../capsolver/trySolve");
const { gatherInteractiveElements, clickGatheredIndex } = require("./uiGather");

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

function urlKey(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/** Stable key for a listing link so we do not reopen the same job after returning from it. */
function resolveListingHrefKey(basePageUrl, hrefAttr) {
  if (!hrefAttr || hrefAttr === "#" || hrefAttr.startsWith("javascript:")) return null;
  try {
    const u = new URL(hrefAttr, basePageUrl);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function addDeadClickIndex(deadClickByListingUrl, listingPageUrl, index) {
  const k = urlKey(listingPageUrl);
  if (!k) return;
  if (!deadClickByListingUrl.has(k)) deadClickByListingUrl.set(k, new Set());
  deadClickByListingUrl.get(k).add(index);
}

function blockedIndicesForListingUrl(deadClickByListingUrl, listingPageUrl) {
  const k = urlKey(listingPageUrl);
  if (!k) return [];
  return [...(deadClickByListingUrl.get(k) || [])].sort((a, b) => a - b);
}

async function askNavigatorDecision({
  page,
  bus,
  cfg,
  bodyExcerpt,
  elements,
  jobsDone,
  jobsQuota,
  attemptedKeys,
  blockedIndices,
}) {
  if (!cfg.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required for navigator");

  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  const url = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "";
  }

  const lines = elements.map((e, i) => {
    const hk = resolveListingHrefKey(url, e.href || "");
    const triedHref = hk && attemptedKeys.has(hk);
    const triedIdx = blockedIndices.includes(i);
    const mark = triedHref || triedIdx ? " [ALREADY_TRIED—pick another index or SKIP_STEP] " : " ";
    return `[${i}]${mark}<${e.tag}> "${e.text}"${e.href ? ` href=${e.href}` : ""}`;
  });

  const triedSample = [...attemptedKeys]
    .filter((k) => !k.includes("#clickidx"))
    .slice(-40)
    .map((k) => trimText(k, 120));
  const triedExtra = Math.max(0, [...attemptedKeys].filter((k) => !k.includes("#clickidx")).length - triedSample.length);

  const system = [
    "You are a browser automation planner for Microworkers (worker side).",
    "Pick ONE next step as strict JSON only (no markdown).",
    "Goals: reach available jobs, open a suitable job, avoid phone/SMS/OTP/voice verification tasks.",
    "Prefer actions that clearly start or accept work: Accept, Apply, Participate, View job, Start, Continue, etc.",
    "For CLICK, the reason field must name the control you are clicking (e.g. \"View job\"), not a phone/SMS suitability essay — suitability is checked later by automation.",
    "Avoid: Logout, Login (user is already logged in), Blog, social, Terms/Privacy unless needed to unblock.",
    "Never CLICK an index marked ALREADY_TRIED — those jobs were already opened this run or failed to navigate; choose a different job or NAVIGATE to jobs.php to refresh.",
    "If the list has no good option, return SKIP_STEP with a short reason.",
    "If enough jobs have been handled for this session or the page has no work left, return DONE.",
    "For NAVIGATE, only use URLs on microworkers.com (e.g. https://www.microworkers.com/jobs.php).",
    "Schema:",
    '{"action":"CLICK","index":number,"reason":"string"}',
    '{"action":"NAVIGATE","url":"string","reason":"string"}',
    '{"action":"DONE","reason":"string"}',
    '{"action":"SKIP_STEP","reason":"string"}',
  ].join(" ");

  const userParts = [
    `Current URL: ${url}`,
    `Title: ${title}`,
    `Jobs handled this run (opened + classified): ${jobsDone} / quota ${jobsQuota}`,
    "",
    "Page text excerpt:",
    trimText(bodyExcerpt, 3500),
    "",
    "Interactive elements (indices are stable for CLICK):",
    lines.join("\n") || "(none)",
  ];
  if (triedSample.length) {
    userParts.push("", `Job/listing URLs already used this run (sample; ${triedExtra} more not shown):`, triedSample.join("\n"));
  }
  if (blockedIndices.length) {
    userParts.push("", `Do not CLICK these indices (unproductive clicks on this page): ${blockedIndices.join(", ")}`);
  }
  const user = userParts.join("\n");

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
  const attemptedKeys = new Set();
  const deadClickByListingUrl = new Map();
  let skipStreak = 0;

  const returnToJobs = async () => {
    try {
      await page.goto(`${new URL(cfg.MICROWORKERS_BASE_URL).origin}/jobs.php`, { waitUntil: "domcontentloaded" });
    } catch {
      // ignore
    }
    await trySolveCaptchasOnPage(page, cfg, bus, "openai nav return jobs");
  };

  while (jobsHandled < jobsQuota && step < maxSteps) {
    step++;
    await page.waitForTimeout(400).catch(() => {});

    const elements = await gatherInteractiveElements(page);
    if (elements.length === 0) {
      bus.emit("event", { type: "OPENAI_NAV_EMPTY_UI", label: "No interactive elements found; try NAVIGATE to jobs.php" });
    }

    const bodyExcerpt = await page.locator("body").innerText().catch(() => "");
    const listingUrlForPrompt = page.url();
    const blockedIndices = blockedIndicesForListingUrl(deadClickByListingUrl, listingUrlForPrompt);
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
        attemptedKeys,
        blockedIndices,
      });
    } catch (err) {
      bus.emit("event", { type: "OPENAI_NAV_ERROR", label: trimText(String(err?.message || err), 300) });
      break;
    }

    if (decision.action === "DONE") break;
    if (decision.action === "SKIP_STEP") {
      skipStreak++;
      if (
        skipStreak >= 5 &&
        /microworkers\.com/i.test(page.url()) &&
        /jobs\.php/i.test(page.url())
      ) {
        skipStreak = 0;
        await page.mouse.wheel(0, 700).catch(() => {});
        bus.emit("event", {
          type: "OPENAI_NAV_SCROLL_JOBS",
          label: "Scrolled jobs listing after repeated SKIP_STEP",
        });
      }
      await page.waitForTimeout(1200).catch(() => {});
      continue;
    }

    skipStreak = 0;

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

      if (blockedIndices.includes(decision.index)) {
        bus.emit("event", {
          type: "OPENAI_NAV_BLOCKED_INDEX",
          label: `Model chose blocked index ${decision.index}`,
        });
        continue;
      }

      const prevUrl = page.url();
      const chosen = elements[decision.index];
      const listingHrefKey = resolveListingHrefKey(prevUrl, chosen?.href || "");

      if (listingHrefKey && attemptedKeys.has(listingHrefKey)) {
        bus.emit("event", {
          type: "OPENAI_NAV_DUPLICATE_BLOCKED",
          label: trimText(`Blocked duplicate listing: ${listingHrefKey}`, 220),
        });
        continue;
      }

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
      const navigated = popupPage != null || navigatedSameTab;
      const onTaskLike =
        popupPage != null ||
        navigatedSameTab ||
        /job|task|campaign|worker_start|basic|ttv/i.test(taskPage.url());

      const registerAttemptKeys = () => {
        if (listingHrefKey) attemptedKeys.add(listingHrefKey);
        const tu = urlKey(taskPage.url());
        if (tu) attemptedKeys.add(tu);
      };

      if (!navigated) {
        if (listingHrefKey) attemptedKeys.add(listingHrefKey);
        else addDeadClickIndex(deadClickByListingUrl, prevUrl, decision.index);
        bus.emit("event", {
          type: "OPENAI_NAV_NO_NAV_AFTER_CLICK",
          label: trimText(`No navigation; marked tried idx=${decision.index}`, 160),
        });
        continue;
      }

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
        registerAttemptKeys();
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
        await returnToJobs();
      } else {
        registerAttemptKeys();
        jobsHandled++;
        bus.emit("event", {
          type: "OPENAI_NAV_NON_TASK_NAV",
          label: trimText(`Opened non-task page, returning to jobs: ${taskPage.url()}`, 200),
        });
        if (popupPage) await popupPage.close().catch(() => {});
        await page.bringToFront().catch(() => {});
        await returnToJobs();
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
