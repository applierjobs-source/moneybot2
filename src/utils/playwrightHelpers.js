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

/**
 * Labels that look like Microworkers nav / account links but match task-style regexes
 * (e.g. "finish" matching inside "Tasks I finished").
 */
const DEFAULT_TASK_UI_EXCLUDE =
  /tasks?\s+i\s+finished|finished\s+tasks|jobs?\s+i\s+(?:finished|completed)|my\s+finished|available\s+jobs|browse\s+jobs|post\s+a\s+job|hire\s+workers|log\s*(?:out|off)|sign\s*out|my\s+account|account\s+balance|worker\s+id|post\s+job|messages?|notifications?|settings|help\s*center|support/i;

async function clickIfExists({
  page,
  bus,
  textRegex,
  timeoutMs = 1200,
  actionName = "CLICK",
  excludeLabelRe = null,
}) {
  const candidates = page
    .locator("button, a, input[type='submit'], input[type='button']")
    .filter({ hasText: textRegex });

  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const locator = candidates.nth(i);
    try {
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
    } catch {
      continue;
    }
    const label = await safeGetInnerText(locator);
    if (excludeLabelRe && excludeLabelRe.test(label)) continue;

    bus.emit("event", { type: actionName, label: trimText(label, 120), textRegex: String(textRegex) });
    await locator.click({ timeout: timeoutMs });
    return { clicked: true };
  }
  return { clicked: false };
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

module.exports = {
  safeGetInnerText,
  trimText,
  clickIfExists,
  DEFAULT_TASK_UI_EXCLUDE,
  typeIntoFirst,
  containsText,
};

