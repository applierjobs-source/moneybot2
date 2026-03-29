/**
 * Shared Playwright helpers: collect visible clickables and click by stable index.
 * Works with Page or Frame (same evaluate API).
 */

async function gatherInteractiveElements(root) {
  return root.evaluate(() => {
    const isVisible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (r.bottom < -200 || r.top > window.innerHeight + 800) return false;
      return true;
    };

    const sel = 'a[href], button, input[type="submit"], input[type="button"]';
    const out = [];
    document.querySelectorAll(sel).forEach((el) => {
      if (!isVisible(el)) return;
      const tag = el.tagName;
      const href = el.getAttribute("href") || "";
      if (tag === "A" && (href === "#" || href.startsWith("javascript:"))) return;
      const text = (
        el.innerText ||
        el.value ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 180);
      out.push({
        tag,
        text: text || "(no visible text)",
        href: href.slice(0, 280),
      });
    });
    return out.slice(0, 100);
  });
}

async function clickGatheredIndex(root, index) {
  return root.evaluate((i) => {
    const isVisible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (r.bottom < -200 || r.top > window.innerHeight + 800) return false;
      return true;
    };
    const sel = 'a[href], button, input[type="submit"], input[type="button"]';
    const els = [...document.querySelectorAll(sel)].filter((el) => {
      if (!isVisible(el)) return false;
      const tag = el.tagName;
      const href = el.getAttribute("href") || "";
      if (tag === "A" && (href === "#" || href.startsWith("javascript:"))) return false;
      return true;
    });
    const el = els[i];
    if (!el) return { ok: false, error: "index out of range" };
    el.click();
    return { ok: true };
  }, index);
}

module.exports = { gatherInteractiveElements, clickGatheredIndex };
