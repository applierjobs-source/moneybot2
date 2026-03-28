const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const { textLooksLikePhoneTask, formLooksLikePhoneTask } = require("./phoneFilter");
const { clickIfExists, trimText } = require("../utils/playwrightHelpers");
const { classifyTaskForPhoneRequirement } = require("../openai/classifier");
const { trySolveCaptchasOnPage } = require("../capsolver/trySolve");
const { emitLoginAnalysis } = require("./loginDiagnostics");

function emit(bus, event) {
  bus.emit("event", event);
}

function baseUrlVariants(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/$/, "");
  const out = new Set([trimmed]);
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    if (host === "microworkers.com") {
      out.add(`${u.protocol}//www.microworkers.com`);
    }
    if (host === "www.microworkers.com") {
      out.add(`${u.protocol}//microworkers.com`);
    }
  } catch {
    // ignore
  }
  return [...out];
}

function loginUrlCandidates(baseUrl) {
  const urls = [];
  for (const base of baseUrlVariants(baseUrl)) {
    const b = base.replace(/\/$/, "");
    urls.push(
      `${b}/login.php`,
      `${b}/signin.php`,
      `${b}/login`,
      `${b}/signin`,
      `${b}/sign-in`,
    );
  }
  return [...new Set(urls)];
}

async function pageText(page) {
  try {
    return await page.locator("body").innerText();
  } catch {
    return "";
  }
}

async function emitPageDiagnostics(bus, page, tag) {
  const url = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "";
  }
  let snippet = "";
  try {
    snippet = trimText(await page.locator("body").innerText(), 400);
  } catch {
    snippet = "";
  }
  emit(bus, { type: "PAGE_DIAG", label: `[${tag}] ${url} | ${title} | ${snippet}` });
}

async function detectLoggedIn(page) {
  const url = page.url().toLowerCase();
  if (url.includes("logout") || url.includes("logoff")) return true;

  const hrefLogout = await page.locator('a[href*="logout" i], a[href*="logoff" i], a[href*="sign_out" i]').count();
  if (hrefLogout > 0) return true;

  const roleLogout = await page.getByRole("link", { name: /log\s*out|sign\s*out|logoff/i }).count();
  if (roleLogout > 0) return true;

  const t = await pageText(page);
  if (/\b(log\s*out|logout|sign\s*out|signout|logoff)\b/i.test(t)) return true;

  // Microworkers-style dashboard (no password field visible — avoids false positives on login page).
  if (/\b(available jobs|my account|account balance|worker id|post a job|hire workers)\b/i.test(t)) {
    const pwdVisible = await page.locator("input[type='password']:visible").count();
    if (pwdVisible === 0) return true;
  }

  return false;
}

async function navigateToLogin(page, cfg, bus) {
  emit(bus, { type: "NAVIGATE", label: `Base ${cfg.MICROWORKERS_BASE_URL}` });
  await page.goto(cfg.MICROWORKERS_BASE_URL, { waitUntil: "domcontentloaded" });
  await emitPageDiagnostics(bus, page, "after base");

  const loggedIn = await detectLoggedIn(page);
  if (loggedIn) return;

  const candidates = loginUrlCandidates(cfg.MICROWORKERS_BASE_URL);

  for (const url of candidates) {
    try {
      emit(bus, { type: "NAVIGATE", label: `Try ${url}` });
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const t = await pageText(page);
      if (/\b(password|sign in|log in|login)\b/i.test(t) || (await page.locator('input[type="password"]').count()) > 0) {
        await emitPageDiagnostics(bus, page, "login form");
        await trySolveCaptchasOnPage(page, cfg, bus, "login form");
        return;
      }
    } catch {
      // try next
    }
  }

  emit(bus, {
    type: cfg.SAFE_MANUAL_PAUSE ? "MANUAL_PAUSE" : "LOGIN_ASSIST_REQUIRED",
    label: "Could not locate login page automatically. Set MICROWORKERS_BASE_URL=https://www.microworkers.com and use ENABLE_VNC=true if Cloudflare blocks headless login.",
  });
}

async function loginWithCredentials(page, cfg, bus) {
  if (!cfg.MICROWORKERS_USERNAME || !cfg.MICROWORKERS_PASSWORD) {
    emit(bus, {
      type: cfg.SAFE_MANUAL_PAUSE ? "MANUAL_PAUSE" : "LOGIN_ASSIST_REQUIRED",
      label: "Missing MICROWORKERS_USERNAME/MICROWORKERS_PASSWORD in env. Please login manually in the visible browser. Resume only if needed.",
    });
    return false;
  }

  // Best-effort: Microworkers login.php often uses a text field named email/username.
  let emailLocator = page.locator(
    'input[type="email"], input[name="email" i], input[name*="email" i], input[name="username" i], input[id*="email" i], input[autocomplete="username"]',
  );
  if ((await emailLocator.count()) === 0) {
    emailLocator = page.locator('form:has(input[type="password"]) input[type="text"]').first();
  }
  const passwordLocator = page.locator('input[type="password"]').first();

  if ((await emailLocator.count()) === 0 || (await passwordLocator.count()) === 0) {
    emit(bus, {
      type: cfg.SAFE_MANUAL_PAUSE ? "MANUAL_PAUSE" : "LOGIN_ASSIST_REQUIRED",
      label: "Could not find email/password fields automatically. Please login manually in the visible browser. Resume only if needed.",
    });
    return false;
  }

  await trySolveCaptchasOnPage(page, cfg, bus, "before login fill");

  const emailEl = emailLocator.first();
  const passEl = passwordLocator;

  emit(bus, { type: "LOGIN_TYPE", label: "Email + password (best-effort)" });
  await emailEl.fill(cfg.MICROWORKERS_USERNAME);
  await passEl.fill(cfg.MICROWORKERS_PASSWORD);

  const beforeUrl = page.url();
  // Try a submit/login button.
  const clicked = await clickIfExists({ page, bus, textRegex: /login|sign in|sign-in|submit/i, timeoutMs: 3000, actionName: "LOGIN_SUBMIT" });
  if (!clicked.clicked) {
    emit(bus, {
      type: cfg.SAFE_MANUAL_PAUSE ? "MANUAL_PAUSE" : "LOGIN_ASSIST_REQUIRED",
      label: "Found credentials fields but could not find a login button. Please submit manually in the visible browser. Resume only if needed.",
    });
    return false;
  }

  try {
    await page.waitForURL((u) => u.href !== beforeUrl, { timeout: 25000 });
  } catch {
    // stay on same URL sometimes; continue
  }
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000).catch(() => {});
  await emitPageDiagnostics(bus, page, "after login submit");
  await trySolveCaptchasOnPage(page, cfg, bus, "after login submit");
  return detectLoggedIn(page);
}

async function loginIfNeeded(page, context, cfg, bus) {
  await page.goto(cfg.MICROWORKERS_BASE_URL, { waitUntil: "domcontentloaded" });
  await trySolveCaptchasOnPage(page, cfg, bus, "base");
  const ok = await detectLoggedIn(page);
  if (ok) return true;

  await navigateToLogin(page, cfg, bus);
  const loggedIn = await loginWithCredentials(page, cfg, bus);
  return loggedIn;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function clickContinueLoop({ page, bus, cfg, taskLabel }) {
  const actionPriority = [
    /continue|next/i,
    /start|begin/i,
    /i agree|agree|accept/i,
    /submit|finish|done/i,
    /confirm/i,
  ];

  const maxSteps = 20;
  for (let step = 0; step < maxSteps; step++) {
    await trySolveCaptchasOnPage(page, cfg, bus, `${taskLabel} step ${step + 1}`);
    const body = await pageText(page);
    if (/\b(done|completed|success)\b/i.test(body)) {
      emit(bus, { type: "TASK_COMPLETE", label: `${taskLabel} marked complete` });
      return { completed: true };
    }

    // If phone-related inputs appear, bail out.
    const phoneForm = await formLooksLikePhoneTask(page);
    if (phoneForm.requiresPhone) {
      emit(bus, { type: "TASK_SKIP_PHONE", label: `${taskLabel}: ${phoneForm.reason}` });
      return { completed: false, skippedPhone: true };
    }

    let clickedAny = false;
    for (const re of actionPriority) {
      const res = await clickIfExists({ page, bus, textRegex: re, timeoutMs: 800, actionName: "TASK_ACTION" });
      if (res.clicked) {
        clickedAny = true;
        emit(bus, { type: "STEP", label: `${taskLabel}: clicked ${re}` });
        await sleep(1200);
        break;
      }
    }

    if (!clickedAny) return { completed: false, skippedPhone: false };
  }

  return { completed: false, skippedPhone: false };
}

async function completeTask({ taskPageOrMain, pageMain, context, bus, cfg, taskLabel }) {
  // Always operate on the task page (which can be a popup/new tab or the same page).
  const page = taskPageOrMain;

  emit(bus, { type: "TASK_OPEN", label: taskLabel });

  const body = await pageText(page);
  const heuristic = textLooksLikePhoneTask(body);
  let classifiedPhone = { requiresPhone: false, reason: "not classified", confidence: 0 };
  if (cfg.OPENAI_CLASSIFY_TASKS && cfg.OPENAI_API_KEY) {
    classifiedPhone = await classifyTaskForPhoneRequirement({
      bus,
      apiKey: cfg.OPENAI_API_KEY,
      model: cfg.OPENAI_MODEL,
      taskText: body,
      heuristicFallback: () => ({ ...heuristic, confidence: heuristic.requiresPhone ? 0.6 : 0.1 }),
    });
  }

  const phoneForm = await formLooksLikePhoneTask(page);
  const shouldSkip =
    phoneForm.requiresPhone || (classifiedPhone.requiresPhone && (classifiedPhone.confidence ?? 0) >= cfg.OPENAI_SKIP_CONFIDENCE_THRESHOLD);

  if (shouldSkip) {
    const why = phoneForm.requiresPhone ? phoneForm.reason : `${classifiedPhone.reason} (conf ${classifiedPhone.confidence ?? 0})`;
    emit(bus, { type: "TASK_SKIP_PHONE", label: `${taskLabel}: requiresPhone (${why})` });
    return { status: "skipped_phone" };
  }

  const res = await clickContinueLoop({ page, bus, cfg, taskLabel });
  if (res.completed) return { status: "completed" };
  if (res.skippedPhone) return { status: "skipped_phone" };
  return { status: "needs_manual" };
}

async function findTaskCandidates(page, cfg) {
  // Very generic: collect clickable elements that likely correspond to tasks.
  // Microworkers may vary, so this is best-effort only.
  const locator = page
    .locator("a, button")
    .filter({ hasText: /start|begin|work|do task|open/i });

  const count = await locator.count();
  const max = Math.min(cfg.MAX_TASKS_PER_RUN, count);
  const candidates = [];
  for (let i = 0; i < max; i++) {
    const el = locator.nth(i);
    const info = await el.evaluate((node) => {
      const parent = node.closest("article, li, div") || node.parentElement || node;
      const txt = parent ? parent.innerText : node.innerText;
      return {
        text: (txt || "").slice(0, 2000),
        href: node.getAttribute("href") || null,
      };
    });
    candidates.push({ index: i, ...info });
  }
  return candidates;
}

async function runMicroworkersAutomation({ bus, manualGate, cfg }) {
  emit(bus, { type: "AUTOMATION_START", label: "Starting Microworkers automation" });

  const storageStatePath = cfg.STORAGE_STATE_PATH;
  const storageDir = path.dirname(storageStatePath);
  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

  const browser = await chromium.launch({
    headless: cfg.BROWSER_HEADLESS,
    args: ["--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    storageState: fs.existsSync(storageStatePath) ? storageStatePath : undefined,
  });

  const page = await context.newPage();

  try {
    // Stream browser-level diagnostics to the dashboard.
    page.on("console", (msg) => {
      const txt = msg?.text?.() ?? "";
      bus.emit("event", { type: "BROWSER_CONSOLE", label: trimText(txt, 200) });
    });
    page.on("pageerror", (err) => {
      bus.emit("event", { type: "BROWSER_PAGEERROR", label: trimText(String(err?.message || err), 200) });
    });
    page.on("requestfailed", (req) => {
      const url = req?.url?.() ?? "";
      bus.emit("event", { type: "BROWSER_REQUEST_FAILED", label: trimText(`${req?.method?.() || ""} ${url}`, 200) });
    });

    await loginIfNeeded(page, context, cfg, bus);
    if (!(await detectLoggedIn(page))) {
      emit(bus, { type: "LOGIN_NOT_CONFIRMED", label: "Login not confirmed." });
      await emitPageDiagnostics(bus, page, "login not confirmed");
      await emitLoginAnalysis(bus, page, "login not confirmed");
      if (cfg.SAFE_MANUAL_PAUSE) {
        emit(bus, { type: "MANUAL_PAUSE", label: "Complete login in the browser, then click Resume." });
        await manualGate.waitForResume();
      } else {
        for (let i = 0; i < 5; i++) {
          await page.waitForTimeout(3000);
          if (await detectLoggedIn(page)) break;
          emit(bus, { type: "LOGIN_RECHECK", label: `Recheck login attempt ${i + 1}/5` });
          await trySolveCaptchasOnPage(page, cfg, bus, `login recheck ${i + 1}`);
          await emitLoginAnalysis(bus, page, `login recheck ${i + 1}`);
        }
        if (!(await detectLoggedIn(page))) {
          await emitLoginAnalysis(bus, page, "login final");
          emit(bus, {
            type: "LOGIN_FAILED",
            label:
              "Still not logged in. Read LOGIN_ANALYSIS, LOGIN_STATE, and PAGE_SNIPPET above. Set MICROWORKERS_BASE_URL=https://www.microworkers.com, CAPSOLVER_API_KEY for widgets, CAPSOLVER_CLOUDFLARE_PROXY for CF interstitial, or ENABLE_VNC=true and use the Live browser panel on this site.",
          });
          return;
        }
      }
    }

    // Try to reach tasks list.
    emit(bus, { type: "NAVIGATE", label: "Going to tasks page" });
    const taskUrls = [];
    for (const b of baseUrlVariants(cfg.MICROWORKERS_BASE_URL)) {
      const base = b.replace(/\/$/, "");
      taskUrls.push(
        `${base}/jobs.php`,
        `${base}/campaigns.php`,
        `${base}/tasks`,
        `${base}/task`,
      );
    }
    let tasksLoaded = false;
    for (const url of taskUrls) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await trySolveCaptchasOnPage(page, cfg, bus, "tasks page");
        const t = await pageText(page);
        if (/\b(task|available|earn|work)\b/i.test(t)) {
          tasksLoaded = true;
          break;
        }
      } catch {
        // try next url
      }
    }

    if (!tasksLoaded) {
      emit(bus, { type: "TASKS_NOT_FOUND", label: "Could not find tasks list automatically." });
      if (cfg.SAFE_MANUAL_PAUSE) {
        emit(bus, { type: "MANUAL_PAUSE", label: "Navigate to your tasks page in the browser, then click Resume." });
        await manualGate.waitForResume();
      } else {
        for (let i = 0; i < 5; i++) {
          await page.waitForTimeout(2500);
          for (const url of taskUrls) {
            try {
              await page.goto(url, { waitUntil: "domcontentloaded" });
              await trySolveCaptchasOnPage(page, cfg, bus, "tasks recheck");
            } catch {
              // ignore
            }
          }
          if (await pageText(page).then((t) => /\b(task|available|earn|work)\b/i.test(t))) break;
          emit(bus, { type: "TASKS_RECHECK", label: `Recheck tasks list attempt ${i + 1}/5` });
        }
      }
    }

    const candidates = await findTaskCandidates(page, cfg);
    emit(bus, { type: "TASK_QUEUE", label: `Found ${candidates.length} task candidates` });

    let completed = 0;
    let skippedPhone = 0;
    let needsManual = 0;

    for (const cand of candidates) {
      const summaryText = cand.text;
      const heuristic = textLooksLikePhoneTask(summaryText);
      const openaiRan = cfg.OPENAI_CLASSIFY_TASKS && cfg.OPENAI_API_KEY;

      let classified = heuristic;
      if (openaiRan) {
        classified = await classifyTaskForPhoneRequirement({
          bus,
          apiKey: cfg.OPENAI_API_KEY,
          model: cfg.OPENAI_MODEL,
          taskText: summaryText,
          heuristicFallback: () => ({ ...heuristic, confidence: heuristic.requiresPhone ? 0.6 : 0.1 }),
        });
      }

      const shouldSkipPhone =
        (heuristic.requiresPhone && !openaiRan) ||
        (classified.requiresPhone && (classified.confidence ?? 0) >= cfg.OPENAI_SKIP_CONFIDENCE_THRESHOLD);

      if (shouldSkipPhone) {
        skippedPhone++;
        const why = heuristic.requiresPhone ? heuristic.reason : classified.reason;
        emit(bus, { type: "TASK_SKIP_PHONE", label: `Skipping task: ${why}` });
        continue;
      }

      // Click the candidate and capture a potential popup.
      const locator = page.locator("a, button").filter({ hasText: /start|begin|work|do task|open/i }).nth(cand.index);
      const taskLabel = trimText(summaryText || "Task", 120);

      emit(bus, { type: "TASK_START_ATTEMPT", label: taskLabel });

      let popupPage = null;
      try {
        const [newPage] = await Promise.all([
          context.waitForEvent("page").catch(() => null),
          locator.click({ timeout: 3000 }),
        ]);
        popupPage = newPage;
      } catch {
        // If click fails, pause for manual.
        if (cfg.SAFE_MANUAL_PAUSE) {
          emit(bus, { type: "MANUAL_PAUSE", label: "Clicking a task candidate failed. Please click it manually in the browser, then click Resume." });
          await manualGate.waitForResume();
        }
        continue;
      }

      const taskPage = popupPage || page;
      const result = await completeTask({
        taskPageOrMain: taskPage,
        pageMain: page,
        context,
        bus,
        cfg,
        taskLabel,
      });

      if (result.status === "completed") completed++;
      if (result.status === "skipped_phone") skippedPhone++;
      if (result.status === "needs_manual") {
        needsManual++;
        emit(bus, { type: "MANUAL_PAUSE", label: "Task flow needs manual interaction. Complete it in the browser, then click Resume." });
        if (cfg.SAFE_MANUAL_PAUSE) {
          await manualGate.waitForResume();
        } else {
          emit(bus, { type: "AUTONOMOUS_SKIP_MANUAL", label: "SAFE_MANUAL_PAUSE=false, continuing to next task." });
        }
      }

      // Close popup if used, then try to return to tasks list.
      if (popupPage) {
        await popupPage.close().catch(() => {});
      }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(1000).catch(() => {});
      // Attempt to reload tasks list for next task context.
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
      } catch {
        // ignore
      }
    }

    emit(bus, {
      type: "AUTOMATION_SUMMARY",
      label: `Completed=${completed} skippedPhone=${skippedPhone} needsManual=${needsManual}`,
    });
  } catch (err) {
    emit(bus, { type: "ERROR", label: `Automation error: ${err?.message || String(err)}` });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    emit(bus, { type: "AUTOMATION_END", label: "Automation finished" });
  }
}

module.exports = { runMicroworkersAutomation };

