/**
 * Shared Playwright helpers: collect visible clickables and click by stable index.
 * Works with Page or Frame (same evaluate API).
 *
 * Task pages often use <a href="#">Next</a> — excluded by default for job listings;
 * pass allowHashAndJsLinks: true from the task runner.
 */

const CLICKABLE_SELECTOR = [
  'a[href]',
  'a[role="button"]',
  'a[role="link"]',
  'a[onclick]',
  'button',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="image"]',
  '[role="button"]',
  '[role="link"]',
].join(", ");

const DEFAULT_BELOW_FOLD_SLACK = 800;

async function gatherInteractiveElements(root, options = {}) {
  const belowFoldSlack = options.belowFoldSlack ?? DEFAULT_BELOW_FOLD_SLACK;
  const allowHashAndJsLinks = Boolean(options.allowHashAndJsLinks);
  return root.evaluate(
    ({ selectorList, belowFoldSlack: slack, allowHashAndJsLinks: allowHash }) => {
      const CLICKABLE_SELECTOR = selectorList;

      const isVisible = (el) => {
        const s = window.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        if (r.bottom < -200 || r.top > window.innerHeight + slack) return false;
        return true;
      };

      const seen = new Set();
      const out = [];

      function maybePush(el) {
        if (seen.has(el)) return;
        seen.add(el);
        if (!isVisible(el)) return;
        const tag = el.tagName;
        const href = el.getAttribute("href") || "";
        if (tag === "A" && !allowHash) {
          if (href === "#" || href === "" || href.toLowerCase().startsWith("javascript:")) return;
        }
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
      }

      function collectFromRoot(docOrShadow) {
        docOrShadow.querySelectorAll(CLICKABLE_SELECTOR).forEach(maybePush);
      }

      collectFromRoot(document);

      document.querySelectorAll("*").forEach((host) => {
        if (host.shadowRoot) {
          collectFromRoot(host.shadowRoot);
          host.shadowRoot.querySelectorAll("*").forEach((inner) => {
            if (inner.shadowRoot) collectFromRoot(inner.shadowRoot);
          });
        }
      });

      return out.slice(0, 100);
    },
    { selectorList: CLICKABLE_SELECTOR, belowFoldSlack, allowHashAndJsLinks },
  );
}

async function clickGatheredIndex(root, index, options = {}) {
  const belowFoldSlack = options.belowFoldSlack ?? DEFAULT_BELOW_FOLD_SLACK;
  const allowHashAndJsLinks = Boolean(options.allowHashAndJsLinks);
  return root.evaluate(
    ({ selectorList, belowFoldSlack: slack, allowHashAndJsLinks: allowHash, i }) => {
      const CLICKABLE_SELECTOR = selectorList;

      const isVisible = (el) => {
        const s = window.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        if (r.bottom < -200 || r.top > window.innerHeight + slack) return false;
        return true;
      };

      const seen = new Set();
      const els = [];

      function maybePush(el) {
        if (seen.has(el)) return;
        seen.add(el);
        if (!isVisible(el)) return;
        const tag = el.tagName;
        const href = el.getAttribute("href") || "";
        if (tag === "A" && !allowHash) {
          if (href === "#" || href === "" || href.toLowerCase().startsWith("javascript:")) return;
        }
        els.push(el);
      }

      function collectFromRoot(docOrShadow) {
        docOrShadow.querySelectorAll(CLICKABLE_SELECTOR).forEach(maybePush);
      }

      collectFromRoot(document);
      document.querySelectorAll("*").forEach((host) => {
        if (host.shadowRoot) {
          collectFromRoot(host.shadowRoot);
          host.shadowRoot.querySelectorAll("*").forEach((inner) => {
            if (inner.shadowRoot) collectFromRoot(inner.shadowRoot);
          });
        }
      });

      const el = els[i];
      if (!el) return { ok: false, error: "index out of range" };
      el.click();
      return { ok: true };
    },
    { selectorList: CLICKABLE_SELECTOR, belowFoldSlack, allowHashAndJsLinks, i: index },
  );
}

module.exports = {
  gatherInteractiveElements,
  clickGatheredIndex,
  CLICKABLE_SELECTOR,
  DEFAULT_BELOW_FOLD_SLACK,
};
