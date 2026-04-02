import { state } from './state.js';
import { currentLang, t } from './i18n.js';
import { getApiBase, toAbsoluteVideoUrl, postJson } from './utils.js';

// Callbacks injected by index.js (avoids circular deps)
let _openEditorPanel = () => {};
let _updateWorkspaceTabs = () => {};
let _updateWorkspaceToolbarVisibility = () => {};
let _updateGenerationGateUI = () => {};
let _scrollToBottom = () => {};
let _getActiveVideoCardId = () => "";
let _applyWorkspaceMode = () => {};
let _pushSystemStateMsg = () => null;
let _setActionButtonState = () => {};
let _sanitizeInputValue = (v) => String(v || "");

export function initVideoEditorCallbacks(cbs) {
  if (cbs.openEditorPanel) _openEditorPanel = cbs.openEditorPanel;
  if (cbs.updateWorkspaceTabs) _updateWorkspaceTabs = cbs.updateWorkspaceTabs;
  if (cbs.updateWorkspaceToolbarVisibility) _updateWorkspaceToolbarVisibility = cbs.updateWorkspaceToolbarVisibility;
  if (cbs.updateGenerationGateUI) _updateGenerationGateUI = cbs.updateGenerationGateUI;
  if (cbs.scrollToBottom) _scrollToBottom = cbs.scrollToBottom;
  if (cbs.getActiveVideoCardId) _getActiveVideoCardId = cbs.getActiveVideoCardId;
  if (cbs.applyWorkspaceMode) _applyWorkspaceMode = cbs.applyWorkspaceMode;
  if (cbs.pushSystemStateMsg) _pushSystemStateMsg = cbs.pushSystemStateMsg;
  if (cbs.setActionButtonState) _setActionButtonState = cbs.setActionButtonState;
  if (cbs.sanitizeInputValue) _sanitizeInputValue = cbs.sanitizeInputValue;
}

export function getVideoDurationSec() {
  const d = Number(state.duration || 8);
  return Number.isFinite(d) && d > 0 ? d : 8;
}

export function fmtSec(sec = 0) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `0:${String(s).padStart(2, "0")}`;
}

export function getTimelineSnapCandidates(ignoreTrack = "", ignoreIdx = -1) {
  const tl = state.videoEdit?.timeline;
  if (!tl?.keyframes) return [];
  const tracks = ["mask", "color", "bgm", "motion"];
  const out = [];
  tracks.forEach((track) => {
    const list = Array.isArray(tl.keyframes[track]) ? tl.keyframes[track] : [];
    list.forEach((sec, idx) => {
      if (track === ignoreTrack && idx === ignoreIdx) return;
      out.push(Number(sec));
    });
  });
  return out.filter((v) => Number.isFinite(v));
}

export function snapTimelineSec(sec, maxDelta = 0.2, ignoreTrack = "", ignoreIdx = -1) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return 0;
  const pool = getTimelineSnapCandidates(ignoreTrack, ignoreIdx);
  if (!pool.length) return n;
  let best = n;
  let bestDelta = Number.POSITIVE_INFINITY;
  pool.forEach((v) => {
    const d = Math.abs(v - n);
    if (d < bestDelta) {
      best = v;
      bestDelta = d;
    }
  });
  return bestDelta <= maxDelta ? best : n;
}

export function ensureTimelineState() {
  if (!state.videoEdit.timeline) {
    state.videoEdit.timeline = {
      playhead: 0,
      selectedTrack: "mask",
      pendingRangeStart: null,
      pendingRangeHoverSec: null,
      trackState: {
        mask: { visible: true, locked: false },
        color: { visible: true, locked: false },
        bgm: { visible: true, locked: false },
        motion: { visible: true, locked: false },
      },
      keyframes: { mask: [], color: [], bgm: [], motion: [] },
    };
  }
  const tl = state.videoEdit.timeline;
  if (!tl.trackState) {
    tl.trackState = {
      mask: { visible: true, locked: false },
      color: { visible: true, locked: false },
      bgm: { visible: true, locked: false },
      motion: { visible: true, locked: false },
    };
  }
  ["mask", "color", "bgm", "motion"].forEach((k) => {
    if (!tl.trackState[k] || typeof tl.trackState[k] !== "object") tl.trackState[k] = { visible: true, locked: false };
    tl.trackState[k].visible = tl.trackState[k].visible !== false;
    tl.trackState[k].locked = tl.trackState[k].locked === true;
  });
  if (!tl.keyframes) tl.keyframes = { mask: [], color: [], bgm: [], motion: [] };
  ["mask", "color", "bgm", "motion"].forEach((k) => {
    if (!Array.isArray(tl.keyframes[k])) tl.keyframes[k] = [];
    tl.keyframes[k] = tl.keyframes[k]
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);
  });
  if (typeof tl.selectedTrack !== "string") tl.selectedTrack = "mask";
  if (!["mask", "color", "bgm", "motion"].includes(tl.selectedTrack)) tl.selectedTrack = "mask";
  if (
    tl.pendingRangeStart
    && (
      typeof tl.pendingRangeStart !== "object"
      || !["mask", "color", "bgm", "motion"].includes(String(tl.pendingRangeStart.track || ""))
      || !Number.isFinite(Number(tl.pendingRangeStart.sec))
    )
  ) {
    tl.pendingRangeStart = null;
  }
  if (!Number.isFinite(Number(tl.pendingRangeHoverSec))) tl.pendingRangeHoverSec = null;
  if (typeof state.videoEdit.activeModule !== "string") state.videoEdit.activeModule = tl.selectedTrack;
  if (!["mask", "color", "bgm", "motion"].includes(state.videoEdit.activeModule)) state.videoEdit.activeModule = "mask";
  if (!Number.isFinite(Number(tl.playhead))) tl.playhead = 0;
}

export function buildTrackSegmentsHtml(trackId, points = [], maxSec = 8, isVisible = true) {
  if (!isVisible) return "";
  if (!points.length) return "";
  const list = points.slice().sort((a, b) => a - b);
  const bars = [];
  // Pairwise ranges: [k1,k2], [k3,k4] ... to support partial edits per segment.
  for (let i = 0; i < list.length - 1; i += 2) {
    const start = Math.max(0, Math.min(100, (list[i] / maxSec) * 100));
    const end = Math.max(0, Math.min(100, (list[i + 1] / maxSec) * 100));
    const width = Math.max(2, end - start);
    bars.push(
      `<i class="kf-seg kf-seg-${trackId}" data-track="${trackId}" data-start-idx="${i}" data-end-idx="${i + 1}" style="left:${start}%;width:${width}%"></i>`,
    );
  }
  if (list.length % 2 === 1) {
    const start = Math.max(0, Math.min(96, (list[list.length - 1] / maxSec) * 100));
    bars.push(`<i class="kf-seg kf-seg-${trackId} is-single" style="left:${start}%;width:4%"></i>`);
  }
  return bars.join("");
}

export function getTrackRangesByKeyframes(points = []) {
  const list = (Array.isArray(points) ? points : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const ranges = [];
  for (let i = 0; i < list.length - 1; i += 2) {
    const start = list[i];
    const end = list[i + 1];
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

export function isTrackActiveAtTime(trackId = "mask", sec = 0, timeline = null) {
  const tl = timeline && typeof timeline === "object" ? timeline : state.videoEdit?.timeline;
  const trackState = tl?.trackState?.[trackId] || { visible: true, locked: false };
  if (trackState.visible === false) return false;
  const points = Array.isArray(tl?.keyframes?.[trackId]) ? tl.keyframes[trackId] : [];
  // Backward compatibility: no ranges configured => global effect still active.
  if (points.length < 2) return true;
  const ranges = getTrackRangesByKeyframes(points);
  if (!ranges.length) return false;
  const t = Number(sec || 0);
  return ranges.some(([s, e]) => t >= s && t <= e);
}

export function buildTimelineRowsHtml(maxSec) {
  const tl = state.videoEdit.timeline;
  const trackDefs = [
    { id: "mask", label: t("timelineTrackMask") },
    { id: "color", label: t("timelineTrackColor") },
    { id: "bgm", label: t("timelineTrackBgm") },
    { id: "motion", label: t("timelineTrackMotion") },
  ];
  return trackDefs
    .map((track) => {
      const points = tl.keyframes[track.id] || [];
      const trackState = tl.trackState?.[track.id] || { visible: true, locked: false };
      const segments = buildTrackSegmentsHtml(track.id, points, maxSec, trackState.visible);
      const pending = (
        tl.pendingRangeStart
        && String(tl.pendingRangeStart.track || "") === track.id
        && Number.isFinite(Number(tl.pendingRangeStart.sec))
      )
        ? `<i class="kf-pending" style="left:${Math.max(0, Math.min(100, (Number(tl.pendingRangeStart.sec) / maxSec) * 100))}%"></i>`
        : "";
      const dots = points.length
        ? points
            .map((sec, idx) => {
              const left = Math.max(0, Math.min(100, (sec / maxSec) * 100));
              return `<button class="kf-dot" data-track="${track.id}" data-idx="${idx}" data-sec="${sec.toFixed(2)}" style="left:${left}%"></button>`;
            })
            .join("")
        : `<span class="kf-empty">${t("timelineNoKeyframe")}</span>`;
      return `
        <div class="kf-row ${state.videoEdit.activeModule === track.id ? "is-active" : ""} ${trackState.visible ? "" : "is-hidden"} ${trackState.locked ? "is-locked" : ""}" data-track="${track.id}">
          <div class="kf-label-wrap">
            <div class="kf-label">${track.label}</div>
            <div class="kf-controls">
              <button class="kf-ctrl ${trackState.visible ? "" : "is-off"}" data-action="toggle-visibility" data-track="${track.id}" title="${t("timelineToggleVisible")}">${trackState.visible ? "V" : "H"}</button>
              <button class="kf-ctrl ${trackState.locked ? "is-on" : ""}" data-action="toggle-lock" data-track="${track.id}" title="${t("timelineToggleLock")}">${trackState.locked ? "L" : "U"}</button>
            </div>
          </div>
          <div class="kf-track ${state.videoEdit.activeModule === track.id ? "is-active" : ""} ${trackState.visible ? "" : "is-hidden"} ${trackState.locked ? "is-locked" : ""}" data-track="${track.id}">
            ${segments}
            ${pending}
            ${dots}
          </div>
        </div>
      `;
    })
    .join("");
}

export function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function revokeLocalObjectUrl(url = "") {
  if (typeof url === "string" && url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch (_e) {}
  }
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read file failed"));
    reader.readAsDataURL(file);
  });
}

export function setupSurfaceFullscreen(surface) {
  if (!surface || surface.dataset.fsSetup) return;
  surface.dataset.fsSetup = "1";

  // Custom fullscreen button (shows on hover)
  const btn = document.createElement("button");
  btn.className = "video-fs-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", currentLang === "zh" ? "全屏预览（含蒙版/调色效果）" : "Fullscreen preview (with effects)");
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const req = surface.requestFullscreen || surface.webkitRequestFullscreen;
    if (req) req.call(surface).catch(err => console.debug("[shoplive]", err));
  });
  surface.appendChild(btn);
  // Global fullscreenchange in index.js handles inline-style reset and applyVideoEditsToPreview.
}

export function setupMaskDrag(surface) {
  if (!surface || surface.dataset.maskDragBound) return;
  surface.dataset.maskDragBound = "1";
  let dragging = false;
  let startX, startY, startPx, startPy;
  surface.addEventListener("pointerdown", (ev) => {
    const overlay = surface.querySelector(".video-subtitle-overlay");
    if (!overlay) return;
    const r = overlay.getBoundingClientRect();
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
    ev.preventDefault();
    dragging = true;
    surface.setPointerCapture(ev.pointerId);
    startX = state.videoEdit.x;
    startY = state.videoEdit.y;
    startPx = ev.clientX;
    startPy = ev.clientY;
    overlay.style.cursor = "grabbing";
  });
  surface.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const sr = surface.getBoundingClientRect();
    const dx = ((ev.clientX - startPx) / sr.width) * 100;
    const dy = ((ev.clientY - startPy) / sr.height) * 100;
    state.videoEdit.x = Math.max(0, Math.min(95, startX + dx));
    state.videoEdit.y = Math.max(0, Math.min(95, startY + dy));
    applyVideoEditsToPreview();
    // Sync sliders + display values in editor panel if open
    const xr = document.getElementById("videoEditorPanel")?.querySelector("#maskXRange");
    const yr = document.getElementById("videoEditorPanel")?.querySelector("#maskYRange");
    const xv = document.getElementById("videoEditorPanel")?.querySelector("#maskXVal");
    const yv = document.getElementById("videoEditorPanel")?.querySelector("#maskYVal");
    const rx = Math.round(state.videoEdit.x);
    const ry = Math.round(state.videoEdit.y);
    if (xr) xr.value = String(rx);
    if (yr) yr.value = String(ry);
    if (xv) xv.textContent = `${rx}%`;
    if (yv) yv.textContent = `${ry}%`;
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    const overlay = surface.querySelector(".video-subtitle-overlay");
    if (overlay) overlay.style.cursor = "grab";
  };
  surface.addEventListener("pointerup", endDrag);
  surface.addEventListener("pointercancel", endDrag);
}

const MASK_PRESETS = {
  elegant:    { bg: "transparent",          color: null, shadow: "0 1px 8px rgba(0,0,0,0.6)",  weight: "300", spacing: "0.15em", transform: "uppercase", pad: "0",        radius: "0",   border: "none" },
  bold:       { bg: "rgba(0,0,0,0.78)",     color: null, shadow: "none",                       weight: "900", spacing: "0.05em", transform: "uppercase", pad: "4px 14px", radius: "4px", border: "none" },
  soft:       { bg: "rgba(120,160,255,0.18)",color:null,  shadow: "0 1px 4px rgba(0,0,0,0.4)", weight: "400", spacing: "0.08em", transform: "none",      pad: "6px 16px", radius: "20px",border: "1px solid rgba(160,200,255,0.5)" },
  neon:       { bg: "transparent",          color: "#00f5d4", shadow: "0 0 8px #00f5d4,0 0 22px #00f5d4", weight: "700", spacing: "0.1em",  transform: "uppercase", pad: "0",        radius: "0",   border: "none" },
  luxury:     { bg: "rgba(10,8,4,0.65)",    color: "#d4af37", shadow: "0 1px 6px rgba(0,0,0,0.8)",        weight: "300", spacing: "0.22em", transform: "uppercase", pad: "6px 18px", radius: "2px", border: "1px solid rgba(212,175,55,0.5)" },
  minimal:    { bg: "rgba(255,255,255,0.06)",color: null, shadow: "none",                       weight: "200", spacing: "0.28em", transform: "uppercase", pad: "4px 8px",  radius: "0",   border: "none", borderBottom: "1px solid rgba(255,255,255,0.7)" },
  stamp:      { bg: "transparent",          color: null, shadow: "none",                       weight: "800", spacing: "0.04em", transform: "uppercase", pad: "4px 10px", radius: "2px", border: "2px solid currentColor" },
  cinematic:  { bg: "rgba(0,0,0,0.82)",     color: "#e5e5e5", shadow: "none",                  weight: "400", spacing: "0.14em", transform: "uppercase", pad: "8px 0",    radius: "0",   border: "none", fullWidth: true },
};
const MASK_FONTS = {
  sans:    '"PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif',
  serif:   '"Songti SC","SimSun","Times New Roman",serif',
  kai:     '"KaiTi","STKaiti",serif',
  impact:  '"Impact","Arial Black",sans-serif',
  rounded: '"PingFang SC","Hiragino Maru Gothic Pro",sans-serif',
  mono:    '"SF Mono","Consolas","Courier New",monospace',
};

export function applyVideoEditsToPreview() {
  const fx = state.videoEdit || {};
  const timeline = fx.timeline || state.videoEdit?.timeline || {};
  const bgmVolume = clampNum(Number(fx.bgmVolume || 70), 0, 100) / 100;

  const surfaces = Array.from(document.querySelectorAll(".video-edit-surface"));
  surfaces.forEach((surface) => {
    const video = surface.querySelector("video");
    if (!video) return;

    // Determine whether this surface belongs to the active card or the editor panel.
    // Only those should have edits applied — all other chat-card surfaces get reset.
    const parentCard = surface.closest("[data-task-card-id]");
    const isActiveCard = parentCard
      ? String(parentCard.getAttribute("data-task-card-id")) === String(state.activeVideoCardId || "")
      : true; // surfaces not inside a card (i.e. editor panel) are always active
    const isEditorPanel = Boolean(surface.closest("#videoEditorPanel"));
    const shouldApplyEdits = isActiveCard || isEditorPanel;

    if (!shouldApplyEdits) {
      // Reset this non-active card's video to neutral state
      video.playbackRate = 1;
      video.volume = 1;
      video.style.filter = "";
      surface.querySelector(".video-subtitle-overlay")?.remove();
      const staleAudio = surface.querySelector(".video-bgm-audio");
      if (staleAudio) {
        staleAudio.pause();
        staleAudio.removeAttribute("src");
        try { staleAudio.load(); } catch (_e) {}
      }
      return;
    }

    const sec = Number(video.currentTime || 0);
    const motionActive = isTrackActiveAtTime("motion", sec, timeline);
    const colorActive = isTrackActiveAtTime("color", sec, timeline);
    const maskActive = isTrackActiveAtTime("mask", sec, timeline);
    const bgmActive = isTrackActiveAtTime("bgm", sec, timeline);
    const speed = motionActive ? clampNum(fx.speed || 1, 0.5, 2) : 1;
    const sat = colorActive ? clampNum(100 + Number(fx.sat || 0) * 3, 20, 260) : 100;
    const bright = colorActive ? clampNum(100 + Number(fx.vibrance || 0) * 2, 40, 220) : 100;
    const contrast = colorActive ? clampNum(100 + Math.abs(Number(fx.temp || 0)) * 1.2, 60, 180) : 100;
    const hue = colorActive ? clampNum(Number(fx.tint || 0) * 1.8, -45, 45) : 0;
    video.playbackRate = speed;
    video.volume = bgmVolume;
    video.style.filter = `saturate(${sat}%) brightness(${bright}%) contrast(${contrast}%) hue-rotate(${hue}deg)`;

    surface.querySelector(".video-bgm-badge")?.remove();

    // Real-time text mask overlay — find-or-create so drag handlers survive re-renders
    const maskVisible = maskActive;
    const maskText = String(fx.maskText || "").trim();
    let overlay = surface.querySelector(".video-subtitle-overlay");
    if (!maskVisible || !maskText) {
      overlay?.remove();
    } else {
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "video-subtitle-overlay";
        surface.appendChild(overlay);
      }
      const ox = Number(fx.x ?? 10);
      const oy = Number(fx.y ?? 0);
      const ow = Number(fx.w ?? 80);
      const oh = Number(fx.h ?? 12);
      const oop = Number(fx.opacity ?? 90) / 100;
      const orot = Number(fx.rotation ?? 0);
      const pr = MASK_PRESETS[fx.maskStyle] || MASK_PRESETS.elegant;
      const fontStack = MASK_FONTS[fx.maskFont] || MASK_FONTS.sans;
      const textColor = pr.color || fx.maskColor || "#ffffff";
      const widthCSS = pr.fullWidth ? "left:0;width:100%;" : `left:${ox}%;width:${ow}%;`;
      const borderBottomCSS = pr.borderBottom ? `border-bottom:${pr.borderBottom};` : "";
      overlay.style.cssText = `position:absolute;${widthCSS}top:${oy}%;height:${oh}%;opacity:${oop};transform:rotate(${orot}deg);display:flex;align-items:center;justify-content:center;color:${textColor};font-family:${fontStack};font-size:clamp(11px,2.2vw,32px);font-weight:${pr.weight};letter-spacing:${pr.spacing};text-transform:${pr.transform};text-shadow:${pr.shadow};background:${pr.bg};padding:${pr.pad};border-radius:${pr.radius};border:${pr.border};${borderBottomCSS}pointer-events:auto;cursor:grab;z-index:2;user-select:none;`;
      overlay.textContent = maskText;
    }

    let bgmAudio = surface.querySelector(".video-bgm-audio");
    if (!bgmAudio) {
      bgmAudio = document.createElement("audio");
      bgmAudio.className = "video-bgm-audio";
      bgmAudio.preload = "auto";
      bgmAudio.hidden = true;
      surface.appendChild(bgmAudio);
    }
    const shouldUseLocalBgm = Boolean(fx.bgmExtract && fx.localBgmUrl && bgmActive);
    if (!shouldUseLocalBgm) {
      video.muted = false;
      bgmAudio.pause();
      if (bgmAudio.getAttribute("src")) {
        bgmAudio.removeAttribute("src");
        try {
          bgmAudio.load();
        } catch (_e) {}
      }
      return;
    }
    if (bgmAudio.getAttribute("src") !== fx.localBgmUrl) {
      bgmAudio.setAttribute("src", fx.localBgmUrl);
      try {
        bgmAudio.load();
      } catch (_e) {}
    }
    bgmAudio.loop = true;
    bgmAudio.volume = bgmVolume;
    bgmAudio.playbackRate = speed;
    video.muted = true;
    const syncBgm = () => {
      const target = Number(video.currentTime || 0);
      if (!Number.isFinite(target)) return;
      if (Math.abs((bgmAudio.currentTime || 0) - target) > 0.35) {
        try {
          bgmAudio.currentTime = target;
        } catch (_e) {}
      }
      if (!video.paused) {
        const p = bgmAudio.play();
        if (p && typeof p.catch === "function") p.catch(err => console.debug('[shoplive]', err));
      }
    };
    if (!surface.dataset.bgmBound) {
      const onPlay = () => syncBgm();
      const onPause = () => bgmAudio.pause();
      const onSeek = () => syncBgm();
      const onRate = () => {
        bgmAudio.playbackRate = clampNum(video.playbackRate || speed, 0.5, 2);
      };
      video.addEventListener("play", onPlay);
      video.addEventListener("pause", onPause);
      video.addEventListener("seeking", onSeek);
      video.addEventListener("seeked", onSeek);
      video.addEventListener("timeupdate", onSeek);
      video.addEventListener("ratechange", onRate);
      surface.dataset.bgmBound = "1";
      surface._bgmListeners = { onPlay, onPause, onSeek, onRate };
    }
    if (!surface.dataset.timelineFxBound) {
      const onTimelineTick = () => applyVideoEditsToPreview();
      video.addEventListener("timeupdate", onTimelineTick);
      video.addEventListener("seeking", onTimelineTick);
      video.addEventListener("seeked", onTimelineTick);
      surface.dataset.timelineFxBound = "1";
      surface._timelineFxListeners = { onTimelineTick };
    }
    syncBgm();
  });
}

export function renderVideoEditor() {
  if (!document.getElementById("videoEditorPanel")) return;
  if (!state.videoEditorOpen) return;
  const _currentHash = JSON.stringify({
    speed: state.videoEdit.speed,
    maskText: state.videoEdit.maskText,
    maskStyle: state.videoEdit.maskStyle,
    temp: state.videoEdit.temp,
    sat: state.videoEdit.sat,
    bgmMood: state.videoEdit.bgmMood,
    activeModule: state.videoEdit.activeModule,
    localBgmName: state.videoEdit.localBgmName,
    // Include active card context so switching cards always forces a re-render
    lastVideoUrl: state.lastVideoUrl,
    activeVideoCardId: state.activeVideoCardId,
  });
  if (_currentHash === state.videoEdit._renderHash && document.getElementById("videoEditorPanel")?.innerHTML) return;
  state.videoEdit._renderHash = _currentHash;
  if (typeof state.videoEdit._timelineKeydownHandler === "function") {
    window.removeEventListener("keydown", state.videoEdit._timelineKeydownHandler);
    state.videoEdit._timelineKeydownHandler = null;
  }
  const fx = state.videoEdit || {};
  ensureTimelineState();
  const tl = state.videoEdit.timeline;
  const activeModule = state.videoEdit.activeModule || tl.selectedTrack || "mask";
  const trackLabelMap = {
    mask: t("timelineTrackMask"),
    color: t("timelineTrackColor"),
    bgm: t("timelineTrackBgm"),
    motion: t("timelineTrackMotion"),
  };
  const activeTrackLabel = trackLabelMap[activeModule] || trackLabelMap.mask;
  const activeTrackState = tl.trackState?.[activeModule] || { visible: true, locked: false };
  const moduleSwitchHtml = ["mask", "color", "bgm", "motion"]
    .map(
      (id) =>
        `<button class="module-switch-btn ${activeModule === id ? "is-active" : ""}" data-module="${id}">${trackLabelMap[id]}</button>`,
    )
    .join("");
  const maskPresetKeys = ["elegant","bold","soft","neon","luxury","minimal","stamp","cinematic"];
  const maskPresetLabels = { elegant: t("textMaskElegant"), bold: t("textMaskBold"), soft: t("textMaskSoft"), neon: t("textMaskNeon"), luxury: t("textMaskLuxury"), minimal: t("textMaskMinimal"), stamp: t("textMaskStamp"), cinematic: t("textMaskCinematic") };
  const maskPresetCardsHtml = maskPresetKeys.map((key) => {
    const pr = MASK_PRESETS[key];
    const isActive = (fx.maskStyle || "elegant") === key;
    const previewColor = pr.color || fx.maskColor || "#ffffff";
    return `<button class="mask-preset-card${isActive ? " is-active" : ""}" data-preset="${key}" style="background:${pr.bg === "transparent" ? "rgba(30,36,60,0.7)" : pr.bg};border:${isActive ? "2px solid #54a8ff" : pr.border === "none" ? "1px solid rgba(255,255,255,0.15)" : pr.border};border-radius:${pr.radius || "6px"};color:${previewColor};font-weight:${pr.weight};letter-spacing:${pr.spacing};text-transform:${pr.transform};text-shadow:${pr.shadow};padding:6px 8px;cursor:pointer;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${maskPresetLabels[key]}">${maskPresetLabels[key]}</button>`;
  }).join("");
  const moduleEditorHtml =
    activeModule === "mask"
      ? `
        <label>${t("textMaskText")}<input id="maskTextInput" value="${_sanitizeInputValue(fx.maskText)}" placeholder="${currentLang === 'zh' ? '输入文字蒙版内容…' : 'Enter overlay text…'}" /></label>
        <p class="editor-note" style="margin:4px 0 8px;">${t("textMaskDragHint")}</p>
        <label>${t("textMaskStyle")}</label>
        <div class="mask-preset-grid">${maskPresetCardsHtml}</div>
        <div class="mask-font-color-row">
          <label style="flex:1;">${t("textMaskFont")}<select id="maskFontSelect">
            <option value="sans">${currentLang === "zh" ? "黑体（默认）" : "Gothic (default)"}</option>
            <option value="serif">${currentLang === "zh" ? "宋体" : "Serif / Ming"}</option>
            <option value="kai">${currentLang === "zh" ? "楷体" : "Kai / Script"}</option>
            <option value="impact">${currentLang === "zh" ? "超宽黑 Impact" : "Impact Bold"}</option>
            <option value="rounded">${currentLang === "zh" ? "圆体" : "Rounded"}</option>
            <option value="mono">${currentLang === "zh" ? "等宽" : "Monospace"}</option>
          </select></label>
          <label>${t("textMaskColor")}<input id="maskColorInput" type="color" value="${fx.maskColor || "#ffffff"}" style="width:44px;height:28px;padding:2px;cursor:pointer;" /></label>
        </div>
        <div class="range-grid">
          <label>${t("positionX")} <span id="maskXVal">${Number(fx.x || 0)}%</span><input id="maskXRange" type="range" min="0" max="95" value="${Number(fx.x || 0)}" /></label>
          <label>${t("positionY")} <span id="maskYVal">${Number(fx.y || 0)}%</span><input id="maskYRange" type="range" min="0" max="95" value="${Number(fx.y || 0)}" /></label>
          <label>${t("maskWidth")} <span id="maskWVal">${Number(fx.w || 80)}%</span><input id="maskWRange" type="range" min="10" max="100" value="${Number(fx.w || 80)}" /></label>
          <label>${t("maskHeight")} <span id="maskHVal">${Number(fx.h || 12)}%</span><input id="maskHRange" type="range" min="4" max="60" value="${Number(fx.h || 12)}" /></label>
          <label>${t("maskOpacity")} <span id="maskOVal">${Number(fx.opacity || 90)}%</span><input id="maskORange" type="range" min="0" max="100" value="${Number(fx.opacity || 90)}" /></label>
          <label>${t("maskRotation")} <span id="maskRVal">${Number(fx.rotation || 0)}deg</span><input id="maskRRange" type="range" min="-30" max="30" value="${Number(fx.rotation || 0)}" /></label>
        </div>
      `
      : activeModule === "color"
        ? `
          <div class="range-grid">
            <label>${t("colorTemp")} <span id="tempVal">${Number(fx.temp || 12)}</span><input id="tempRange" type="range" min="-30" max="30" value="${Number(fx.temp || 12)}" /></label>
            <label>${t("colorTint")} <span id="tintVal">${Number(fx.tint || 5)}</span><input id="tintRange" type="range" min="-30" max="30" value="${Number(fx.tint || 5)}" /></label>
            <label>${t("colorSat")} <span id="satVal">${Number(fx.sat || 8)}</span><input id="satRange" type="range" min="-30" max="30" value="${Number(fx.sat || 8)}" /></label>
            <label>${t("colorVibrance")} <span id="vibVal">${Number(fx.vibrance || 10)}</span><input id="vibRange" type="range" min="-30" max="30" value="${Number(fx.vibrance || 10)}" /></label>
          </div>
        `
        : activeModule === "bgm"
          ? `
            <label class="inline-check"><input id="bgmExtractChk" type="checkbox" ${fx.bgmExtract ? "checked" : ""} /> ${t("bgmExtract")}</label>
            <label>${t("bgmMood")}<select id="bgmMoodSelect">
              <option value="elegant">${t("bgmMoodElegant")}</option>
              <option value="daily">${t("bgmMoodDaily")}</option>
              <option value="trendy">${t("bgmMoodTrendy")}</option>
              <option value="piano">${t("bgmMoodPiano")}</option>
            </select></label>
            <label>${t("bgmReplace")}<select id="bgmReplaceModeSelect">
              <option value="auto">${t("bgmReplaceAuto")}</option>
              <option value="keep">${t("bgmReplaceKeep")}</option>
              <option value="beat">${t("bgmReplaceStrongBeat")}</option>
            </select></label>
            <label>${t("bgmVolume")} <span id="bgmVolVal">${Number(fx.bgmVolume || 70)}%</span><input id="bgmVolRange" type="range" min="0" max="100" value="${Number(fx.bgmVolume || 70)}" /></label>
            <label>${t("bgmLocalFile")}
              <input id="bgmFileInput" type="file" accept="audio/*" />
            </label>
            <div class="bgm-file-row">
              <span id="bgmFileName">${_sanitizeInputValue(fx.localBgmName || t("bgmNoLocalFile"))}</span>
              <button id="clearBgmFileBtn">${t("bgmClearFile")}</button>
            </div>
          `
          : `
            <label>${t("clipSpeed")}<select id="videoEditSpeed"><option value="0.75">0.75x</option><option value="1.0">1.0x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option></select></label>
            <p class="editor-note">${currentLang === "zh" ? "运动轨道用于控制全片速度与关键帧点位。" : "Motion track controls global speed and keyframe positions."}</p>
          `;
  const maxSec = getVideoDurationSec();
  const videoBlock = state.lastVideoUrl
    ? `<div class="video-edit-surface"><video controls controlslist="nofullscreen" src="${state.lastVideoUrl}"></video></div>`
    : `<div class="empty-video">${currentLang === "zh" ? "暂无视频，请先生成一次视频。" : "No video yet. Generate one first."}</div>`;
  document.getElementById("videoEditorPanel").innerHTML = `
    <div class="editor-head">
      <strong>${t("videoEditTitle")}</strong>
      <button class="editor-close-btn" id="closeVideoPanelBtn">${t("closePanel")}</button>
    </div>
    <p class="editor-hint">${t("videoEditHint")}</p>
    <div class="video-editor-shell">
      <div class="video-stage-grid">
        <div class="video-preview-wrap">${videoBlock}</div>
        <section class="editor-section module-panel">
          <h4>${t("videoModuleTitle")}</h4>
          <p class="editor-note">${t("videoModuleHint")}</p>
          ${activeTrackState.visible ? "" : `<p class="editor-note">${t("timelineTrackHidden")}</p>`}
          ${activeTrackState.locked ? `<p class="editor-note">${t("timelineTrackLocked")}</p>` : ""}
          <div class="module-switch">${moduleSwitchHtml}</div>
          <div class="video-editor-grid module-body">${moduleEditorHtml}</div>
        </section>
      </div>
      <section class="editor-section timeline-section">
        <h4>${t("timelineTitle")}</h4>
        <p class="editor-note">${t("timelineHint")}</p>
        <label>${t("timelinePlayhead")} <span id="playheadVal">${fmtSec(tl.playhead)}</span><input id="timelinePlayheadRange" type="range" min="0" max="${maxSec}" step="0.1" value="${Number(tl.playhead || 0)}" /></label>
        <p class="timeline-track-current">${t("timelineSelectTrack")}：<strong>${activeTrackLabel}</strong></p>
        <p class="timeline-pending-tip" id="timelinePendingTip">${tl.pendingRangeStart ? t("timelinePendingArmed", { time: fmtSec(Number(tl.pendingRangeStart.sec || 0)) }) : t("timelinePendingIdle")}</p>
        <div class="kf-ruler">
          <span>0:00</span><span>${fmtSec(Math.round(maxSec / 2))}</span><span>${fmtSec(maxSec)}</span>
          <i id="kfPlayheadLine" style="left:${Math.max(0, Math.min(100, (tl.playhead / maxSec) * 100))}%"></i>
        </div>
        <div class="kf-rows">${buildTimelineRowsHtml(maxSec)}</div>
        <div class="timeline-actions">
          <button id="addKeyframeBtn">${t("timelineAddKeyframe")}</button>
          <button id="removeKeyframeBtn">${t("timelineRemoveKeyframe")}</button>
        </div>
        <div class="timeline-mini-toast" id="timelineMiniToast"></div>
      </section>
    </div>
    <div class="editor-actions">
      <button id="downloadVideoBtn" class="action-chip-btn action-chip-primary">${t("videoDownload")}</button>
      <button id="regenFromVideoEditorBtn" class="action-chip-btn action-chip-secondary">${t("videoRegenerate")}</button>
      <button id="resetVideoEditorBtn" class="action-chip-btn action-chip-danger">${currentLang === "zh" ? "重置后处理" : "Reset post-edits"}</button>
    </div>
  `;
  const speedSelect = document.getElementById("videoEditorPanel").querySelector("#videoEditSpeed");
  const maskStyleSelect = document.getElementById("videoEditorPanel").querySelector("#maskStyleSelect");
  const moodSelect = document.getElementById("videoEditorPanel").querySelector("#bgmMoodSelect");
  const replaceSelect = document.getElementById("videoEditorPanel").querySelector("#bgmReplaceModeSelect");
  if (speedSelect) speedSelect.value = String(fx.speed || "1.0");
  if (maskStyleSelect) maskStyleSelect.value = String(fx.maskStyle || "elegant");
  if (moodSelect) moodSelect.value = String(fx.bgmMood || "elegant");
  if (replaceSelect) replaceSelect.value = String(fx.bgmReplaceMode || "auto");

  const bindRange = (id, outId, suffix = "") => {
    const input = document.getElementById("videoEditorPanel").querySelector(id);
    const out = document.getElementById("videoEditorPanel").querySelector(outId);
    if (!input || !out) return;
    const render = () => {
      out.textContent = `${input.value}${suffix}`;
    };
    input.addEventListener("input", render);
    render();
  };
  bindRange("#maskXRange", "#maskXVal", "%");
  bindRange("#maskYRange", "#maskYVal", "%");
  bindRange("#maskWRange", "#maskWVal", "%");
  bindRange("#maskHRange", "#maskHVal", "%");
  bindRange("#maskORange", "#maskOVal", "%");
  bindRange("#maskRRange", "#maskRVal", "deg");
  bindRange("#tempRange", "#tempVal");
  bindRange("#tintRange", "#tintVal");
  bindRange("#satRange", "#satVal");
  bindRange("#vibRange", "#vibVal");
  bindRange("#bgmVolRange", "#bgmVolVal", "%");

  // Set initial values for new selects
  const maskFontSelect = document.getElementById("videoEditorPanel").querySelector("#maskFontSelect");
  if (maskFontSelect) maskFontSelect.value = String(fx.maskFont || "sans");

  // Live-preview: write slider/select values back to state.videoEdit immediately
  const liveNum = (sel, key) => {
    document.getElementById("videoEditorPanel").querySelector(sel)?.addEventListener("input", (e) => {
      state.videoEdit[key] = Number(e.target.value);
      applyVideoEditsToPreview();
    });
  };
  const liveStr = (sel, key, evtName = "change") => {
    document.getElementById("videoEditorPanel").querySelector(sel)?.addEventListener(evtName, (e) => {
      state.videoEdit[key] = e.target.value;
      applyVideoEditsToPreview();
    });
  };
  // Mask preset cards
  document.getElementById("videoEditorPanel").querySelectorAll(".mask-preset-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.videoEdit.maskStyle = btn.getAttribute("data-preset") || "elegant";
      renderVideoEditor();  // re-render to update active card highlight
    });
  });
  // Mask text + font + color
  document.getElementById("videoEditorPanel").querySelector("#maskTextInput")?.addEventListener("input", (e) => {
    state.videoEdit.maskText = e.target.value;
    applyVideoEditsToPreview();
  });
  liveStr("#maskFontSelect", "maskFont");
  document.getElementById("videoEditorPanel").querySelector("#maskColorInput")?.addEventListener("input", (e) => {
    state.videoEdit.maskColor = e.target.value;
    applyVideoEditsToPreview();
  });
  liveNum("#maskXRange", "x");
  liveNum("#maskYRange", "y");
  liveNum("#maskWRange", "w");
  liveNum("#maskHRange", "h");
  liveNum("#maskORange", "opacity");
  liveNum("#maskRRange", "rotation");
  // Color
  liveNum("#tempRange", "temp");
  liveNum("#tintRange", "tint");
  liveNum("#satRange", "sat");
  liveNum("#vibRange", "vibrance");
  // Motion
  liveStr("#videoEditSpeed", "speed");
  // BGM
  liveNum("#bgmVolRange", "bgmVolume");
  document.getElementById("videoEditorPanel").querySelector("#bgmExtractChk")?.addEventListener("change", (e) => {
    state.videoEdit.bgmExtract = e.target.checked;
    applyVideoEditsToPreview();
  });
  liveStr("#bgmMoodSelect", "bgmMood");
  liveStr("#bgmReplaceModeSelect", "bgmReplaceMode");

  if (activeTrackState.locked) {
    document.getElementById("videoEditorPanel").querySelectorAll(".module-body input, .module-body select, .module-body button, #addKeyframeBtn, #removeKeyframeBtn").forEach((el) => {
      el.disabled = true;
    });
  }
  document.getElementById("videoEditorPanel").querySelectorAll(".module-switch-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mod = btn.getAttribute("data-module") || "mask";
      state.videoEdit.activeModule = mod;
      state.videoEdit.timeline.selectedTrack = mod;
      renderVideoEditor();
    });
  });

  const bgmFileInput = document.getElementById("videoEditorPanel").querySelector("#bgmFileInput");
  const bgmFileName = document.getElementById("videoEditorPanel").querySelector("#bgmFileName");
  bgmFileInput?.addEventListener("change", async () => {
    const file = bgmFileInput.files?.[0];
    if (!file) return;
    const oldUrl = state.videoEdit.localBgmUrl || "";
    const url = URL.createObjectURL(file);
    let dataUrl = "";
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch (_e) {}
    state.videoEdit.localBgmUrl = url;
    state.videoEdit.localBgmName = file.name;
    state.videoEdit.localBgmDataUrl = dataUrl;
    revokeLocalObjectUrl(oldUrl);
    if (bgmFileName) bgmFileName.textContent = file.name;
    applyVideoEditsToPreview();
  });
  document.getElementById("videoEditorPanel").querySelector("#clearBgmFileBtn")?.addEventListener("click", () => {
    const oldUrl = state.videoEdit.localBgmUrl || "";
    state.videoEdit.localBgmUrl = "";
    state.videoEdit.localBgmName = "";
    state.videoEdit.localBgmDataUrl = "";
    revokeLocalObjectUrl(oldUrl);
    renderVideoEditor();
    applyVideoEditsToPreview();
  });

  const playheadRange = document.getElementById("videoEditorPanel").querySelector("#timelinePlayheadRange");
  const playheadVal = document.getElementById("videoEditorPanel").querySelector("#playheadVal");
  const playheadLine = document.getElementById("videoEditorPanel").querySelector("#kfPlayheadLine");
  const pendingTip = document.getElementById("videoEditorPanel").querySelector("#timelinePendingTip");
  const miniToast = document.getElementById("videoEditorPanel").querySelector("#timelineMiniToast");
  const previewVideo = document.getElementById("videoEditorPanel").querySelector(".video-edit-surface video");
  let syncingFromVideo = false;
  let syncingFromTimeline = false;
  const syncVideoFromPlayhead = () => {
    if (!previewVideo || syncingFromVideo) return;
    const actualMax = Number(playheadRange?.max || maxSec);
    const sec = clampNum(Number(playheadRange?.value || 0), 0, actualMax);
    if (!Number.isFinite(sec)) return;
    if (Math.abs((previewVideo.currentTime || 0) - sec) < 0.05) return;
    syncingFromTimeline = true;
    try {
      previewVideo.currentTime = sec;
    } catch (_e) {}
    setTimeout(() => {
      syncingFromTimeline = false;
    }, 0);
  };
  const syncPlayheadFromVideo = () => {
    if (!playheadRange || !previewVideo || syncingFromTimeline) return;
    const actualMax = Number(playheadRange.max || maxSec);
    const sec = clampNum(Number(previewVideo.currentTime || 0), 0, actualMax);
    if (!Number.isFinite(sec)) return;
    const curr = Number(playheadRange.value || 0);
    if (Math.abs(curr - sec) < 0.05) return;
    const snapped = snapTimelineSec(sec, 0.08);
    syncingFromVideo = true;
    state.videoEdit.timeline.playhead = snapped;
    playheadRange.value = String(snapped);
    updatePlayheadUI();
    syncingFromVideo = false;
  };
  const updatePlayheadUI = () => {
    const sec = Number(playheadRange?.value || 0);
    const actualMax = Number(playheadRange?.max || maxSec);
    if (playheadVal) playheadVal.textContent = fmtSec(sec);
    if (playheadLine) playheadLine.style.left = `${Math.max(0, Math.min(100, (sec / (actualMax || 1)) * 100))}%`;
    syncVideoFromPlayhead();
  };
  const updatePendingTip = (msg = "", tone = "info") => {
    if (!pendingTip) return;
    pendingTip.textContent = String(msg || "").trim() || t("timelinePendingIdle");
    pendingTip.dataset.state = tone;
  };
  const flashTimelineToast = (msg = "", tone = "info") => {
    if (!miniToast) return;
    miniToast.textContent = String(msg || "").trim();
    if (!miniToast.textContent) return;
    miniToast.dataset.state = tone;
    miniToast.classList.add("is-show");
    if (state.videoEdit._timelineToastTimer) {
      clearTimeout(state.videoEdit._timelineToastTimer);
      state.videoEdit._timelineToastTimer = null;
    }
    state.videoEdit._timelineToastTimer = setTimeout(() => {
      miniToast.classList.remove("is-show");
    }, 1600);
  };
  const pendingToastText = String(state.videoEdit._timelineToastNext || "").trim();
  if (pendingToastText) {
    state.videoEdit._timelineToastNext = "";
    const pendingTone = String(state.videoEdit._timelineToastTone || "info");
    state.videoEdit._timelineToastTone = "";
    setTimeout(() => flashTimelineToast(pendingToastText, pendingTone), 0);
  }
  const updatePendingPreview = (trackEl, track, hoverSec) => {
    if (!trackEl) return;
    const pending = state.videoEdit.timeline.pendingRangeStart;
    let preview = trackEl.querySelector(".kf-seg-preview");
    if (!pending || pending.track !== track || !Number.isFinite(Number(hoverSec))) {
      if (preview) preview.remove();
      return;
    }
    const startSec = Number(pending.sec || 0);
    const endSec = Number(hoverSec || 0);
    if (Math.abs(endSec - startSec) < 0.03) {
      if (preview) preview.remove();
      return;
    }
    const start = Math.min(startSec, endSec);
    const end = Math.max(startSec, endSec);
    if (!preview) {
      preview = document.createElement("i");
      preview.className = `kf-seg kf-seg-${track} kf-seg-preview`;
      trackEl.appendChild(preview);
    }
    preview.style.left = `${Math.max(0, Math.min(100, (start / maxSec) * 100))}%`;
    preview.style.width = `${Math.max(2, ((end - start) / maxSec) * 100)}%`;
  };
  const commitPendingRange = (track, endSecRaw) => {
    const pending = state.videoEdit.timeline.pendingRangeStart;
    if (!pending || pending.track !== track) return null;
    const endSec = clampNum(Number(endSecRaw || 0), 0, maxSec);
    const start = Math.min(Number(pending.sec || 0), endSec);
    const end = Math.max(Number(pending.sec || 0), endSec);
    state.videoEdit.timeline.pendingRangeStart = null;
    state.videoEdit.timeline.pendingRangeHoverSec = null;
    if (Math.abs(end - start) < 0.06) return null;
    const list = (state.videoEdit.timeline.keyframes[track] || []).slice();
    const pushIfMissing = (v) => {
      if (!list.some((x) => Math.abs(Number(x) - v) <= 0.06)) list.push(v);
    };
    pushIfMissing(Math.round(start * 100) / 100);
    pushIfMissing(Math.round(end * 100) / 100);
    list.sort((a, b) => a - b);
    state.videoEdit.timeline.keyframes[track] = list;
    return { start, end };
  };
  playheadRange?.addEventListener("input", () => {
    const raw = Number(playheadRange.value || 0);
    const snapped = snapTimelineSec(raw, 0.12);
    state.videoEdit.timeline.playhead = snapped;
    playheadRange.value = String(snapped);
    updatePlayheadUI();
  });
  updatePlayheadUI();
  if (previewVideo && !previewVideo.dataset.timelineSyncBound) {
    previewVideo.addEventListener("timeupdate", syncPlayheadFromVideo);
    previewVideo.addEventListener("seeked", syncPlayheadFromVideo);
    previewVideo.addEventListener("loadedmetadata", () => {
      // Update timeline max from actual video duration
      const actualDur = Number(previewVideo.duration || 0);
      if (actualDur > 0 && Number.isFinite(actualDur)) {
        const newMax = Math.ceil(actualDur * 10) / 10;
        if (playheadRange) {
          playheadRange.max = String(newMax);
          playheadRange.step = "0.1";
        }
        // Update ruler labels
        const ruler = document.getElementById("videoEditorPanel").querySelector(".kf-ruler");
        if (ruler) {
          const spans = ruler.querySelectorAll("span");
          if (spans[0]) spans[0].textContent = "0:00";
          if (spans[1]) spans[1].textContent = fmtSec(Math.round(newMax / 2));
          if (spans[2]) spans[2].textContent = fmtSec(Math.round(newMax));
        }
        // Update all kf-track data-max attributes
        document.getElementById("videoEditorPanel").querySelectorAll(".kf-track[data-max]").forEach((el) => {
          el.dataset.max = String(newMax);
        });
      }
      syncPlayheadFromVideo();
    });
    previewVideo.dataset.timelineSyncBound = "1";
  }
  document.getElementById("videoEditorPanel").querySelectorAll(".kf-row .kf-label").forEach((labelNode) => {
    labelNode.addEventListener("click", () => {
      const row = labelNode.closest(".kf-row");
      const track = row?.getAttribute("data-track") || "mask";
      state.videoEdit.timeline.selectedTrack = track;
      state.videoEdit.activeModule = track;
      state.videoEdit.timeline.pendingRangeStart = null;
      state.videoEdit.timeline.pendingRangeHoverSec = null;
      renderVideoEditor();
    });
  });
  document.getElementById("videoEditorPanel").querySelectorAll(".kf-track").forEach((trackNode) => {
    let suppressNextClick = false;
    trackNode.addEventListener("pointerdown", (ev) => {
      const target = ev.target;
      if (target instanceof Element && target.closest(".kf-dot, .kf-seg")) return;
      if (!ev.shiftKey) return;
      const track = trackNode.getAttribute("data-track") || "mask";
      if (state.videoEdit.timeline.trackState?.[track]?.locked) return;
      ev.preventDefault();
      ev.stopPropagation();
      const toSec = (clientX) => {
        const rect = trackNode.getBoundingClientRect();
        const ratio = clampNum((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        return Math.round((ratio * maxSec) * 100) / 100;
      };
      const startSec = toSec(ev.clientX);
      state.videoEdit.timeline.selectedTrack = track;
      state.videoEdit.activeModule = track;
      state.videoEdit.timeline.playhead = startSec;
      if (playheadRange) playheadRange.value = String(startSec);
      updatePlayheadUI();
      state.videoEdit.timeline.pendingRangeStart = { track, sec: startSec };
      state.videoEdit.timeline.pendingRangeHoverSec = startSec;
        updatePendingTip(t("timelinePendingArmed", { time: fmtSec(startSec) }), "progress");
      updatePendingPreview(trackNode, track, startSec);
      trackNode.classList.add("is-drag-creating");
      const onMove = (moveEv) => {
        const sec = toSec(moveEv.clientX);
        state.videoEdit.timeline.pendingRangeHoverSec = sec;
        state.videoEdit.timeline.playhead = sec;
        if (playheadRange) playheadRange.value = String(sec);
        updatePlayheadUI();
        updatePendingPreview(trackNode, track, sec);
      };
      const onUp = (upEv) => {
        suppressNextClick = true;
        trackNode.classList.remove("is-drag-creating");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const sec = toSec(upEv.clientX);
        const committed = commitPendingRange(track, sec);
        if (committed) {
          state.videoEdit._timelineToastNext = t("timelinePendingCommitted", { start: fmtSec(committed.start), end: fmtSec(committed.end) });
          state.videoEdit._timelineToastTone = "done";
        } else {
          state.videoEdit._timelineToastNext = t("timelinePendingCancelled");
          state.videoEdit._timelineToastTone = "blocked";
        }
        renderVideoEditor();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    trackNode.addEventListener("pointermove", (ev) => {
      const track = trackNode.getAttribute("data-track") || "mask";
      const pending = state.videoEdit.timeline.pendingRangeStart;
      if (!pending || pending.track !== track) {
        updatePendingPreview(trackNode, track, Number.NaN);
        return;
      }
      const rect = trackNode.getBoundingClientRect();
      const ratio = clampNum((ev.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const sec = Math.round((ratio * maxSec) * 100) / 100;
      state.videoEdit.timeline.pendingRangeHoverSec = sec;
      updatePendingPreview(trackNode, track, sec);
    });
    trackNode.addEventListener("pointerleave", () => {
      const track = trackNode.getAttribute("data-track") || "mask";
      state.videoEdit.timeline.pendingRangeHoverSec = null;
      updatePendingPreview(trackNode, track, Number.NaN);
    });
    trackNode.addEventListener("click", (ev) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const target = ev.target;
      if (target instanceof Element && target.closest(".kf-dot, .kf-seg")) return;
      const track = trackNode.getAttribute("data-track") || "mask";
      const rect = trackNode.getBoundingClientRect();
      const ratio = clampNum((ev.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const sec = Math.round((ratio * maxSec) * 100) / 100;
      state.videoEdit.timeline.selectedTrack = track;
      state.videoEdit.activeModule = track;
      state.videoEdit.timeline.playhead = sec;
      if (playheadRange) playheadRange.value = String(sec);
      updatePlayheadUI();
      if (state.videoEdit.timeline.trackState?.[track]?.locked) {
        state.videoEdit.timeline.pendingRangeStart = null;
        state.videoEdit.timeline.pendingRangeHoverSec = null;
        renderVideoEditor();
        return;
      }
      const pending = state.videoEdit.timeline.pendingRangeStart;
      if (!pending || pending.track !== track) {
        state.videoEdit.timeline.pendingRangeStart = { track, sec };
        state.videoEdit.timeline.pendingRangeHoverSec = null;
        updatePendingTip(t("timelinePendingArmed", { time: fmtSec(sec) }), "progress");
        renderVideoEditor();
        return;
      }
      const committed = commitPendingRange(track, sec);
      if (committed) {
        state.videoEdit._timelineToastNext = t("timelinePendingCommitted", { start: fmtSec(committed.start), end: fmtSec(committed.end) });
        state.videoEdit._timelineToastTone = "done";
      }
      renderVideoEditor();
    });
  });
  const timelineKeydownHandler = (ev) => {
    if (!state.videoEditorOpen) return;
    const pending = state.videoEdit.timeline.pendingRangeStart;
    if (!pending) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      state.videoEdit.timeline.pendingRangeStart = null;
      state.videoEdit.timeline.pendingRangeHoverSec = null;
      state.videoEdit._timelineToastNext = t("timelinePendingCancelled");
      state.videoEdit._timelineToastTone = "blocked";
      renderVideoEditor();
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      const track = String(pending.track || "mask");
      if (state.videoEdit.timeline.trackState?.[track]?.locked) {
        state.videoEdit.timeline.pendingRangeStart = null;
        state.videoEdit.timeline.pendingRangeHoverSec = null;
        state.videoEdit._timelineToastNext = t("timelinePendingCancelled");
        state.videoEdit._timelineToastTone = "blocked";
        renderVideoEditor();
        return;
      }
      const endSec = Number.isFinite(Number(state.videoEdit.timeline.pendingRangeHoverSec))
        ? Number(state.videoEdit.timeline.pendingRangeHoverSec)
        : Number(state.videoEdit.timeline.playhead || pending.sec || 0);
      const committed = commitPendingRange(track, endSec);
      if (committed) {
        state.videoEdit._timelineToastNext = t("timelinePendingCommitted", { start: fmtSec(committed.start), end: fmtSec(committed.end) });
        state.videoEdit._timelineToastTone = "done";
      }
      renderVideoEditor();
    }
  };
  state.videoEdit._timelineKeydownHandler = timelineKeydownHandler;
  window.addEventListener("keydown", timelineKeydownHandler);
  document.getElementById("videoEditorPanel").querySelectorAll(".kf-ctrl").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const track = btn.getAttribute("data-track") || "mask";
      const action = btn.getAttribute("data-action") || "";
      const curr = state.videoEdit.timeline.trackState?.[track] || { visible: true, locked: false };
      if (action === "toggle-visibility") curr.visible = !curr.visible;
      if (action === "toggle-lock") curr.locked = !curr.locked;
      state.videoEdit.timeline.trackState[track] = curr;
      if (state.videoEdit.activeModule === track && curr.locked) {
        state.videoEdit.timeline.selectedTrack = track;
      }
      renderVideoEditor();
      applyVideoEditsToPreview();
    });
  });

  document.getElementById("videoEditorPanel").querySelectorAll(".kf-dot").forEach((dot) => {
    dot.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const sec = Number(dot.getAttribute("data-sec") || 0);
      const track = dot.getAttribute("data-track") || "mask";
      state.videoEdit.timeline.selectedTrack = track;
      state.videoEdit.timeline.playhead = sec;
      state.videoEdit.timeline.pendingRangeStart = null;
      state.videoEdit.timeline.pendingRangeHoverSec = null;
      if (playheadRange) playheadRange.value = String(sec);
      updatePlayheadUI();
    });
    dot.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const track = dot.getAttribute("data-track") || "mask";
      if (state.videoEdit.timeline.trackState?.[track]?.locked) return;
      const trackEl = dot.closest(".kf-track");
      if (!trackEl) return;
      const rawIdx = Number(dot.getAttribute("data-idx") || -1);
      const keyframes = state.videoEdit.timeline.keyframes[track] || [];
      let dragIdx = Number.isInteger(rawIdx) ? rawIdx : -1;
      if (dragIdx < 0 || dragIdx >= keyframes.length) {
        const sec = Number(dot.getAttribute("data-sec") || 0);
        let nearest = 0;
        let best = Number.POSITIVE_INFINITY;
        keyframes.forEach((v, idx) => {
          const d = Math.abs(Number(v) - sec);
          if (d < best) {
            best = d;
            nearest = idx;
          }
        });
        dragIdx = nearest;
      }
      if (dragIdx < 0 || dragIdx >= keyframes.length) return;
      const toSec = (clientX) => {
        const rect = trackEl.getBoundingClientRect();
        const ratio = clampNum((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        return clampNum(ratio * maxSec, 0, maxSec);
      };
      const commitDot = (clientX) => {
        const raw = toSec(clientX);
        const snapped = snapTimelineSec(raw, 0.12, track, dragIdx);
        const sec = Math.round(snapped * 100) / 100;
        state.videoEdit.timeline.playhead = sec;
        if (playheadRange) playheadRange.value = String(sec);
        dot.style.left = `${(sec / maxSec) * 100}%`;
        updatePlayheadUI();
        return sec;
      };
      dot.classList.add("is-dragging");
      const onMove = (moveEv) => {
        commitDot(moveEv.clientX);
      };
      const onUp = (upEv) => {
        const finalSec = commitDot(upEv.clientX);
        const list = (state.videoEdit.timeline.keyframes[track] || []).slice();
        list[dragIdx] = finalSec;
        list.sort((a, b) => a - b);
        state.videoEdit.timeline.keyframes[track] = list;
        state.videoEdit.timeline.selectedTrack = track;
        state.videoEdit.activeModule = track;
        state.videoEdit.timeline.pendingRangeStart = null;
        state.videoEdit.timeline.pendingRangeHoverSec = null;
        dot.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        renderVideoEditor();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  });
  document.getElementById("videoEditorPanel").querySelectorAll(".kf-seg[data-start-idx][data-end-idx]").forEach((seg) => {
    seg.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const track = seg.getAttribute("data-track") || "mask";
      if (state.videoEdit.timeline.trackState?.[track]?.locked) return;
      const trackEl = seg.closest(".kf-track");
      if (!trackEl) return;
      const startIdx = Number(seg.getAttribute("data-start-idx") || -1);
      const endIdx = Number(seg.getAttribute("data-end-idx") || -1);
      if (startIdx < 0 || endIdx <= startIdx) return;
      const keyframes = state.videoEdit.timeline.keyframes[track] || [];
      if (endIdx >= keyframes.length) return;

      const startSec0 = Number(keyframes[startIdx]);
      const endSec0 = Number(keyframes[endIdx]);
      if (!Number.isFinite(startSec0) || !Number.isFinite(endSec0)) return;
      const toSec = (clientX) => {
        const rect = trackEl.getBoundingClientRect();
        const ratio = clampNum((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        return clampNum(ratio * maxSec, 0, maxSec);
      };
      const pointerSec0 = toSec(ev.clientX);
      const prevSec = startIdx > 0 ? Number(keyframes[startIdx - 1]) : null;
      const nextSec = endIdx + 1 < keyframes.length ? Number(keyframes[endIdx + 1]) : null;
      const minDelta = startIdx > 0 ? prevSec - startSec0 + 0.02 : -startSec0;
      const maxDelta = endIdx + 1 < keyframes.length ? nextSec - endSec0 - 0.02 : maxSec - endSec0;
      const startDot = trackEl.querySelector(`.kf-dot[data-track="${track}"][data-idx="${startIdx}"]`);
      const endDot = trackEl.querySelector(`.kf-dot[data-track="${track}"][data-idx="${endIdx}"]`);

      const commitSegment = (clientX) => {
        const pointerSec = toSec(clientX);
        const rawStart = startSec0 + (pointerSec - pointerSec0);
        const snappedStart = snapTimelineSec(rawStart, 0.12, track, startIdx);
        const delta = clampNum(snappedStart - startSec0, minDelta, maxDelta);
        const nextStart = Math.round((startSec0 + delta) * 100) / 100;
        const nextEnd = Math.round((endSec0 + delta) * 100) / 100;
        seg.style.left = `${(nextStart / maxSec) * 100}%`;
        seg.style.width = `${Math.max(2, ((nextEnd - nextStart) / maxSec) * 100)}%`;
        if (startDot) startDot.style.left = `${(nextStart / maxSec) * 100}%`;
        if (endDot) endDot.style.left = `${(nextEnd / maxSec) * 100}%`;
        const playSec = Math.round(((nextStart + nextEnd) / 2) * 100) / 100;
        state.videoEdit.timeline.playhead = playSec;
        if (playheadRange) playheadRange.value = String(playSec);
        updatePlayheadUI();
        return { nextStart, nextEnd };
      };

      seg.classList.add("is-dragging");
      const onMove = (moveEv) => {
        commitSegment(moveEv.clientX);
      };
      const onUp = (upEv) => {
        const { nextStart, nextEnd } = commitSegment(upEv.clientX);
        const list = (state.videoEdit.timeline.keyframes[track] || []).slice();
        list[startIdx] = nextStart;
        list[endIdx] = nextEnd;
        list.sort((a, b) => a - b);
        state.videoEdit.timeline.keyframes[track] = list;
        state.videoEdit.timeline.selectedTrack = track;
        state.videoEdit.activeModule = track;
        state.videoEdit.timeline.pendingRangeStart = null;
        state.videoEdit.timeline.pendingRangeHoverSec = null;
        seg.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        renderVideoEditor();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  });

  document.getElementById("videoEditorPanel").querySelector("#addKeyframeBtn")?.addEventListener("click", () => {
    const sec = Number(state.videoEdit.timeline.playhead || 0);
    const track = state.videoEdit.timeline.selectedTrack || "mask";
    if (state.videoEdit.timeline.trackState?.[track]?.locked) return;
    const list = state.videoEdit.timeline.keyframes[track] || [];
    if (!list.some((v) => Math.abs(v - sec) <= 0.08)) {
      list.push(sec);
      list.sort((a, b) => a - b);
      state.videoEdit.timeline.keyframes[track] = list;
    }
    state.videoEdit.timeline.pendingRangeStart = null;
    state.videoEdit.timeline.pendingRangeHoverSec = null;
    renderVideoEditor();
  });

  document.getElementById("videoEditorPanel").querySelector("#removeKeyframeBtn")?.addEventListener("click", () => {
    const sec = Number(state.videoEdit.timeline.playhead || 0);
    const track = state.videoEdit.timeline.selectedTrack || "mask";
    if (state.videoEdit.timeline.trackState?.[track]?.locked) return;
    const list = (state.videoEdit.timeline.keyframes[track] || []).slice();
    if (!list.length) return;
    let nearestIdx = 0;
    let nearestDist = Math.abs(list[0] - sec);
    for (let i = 1; i < list.length; i += 1) {
      const d = Math.abs(list[i] - sec);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    }
    list.splice(nearestIdx, 1);
    state.videoEdit.timeline.keyframes[track] = list;
    state.videoEdit.timeline.pendingRangeStart = null;
    state.videoEdit.timeline.pendingRangeHoverSec = null;
    renderVideoEditor();
  });

  document.getElementById("videoEditorPanel").querySelector("#closeVideoPanelBtn")?.addEventListener("click", () => {
    if (typeof state.videoEdit._timelineKeydownHandler === "function") {
      window.removeEventListener("keydown", state.videoEdit._timelineKeydownHandler);
      state.videoEdit._timelineKeydownHandler = null;
    }
    if (state.videoEdit._timelineToastTimer) {
      clearTimeout(state.videoEdit._timelineToastTimer);
      state.videoEdit._timelineToastTimer = null;
    }
    state.videoEditorOpen = false;
    _applyWorkspaceMode();
  });
  document.getElementById("videoEditorPanel").querySelector("#downloadVideoBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("videoEditorPanel").querySelector("#downloadVideoBtn");
    _setActionButtonState(btn, "progress", t("videoDownload"));
    const url = state.lastVideoUrl;
    if (!url) {
      _setActionButtonState(btn, "idle");
      return;
    }
    try {
      // Fetch as blob so the browser triggers a real download instead of navigation
      const resp = await fetch(url);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `shoplive-video-${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      _setActionButtonState(btn, "done", t("videoDownload"));
    } catch (_e) {
      // Fallback: open in new tab
      window.open(url, "_blank", "noopener");
      _setActionButtonState(btn, "blocked", t("videoDownload"));
    }
    setTimeout(() => _setActionButtonState(btn, "idle"), 1400);
  });
  document.getElementById("videoEditorPanel").querySelector("#regenFromVideoEditorBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("videoEditorPanel").querySelector("#regenFromVideoEditorBtn");
    _setActionButtonState(btn, "progress", t("videoRegenerate"));
    const pickValue = (selector, fallback) => {
      const el = document.getElementById("videoEditorPanel").querySelector(selector);
      return el ? el.value : fallback;
    };
    const pickChecked = (selector, fallback) => {
      const el = document.getElementById("videoEditorPanel").querySelector(selector);
      return el ? Boolean(el.checked) : Boolean(fallback);
    };
    state.videoEdit = {
      maskText: String(pickValue("#maskTextInput", fx.maskText || "")).trim(),
      maskStyle: state.videoEdit.maskStyle || "elegant",
      maskFont: pickValue("#maskFontSelect", fx.maskFont || "sans"),
      maskColor: String(document.getElementById("videoEditorPanel").querySelector("#maskColorInput")?.value || fx.maskColor || "#ffffff"),
      x: Number(pickValue("#maskXRange", fx.x ?? 0)),
      y: Number(pickValue("#maskYRange", fx.y ?? 0)),
      w: Number(pickValue("#maskWRange", fx.w ?? 80)),
      h: Number(pickValue("#maskHRange", fx.h ?? 12)),
      opacity: Number(pickValue("#maskORange", fx.opacity ?? 90)),
      rotation: Number(pickValue("#maskRRange", fx.rotation ?? 0)),
      speed: pickValue("#videoEditSpeed", fx.speed || "1.0"),
      temp: Number(pickValue("#tempRange", fx.temp ?? 12)),
      tint: Number(pickValue("#tintRange", fx.tint ?? 5)),
      sat: Number(pickValue("#satRange", fx.sat ?? 8)),
      vibrance: Number(pickValue("#vibRange", fx.vibrance ?? 10)),
      bgmExtract: pickChecked("#bgmExtractChk", fx.bgmExtract),
      bgmMood: pickValue("#bgmMoodSelect", fx.bgmMood || "elegant"),
      bgmVolume: Number(pickValue("#bgmVolRange", fx.bgmVolume ?? 70)),
      bgmReplaceMode: pickValue("#bgmReplaceModeSelect", fx.bgmReplaceMode || "auto"),
      localBgmUrl: state.videoEdit.localBgmUrl || "",
      localBgmName: state.videoEdit.localBgmName || "",
      localBgmDataUrl: state.videoEdit.localBgmDataUrl || "",
      activeModule: state.videoEdit.activeModule || "mask",
      timeline: state.videoEdit.timeline,
    };
    if (!state.lastVideoUrl) {
      applyVideoEditsToPreview();
      _pushSystemStateMsg(t("videoApplyDone"), "done");
      _setActionButtonState(btn, "done", t("videoRegenerate"));
      setTimeout(() => _setActionButtonState(btn, "idle"), 1400);
      return;
    }
    _pushSystemStateMsg(t("videoExporting"), "progress");
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
      state.lastVideoUrl = exportedUrl;
      document.querySelectorAll(".video-edit-surface video").forEach((v) => {
        v.src = exportedUrl;
      });
      renderVideoEditor();
      applyVideoEditsToPreview();
      _pushSystemStateMsg(t("videoApplyDone"), "done");
      if (state.videoEdit.maskText && resp?.mask_applied === false) {
      _pushSystemStateMsg(t("videoMaskUnsupported"), "blocked");
      }
      _setActionButtonState(btn, "done", t("videoRegenerate"));
    } catch (_e) {
      applyVideoEditsToPreview();
      _pushSystemStateMsg(t("videoExportFail"), "blocked");
      _setActionButtonState(btn, "blocked", t("videoRegenerate"));
    }
    setTimeout(() => _setActionButtonState(btn, "idle"), 1600);
  });
  document.getElementById("videoEditorPanel").querySelector("#resetVideoEditorBtn")?.addEventListener("click", () => {
    revokeLocalObjectUrl(state.videoEdit.localBgmUrl || "");
    state.videoEdit = {
      ...state.videoEdit,
      maskText: "",
      maskStyle: "elegant",
      maskFont: "sans",
      maskColor: "#ffffff",
      x: 50,
      y: 88,
      w: 78,
      h: 14,
      opacity: 95,
      rotation: 0,
      speed: "1.0",
      temp: 0,
      tint: 0,
      sat: 0,
      vibrance: 0,
      bgmExtract: false,
      bgmMood: "elegant",
      bgmVolume: 70,
      bgmReplaceMode: "auto",
      localBgmUrl: "",
      localBgmName: "",
      localBgmDataUrl: "",
      activeModule: state.videoEdit.activeModule || "mask",
    };
    renderVideoEditor();
    applyVideoEditsToPreview();
  });
  applyVideoEditsToPreview();
  // Enable drag-to-reposition and fullscreen on the editor panel's video surface
  const editorSurface = document.getElementById("videoEditorPanel").querySelector(".video-edit-surface");
  if (editorSurface) {
    setupMaskDrag(editorSurface);
    setupSurfaceFullscreen(editorSurface);
  }
}
