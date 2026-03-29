async function safeGetInnerText(locator) {
  try {
    const text = await locator.innerText();
    return String(text ?? "");
  } catch {
    return "";
  }
}

function trimText(text, max = 2500) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + "…(truncated)";
}

async function clickIfExists({ page, bus, textRegex, timeoutMs = 1200, actionName = "CLICK" }) {
  // Attempts a text-based click across common clickable elements.
  const locator = page
    .locator("button, a, input[type='submit'], input[type='button']")
    .filter({ hasText: textRegex })
    .first();

  const count = await locator.count();
  if (!count) return { clicked: false };

  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return { clicked: false };
  }

  const label = await safeGetInnerText(locator);
  bus.emit("event", { type: actionName, label: trimText(label, 120), textRegex: String(textRegex) });
  await locator.click({ timeout: timeoutMs });
  return { clicked: true };
}

async function typeIntoFirst({ page, bus, fieldRegex, value, actionName = "TYPE" }) {
  // Types into the first matching input/textarea by placeholder/name/label text.
  const locator = page.locator("input, textarea").filter({
    hasText: fieldRegex,
  });
  if ((await locator.count()) === 0) return false;
  const el = locator.first();
  await el.fill(value);
  bus.emit("event", { type: actionName, fieldRegex: String(fieldRegex) });
  return true;
}

async function containsText(page, re) {
  const body = await page.locator("body").innerText().catch(() => "");
  return re.test(body);
}

module.exports = { safeGetInnerText, trimText, clickIfExists, typeIntoFirst, containsText };

