const OpenAI = require("openai");
const { z } = require("zod");
const { trimText } = require("../utils/playwrightHelpers");

const CompletionSchema = z.object({
  taskCompletedForPayment: z.boolean(),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

/**
 * Decide from visible page text whether this Microworkers task is already finished
 * (submitted / accepted / will be paid), vs still in progress. No keyword matching on our side.
 */
async function classifyTaskCompletionForPayment({
  bus,
  apiKey,
  model,
  pageText,
  pageUrl,
  taskLabel,
  progressClicksSoFar,
}) {
  const excerpt = trimText(pageText, 7000);

  const client = new OpenAI({ apiKey });
  const system = [
    "You judge whether a Microworkers.com WORKER task page shows that THIS task is already successfully finished for payment.",
    "taskCompletedForPayment=true ONLY when the page clearly indicates the worker is done with THIS job, e.g.: proof accepted/submitted, thank you for submission, you will be paid/credited, job/task successfully completed for this campaign, or you already completed this task.",
    "taskCompletedForPayment=false when: only job instructions/description, must visit external site, upload screenshots not done yet, empty form, captcha in progress, errors, login prompts, generic site chrome, or ambiguous.",
    "Do not infer completion from ads, unrelated footers, or other tasks.",
    "Output strict JSON only, no markdown.",
    '{"taskCompletedForPayment":boolean,"reason":"string","confidence":number}',
  ].join(" ");

  const user = [
    `Page URL: ${pageUrl}`,
    `Task context: ${trimText(taskLabel, 200)}`,
    `Heuristic progress clicks so far (automation): ${progressClicksSoFar}`,
    "",
    "Visible text from page (may include iframes concatenated):",
    excerpt,
  ].join("\n");

  bus.emit("event", { type: "OPENAI_COMPLETION_ASK", label: `Model=${model}` });

  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
    });

    const content = resp?.choices?.[0]?.message?.content ?? "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = String(content).match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }

    const result = CompletionSchema.parse(parsed);
    bus.emit("event", {
      type: "OPENAI_COMPLETION_RESULT",
      label: `done=${result.taskCompletedForPayment} conf=${result.confidence.toFixed(2)} ${trimText(result.reason, 160)}`,
    });
    return result;
  } catch (err) {
    bus.emit("event", {
      type: "OPENAI_COMPLETION_FAILED",
      label: trimText(String(err?.message || err), 220),
    });
    return null;
  }
}

module.exports = { classifyTaskCompletionForPayment, CompletionSchema };
