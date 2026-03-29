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
  // Detect phone inputs dynamically inside the task page.
  const phoneInputCount = await page
    .locator('input[type="tel"], input[name*="phone" i], input[id*="phone" i]')
    .count();
  if (phoneInputCount > 0) return { requiresPhone: true, reason: "phone input field detected" };

  // Some flows label the input with "phone" even if type isn't tel.
  const phoneLabelCount = await page
    .locator('label:has-text("phone"), label:has-text("mobile"), label:has-text("tel")')
    .count();
  if (phoneLabelCount > 0) return { requiresPhone: true, reason: "phone-labeled input detected" };

  const body = await page.locator("body").innerText();
  return textLooksLikePhoneTask(body);
}

module.exports = { textLooksLikePhoneTask, formLooksLikePhoneTask };

