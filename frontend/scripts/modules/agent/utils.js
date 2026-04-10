export function getApiBase() {
  const { protocol, hostname, port, origin } = window.location;
  // Default to 8765 for local Shoplive backend.
  // 8000 is often occupied by unrelated local services, which can cause
  // requests to hit the wrong backend and produce auth errors.
  if (protocol === "file:") return "http://127.0.0.1:8765";
  if ((hostname === "127.0.0.1" || hostname === "localhost") && !port) return "http://127.0.0.1:8765";
  return origin;
}

/**
 * Convert a possibly-relative video URL to an absolute URL suitable for
 * sending to the backend (which needs http(s):// or data: URLs to download).
 *
 * Backend-served export files use relative paths like /video-edits/xxx.mp4
 * so the browser resolves them correctly regardless of the server's bind address
 * (0.0.0.0 vs 127.0.0.1). When the frontend forwards the URL to the backend for
 * further editing, we must re-attach the origin.
 */
export function toAbsoluteVideoUrl(url) {
  if (!url) return url;
  if (url.startsWith("/")) return `${getApiBase()}${url}`;
  return url;
}

/**
 * Pull the first URL-like token from free text (https / www / bare domain + path).
 * Used so pasted "amazon.com/dp/…" without scheme still parses when embedded in a sentence.
 */
export function extractProductUrlCandidateFromText(raw = "") {
  const s = String(raw || "")
    .replace(/\ufeff|\u200b/g, "")
    .replace(/[\u201c\u201d\u2018\u2019]/g, "")
    .replace(/[\n\r\t\f\v]+/g, "")
    .trim();
  if (!s) return "";
  const withScheme = s.match(/https?:\/\/[^\s<>"'`]+/i);
  if (withScheme) return String(withScheme[0]).replace(/[),.;，。]+$/g, "").trim();
  const www = s.match(/\bwww\.[a-z0-9.-]+\.[a-z]{2,}[^\s<>"'`]*/i);
  if (www) return String(www[0]).replace(/[),.;，。]+$/g, "").trim();
  const bare = s.match(/\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s<>"'`]*)?/i);
  if (bare) return String(bare[0]).replace(/[),.;，。]+$/g, "").trim();
  return "";
}

export function extractHttpUrlCandidateFromText(raw = "") {
  const s = String(raw || "")
    .replace(/\ufeff|\u200b/g, "")
    .replace(/[\u201c\u201d\u2018\u2019]/g, "")
    .trim();
  if (!s) return "";
  const withScheme = s.match(/https?:\/\/[^\s<>"'`]+/i);
  if (withScheme) return String(withScheme[0]).replace(/[),.;，。!！]+$/g, "").trim();
  const www = s.match(/\bwww\.[a-z0-9.-]+\.[a-z]{2,}[^\s<>"'`]*/i);
  if (www) return String(www[0]).replace(/[),.;，。!！]+$/g, "").trim();
  const bare = s.match(/\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s<>"'`]*)?/i);
  if (bare) return String(bare[0]).replace(/[),.;，。!！]+$/g, "").trim();
  return "";
}

/**
 * Normalize to a valid http(s) URL for ProductInsightRequest / shop-product-insight.
 */
export function normalizeProductUrlForApi(raw = "") {
  let s = extractProductUrlCandidateFromText(raw);
  if (!s) s = String(raw || "").replace(/[\n\r\t\f\v]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) {
    s = s.replace(/^\/+/, "");
    if (!/^[a-z0-9]/i.test(s)) return "";
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname && u.hostname.includes(".")) {
      return u.href;
    }
  } catch (_e) {}
  return "";
}

export function isLikelyProductUrlCandidate(text = "") {
  return Boolean(normalizeProductUrlForApi(text));
}

export function normalizeHttpUrlForApi(raw = "") {
  let s = extractHttpUrlCandidateFromText(raw);
  if (!s) s = String(raw || "").replace(/[\n\r\t\f\v]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) {
    s = s.replace(/^\/+/, "");
    if (!/^[a-z0-9]/i.test(s)) return "";
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname && u.hostname.includes(".")) {
      return u.href;
    }
  } catch (_e) {}
  return "";
}

export async function postJson(url, body, timeout = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    const traceId = resp.headers.get("X-Trace-Id") || "";
    if (data && typeof data === "object" && traceId) {
      data.__trace_id = traceId;
    }
    if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function postSse(url, body, onEvent, timeout = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let errText = `HTTP ${resp.status}`;
      try {
        const data = await resp.json();
        errText = data?.error || data?.message || errText;
      } catch (_e) {
        try {
          errText = (await resp.text()) || errText;
        } catch (_e2) {}
      }
      throw new Error(errText);
    }
    if (!resp.body) throw new Error("empty stream body");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const blocks = pending.split("\n\n");
      pending = blocks.pop() || "";
      for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        let eventName = "message";
        const dataLines = [];
        for (const line of lines) {
          if (!line) continue;
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim() || "message";
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }
        if (!dataLines.length) continue;
        const rawPayload = dataLines.join("\n");
        let payload = null;
        try {
          payload = JSON.parse(rawPayload);
        } catch (_e) {
          payload = { raw: rawPayload };
        }
        onEvent?.(eventName, payload);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
