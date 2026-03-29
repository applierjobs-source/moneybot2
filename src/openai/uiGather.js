/**
 * Shared Playwright helpers: collect visible clickables and click by stable index.
 * Works with Page or Frame (same evaluate API).
 *
 * Includes [role="button"] / [role="link"] — many exam UIs use <div role="button">Next</div>.
 */

const CLICKABLE_SELECTOR = [
  'a[href]',
  'button',
  'input[type="submit"]',
  'input[type="button"]',
  '[role="button"]',
  '[role="link"]',
].join(", ");

async function gatherInteractiveElements(root) {
  return root.evaluate((selectorList) => {
    const CLICKABLE_SELECTOR = selectorList;
    const isVisible = (el) => {
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (r.bottom < -200 || r.top > window.innerHeight + 800) return false;
      return true;
    };

    const seen = new Set();
    const out = [];
    document.querySelectorAll(CLICKABLE_SELECTOR).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
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
      const role = el.getAttribute("role") || "";
      const tagLabel = role && tag !== "BUTTON" && tag !== "A" ? `${tag}+role=${role}` : tag;
      out.push({
        tag: tagLabel,
        text: text || "(no visible text)",
        href: href.slice(0, 280),
      });
    });
    return out.slice(0, 100);
  }, CLICKABLE_SELECTOR);
}

async function clickGatheredIndex(root, index) {
  return root.evaluate(
    ({ selectorList, i }) => {
      const CLICKABLE_SELECTOR = selectorList;
      const isVisible = (el) => {
        const s = window.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        if (r.bottom < -200 || r.top > window.innerHeight + 800) return false;
        return true;
      };

      const seen = new Set();
      const els = [];
      document.querySelectorAll(CLICKABLE_SELECTOR).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        if (!isVisible(el)) return;
        const tag = el.tagName;
        const href = el.getAttribute("href") || "";
        if (tag === "A" && (href === "#" || href.startsWith("javascript:"))) return;
        els.push(el);
      });
      const el = els[i];
      if (!el) return { ok: false, error: "index out of range" };
      el.click();
      return { ok: true };
    },
    { selectorList: CLICKABLE_SELECTOR, i: index },
  );
}

module.exports = { gatherInteractiveElements, clickGatheredIndex, CLICKABLE_SELECTOR };
