/**
 * Job listing row / link text that implies a native mobile app or device-only task.
 * Used by OpenAI navigator (prompt + hard block) and keyword task queue.
 */
function listingTextSuggestsMobileAppTask(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s.trim()) return false;

  if (/\b(ios|iphone|ipad|ipod|android|apk|testflight|swiftui|kotlin|xcode)\b/.test(s)) return true;
  if (/app\s+store|google\s+play|play\s+store/.test(s)) return true;
  if (/\bmobile\s+app\b|\bandroid\s+app\b|\bios\s+app\b/.test(s)) return true;
  if (/\binstall\s+(?:the\s+)?app\b|\bdownload\s+(?:the\s+)?app\b/.test(s)) return true;
  if (/\bfor\s+(?:ios|android|iphone|ipad)\b/.test(s)) return true;
  if (/\b(?:only|requires?|need)\s+(?:an?\s+)?(?:ios|android|iphone)\b/.test(s)) return true;
  if (/\bmobile\s*(?:only|device|phone|version|users?|app)\b/.test(s)) return true;
  if (/\bmobile\b/.test(s)) return true;

  return false;
}

module.exports = { listingTextSuggestsMobileAppTask };
