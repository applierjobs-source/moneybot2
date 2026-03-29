const OpenAI = require("openai");
const { z } = require("zod");
const { trimText } = require("../utils/playwrightHelpers");
const { gatherInteractiveElements, clickGatheredIndex } = require("./uiGather");
const { trySolveCaptchasOnPage } = require("../capsolver/trySolve");
const { formLooksLikePhoneTask } = require("../microworkers/phoneFilter");

const TaskStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("CLICK"), index: z.number().int().min(0), reason: z.string().min(1) }),
  z.object({
    action: z.literal("TASK_DONE"),
    reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
  }),
  z.object({ action: z.literal("SKIP_STEP"), reason: z.string().min(1) }),
  z.object({ action: z.literal("NEEDS_MANUAL"), reason: z.string().min(1) }),
]);

function orderedFrames(page) {
  const main = page.mainFrame();
  return [main, ...page.frames().filter((f) => !f.isDetached() && f !== main)];
}

async function pageTextDeep(page) {
  const parts = [];
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    parts.push(await f.locator("body").innerText().catch(() => ""));
  }
  return parts.filter(Boolean).join("\n");
}

/** Extra px below viewport to still count controls (after we scroll, Next may sit just off-screen). */
const TASK_GATHER_BELOW_FOLD_SLACK = 3200;

async function gatherFlattenedUi(page, maxTotal, gatherOptions = {}) {
  const targets = [];
  const parts = [];
  let g = 0;
  const frames = orderedFrames(page);
  for (let fi = 0; fi < frames.length && g < maxTotal; fi++) {
    const frame = frames[fi];
    if (frame.isDetached()) continue;
    const els = await gatherInteractiveElements(frame, gatherOptions);
    const tagLabel = fi === 0 ? "main" : `iframe${fi}`;
    for (let li = 0; li < els.length && g < maxTotal; li++) {
      const e = els[li];
      parts.push(`[${g}] (${tagLabel}) <${e.tag}> "${e.text}"${e.href ? ` href=${e.href}` : ""}`);
      targets.push({ frame, localIndex: li });
      g++;
    }
  }
  return { lines: parts, targets };
}

async function scrollTaskSurfaces(page) {
  const frames = orderedFrames(page);
  for (const f of frames) {
    if (f.isDetached()) continue;
    try {
      await f.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const maxOutScroll = () => {
          document.querySelectorAll("*").forEach((el) => {
            const s = getComputedStyle(el);
            if (
              (s.overflowY === "auto" || s.overflowY === "scroll") &&
              el.scrollHeight > el.clientHeight + 24
            ) {
              el.scrollTop = el.scrollHeight;
            }
          });
        };
        const step = Math.min(500, Math.ceil((window.innerHeight || 720) * 0.72));
        const bottom = Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0,
        );
        for (let y = 0; y <= bottom + step; y += step) {
          window.scrollTo(0, y);
          maxOutScroll();
          await sleep(45);
        }
        window.scrollTo(0, bottom);
        maxOutScroll();
        await sleep(100);
      });
    } catch {
      // ignore
    }
  }
  try {
    const vp = page.viewportSize();
    if (vp) {
      const x = Math.max(80, Math.floor(vp.width / 2));
      const y = Math.max(80, Math.floor(vp.height / 2));
      await page.mouse.move(x, y);
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 520);
        await page.waitForTimeout(90);
      }
    }
  } catch {
    // ignore
  }
}

async function tryPlaywrightFallbackNext(activePage, bus, taskLabel) {
  const nameRes = [/^next$/i, /^next step$/i, /^continue$/i, /^proceed$/i];
  const roles = ["button", "link"];
  const frames = orderedFrames(activePage);
  for (const f of frames) {
    if (f.isDetached()) continue;
    for (const role of roles) {
      for (const name of nameRes) {
        try {
          const loc = f.getByRole(role, { name }).first();
          if ((await loc.count()) === 0) continue;
          await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
          await loc.click({ timeout: 5000 });
          bus.emit("event", {
            type: "OPENAI_TASK_FALLBACK_CLICK",
            label: `${trimText(taskLabel, 70)} — Playwright ${role} name=${String(name)}`,
          });
          return true;
        } catch {
          // try next
        }
      }
    }
  }
  return false;
}

async function askTaskStepDecision({
  page,
  bus,
  cfg,
  bodyExcerpt,
  lines,
  taskLabel,
  step,
  maxSteps,
  repairMessage,
}) {
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  let url = "";
  let title = "";
  try {
    url = page.url();
  } catch {
    url = "";
  }
  try {
    title = await page.title();
  } catch {
    title = "";
  }

  const n = lines.length;
  const maxIdx = Math.max(0, n - 1);

  const system = [
    "You operate INSIDE an active Microworkers worker task (instructions, forms, proof upload, external steps).",
    "Pick ONE next step as strict JSON only (no markdown).",
    "CLICK: pick ONE index from the numbered list [0], [1], … ONLY. The index integer MUST appear in that list — never use question numbers, exam scores, step counts, or any number from prose.",
    `If the list has ${n} items, valid CLICK indices are exactly 0 through ${maxIdx}.`,
    "Avoid Microworkers global nav junk: \"Tasks I finished\", \"Available jobs\", \"Logout\", \"My account\", \"Post a job\" — do not CLICK those unless absolutely required to unblock the task.",
    "If this task requires installing or using a native iOS/Android app (App Store, Google Play, APK, TestFlight), return NEEDS_MANUAL — desktop automation cannot do that.",
    "TASK_DONE: page clearly shows THIS task is finished for payment (proof accepted, submitted, you will be paid, already completed this task). Include confidence 0-1.",
    "NEEDS_MANUAL: only if automation cannot proceed safely (captcha unsolved, must type free text, upload files you cannot describe, ambiguous).",
    "SKIP_STEP: wait / nothing actionable right now / page still loading.",
    "If the interactive list is empty, never CLICK — use SKIP_STEP or NEEDS_MANUAL.",
    "Schema:",
    '{"action":"CLICK","index":number,"reason":"string"}',
    '{"action":"TASK_DONE","reason":"string","confidence":number}',
    '{"action":"SKIP_STEP","reason":"string"}',
    '{"action":"NEEDS_MANUAL","reason":"string"}',
  ].join(" ");

  const indexRules =
    n === 0
      ? "There are ZERO listed interactive elements — do not use CLICK; use SKIP_STEP or NEEDS_MANUAL."
      : `CLICK index MUST be between 0 and ${maxIdx} inclusive (${n} elements). Do not use any other number.`;

  const user = [
    `Task step ${step + 1} / max ${maxSteps}`,
    `URL: ${url}`,
    `Title: ${title}`,
    `Context: ${trimText(taskLabel, 200)}`,
    "",
    indexRules,
    "",
    "Page text excerpt:",
    trimText(bodyExcerpt, 4500),
    "",
    "Interactive elements (CLICK index = leading [number] on each line):",
    lines.join("\n") || "(none)",
  ].join("\n");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  if (repairMessage) {
    messages.push({ role: "user", content: repairMessage });
  }

  bus.emit("event", {
    type: "OPENAI_TASK_ASK",
    label: `Model=${cfg.OPENAI_MODEL} elements=${n}${repairMessage ? " (repair)" : ""}`,
  });

  const resp = await client.chat.completions.create({
    model: cfg.OPENAI_MODEL,
    messages,
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
  const decision = TaskStepSchema.parse(parsed);
  bus.emit("event", { type: "OPENAI_TASK_DECISION", label: `${decision.action}: ${trimText(decision.reason, 100)}` });
  return decision;
}

/**
 * OpenAI chooses each in-task click / declares TASK_DONE / NEEDS_MANUAL.
 */
async function runOpenAITaskRunnerLoop({ page, context, bus, cfg, taskLabel }) {
  if (!cfg.OPENAI_API_KEY) {
    return { completed: false, skippedPhone: false, needsManual: true, error: "no API key" };
  }

  const maxSteps = cfg.OPENAI_TASK_RUNNER_MAX_STEPS ?? 55;
  const doneThreshold = cfg.OPENAI_COMPLETION_CONFIDENCE_THRESHOLD ?? 0.72;
  const uiCap = Math.min(120, Math.max(40, cfg.OPENAI_TASK_UI_ELEMENTS_MAX ?? 100));

  let activePage = page;

  for (let step = 0; step < maxSteps; step++) {
    await trySolveCaptchasOnPage(activePage, cfg, bus, `${taskLabel} AI-task ${step + 1}`);

    const phoneForm = await formLooksLikePhoneTask(activePage);
    if (phoneForm.requiresPhone) {
      bus.emit("event", { type: "TASK_SKIP_PHONE", label: `${taskLabel}: ${phoneForm.reason}` });
      return { completed: false, skippedPhone: true, needsManual: false };
    }

    bus.emit("event", { type: "OPENAI_TASK_SCROLL", label: "Scrolling window + overflow areas to reveal controls" });
    await scrollTaskSurfaces(activePage);
    await activePage.waitForTimeout(200).catch(() => {});

    const bodyExcerpt = await pageTextDeep(activePage);
    const gatherOpts = { belowFoldSlack: TASK_GATHER_BELOW_FOLD_SLACK };
    const { lines, targets } = await gatherFlattenedUi(activePage, uiCap, gatherOpts);
    const nTargets = targets.length;

    let decision;
    let repairMessage = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        decision = await askTaskStepDecision({
          page: activePage,
          bus,
          cfg,
          bodyExcerpt,
          lines,
          taskLabel,
          step,
          maxSteps,
          repairMessage,
        });
      } catch (err) {
        bus.emit("event", {
          type: "OPENAI_TASK_ERROR",
          label: trimText(String(err?.message || err), 280),
        });
        return { completed: false, skippedPhone: false, needsManual: true };
      }
      repairMessage = null;

      if (decision.action !== "CLICK") break;

      if (nTargets === 0) {
        bus.emit("event", {
          type: "OPENAI_TASK_BAD_INDEX",
          label: "CLICK with empty UI list",
        });
        repairMessage =
          "You returned CLICK but the interactive elements list is empty. Reply with SKIP_STEP or NEEDS_MANUAL, not CLICK.";
        continue;
      }

      if (decision.index >= 0 && decision.index < nTargets) break;

      bus.emit("event", {
        type: "OPENAI_TASK_BAD_INDEX",
        label: `index ${decision.index} max ${nTargets - 1}`,
      });
      repairMessage = [
        `Your JSON used CLICK index ${decision.index}, but ONLY indices 0..${nTargets - 1} exist (${nTargets} lines).`,
        "Reply with ONE JSON object: CLICK with a valid index, or SKIP_STEP / NEEDS_MANUAL.",
        "Do NOT use question numbers, exam step numbers, or 3/5/6 from the page text.",
        "The ONLY allowed indices and labels are:",
        lines.join("\n") || "(none)",
      ].join("\n");
    }

    if (decision.action === "CLICK" && (nTargets === 0 || decision.index < 0 || decision.index >= nTargets)) {
      const popupPromise = context.waitForEvent("page", { timeout: 4500 }).catch(() => null);
      const fb = await tryPlaywrightFallbackNext(activePage, bus, taskLabel);
      if (fb) {
        await activePage.waitForTimeout(400).catch(() => {});
        const popupPage = await popupPromise;
        if (popupPage) {
          activePage = popupPage;
          await activePage.bringToFront().catch(() => {});
        } else {
          await activePage.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
        }
        await activePage.waitForTimeout(500).catch(() => {});
        continue;
      }
      await activePage.waitForTimeout(600).catch(() => {});
      continue;
    }

    if (decision.action === "TASK_DONE") {
      if (decision.confidence >= doneThreshold) {
        bus.emit("event", {
          type: "TASK_COMPLETE",
          label: `${taskLabel} — OpenAI TASK_DONE (conf ${decision.confidence.toFixed(2)}): ${trimText(decision.reason, 120)}`,
        });
        return { completed: true, skippedPhone: false, needsManual: false };
      }
      await activePage.waitForTimeout(800).catch(() => {});
      continue;
    }

    if (decision.action === "NEEDS_MANUAL") {
      bus.emit("event", {
        type: "TASK_NEEDS_MANUAL",
        label: `${taskLabel}: OpenAI NEEDS_MANUAL — ${trimText(decision.reason, 200)}`,
      });
      return { completed: false, skippedPhone: false, needsManual: true };
    }

    if (decision.action === "SKIP_STEP") {
      await activePage.waitForTimeout(1400).catch(() => {});
      continue;
    }

    const slackOpts = { belowFoldSlack: TASK_GATHER_BELOW_FOLD_SLACK };

    if (decision.action === "CLICK") {
      const { frame, localIndex } = targets[decision.index];
      const popupPromise = context.waitForEvent("page", { timeout: 4500 }).catch(() => null);
      const clickRes = await clickGatheredIndex(frame, localIndex, slackOpts);
      if (!clickRes?.ok) {
        bus.emit("event", { type: "OPENAI_TASK_CLICK_FAIL", label: clickRes?.error || "click failed" });
        await popupPromise.catch(() => {});
        const pFb = context.waitForEvent("page", { timeout: 4500 }).catch(() => null);
        if (await tryPlaywrightFallbackNext(activePage, bus, taskLabel)) {
          await activePage.waitForTimeout(400).catch(() => {});
          const popupPage2 = await pFb;
          if (popupPage2) {
            activePage = popupPage2;
            await activePage.bringToFront().catch(() => {});
          } else {
            await activePage.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
          }
          await activePage.waitForTimeout(500).catch(() => {});
        }
        continue;
      }

      const popupPage = await popupPromise;
      await activePage.waitForTimeout(500).catch(() => {});
      if (popupPage) {
        bus.emit("event", {
          type: "OPENAI_TASK_POPUP",
          label: "New tab opened; automating that tab next",
        });
        activePage = popupPage;
        await activePage.bringToFront().catch(() => {});
      } else {
        await activePage.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
      }

      await activePage.waitForTimeout(600).catch(() => {});
    }
  }

  bus.emit("event", {
    type: "TASK_NEEDS_MANUAL",
    label: `${taskLabel}: OpenAI task runner exceeded max steps (${maxSteps}). ${trimText(page.url(), 120)}`,
  });
  return { completed: false, skippedPhone: false, needsManual: true };
}

module.exports = {
  runOpenAITaskRunnerLoop,
  TaskStepSchema,
  gatherFlattenedUi,
  orderedFrames,
};
