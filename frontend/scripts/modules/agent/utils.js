export function getApiBase() {
  const { protocol, hostname, port, origin } = window.location;
  if (protocol === "file:") return "http://127.0.0.1:8000";
  if ((hostname === "127.0.0.1" || hostname === "localhost") && !port) return "http://127.0.0.1:8000";
  return origin;
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
