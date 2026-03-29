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

    const bodyExcerpt = await pageTextDeep(activePage);
    const { lines, targets } = await gatherFlattenedUi(activePage, uiCap);
    const nTargets = targets.length;

    let decision;
    let repairMessage = null;
    for (let attempt = 0; attempt < 2; attempt++) {
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
      repairMessage = `Your JSON used CLICK index ${decision.index}, but the list only has indices 0 through ${
        nTargets - 1
      } (${nTargets} lines). Reply with ONE new JSON object: either CLICK with a valid index from that list, or SKIP_STEP / NEEDS_MANUAL.`;
    }

    if (decision.action === "CLICK" && (nTargets === 0 || decision.index < 0 || decision.index >= nTargets)) {
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
      await page.waitForTimeout(1400).catch(() => {});
      continue;
    }

    if (decision.action === "CLICK") {
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
