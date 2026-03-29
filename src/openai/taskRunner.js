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

async function gatherFlattenedUi(page, maxTotal) {
  const targets = [];
  const parts = [];
  let g = 0;
  const frames = orderedFrames(page);
  for (let fi = 0; fi < frames.length && g < maxTotal; fi++) {
    const frame = frames[fi];
    if (frame.isDetached()) continue;
    const els = await gatherInteractiveElements(frame);
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

async function askTaskStepDecision({ page, bus, cfg, bodyExcerpt, lines, taskLabel, step, maxSteps }) {
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

  const system = [
    "You operate INSIDE an active Microworkers worker task (instructions, forms, proof upload, external steps).",
    "Pick ONE next step as strict JSON only (no markdown).",
    "CLICK: choose an index from the numbered list to advance the task (Continue, Submit proof, I agree, Visit link, Next, etc.).",
    "Avoid Microworkers global nav junk: \"Tasks I finished\", \"Available jobs\", \"Logout\", \"My account\", \"Post a job\" — do not CLICK those unless absolutely required to unblock the task.",
    "If this task requires installing or using a native iOS/Android app (App Store, Google Play, APK, TestFlight), return NEEDS_MANUAL — desktop automation cannot do that.",
    "TASK_DONE: page clearly shows THIS task is finished for payment (proof accepted, submitted, you will be paid, already completed this task). Include confidence 0-1.",
    "NEEDS_MANUAL: only if automation cannot proceed safely (captcha unsolved, must type free text, upload files you cannot describe, ambiguous).",
    "SKIP_STEP: wait / nothing actionable right now / page still loading.",
    "Schema:",
    '{"action":"CLICK","index":number,"reason":"string"}',
    '{"action":"TASK_DONE","reason":"string","confidence":number}',
    '{"action":"SKIP_STEP","reason":"string"}',
    '{"action":"NEEDS_MANUAL","reason":"string"}',
  ].join(" ");

  const user = [
    `Task step ${step + 1} / max ${maxSteps}`,
    `URL: ${url}`,
    `Title: ${title}`,
    `Context: ${trimText(taskLabel, 200)}`,
    "",
    "Page text excerpt:",
    trimText(bodyExcerpt, 4500),
    "",
    "Interactive elements (CLICK uses index exactly):",
    lines.join("\n") || "(none)",
  ].join("\n");

  bus.emit("event", { type: "OPENAI_TASK_ASK", label: `Model=${cfg.OPENAI_MODEL} elements=${lines.length}` });

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

    const bodyExcerpt = await pageTextDeep(activePage);
    const { lines, targets } = await gatherFlattenedUi(activePage, uiCap);

    let decision;
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
      });
    } catch (err) {
      bus.emit("event", {
        type: "OPENAI_TASK_ERROR",
        label: trimText(String(err?.message || err), 280),
      });
      return { completed: false, skippedPhone: false, needsManual: true };
    }

    if (decision.action === "TASK_DONE") {
      if (decision.confidence >= doneThreshold) {
        bus.emit("event", {
          type: "TASK_COMPLETE",
          label: `${taskLabel} — OpenAI TASK_DONE (conf ${decision.confidence.toFixed(2)}): ${trimText(decision.reason, 120)}`,
        });
        return { completed: true, skippedPhone: false, needsManual: false };
      }
      await page.waitForTimeout(800).catch(() => {});
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
      await page.waitForTimeout(1400).catch(() => {});
      continue;
    }

    if (decision.action === "CLICK") {
      if (decision.index >= targets.length) {
        bus.emit("event", {
          type: "OPENAI_TASK_BAD_INDEX",
          label: `index ${decision.index} max ${targets.length - 1}`,
        });
        continue;
      }

      const { frame, localIndex } = targets[decision.index];
      const popupPromise = context.waitForEvent("page", { timeout: 4500 }).catch(() => null);
      const clickRes = await clickGatheredIndex(frame, localIndex);
      if (!clickRes?.ok) {
        bus.emit("event", { type: "OPENAI_TASK_CLICK_FAIL", label: clickRes?.error || "click failed" });
        await popupPromise.catch(() => {});
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
