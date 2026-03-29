// Heuristic filters to avoid tasks that require phone/SMS/OTP flows.

// Avoid generic "verify" — most Microworkers tasks ask you to verify proof; that is not phone/SMS.
const KEYWORD_RULES = [
  { re: /\b(phone|mobile|cell(?:ular)?)\s*(number|#|no\.?|verification|code|otp)?\b/i, reason: "mentions phone/mobile" },
  { re: /\b(telephone|tel\.?)\s*(number|no\.?)?\b/i, reason: "mentions telephone/tel" },
  { re: /\b(sms|text message)\b/i, reason: "mentions SMS/text" },
  { re: /\b(otp|one[-\s]?time password|sms\s+code|phone\s+code)\b/i, reason: "mentions OTP/SMS code" },
  { re: /\b(call|voip|dial)\s+(to|me|this|number)?\b/i, reason: "mentions phone call" },
];

function textLooksLikePhoneTask(text) {
  const t = String(text ?? "");
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(t)) return { requiresPhone: true, reason: rule.reason };
  }
  return { requiresPhone: false };
}

async function formLooksLikePhoneTask(page) {
  // Detect phone inputs in any frame (task UIs often sit in iframes).
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    const phoneInputCount = await f
      .locator('input[type="tel"], input[name*="phone" i], input[id*="phone" i]')
      .count();
    if (phoneInputCount > 0) return { requiresPhone: true, reason: "phone input field detected" };

    const phoneLabelCount = await f
      .locator('label:has-text("phone"), label:has-text("mobile"), label:has-text("tel")')
      .count();
    if (phoneLabelCount > 0) return { requiresPhone: true, reason: "phone-labeled input detected" };
  }

  const parts = [];
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    parts.push(await f.locator("body").innerText().catch(() => ""));
  }
  return textLooksLikePhoneTask(parts.join("\n"));
}

module.exports = { textLooksLikePhoneTask, formLooksLikePhoneTask };

