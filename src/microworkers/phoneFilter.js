// Heuristic filters to avoid tasks that require phone/SMS/OTP flows.

const KEYWORD_RULES = [
  { re: /\b(phone|mobile|cell(?:ular)?)\b/i, reason: "mentions phone/mobile" },
  { re: /\b(telephone|tel)\b/i, reason: "mentions telephone/tel" },
  { re: /\b(sms)\b/i, reason: "mentions SMS" },
  { re: /\b(otp|one[-\s]?time password|verification code)\b/i, reason: "mentions OTP/verification code" },
  { re: /\b(verify|verification)\b/i, reason: "mentions verification" },
  { re: /\b(call|voip|dial)\b/i, reason: "mentions call/dial" },
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

  // If the page is explicitly describing SMS verification, treat it as phone-required.
  const smsText = await page.locator("body").innerText();
  return textLooksLikePhoneTask(smsText);
}

module.exports = { textLooksLikePhoneTask, formLooksLikePhoneTask };

