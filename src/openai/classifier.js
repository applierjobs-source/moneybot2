const OpenAI = require("openai");
const { z } = require("zod");
const { trimText } = require("../utils/playwrightHelpers");

const ClassifySchema = z.object({
  requiresPhone: z.boolean(),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

async function classifyTaskForPhoneRequirement({ bus, apiKey, model, taskText, heuristicFallback }) {
  const text = trimText(taskText, 6000);

  if (!apiKey) {
    const h = heuristicFallback();
    bus.emit("event", { type: "CLASSIFY_HEURISTIC_ONLY", label: `requiresPhone=${h.requiresPhone} (${h.reason})` });
    return h;
  }

  const client = new OpenAI({ apiKey });
  const system = [
    "You are a safety classifier for task automation.",
    "Goal: decide whether completing a task likely requires phone number entry, SMS, OTP, or call verification.",
    "Output strict JSON that matches the schema.",
  ].join(" ");

  const user = [
    "Task text:",
    text,
    "",
    "Classify requiresPhone as true if the task likely asks for a phone number, SMS/OTP code, or verification by SMS/call.",
  ].join("\n");

  bus.emit("event", { type: "CLASSIFY_OPENAI_START", label: "Asking OpenAI to classify phone requirement…" });

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
      // Some models return extra text; attempt to salvage a JSON substring.
      const m = String(content).match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }

    const result = ClassifySchema.parse(parsed);
    bus.emit("event", {
      type: "CLASSIFY_OPENAI_RESULT",
      label: `requiresPhone=${result.requiresPhone} conf=${result.confidence.toFixed(2)} reason=${result.reason}`,
    });
    return { requiresPhone: result.requiresPhone, reason: result.reason, confidence: result.confidence };
  } catch (err) {
    const h = heuristicFallback();
    bus.emit("event", { type: "CLASSIFY_OPENAI_FAILED", label: `Fallback to heuristic: ${err?.message || String(err)}` });
    return h;
  }
}

module.exports = { classifyTaskForPhoneRequirement };

