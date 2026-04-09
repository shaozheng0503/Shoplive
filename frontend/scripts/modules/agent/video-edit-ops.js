import { state } from './state.js';
import { currentLang, t } from './i18n.js';
import { getApiBase, toAbsoluteVideoUrl, postJson, postSse } from './utils.js';

// ---------------------------------------------------------------------------
// Single global dispatcher for inline onclick= handlers in dynamic HTML.
// Replaces the old per-operation window[`__xxx_${id}`] pattern which leaked
// one global key per call and was never cleaned up.
// ---------------------------------------------------------------------------
const _cbRegistry = new Map();
window.__shopliveCb = (key) => { _cbRegistry.get(key)?.(); };
const _cbCleanup = (...keys) => keys.forEach((k) => _cbRegistry.delete(k));

// Callbacks injected by index.js to break circular dependencies
let _pushSystemStateMsg = () => null;
let _pushSystemGuideMsg = () => null;
let _pushSystemReplyMsg = () => null;
let _renderVideoEditor = () => {};
let _applyVideoEditsToPreview = () => {};
let _scrollToBottom = () => {};
/** Appends a new chat video card for an exported URL; does not replace older cards. */
let _appendExportedVideoCard = (_url) => {};

export function initVideoEditCallbacks(cbs) {
  if (cbs.pushSystemStateMsg) _pushSystemStateMsg = cbs.pushSystemStateMsg;
  if (cbs.pushSystemGuideMsg) _pushSystemGuideMsg = cbs.pushSystemGuideMsg;
  if (cbs.pushSystemReplyMsg) _pushSystemReplyMsg = cbs.pushSystemReplyMsg;
  if (cbs.renderVideoEditor) _renderVideoEditor = cbs.renderVideoEditor;
  if (cbs.applyVideoEditsToPreview) _applyVideoEditsToPreview = cbs.applyVideoEditsToPreview;
  if (cbs.scrollToBottom) _scrollToBottom = cbs.scrollToBottom;
  if (cbs.appendExportedVideoCard) _appendExportedVideoCard = cbs.appendExportedVideoCard;
}

function _finalizeExportedVideo(exportedUrl) {
  _appendExportedVideoCard(exportedUrl);
}

export async function applyRangedSpeedToCurrentVideo({ start, end, speed }) {
  const startSec = Math.max(0, Number(start) || 0);
  const endSec = Math.max(startSec + 0.5, Number(end) || startSec + 3);
  const spd = Math.max(0.5, Math.min(2, Number(speed) || 1));

  state.videoEdit = {
    ...state.videoEdit,
    speed: String(spd),
    timeline: {
      ...(state.videoEdit?.timeline || {}),
      keyframes: {
        ...(state.videoEdit?.timeline?.keyframes || { mask: [], color: [], bgm: [], motion: [] }),
        motion: [startSec, endSec],
      },
      selectedTrack: "motion",
      playhead: startSec,
    },
    activeModule: "motion",
  };
  _applyVideoEditsToPreview();
  _pushSystemStateMsg(t("speedRangeApplying", { start: startSec.toFixed(1), end: endSec.toFixed(1), speed: spd }), "progress");
  try {
    const base = getApiBase();
    const resp = await postJson(`${base}/api/video/edit/export`, { video_url: toAbsoluteVideoUrl(state.lastVideoUrl), edits: state.videoEdit }, 240000);
    const exportedUrl = String(resp?.video_url || "").trim();
    if (!exportedUrl) throw new Error("exported url missing");
    pushVideoUrlToHistory();
    _finalizeExportedVideo(exportedUrl);
    _pushSystemStateMsg(t("speedRangeApplied", { start: startSec.toFixed(1), end: endSec.toFixed(1) }), "done");
  } catch (_e) {
    _applyVideoEditsToPreview();
    const msg = String(_e?.message || "").trim();
    _pushSystemStateMsg(msg ? `${t("speedIntentFailed")}（${msg}）` : t("speedIntentFailed"), "blocked");
  }
}

export async function applyColorGradingToCurrentVideo({ bright = 0, sat = 0, hue = 0, contrast = 0 }) {
  state.videoEdit = {
    ...state.videoEdit,
    // hue intent → tint field (backend: tint_val drives the hue= ffmpeg filter)
    tint: Number(state.videoEdit?.tint || 0) + (Number(hue) || 0),
    sat: Number(state.videoEdit?.sat || 0) + (Number(sat) || 0),
    vibrance: Number(state.videoEdit?.vibrance || 0) + (Number(bright) || 0),
    // contrast is now a direct backend parameter (combined with temp-derived contrast)
    contrast: Number(state.videoEdit?.contrast || 0) + (Number(contrast) || 0),
  };
  _applyVideoEditsToPreview();
  _pushSystemStateMsg(t("colorIntentApplying"), "progress");
  try {
    const base = getApiBase();
    const resp = await postJson(`${base}/api/video/edit/export`, { video_url: toAbsoluteVideoUrl(state.lastVideoUrl), edits: state.videoEdit }, 240000);
    const exportedUrl = String(resp?.video_url || "").trim();
    if (!exportedUrl) throw new Error("exported url missing");
    pushVideoUrlToHistory();
    _finalizeExportedVideo(exportedUrl);
    _pushSystemStateMsg(t("colorIntentApplied"), "done");
  } catch (_e) {
    _applyVideoEditsToPreview();
    _pushSystemStateMsg(t("colorIntentFailed"), "blocked");
  }
}

export async function applyBgmEditToCurrentVideo({ action, volume }) {
  if (action === "remove") {
    state.videoEdit = { ...state.videoEdit, bgmExtract: false, bgmVolume: 0 };
  } else if (action === "lower") {
    state.videoEdit = { ...state.videoEdit, bgmVolume: Math.max(0, Number(volume) || 30) };
  } else if (action === "raise") {
    state.videoEdit = { ...state.videoEdit, bgmVolume: Math.min(100, Number(volume) || 80) };
  }
  _applyVideoEditsToPreview();
  _pushSystemStateMsg(t("bgmIntentApplying"), "progress");
  try {
    const base = getApiBase();
    const resp = await postJson(`${base}/api/video/edit/export`, { video_url: toAbsoluteVideoUrl(state.lastVideoUrl), edits: state.videoEdit }, 240000);
    const exportedUrl = String(resp?.video_url || "").trim();
    if (!exportedUrl) throw new Error("exported url missing");
    pushVideoUrlToHistory();
    _finalizeExportedVideo(exportedUrl);
    _pushSystemStateMsg(t("bgmIntentApplied"), "done");
  } catch (_e) {
    _applyVideoEditsToPreview();
    _pushSystemStateMsg(t("bgmIntentFailed"), "blocked");
  }
}

// ── New edit helpers ────────────────────────────────────────────────────────

// ── Video URL history — localStorage persistence ─────────────────────────
const _HIST_KEY = "shoplive.videoUrlHistory";
function _saveVideoHistory() {
  try { localStorage.setItem(_HIST_KEY, JSON.stringify(state.videoUrlHistory || [])); } catch (_e) {}
}
export function _loadVideoHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(_HIST_KEY) || "[]");
    if (Array.isArray(saved)) state.videoUrlHistory = saved.slice(-10);
  } catch (_e) {}
}

/** Push current video URL onto the undo stack (max 10) and persist to localStorage. */
export function pushVideoUrlToHistory() {
  if (!state.lastVideoUrl) return;
  state.videoUrlHistory = [...(state.videoUrlHistory || []), state.lastVideoUrl].slice(-10);
  _saveVideoHistory();
}

function _getLoadedVideoDurationSec() {
  const videos = Array.from(document.querySelectorAll(".video-edit-surface video"));
  for (const video of videos) {
    const dur = Number(video?.duration || 0);
    if (Number.isFinite(dur) && dur > 0) return dur;
  }
  return 0;
}

/**
 * Poll an async timeline render job until done/failed/cancelled.
 * Updates bubbleEl text with live progress %.
 * @returns result object (has .video_url) on success, throws on failure.
 */
export async function pollRenderJob(base, jobId, bubbleEl, labelStart, labelEnd) {
  const bodyEl = bubbleEl?.querySelector("[data-msg-body]");
  const zh = currentLang === "zh";
  const maxWait = 300000; // 5 min
  const t0 = Date.now();
  let _lastPct = -1; // throttle DOM writes — only update when % changes
  while (Date.now() - t0 < maxWait) {
    await new Promise((r) => setTimeout(r, 1500));
    let s;
    try {
      const r = await fetch(`${base}/api/video/timeline/render/status?job_id=${encodeURIComponent(jobId)}`);
      s = await r.json();
    } catch (_e) { continue; }
    const { status: js, progress = 0, result, error } = s;
    const pct = Math.min(99, Math.round(progress));
    if (bodyEl && pct !== _lastPct) {
      _lastPct = pct;
      const range = labelStart != null ? ` (${labelStart}s → ${labelEnd}s)` : "";
      bodyEl.textContent = zh ? `✂️ 渲染中 ${pct}%…${range}` : `✂️ Rendering ${pct}%…${range}`;
    }
    if (js === "done") return result;
    if (js === "failed") throw new Error(error || "render failed");
    if (js === "cancelled") throw new Error("cancelled");
  }
  throw new Error("render timeout");
}

/** Trim video to [start, end] seconds via async timeline render with live progress. */
export async function applyTrimToCurrentVideo({ start, end }) {
  if (!state.lastVideoUrl) {
    _pushSystemStateMsg(t("trimIntentNoVideo"), "blocked");
    return;
  }
  const s = Math.max(0, Number(start) || 0);
  const loadedDuration = _getLoadedVideoDurationSec();
  const rawEnd = Math.max(s + 0.1, Number(end) || s + 3);
  const e = loadedDuration > 0 ? Math.min(rawEnd, loadedDuration) : rawEnd;
  const bubble = _pushSystemStateMsg(t("trimIntentApplying", { start: s.toFixed(1), end: e.toFixed(1) }), "progress");
  pushVideoUrlToHistory();
  try {
    const base = getApiBase();
    // Launch async job so we can poll progress in real-time
    const initResp = await postJson(
      `${base}/api/video/timeline/render`,
      {
        source_video_url: toAbsoluteVideoUrl(state.lastVideoUrl),
        tracks: [{
          label: "Video", track_type: "video", enabled: true, muted: false, order: 0,
          segments: [{ left: 0, width: 100, start_seconds: s, end_seconds: e, source_index: 0 }],
        }],
        duration_seconds: loadedDuration > 0 ? loadedDuration : undefined,
        async_job: true,
      },
      30000
    );
    if (!initResp?.job_id) throw new Error("no job_id returned");
    const result = await pollRenderJob(base, initResp.job_id, bubble, s.toFixed(1), e.toFixed(1));
    const exportedUrl = String(result?.video_url || "").trim();
    if (!exportedUrl) throw new Error("url missing");
    _finalizeExportedVideo(exportedUrl);
    _pushSystemStateMsg(t("trimIntentApplied", { start: s.toFixed(1), end: e.toFixed(1) }), "done");
  } catch (_e) {
    state.videoUrlHistory = (state.videoUrlHistory || []).slice(0, -1); // rollback on fail
    _saveVideoHistory();
    const msg = String(_e?.message || "").trim();
    _pushSystemStateMsg(msg ? `${t("trimIntentFailed")}（${msg}）` : t("trimIntentFailed"), "blocked");
  }
}

/** Trim video keeping multiple non-contiguous segments, e.g. "保留1-3s和7-10s". */
export async function applyMultiTrimToCurrentVideo({ segments }) {
  if (!state.lastVideoUrl) {
    _pushSystemStateMsg(t("trimIntentNoVideo"), "blocked");
    return;
  }
  const loadedDuration = _getLoadedVideoDurationSec();
  const segs = (segments || [])
    .map((s) => {
      const start = Math.max(0, Number(s.start) || 0);
      const rawEnd = Math.max(start + 0.1, Number(s.end) || 0.1);
      const end = loadedDuration > 0 ? Math.min(rawEnd, loadedDuration) : rawEnd;
      return { start, end };
    })
    .filter((s) => s.end > s.start);
  if (!segs.length) return;
  const zh = currentLang === "zh";
  const bubble = _pushSystemStateMsg(
    zh ? `✂️ 保留 ${segs.length} 段，渲染中…` : `✂️ Keeping ${segs.length} segments, rendering…`,
    "progress"
  );
  pushVideoUrlToHistory();
  try {
    const base = getApiBase();
    const initResp = await postJson(
      `${base}/api/video/timeline/render`,
      {
        source_video_url: toAbsoluteVideoUrl(state.lastVideoUrl),
        tracks: [{
          label: "Video", track_type: "video", enabled: true, muted: false, order: 0,
          segments: segs.map((s, i) => ({
            left: (i / segs.length) * 100,
            width: 100 / segs.length,
            start_seconds: s.start,
            end_seconds: s.end,
            source_index: 0,
          })),
        }],
        duration_seconds: loadedDuration > 0 ? loadedDuration : undefined,
        async_job: true,
      },
      30000
    );
    if (!initResp?.job_id) throw new Error("no job_id returned");
    const result = await pollRenderJob(base, initResp.job_id, bubble);
    const exportedUrl = String(result?.video_url || "").trim();
    if (!exportedUrl) throw new Error("url missing");
    _finalizeExportedVideo(exportedUrl);
    _pushSystemStateMsg(zh ? `✂️ 已保留 ${segs.length} 段` : `✂️ Kept ${segs.length} segments`, "done");
  } catch (_e) {
    state.videoUrlHistory = (state.videoUrlHistory || []).slice(0, -1);
    _saveVideoHistory();
    const msg = String(_e?.message || "").trim();
    _pushSystemStateMsg(msg ? `${t("trimIntentFailed")}（${msg}）` : t("trimIntentFailed"), "blocked");
  }
}

/**
 * Apply subtitle style (color / position) as an instant CSS preview.
 * Shows a confirm prompt in chat — export only happens on user confirmation.
 */
export function applySubtitleStyleToCurrentVideo({ color, position }) {
  if (!state.lastVideoUrl) {
    _pushSystemStateMsg(t("speedIntentNoVideo"), "blocked");
    return;
  }
  const newEdit = { ...state.videoEdit };
  if (color) newEdit.maskColor = color;
  if (position === "center") { newEdit.x = 50; newEdit.y = 50; }
  state.videoEdit = newEdit;
  _applyVideoEditsToPreview();

  // Store the export callback and show an inline confirm prompt
  state.pendingEditExport = async () => {
    pushVideoUrlToHistory();
    const base = getApiBase();
    const resp = await postJson(
      `${base}/api/video/edit/export`,
      { video_url: toAbsoluteVideoUrl(state.lastVideoUrl), edits: state.videoEdit },
      240000
    );
    const exportedUrl = String(resp?.video_url || "").trim();
    if (!exportedUrl) throw new Error("exported url missing");
    _finalizeExportedVideo(exportedUrl);
  };

  const confirmId = `preview-confirm-${Date.now()}`;
  _cbRegistry.set(`${confirmId}:ok`, async () => {
    _cbCleanup(`${confirmId}:ok`, `${confirmId}:cancel`);
    const fn = state.pendingEditExport;
    state.pendingEditExport = null;
    document.getElementById(confirmId)?.remove();
    if (!fn) return;
    _pushSystemStateMsg(t("videoExporting"), "progress");
    try {
      await fn();
      _pushSystemStateMsg(t("subtitleStyleExportDone"), "done");
    } catch (_e) {
      _pushSystemStateMsg(t("subtitleStyleExportFail"), "blocked");
    }
  });
  _cbRegistry.set(`${confirmId}:cancel`, () => {
    _cbCleanup(`${confirmId}:ok`, `${confirmId}:cancel`);
    state.pendingEditExport = null;
    document.getElementById(confirmId)?.remove();
    _pushSystemStateMsg(t("subtitleStyleCancelled"), "done");
  });

  _pushSystemGuideMsg(
    `${t("subtitleStyleApplied")} <span id="${confirmId}" style="display:inline-flex;gap:6px;margin-top:6px;">` +
    `<button class="action-chip-btn" onclick="window.__shopliveCb('${confirmId}:ok')">${t("subtitleStyleConfirmBtn")}</button>` +
    `<button class="action-chip-btn" onclick="window.__shopliveCb('${confirmId}:cancel')">${t("subtitleStyleCancelBtn")}</button>` +
    `</span>`
  );
}

/** Restore the most recent URL from undo history. */
export async function applyUndoLastEdit() {
  const history = state.videoUrlHistory || [];
  if (history.length === 0) {
    _pushSystemStateMsg(t("undoNoHistory"), "blocked");
    return;
  }
  const prevUrl = history[history.length - 1];
  state.videoUrlHistory = history.slice(0, -1);
  _saveVideoHistory();
  state.lastVideoUrl = prevUrl;
  const edVid = document.getElementById("videoEditorPanel")?.querySelector(".video-edit-surface video");
  if (edVid) edVid.src = prevUrl;
  _renderVideoEditor();
  _applyVideoEditsToPreview();
  _pushSystemStateMsg(t("undoApplied"), "done");
}


/**
 * Auto-generate subtitles from the current video using Gemini ASR.
 * Calls /api/video/asr, shows the timestamped subtitle list in chat,
 * then lets the user pick which ones to apply.
 */
export async function applyAsrSubtitlesToCurrentVideo() {
  if (!state.lastVideoUrl) {
    _pushSystemStateMsg(currentLang === "zh" ? "请先加载一段视频" : "Please load a video first", "blocked");
    return;
  }
  const zh = currentLang === "zh";
  const bubble = _pushSystemStateMsg(zh ? "🎙️ 正在识别视频语音，请稍候…" : "🎙️ Transcribing video audio…", "progress");
  try {
    const base = getApiBase();
    const resp = await postJson(`${base}/api/video/asr`, { video_url: toAbsoluteVideoUrl(state.lastVideoUrl) }, 150000);
    const subs = Array.isArray(resp?.subtitles) ? resp.subtitles : [];
    if (!subs.length) {
      const bodyEl = bubble?.querySelector("[data-msg-body]");
      if (bodyEl) bodyEl.textContent = zh ? "⚠️ 未检测到语音内容" : "⚠️ No speech detected";
      bubble?.classList.replace("status-tone-progress", "status-tone-blocked");
      return;
    }
    // Update bubble to show success
    const bodyEl = bubble?.querySelector("[data-msg-body]");
    if (bodyEl) bodyEl.textContent = zh ? `✅ 识别到 ${subs.length} 条字幕` : `✅ Found ${subs.length} subtitles`;
    bubble?.classList.replace("status-tone-progress", "status-tone-done");

    // Render subtitle list as a guide message with "Apply All" button
    const confirmId = `asr-confirm-${Date.now()}`;
    const lines = subs.slice(0, 8).map((s) => `[${s.start.toFixed(1)}s–${s.end.toFixed(1)}s] ${s.text}`);
    if (subs.length > 8) lines.push(`… (+${subs.length - 8} more)`);
    const listHtml = lines.map((l) => `<div style="font-size:12px;opacity:0.85;margin:2px 0">${l}</div>`).join("");

    _cbRegistry.set(`${confirmId}:apply`, async () => {
      // apply is one-time — clean up both keys
      _cbCleanup(`${confirmId}:apply`, `${confirmId}:copy`);
      document.getElementById(confirmId)?.remove();
      const applyBubble = _pushSystemStateMsg(
        zh ? `🖊️ 正在将 ${subs.length} 条字幕批量写入视频…` : `🖊️ Burning ${subs.length} subtitles into video…`,
        "progress"
      );
      const prevEdit = state.videoEdit || {};
      const editsWithSubs = {
        ...prevEdit,
        maskText: "",          // clear single-text field — batch subtitles take over
        maskColor: prevEdit.maskColor || "#ffffff",
        x: prevEdit.x ?? 50, y: prevEdit.y ?? 88,
        w: prevEdit.w ?? 80, h: prevEdit.h ?? 12,
        opacity: prevEdit.opacity ?? 90,
        subtitles: subs.map((s) => ({ text: s.text, start: s.start, end: s.end })),
      };
      const base2 = getApiBase();
      try {
        pushVideoUrlToHistory();
        const exportResp = await postJson(
          `${base2}/api/video/edit/export`,
          { video_url: toAbsoluteVideoUrl(state.lastVideoUrl), edits: editsWithSubs },
          300000
        );
        const url = String(exportResp?.video_url || "").trim();
        if (!url) throw new Error("url missing");
        state.videoEdit = { ...prevEdit, maskText: "", subtitles: editsWithSubs.subtitles };
        _finalizeExportedVideo(url);
        const bodyEl2 = applyBubble?.querySelector("[data-msg-body]");
        if (bodyEl2) bodyEl2.textContent = zh ? `✅ 已批量写入 ${subs.length} 条字幕` : `✅ ${subs.length} subtitles burned in`;
        applyBubble?.classList.replace("status-tone-progress", "status-tone-done");
      } catch (_e) {
        state.videoUrlHistory = (state.videoUrlHistory || []).slice(0, -1);
        _saveVideoHistory();
        const bodyEl2 = applyBubble?.querySelector("[data-msg-body]");
        if (bodyEl2) bodyEl2.textContent = zh ? "❌ 字幕写入失败" : "❌ Subtitle burn failed";
        applyBubble?.classList.replace("status-tone-progress", "status-tone-blocked");
      }
    });
    // copy is idempotent — keep in registry so user can press it multiple times
    _cbRegistry.set(`${confirmId}:copy`, () => {
      const text = subs.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n");
      navigator.clipboard?.writeText(text).then(() => {
        _pushSystemStateMsg(zh ? "已复制字幕到剪贴板" : "Subtitles copied to clipboard", "done");
      });
    });

    _pushSystemGuideMsg(
      `${zh ? "🎙️ 识别到以下字幕：" : "🎙️ Detected subtitles:"}\n${listHtml}` +
      `<span id="${confirmId}" style="display:inline-flex;gap:6px;margin-top:8px;">` +
      `<button class="action-chip-btn" onclick="window.__shopliveCb('${confirmId}:apply')">${zh ? "全部写入视频" : "Burn all"}</button>` +
      `<button class="action-chip-btn" onclick="window.__shopliveCb('${confirmId}:copy')">${zh ? "复制全部" : "Copy all"}</button>` +
      `</span>`
    );
  } catch (e) {
    const bodyEl = bubble?.querySelector("[data-msg-body]");
    if (bodyEl) bodyEl.textContent = zh ? `❌ 识别失败: ${e?.message || ""}` : `❌ Failed: ${e?.message || ""}`;
    bubble?.classList.replace("status-tone-progress", "status-tone-blocked");
  }
}

/**
 * Overlay the first uploaded product image onto the current video using ffmpeg.
 * Calls /api/video/overlay-image. Image source: state.images[0] (data-URL or {base64, mime}).
 */
export async function applyImageOverlayToCurrentVideo({ scale = 0.35, position = "top-right" } = {}) {
  const zh = currentLang === "zh";
  if (!state.lastVideoUrl) {
    _pushSystemStateMsg(zh ? "请先加载一段视频" : "Please load a video first", "blocked");
    return;
  }
  // Find the first uploaded image
  const imgs = Array.isArray(state.images) ? state.images : [];
  if (!imgs.length) {
    _pushSystemStateMsg(
      zh ? "未找到商品图，请先在工作区上传一张商品图" : "No product image found. Please upload one first.",
      "blocked"
    );
    return;
  }
  const img = imgs[0];
  // image can be a data URL string or an object with base64/mime
  let imageBase64 = "";
  let imageMime = "image/jpeg";
  if (typeof img === "string" && img.startsWith("data:")) {
    const comma = img.indexOf(",");
    const header = img.slice(0, comma);
    imageMime = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
    imageBase64 = img.slice(comma + 1);
  } else if (img && typeof img === "object") {
    imageBase64 = String(img.base64 || "").replace(/^data:[^,]+,/, "");
    imageMime = String(img.mime_type || img.mime || "image/jpeg");
  }
  if (!imageBase64) {
    _pushSystemStateMsg(zh ? "图片数据无效" : "Image data invalid", "blocked");
    return;
  }

  const posLabel = { "top-left": "左上", "top-right": "右上", "center": "居中", "bottom-left": "左下", "bottom-right": "右下" };
  const bubble = _pushSystemStateMsg(
    zh ? `🖼️ 叠加商品图（${posLabel[position] || position}，${Math.round(scale * 100)}%）…` : `🖼️ Overlaying product image…`,
    "progress"
  );
  pushVideoUrlToHistory();
  try {
    const base = getApiBase();
    const resp = await postJson(
      `${base}/api/video/overlay-image`,
      {
        video_url: toAbsoluteVideoUrl(state.lastVideoUrl),
        image_base64: imageBase64,
        image_mime_type: imageMime,
        overlay_scale: scale,
        overlay_position: position,
      },
      120000
    );
    const exportedUrl = String(resp?.video_url || "").trim();
    if (!exportedUrl) throw new Error("url missing");
    _finalizeExportedVideo(exportedUrl);
    const bodyEl = bubble?.querySelector("[data-msg-body]");
    if (bodyEl) bodyEl.textContent = zh ? "✅ 商品图已叠加到视频" : "✅ Image overlaid on video";
    bubble?.classList.replace("status-tone-progress", "status-tone-done");
  } catch (_e) {
    state.videoUrlHistory = (state.videoUrlHistory || []).slice(0, -1);
    _saveVideoHistory();
    const bodyEl = bubble?.querySelector("[data-msg-body]");
    if (bodyEl) bodyEl.textContent = zh ? `❌ 叠加失败: ${_e?.message || ""}` : `❌ Overlay failed: ${_e?.message || ""}`;
    bubble?.classList.replace("status-tone-progress", "status-tone-blocked");
  }
}

export async function applySubtitleToCurrentVideo(intent = {}) {
  const { start = 0, end = 3, text = "" } = intent;
  if (!state.lastVideoUrl) {
    _pushSystemStateMsg(t("subtitleIntentNoVideo"), "blocked");
    return;
  }
  if (!text.trim()) return;

  // Update videoEdit state: set mask text + time range via keyframe
  const startSec = Math.max(0, Number(start) || 0);
  const endSec = Math.max(startSec + 0.5, Number(end) || startSec + 3);

  const prevEdit = state.videoEdit || {};
  state.videoEdit = {
    ...prevEdit,
    maskText: text.trim(),
    maskStyle: prevEdit.maskStyle || "elegant",
    maskFont: prevEdit.maskFont || "sans",
    maskColor: prevEdit.maskColor || "#ffffff",
    x: prevEdit.x ?? 10,
    y: prevEdit.y ?? 80,
    w: prevEdit.w ?? 80,
    h: prevEdit.h ?? 12,
    opacity: prevEdit.opacity ?? 90,
    rotation: prevEdit.rotation ?? 0,
    timeline: {
      ...(prevEdit.timeline || {}),
      keyframes: {
        ...(prevEdit.timeline?.keyframes || { mask: [], color: [], bgm: [], motion: [] }),
        // Add keyframes bracketing the subtitle range so only that segment is active
        mask: [startSec, endSec].filter((v, i, arr) => arr.indexOf(v) === i).sort((a, b) => a - b),
      },
      selectedTrack: "mask",
      playhead: startSec,
    },
    activeModule: "mask",
  };
  _applyVideoEditsToPreview();

  _pushSystemStateMsg(
    t("subtitleIntentApplying", { start: startSec.toFixed(1), end: endSec.toFixed(1), text: text.trim() }),
    "progress"
  );
  try {
    const base = getApiBase();
    const resp = await postJson(
      `${base}/api/video/edit/export`,
      { video_url: toAbsoluteVideoUrl(state.lastVideoUrl), edits: state.videoEdit },
      240000
    );
    const exportedUrl = String(resp?.video_url || "").trim();
    if (!exportedUrl) throw new Error("exported url missing");
    pushVideoUrlToHistory();
    _finalizeExportedVideo(exportedUrl);
    _pushSystemStateMsg(
      t("subtitleIntentApplied", { start: startSec.toFixed(1), end: endSec.toFixed(1) }),
      "done"
    );
  } catch (_e) {
    _applyVideoEditsToPreview();
    _pushSystemStateMsg(t("subtitleIntentFailed"), "blocked");
  }
}

export async function applyPlaybackSpeedToCurrentVideo(speed = 1) {
  const normalized = Math.max(0.5, Math.min(2, Number(speed) || 1));
  if (!state.lastVideoUrl) {
    _pushSystemStateMsg(t("speedIntentNoVideo"), "blocked");
    return;
  }
  state.videoEdit = {
    ...state.videoEdit,
    speed: String(normalized),
  };
  const speedSelect = document.getElementById("videoEditorPanel")?.querySelector("#videoEditSpeed");
  if (speedSelect) speedSelect.value = String(normalized);
  _applyVideoEditsToPreview();
  _pushSystemStateMsg(t("speedIntentApplying", { speed: normalized.toFixed(2).replace(/\.00$/, "") }), "progress");
  try {
    const base = getApiBase();
    const resp = await postJson(
      `${base}/api/video/edit/export`,
      {
        video_url: toAbsoluteVideoUrl(state.lastVideoUrl),
        edits: state.videoEdit,
      },
      240000
    );
    const exportedUrl = String(resp?.video_url || "").trim();
    if (!exportedUrl) throw new Error("exported url missing");
    pushVideoUrlToHistory();
    _finalizeExportedVideo(exportedUrl);
    _pushSystemStateMsg(t("speedIntentApplied", { speed: normalized.toFixed(2).replace(/\.00$/, "") }), "done");
  } catch (_e) {
    _applyVideoEditsToPreview();
    const msg = String(_e?.message || "").trim();
    _pushSystemStateMsg(msg ? `${t("speedIntentFailed")}（${msg}）` : t("speedIntentFailed"), "blocked");
  }
}

/**
 * Apply fade-in / fade-out to the current video via /api/video/edit/export.
 * intent = { fadeIn: 0.5, fadeOut: 0.5 }
 */
export async function applyFadeToCurrentVideo({ fadeIn = 0, fadeOut = 0 } = {}) {
  const zh = currentLang === "zh";
  if (!state.lastVideoUrl) {
    _pushSystemStateMsg(zh ? "请先加载视频" : "Please load a video first", "blocked");
    return;
  }
  const fi = Math.max(0, Math.min(3, Number(fadeIn) || 0));
  const fo = Math.max(0, Math.min(3, Number(fadeOut) || 0));
  if (!fi && !fo) {
    _pushSystemStateMsg(zh ? "请指定淡入或淡出时长（如 0.5 秒）" : "Please specify fade-in or fade-out duration", "blocked");
    return;
  }
  const parts = [];
  if (fi) parts.push(zh ? `淡入 ${fi}s` : `fade-in ${fi}s`);
  if (fo) parts.push(zh ? `淡出 ${fo}s` : `fade-out ${fo}s`);
  const label = parts.join(" + ");
  const bubble = _pushSystemStateMsg(
    zh ? `🎬 正在添加${label}效果…` : `🎬 Applying ${label}…`, "progress"
  );
  try {
    const base = getApiBase();
    const resp = await postJson(
      `${base}/api/video/edit/export`,
      { video_url: toAbsoluteVideoUrl(state.lastVideoUrl), edits: { ...state.videoEdit, fadeIn: fi, fadeOut: fo } },
      240000
    );
    const exportedUrl = String(resp?.video_url || "").trim();
    if (!exportedUrl) throw new Error("exported url missing");
    pushVideoUrlToHistory(); // save old URL before overwriting (consistent with other apply* fns)
    _finalizeExportedVideo(exportedUrl);
    const bodyEl = bubble?.querySelector("[data-msg-body]");
    if (bodyEl) bodyEl.textContent = zh ? `✅ ${label} 已应用` : `✅ ${label} applied`;
    bubble?.classList.replace("status-tone-progress", "status-tone-done");
  } catch (_e) {
    const bodyEl = bubble?.querySelector("[data-msg-body]");
    if (bodyEl) bodyEl.textContent = zh ? `❌ 淡入淡出失败` : `❌ Fade failed`;
    bubble?.classList.replace("status-tone-progress", "status-tone-blocked");
  }
}
