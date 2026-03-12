import { createTransientBackoffByPreset } from "../../shared/polling.js";
import { currentLang, setCurrentLang, i18n, shortFeedback, feedbackDeck, insightPulseDeck, targetBatches, brandBatches, REGION_ITEMS, t, shuffle, nextLead, withLead, nextInsightPulseLine } from './i18n.js';
import { state, smartOptionCache, MAX_CONCURRENT_VIDEO_JOBS, CHAT_TAIL_LIMIT_WHEN_SPLIT } from './state.js';
import { getApiBase, postJson, postSse } from './utils.js';
import { initVideoEditCallbacks, pushVideoUrlToHistory, _loadVideoHistory, applyRangedSpeedToCurrentVideo, applyColorGradingToCurrentVideo, applyBgmEditToCurrentVideo, pollRenderJob, applyTrimToCurrentVideo, applyMultiTrimToCurrentVideo, applySubtitleStyleToCurrentVideo, applyUndoLastEdit, callAgentRunAndRender, applyAsrSubtitlesToCurrentVideo, applyImageOverlayToCurrentVideo, applySubtitleToCurrentVideo, applyPlaybackSpeedToCurrentVideo } from './video-edit-ops.js';

const chatList = document.getElementById("chatList");
const taskQueuePanel       = document.getElementById("taskQueuePanel");
const taskQueueTitle       = document.getElementById("taskQueueTitle");
const taskQueueList        = document.getElementById("taskQueueList");
const taskQueueClearBtn    = document.getElementById("taskQueueClearBtn");
const taskQueueCollapseBtn = document.getElementById("taskQueueCollapseBtn");
const taskQueueToggleRow   = document.getElementById("taskQueueToggleRow");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const uploadBtn = document.getElementById("uploadBtn");
const imageInput = document.getElementById("imageInput");
const langToggleBtn = document.getElementById("langToggleBtn");
const aspectRatioSelect = document.getElementById("aspectRatioSelect");
const durationSelect = document.getElementById("durationSelect");
const durationHint   = document.getElementById("durationHint");
const enhancePromptBtn = document.getElementById("enhancePromptBtn");
const uploadHint = document.getElementById("uploadHint");
const productUrlInput = document.getElementById("productUrlInput");
const parseProductUrlBtn = document.getElementById("parseProductUrlBtn");
const toggleProductUrlBtn = document.getElementById("toggleProductUrlBtn");
const workspaceEl = document.getElementById("workspace");
const composerCompact = document.querySelector(".composer.composer-compact");
const workspaceToolbar = document.querySelector(".workspace-toolbar");
const scriptEditorPanel = document.getElementById("scriptEditorPanel");
const videoEditorPanel = document.getElementById("videoEditorPanel");
const toggleScriptTab = document.getElementById("toggleScriptTab");
const toggleVideoTab = document.getElementById("toggleVideoTab");
const queryParams = new URLSearchParams(window.location.search);
const SIMPLE_AGENT_MODE = true;

let thinkingNode = null;

// ── Scroll-to-bottom FAB state ──────────────────────────────────────────────
let _userScrolledUp = false;
let _unreadCount = 0;

function normalizeTextList(value, limit = 6) {
  if (Array.isArray(value)) {
    return value.map((x) => String(x || "").trim()).filter(Boolean).slice(0, limit);
  }
  return String(value || "")
    .split(/[\n,;；，、]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeProductAnchors(anchors = {}) {
  const source = anchors && typeof anchors === "object" ? anchors : {};
  return {
    category: String(source.category || "").trim(),
    colors: normalizeTextList(source.colors, 5),
    materials: normalizeTextList(source.materials, 5),
    silhouette: String(source.silhouette || "").trim(),
    key_details: normalizeTextList(source.key_details, 6),
    keep_elements: normalizeTextList(source.keep_elements, 6),
    usage_scenarios: normalizeTextList(source.usage_scenarios, 4),
    avoid_elements: normalizeTextList(source.avoid_elements, 4),
  };
}

function mergeProductAnchors(base = {}, incoming = {}) {
  const left = normalizeProductAnchors(base);
  const right = normalizeProductAnchors(incoming);
  const mergeList = (a, b, limit = 6) => Array.from(new Set([...(a || []), ...(b || [])])).slice(0, limit);
  return {
    category: left.category || right.category,
    colors: mergeList(left.colors, right.colors, 5),
    materials: mergeList(left.materials, right.materials, 5),
    silhouette: left.silhouette || right.silhouette,
    key_details: mergeList(left.key_details, right.key_details, 6),
    keep_elements: mergeList(left.keep_elements, right.keep_elements, 6),
    usage_scenarios: mergeList(left.usage_scenarios, right.usage_scenarios, 4),
    avoid_elements: mergeList(left.avoid_elements, right.avoid_elements, 4),
  };
}

function hasEffectiveProductAsset() {
  return Boolean(
    (Array.isArray(state.images) && state.images.length)
    || (Array.isArray(state.productImageUrls) && state.productImageUrls.length)
  );
}

function buildProductAnchorSummary(lang = currentLang) {
  const anchors = normalizeProductAnchors(state.productAnchors);
  const lines = [];
  if (anchors.category) lines.push(lang === "zh" ? `商品子类：${anchors.category}` : `Category: ${anchors.category}`);
  if (anchors.colors.length) lines.push(lang === "zh" ? `核心颜色：${anchors.colors.join("、")}` : `Core colors: ${anchors.colors.join(", ")}`);
  if (anchors.materials.length) lines.push(lang === "zh" ? `核心材质：${anchors.materials.join("、")}` : `Core materials: ${anchors.materials.join(", ")}`);
  if (anchors.silhouette) lines.push(lang === "zh" ? `轮廓版型：${anchors.silhouette}` : `Silhouette: ${anchors.silhouette}`);
  if (anchors.key_details.length) lines.push(lang === "zh" ? `关键细节：${anchors.key_details.join("、")}` : `Key details: ${anchors.key_details.join(", ")}`);
  if (anchors.keep_elements.length) lines.push(lang === "zh" ? `必须保留：${anchors.keep_elements.join("、")}` : `Must keep: ${anchors.keep_elements.join(", ")}`);
  if (anchors.usage_scenarios.length) lines.push(lang === "zh" ? `适用场景：${anchors.usage_scenarios.join("、")}` : `Use scenarios: ${anchors.usage_scenarios.join(", ")}`);
  if (anchors.avoid_elements.length) lines.push(lang === "zh" ? `禁止偏移：${anchors.avoid_elements.join("、")}` : `Do not drift to: ${anchors.avoid_elements.join(", ")}`);
  return lines.join(lang === "zh" ? "；" : ". ");
}

function openProductAssetPicker() {
  if (composerCompact && !composerCompact.classList.contains("show-link-row")) {
    composerCompact.classList.add("show-link-row");
    if (toggleProductUrlBtn) toggleProductUrlBtn.textContent = t("toggleLinkHide");
  }
  if (window._agentOpenRefModal) window._agentOpenRefModal();
  else imageInput?.click();
}

function showProductAssetRequiredMessage(reason = "generate") {
  pushSystemStateMsg(reason === "enhance" ? t("assetRequiredEnhance") : t("assetRequiredGenerate"), "blocked");
  showUploadRefQuickAction();
}

function updateGenerationGateUI() {
  const hasAsset = hasEffectiveProductAsset();
  if (uploadHint) uploadHint.textContent = hasAsset ? t("uploadHintReady") : t("uploadHintLocked");
  if (sendBtn) {
    sendBtn.dataset.locked = "false";
    sendBtn.title = "";
  }
  if (enhancePromptBtn) {
    enhancePromptBtn.dataset.locked = "false";
    enhancePromptBtn.title = "";
  }
  updateDurationOptions();
}

function formatElapsedSec(ms) {
  return Math.max(0, Math.floor((Number(ms) || 0) / 1000));
}

// Auto-refresh timer for running tasks (shows live elapsed time)
let _taskQueueRefreshTimer = null;
function _startTaskQueueRefresh() {
  if (_taskQueueRefreshTimer) return;
  _taskQueueRefreshTimer = setInterval(() => {
    const hasRunning = Object.values(state.taskMap || {}).some(
      (item) => item.status === "running" || item.status === "queued"
    );
    if (hasRunning) {
      renderTaskQueue();
    } else {
      clearInterval(_taskQueueRefreshTimer);
      _taskQueueRefreshTimer = null;
    }
  }, 1000);
}

function renderTaskQueue() {
  if (!taskQueuePanel || !taskQueueList) return;
  const items = Object.values(state.taskMap || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const doneCount = items.filter((item) => item.status === "done").length;
  const runningCount = items.filter((item) => item.status === "running" || item.status === "queued").length;
  const blockedCount = items.filter((item) => item.status === "failed" || item.status === "cancelled").length;
  if (!items.length) {
    taskQueuePanel.hidden = true;
    taskQueueList.innerHTML = "";
    if (taskQueueClearBtn) taskQueueClearBtn.disabled = true;
    return;
  }
  taskQueuePanel.hidden = false;
  if (taskQueueTitle) {
    const summaryTone = runningCount > 0 ? "status-dot-progress" : blockedCount > 0 ? "status-dot-blocked" : "status-dot-done";
    const summaryText = runningCount > 0
      ? `${runningCount} ${t("taskRunning")}`
      : blockedCount > 0
        ? `${blockedCount} ${t("taskFailed")}`
        : `${doneCount} ${t("taskDone")}`;
    taskQueueTitle.innerHTML = `<span>${t("taskQueueTitle")}</span><span class="task-state-badge ${summaryTone}">${sanitizeInputValue(summaryText)}</span>`;
  }
  if (taskQueueClearBtn) {
    taskQueueClearBtn.textContent = t("taskClearDone");
    taskQueueClearBtn.disabled = doneCount <= 0;
  }
  taskQueueList.innerHTML = items
    .slice(0, 8)
    .map((item) => {
      const isDone    = item.status === "done";
      const isFailed  = item.status === "failed";
      const isQueued  = item.status === "queued";
      const isFinished = isDone || isFailed;

      // 已完成/失败：显示冻结的最终耗时；进行中/排队：显示已用时（实时）
      const finalSec = isFinished
        ? formatElapsedSec((item.finishedAt || Date.now()) - (item.startedAt || item.createdAt || Date.now()))
        : item.status === "running" || item.status === "queued"
          ? formatElapsedSec(Date.now() - (item.startedAt || item.createdAt || Date.now()))
          : null;

      const stateText = isDone ? t("taskDone")
        : isFailed  ? t("taskFailed")
          : item.status === "cancelled" ? t("taskCancelled")
          : isQueued  ? t("taskQueued")
            : t("taskRunning");

      // 进行中：只显示 stage（里面已有总计时）；完成/失败：显示冻结时长，不重复显示 stage
      const safeStage = isFinished
        ? ""
        : sanitizeInputValue(String(item.stage || "").slice(0, 80));

      const safeTitle = sanitizeInputValue(item.title || "Task");
      const canView   = Boolean(item.resultCardId);
      const canCancel = !isFinished && item.status !== "cancelled";
      const viewBtn   = canView   ? `<button class="task-view-btn action-chip-btn action-chip-view"   type="button" data-task-action="view"   data-task-id="${item.id}">${t("taskView")}</button>`   : "";
      const cancelBtn = canCancel ? `<button class="task-cancel-btn action-chip-btn action-chip-danger" type="button" data-task-action="cancel" data-task-id="${item.id}">${t("taskCancel")}</button>` : "";

      const timeStr  = finalSec !== null ? ` · ${finalSec}s` : "";
      const stageStr = safeStage ? ` · ${safeStage}` : "";
      const stateTone = item.status === "done"
        ? "status-dot-done"
        : item.status === "failed" || item.status === "cancelled"
          ? "status-dot-blocked"
          : item.status === "queued"
            ? "status-dot-info"
            : "status-dot-progress";

      const statusCls = item.status === "cancelled" ? "failed" : (item.status || "running");
      return `<div class="task-item ${statusCls}">
        <strong>${safeTitle}</strong>
        <small>
          <span class="task-state-badge ${stateTone}">${stateText}</span>${timeStr}${stageStr}${viewBtn}${cancelBtn}
        </small>
      </div>`;
    })
    .join("");
  // Start live refresh when there are running tasks
  if (runningCount > 0) _startTaskQueueRefresh();
}

function createVideoTask(durationLabel = "8s") {
  state.taskSeq = Number(state.taskSeq || 0) + 1;
  const id = `video-task-${Date.now()}-${state.taskSeq}`;
  const provider = getModelProvider();
  const sourceLabel = currentLang === "zh"
    ? (provider === "veo" ? "Veo 图生视频" : "Grok 文生视频")
    : (provider === "veo" ? "Veo image-to-video" : "Grok text-to-video");
  state.taskMap[id] = {
    id,
    title: `#${state.taskSeq} · ${durationLabel}`,
    sourceLabel,
    status: "queued",
    stage: "",
    createdAt: Date.now(),
    startedAt: Date.now(),
    cancelRequested: false,
    _releaseSlot: null,
    _abortCtrl: null,
  };
  renderTaskQueue();
  return id;
}

function cancelVideoTask(taskId) {
  const task = state.taskMap?.[taskId];
  if (!task) return;
  if (task.status === "done" || task.status === "failed" || task.status === "cancelled") return;
  // Signal cancel to generation loop
  state.taskMap[taskId].cancelRequested = true;
  // Abort any in-flight fetch
  try { task._abortCtrl?.abort(); } catch (_e) {}
  // Release concurrency slot immediately
  try { task._releaseSlot?.(); } catch (_e) {}
  state.taskMap[taskId] = {
    ...state.taskMap[taskId],
    status: "cancelled",
    stage: currentLang === "zh" ? "已取消" : "Cancelled",
    finishedAt: Date.now(),
  };
  renderTaskQueue();
}

function updateVideoTask(id, patch = {}) {
  if (!id || !state.taskMap[id]) return;
  state.taskMap[id] = { ...state.taskMap[id], ...patch };
  renderTaskQueue();
}

function finishVideoTask(id, ok = true, stage = "") {
  if (!id || !state.taskMap[id]) return;
  state.taskMap[id] = {
    ...state.taskMap[id],
    status: ok ? "done" : "failed",
    stage: stage || state.taskMap[id].stage || "",
    finishedAt: Date.now(),
  };
  renderTaskQueue();
}

function clearCompletedTasks() {
  const nextMap = {};
  for (const [id, item] of Object.entries(state.taskMap || {})) {
    if (item?.status !== "done") nextMap[id] = item;
  }
  state.taskMap = nextMap;
  renderTaskQueue();
}

function scrollToTaskResult(taskId = "") {
  const task = state.taskMap?.[taskId];
  if (!task || !chatList) return;
  let cardId = String(task.resultCardId || "");
  let card = cardId ? chatList.querySelector(`[data-task-card-id="${cardId}"]`) : null;

  // Recovery path: if card is missing but task has a playable result, rebuild
  // the chat preview card so "View" always works.
  if (!card) {
    const recoverUrl = String(task.resultVideoUrl || state.lastVideoUrl || "").trim();
    const recoverGcs = String(task.resultGcsUri || "").trim();
    const recoverOp = String(task.resultOperationName || "").trim();
    if (recoverUrl) {
      const rebuiltId = renderGeneratedVideoCard(recoverUrl, recoverGcs, recoverOp, taskId);
      cardId = String(rebuiltId || "");
      card = cardId ? chatList.querySelector(`[data-task-card-id="${cardId}"]`) : null;
    }
  }
  if (!card) return;
  state.activeVideoCardId = cardId;
  updateActiveVideoCardState();
  const hostRect = chatList.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const currentTop = chatList.scrollTop;
  const targetTop = currentTop + (cardRect.top - hostRect.top) - ((hostRect.height - cardRect.height) / 2);
  chatList.scrollTo({
    top: Math.max(0, targetTop),
    behavior: "smooth",
  });
}

function canStartVideoJob() {
  return Number(state.activeVideoJobs || 0) < MAX_CONCURRENT_VIDEO_JOBS;
}

function acquireVideoJobSlot() {
  state.activeVideoJobs = Math.max(0, Number(state.activeVideoJobs || 0)) + 1;
  state.generating = state.activeVideoJobs > 0;
}

function releaseVideoJobSlot() {
  state.activeVideoJobs = Math.max(0, Number(state.activeVideoJobs || 0) - 1);
  state.generating = state.activeVideoJobs > 0;
}

let hasOpenEditors = false;


function startLinkParseProgress() {
  const steps = [
    t("parseLinkWorking"),
    t("parseLinkStep1"),
    t("parseLinkStep2"),
    t("parseLinkStep3"),
    t("parseLinkStep4"),
  ];
  const startedAt = Date.now();
  let stepIdx = 0;
  const bubble = pushSystemStateMsg(steps[0], "progress");
  const timer = setInterval(() => {
    const sec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    if (sec < 20) {
      stepIdx = Math.min(stepIdx + 1, steps.length - 1);
      bubble.textContent = steps[stepIdx];
    } else {
      bubble.textContent = t("parseLinkSlow", { sec });
    }
    scrollToBottom();
  }, 3000);
  return () => {
    clearInterval(timer);
    if (bubble && bubble.parentNode) bubble.remove();
  };
}

function renderWorkspaceTab(el, label, kind) {
  if (!el) return;
  const safeLabel = label || "";
  const iconSvg =
    kind === "script"
      ? "<svg viewBox='0 0 24 24' aria-hidden='true'><rect x='5' y='3.5' width='14' height='17' rx='3'/><rect x='8' y='8' width='8' height='1.8' fill='white'/><rect x='8' y='12' width='8' height='1.8' fill='white'/><rect x='8' y='16' width='6' height='1.8' fill='white'/></svg>"
      : "<svg viewBox='0 0 24 24' aria-hidden='true'><rect x='3.5' y='5' width='12.5' height='14' rx='3'/><polygon points='10.5,9 10.5,15 14.8,12' fill='white'/><path d='M16 9 L20.5 6.5 V17.5 L16 15 Z'/></svg>";
  el.innerHTML = `<span class="tab-icon">${iconSvg}</span><span class="tab-label">${safeLabel}</span><span class="tab-state-dot" aria-hidden="true"></span>`;
}

function applyLang() {
  localStorage.setItem("shoplive.lang", currentLang);
  chatInput.placeholder = t("inputPh");
  uploadBtn.textContent = t("upload");
  sendBtn.textContent = t("send");
  if (enhancePromptBtn) enhancePromptBtn.textContent = t("enhancePrompt");
  if (toggleProductUrlBtn) {
    const opened = Boolean(composerCompact?.classList.contains("show-link-row"));
    toggleProductUrlBtn.textContent = opened ? t("toggleLinkHide") : t("toggleLinkShow");
  }
  if (uploadHint) uploadHint.textContent = t("uploadHint");
  if (parseProductUrlBtn) parseProductUrlBtn.textContent = t("parseLinkBtn");
  if (productUrlInput) productUrlInput.placeholder = t("parseLinkPh");
  const ratioLabel = document.querySelector('label[for="aspectRatioSelect"] span');
  const durationLabel = document.querySelector('label[for="durationSelect"] span');
  if (ratioLabel) ratioLabel.textContent = t("ratioLabel");
  if (durationLabel) durationLabel.textContent = t("durationLabel");
  if (langToggleBtn) langToggleBtn.textContent = currentLang === "zh" ? "EN" : "中文";
  if (taskQueueClearBtn) taskQueueClearBtn.textContent = t("taskClearDone");
  const back = document.querySelector(".back-link");
  if (back) back.textContent = t("back");
  if (toggleScriptTab) {
    const scriptLabel = t("tabScript") || (currentLang === "zh" ? "分镜脚本" : "Storyboard");
    renderWorkspaceTab(toggleScriptTab, scriptLabel, "script");
    toggleScriptTab.setAttribute("aria-label", scriptLabel);
    toggleScriptTab.setAttribute("title", scriptLabel);
  }
  if (toggleVideoTab) {
    const videoLabel = t("tabVideo") || (currentLang === "zh" ? "视频编辑" : "Editor");
    renderWorkspaceTab(toggleVideoTab, videoLabel, "video");
    toggleVideoTab.setAttribute("aria-label", videoLabel);
    toggleVideoTab.setAttribute("title", videoLabel);
  }
  renderVideoEditor();
  renderScriptEditor();
  renderTaskQueue();
  updateDurationHint();
}

const VEO_MODEL_OPTIONS = [
  { value: "veo-3.1-fast-generate-001", labelZh: "Veo 3.1 Fast",  labelEn: "Veo 3.1 Fast",  provider: "veo" },
  { value: "grok-imagine-1.0-video",    labelZh: "Grok Video ⚡", labelEn: "Grok Video ⚡", provider: "tabcode" },
];
const VEO_FIXED_MODEL = "veo-3.1-fast-generate-001";
const GROK_FIXED_MODEL = "grok-imagine-1.0-video";

function getVeoModel() {
  return VEO_FIXED_MODEL;
}

function getGrokModel() {
  return GROK_FIXED_MODEL;
}

function getModelProvider() {
  return hasEffectiveProductAsset() ? "veo" : "tabcode";
}

// Duration option definitions per provider
const DURATION_OPTIONS = {
  tabcode: [
    { value: "6",  labelZh: "6秒（单次）",        labelEn: "6s (single)" },
    { value: "12", labelZh: "12秒（2段拼接）",     labelEn: "12s (2 clips)" },
    { value: "18", labelZh: "18秒（3段拼接）",     labelEn: "18s (3 clips)", defaultSel: true },
  ],
  veo: [
    { value: "8",  labelZh: "8秒",          labelEn: "8s" },
    { value: "16", labelZh: "16秒（2段拼接）", labelEn: "16s (2-seg)", defaultSel: true },
  ],
};

function updateDurationOptions() {
  if (!durationSelect) return;
  const provider = getModelProvider();
  const opts = DURATION_OPTIONS[provider] || DURATION_OPTIONS.veo;
  const zh = currentLang === "zh";
  const prev = state.duration;
  // Rebuild options
  durationSelect.innerHTML = opts
    .map((o) => `<option value="${o.value}">${zh ? o.labelZh : o.labelEn}</option>`)
    .join("");
  // Keep previous value if valid, else use default
  const valid = opts.find((o) => o.value === prev);
  const defOpt = opts.find((o) => o.defaultSel) || opts[opts.length - 1];
  durationSelect.value = valid ? prev : defOpt.value;
  state.duration = durationSelect.value;
  updateDurationHint();
}

function updateDurationHint() {
  if (!durationHint) return;
  const provider = getModelProvider();
  const dur = Number(state.duration) || 8;
  const zh  = currentLang === "zh";

  durationHint.className = "duration-hint";

  if (provider === "tabcode") {
    // Grok single-shot max is ~6s; all longer durations require multi-clip stitching
    const clips = dur <= 6 ? 1 : dur <= 12 ? 2 : 3;
    const hint = clips === 1
      ? (zh ? `ℹ️ 生成 1 段，实际约 6s。` : `ℹ️ 1 clip generated, ~6s actual.`)
      : clips === 2
        ? (zh ? `ℹ️ 分 2 段串行生成并拼接，实际约 12s。` : `ℹ️ 2 clips generated & concat'd, ~12s actual.`)
        : (zh ? `ℹ️ 分 3 段串行生成并拼接，实际约 18s。` : `ℹ️ 3 clips generated & concat'd, ~18s actual.`);
    durationHint.textContent = hint;
    durationHint.classList.add("hint-warning");
  } else {
    const hint = dur === 16
      ? (zh ? `✅ Veo 精确生成 16s（两段 8s 帧衔接拼接）。` : `✅ Veo exact 16s (two 8s segments, frame-bridged).`)
      : (zh ? `✅ Veo 精确生成 ${dur}s。` : `✅ Veo exact ${dur}s.`);
    durationHint.textContent = hint;
    durationHint.classList.add("hint-ok");
  }
}

// Build a Grok-friendly prompt, injecting actual duration & aspect ratio.
// Grok Video has no duration_seconds param — duration must be in the text.
function buildGrokVideoPrompt(basePrompt, targetDuration = 8) {
  const dur    = Number(targetDuration) || 8;
  const ratio  = state.aspectRatio || "16:9";
  const anchors = normalizeProductAnchors(state.productAnchors);
  const product = String(state.productName || "product").trim() || "product";
  const business = String(state.mainBusiness || "ecommerce product").trim() || "ecommerce product";
  const anchorBits = [];
  if (anchors.category) anchorBits.push(`category ${anchors.category}`);
  if (anchors.colors.length) anchorBits.push(`colors ${anchors.colors.join(', ')}`);
  if (anchors.materials.length) anchorBits.push(`materials ${anchors.materials.join(', ')}`);
  if (anchors.silhouette) anchorBits.push(`silhouette ${anchors.silhouette}`);
  if (anchors.key_details.length) anchorBits.push(`key details ${anchors.key_details.join(', ')}`);
  if (anchors.keep_elements.length) anchorBits.push(`must keep ${anchors.keep_elements.join(', ')}`);
  const avoidBits = anchors.avoid_elements.length
    ? anchors.avoid_elements.join(', ')
    : 'jewelry, earrings, clothing, shoes, bags, cosmetics, headphones, unrelated accessories';
  const durStr = dur >= 16
    ? `${dur}-second continuous ecommerce product video (two seamlessly connected scenes, each ~${Math.round(dur / 2)} seconds)`
    : `${dur}-second ecommerce product video`;
  // Strip any existing duration mention, then prepend our clean directive
  let core = String(basePrompt || "").replace(/\b\d+[\s-]*second(s)?\b/gi, "").trim();
  core = core.replace(/uploaded product images?[^.]*\./gi, "").replace(/parsed product information[^.]*\./gi, "").trim();
  const lockLine = [
    `Show exactly one product only: ${product}.`,
    `Business/category context: ${business}.`,
    anchorBits.length ? `Source-of-truth anchors: ${anchorBits.join('; ')}.` : "",
    "Keep the same product identity in every shot.",
    `Never drift to ${avoidBits}.`,
    "No jewelry, no earrings, no fashion accessories unless they are the exact target product.",
  ].filter(Boolean).join(" ");
  return `Create a ${durStr}, aspect ratio ${ratio}. ${lockLine} ${core}`.replace(/\s{2,}/g, " ").trim();
}

async function _runOneGrokGeneration(base, prompt, model, taskId, labelZh, labelEn) {
  const zh = currentLang === "zh";
  let videoUrl = "";
  let posterUrl = "";
  await postSse(
    `${base}/api/tabcode/video/generate`,
    { prompt, model },
    (eventName, payload) => {
      if (eventName !== "message" && eventName !== "data") return;
      const type = payload?.type;
      if (type === "progress") {
        const pct = Math.max(0, Math.min(100, Number(payload?.percent || 0)));
        updateVideoTask(taskId, {
          status: "running",
          stage: zh ? `${labelZh} ${pct}%` : `${labelEn} ${pct}%`,
        });
      } else if (type === "done") {
        videoUrl  = String(payload?.video_url  || "").trim();
        posterUrl = String(payload?.poster_url || "").trim();
      } else if (type === "error") {
        throw new Error(String(payload?.message || "Grok video generation failed"));
      }
    },
    180000
  );
  if (!videoUrl) throw new Error(zh ? "Grok Video 未返回可播放地址" : "Grok Video: no playable URL returned");
  return { videoUrl, posterUrl };
}

// Concat helper: accepts http URL or data: URL for each input
async function _grokConcat(base, urlA, urlB) {
  const body = { project_id: "gemini-sl-20251120" };
  const isHttp = (u) => /^https?:\/\//i.test(u);
  const isData = (u) => u.startsWith("data:");
  if (isHttp(urlA))       body.video_http_url_a = urlA;
  else if (isData(urlA))  body.video_data_url_a = urlA;
  if (isHttp(urlB))       body.video_http_url_b = urlB;
  else if (isData(urlB))  body.video_data_url_b = urlB;
  if (!body.video_http_url_a && !body.video_data_url_a) return { ok: false, error: "no valid URL_A", url: "" };
  try {
    const resp = await postJson(`${base}/api/veo/concat-segments`, body, 120000);
    const url = String(resp?.video_url || resp?.video_data_url || "").trim();
    return url ? { ok: true, url } : { ok: false, error: "empty response", url: "" };
  } catch (e) {
    return { ok: false, error: String(e?.message || "concat failed"), url: "" };
  }
}

/**
 * Build a shared LLM system prompt for splitting any video prompt into N segments.
 * Enforces: (1) visual anchor lock-in, (2) narrative scene diversity, (3) seamless continuity.
 */
function _buildSplitSystemPrompt(clips, segDuration) {
  const totalSec = clips * segDuration;
  const sceneLines = [
    `- Segment 1 (${segDuration}s): PRODUCT HERO OPENING — camera pushes in from wide to medium, revealing the product's form and silhouette. Focus on the most striking visual feature. Set the mood and color palette for the whole video.`,
    `- Segment 2 (${segDuration}s): USAGE / SELLING-POINT DETAIL — a DIFFERENT camera angle and environment from Segment 1. Show the product being used, demonstrate a key feature up-close, or show a lifestyle context that creates emotional connection.`,
    `- Segment 3 (${segDuration}s): EMOTIONAL PAYOFF & CTA — final scene with confident energy. Product in a fresh setting, wider or dynamic shot. Ends with a memorable visual that reinforces purchase intent.`,
  ].slice(0, clips).join("\n");

  return (
    `You are a professional ecommerce video director and prompt architect.\n`
    + `Your task: split ONE product video prompt into exactly ${clips} distinct ${segDuration}-second segment prompts `
    + `that together form a seamless ${totalSec}-second product video.\n\n`

    + `═══ STEP 1: EXTRACT VISUAL ANCHORS (do this internally before writing segments) ═══\n`
    + `Before splitting, identify and lock these elements from the original prompt:\n`
    + `  • PRODUCT: exact product name, color, material, key visual features\n`
    + `  • STYLE: cinematic tone, visual style (clean/editorial/lifestyle/etc.)\n`
    + `  • LIGHTING: lighting setup (soft natural / studio / golden hour / etc.)\n`
    + `  • COLOR PALETTE: dominant colors and mood\n`
    + `  • CAMERA LANGUAGE: lens style, movement type (push-in/handheld/static/etc.)\n`
    + `These anchors MUST appear consistently in ALL segments. Never contradict them.\n\n`

    + `═══ STEP 2: ASSIGN NARRATIVE ROLES (strictly follow this) ═══\n`
    + sceneLines + `\n\n`

    + `═══ STEP 3: WRITE EACH SEGMENT PROMPT ═══\n`
    + `For each segment:\n`
    + `  • BEGIN with the locked visual anchors (product + style + lighting + palette)\n`
    + `  • THEN add the segment-specific narrative action and camera movement\n`
    + `  • Use timestamp shot control: [00:00-00:0${Math.round(segDuration/4)}] ... [00:0${Math.round(segDuration/4)}-00:0${Math.round(segDuration/2)}] ... etc.\n`
    + `  • Each segment must be COMPLETE and SELF-CONTAINED (readable without the others)\n`
    + `  • The END of Segment N should visually "hand off" to Segment N+1 naturally\n\n`

    + `═══ HARD RULES ═══\n`
    + `  ✗ NEVER repeat the same shot composition, camera angle, or action across segments\n`
    + `  ✗ NEVER use quotation marks (renders as on-screen text in Veo/Grok)\n`
    + `  ✗ NEVER include text overlays, subtitles, or captions\n`
    + `  ✗ NEVER change the product appearance, color, or brand identity between segments\n`
    + `  ✓ Each segment must feel like it belongs to the SAME video shoot\n`
    + `  ✓ Include the compliance suffix from the original prompt if present\n`
    + `  ✓ Write in English only\n\n`

    + `Output ONLY valid JSON: ${JSON.stringify(
        Object.fromEntries(Array.from({length: clips}, (_, i) => [`part${i+1}`, `...`]))
      )}`
  );
}

async function _splitPromptForGrok(base, originalPrompt, clips) {
  /**
   * Use LLM to split a single prompt into N distinct scene prompts for Grok.
   * Falls back to structured hardcoded variants if LLM fails.
   */
  const segDuration = 6;

  try {
    const resp = await postJson(
      `${base}/api/agent/chat`,
      {
        model: "bedrock-claude-4-5-haiku",
        messages: [
          { role: "system", content: _buildSplitSystemPrompt(clips, segDuration) },
          {
            role: "user",
            content:
              `Split this into ${clips} segments of ${segDuration}s each (total ${clips * segDuration}s).\n`
              + `Preserve ALL visual anchors faithfully. Make each segment narratively distinct.\n\n`
              + `Original prompt:\n${originalPrompt}`,
          },
        ],
        temperature: 0.25,
        max_tokens: 1800,
      },
      25000
    );
    const raw = String(resp?.content || "").trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch (_2) {}
    }
    const parts = [];
    for (let i = 1; i <= clips; i++) {
      const p = String(parsed?.[`part${i}`] || "").trim();
      parts.push(p || null);
    }
    if (parts.every(Boolean)) return parts;
  } catch (_) {}

  // Smart fallback: structural scene templates anchored to original prompt
  const sceneActions = [
    `[00:00-00:02] Camera slowly pushes in from wide shot, revealing the product's full form and silhouette against the background. `
    + `[00:02-00:04] Medium close-up highlighting the product's primary visual feature with sharp focus. `
    + `[00:04-00:06] Detail shot and closing hero framing — texture, material, and key design element remain fully consistent.`,

    `[00:00-00:02] Product in a lifestyle context — a hand or person naturally interacting with it in its intended use environment. `
    + `[00:02-00:04] Close-up of the product during use — showing a secondary feature or benefit. `
    + `[00:04-00:06] Emotional payoff and confident lifestyle closing shot — same product identity, no category drift.`,

    `[00:00-00:02] Dynamic angle change — product approached from an unexpected fresh perspective. `
    + `[00:02-00:04] Slow pan across the product's profile, showcasing its full design. `
    + `[00:04-00:06] Final feature close-up and hero hold — product alone, perfect lighting, camera holds still.`,
  ];

  return Array.from({ length: clips }, (_, i) =>
    `${originalPrompt} — SEGMENT ${i + 1}/${clips}: ${sceneActions[i] || sceneActions[sceneActions.length - 1]}`
  );
}

async function generateTabcodeVideo(prompt, taskId = "", targetDuration = 6) {
  const zh    = currentLang === "zh";
  const base  = getApiBase();
  const model = getGrokModel();
  const dur   = Number(targetDuration) || 6;
  // Grok single-shot max is ~6s; all longer durations require multi-clip stitching
  // Map selected duration to clip count: 6→1, 12→2, 18→3
  const clips = dur <= 6 ? 1 : dur <= 12 ? 2 : 3;

  const startLabel = clips === 1
    ? (zh ? `⏳ Grok Video 生成中（约6s），请稍候…` : `⏳ Grok Video generating (~6s), please wait…`)
    : (zh ? `⏳ Grok Video：AI 拆分分镜中，分${clips}段生成…` : `⏳ Grok Video: splitting into ${clips} scenes with AI…`);
  const pollBubble = pushSystemStateMsg(startLabel, "progress");
  updateVideoTask(taskId, { status: "running", stage: zh ? "Grok 生成中" : "Grok generating" });

  try {
    const core = prompt.replace(/\d+[\s-]*second[s]?\s*continuous[^.]*\./i, "").trim();

    // For multi-clip: use LLM to generate truly distinct per-segment prompts
    let segmentPrompts;
    if (clips > 1) {
      if (pollBubble) pollBubble.textContent = zh
        ? `⏳ Grok Video：AI 正在拆分提示词为 ${clips} 段分镜…`
        : `⏳ Grok Video: AI splitting prompt into ${clips} scenes…`;
      segmentPrompts = await _splitPromptForGrok(base, core, clips);
    } else {
      segmentPrompts = [core];
    }
    state.lastStoryboard = buildStoryboardFromPromptSegments(segmentPrompts, 6) || state.lastStoryboard;

    const results = [];
    for (let i = 0; i < clips; i++) {
      if (state.taskMap?.[taskId]?.cancelRequested) throw new Error("CANCELLED");
      const n = i + 1;
      const labelZh = clips > 1 ? `Grok 第${n}/${clips}段` : "Grok 生成中";
      const labelEn = clips > 1 ? `Grok clip ${n}/${clips}` : "Grok generating";
      pollBubble.textContent = clips > 1
        ? (zh ? `⏳ Grok Video 第${n}/${clips}段生成中（0%）…` : `⏳ Grok Video clip ${n}/${clips} generating (0%)…`)
        : (zh ? `⏳ Grok Video 生成中（0%）…` : `⏳ Grok Video generating (0%)…`);
      updateVideoTask(taskId, { status: "running", stage: zh ? `${labelZh} 0%` : `${labelEn} 0%` });
      // Use the LLM-split segment prompt, wrapped with Grok-friendly prefix/suffix
      const clipPrompt = buildGrokVideoPrompt(segmentPrompts[i] || core, 6);
      const res = await _runOneGrokGeneration(base, clipPrompt, model, taskId, labelZh, labelEn);
      results.push(res.videoUrl);
    }

    // Chain concat if multiple clips — show explicit error if any step fails
    let finalUrl = results[0];
    let concatFailed = false;
    for (let i = 1; i < results.length; i++) {
      pollBubble.textContent = zh
        ? `⏳ 第${i}+${i + 1}段拼接中…`
        : `⏳ Concat clip ${i} + ${i + 1}…`;
      updateVideoTask(taskId, { status: "running", stage: zh ? `拼接 ${i}+${i + 1}` : `Concat ${i}+${i + 1}` });
      const merged = await _grokConcat(base, finalUrl, results[i]);
      if (merged.ok && merged.url) {
        finalUrl = merged.url;
      } else {
        concatFailed = true;
        pushSystemStateMsg(zh
          ? `⚠️ 第${i}+${i + 1}段拼接失败（${merged.error}），已保留前 ${i * 6}s 视频。`
          : `⚠️ Concat clip ${i}+${i + 1} failed (${merged.error}), keeping first ${i * 6}s.`, "blocked");
        break;
      }
    }

    const approxSec = clips * 6;
    if (pollBubble.parentNode) pollBubble.remove();
    if (clips === 1) {
      pushSystemStateMsg(zh ? `Grok Video 生成完成（约6s）。` : `Grok Video complete (~6s).`, "done");
    } else if (concatFailed) {
      // partial success already messaged inline above
    } else {
      pushSystemStateMsg(zh
        ? `Grok Video ${clips}段拼接完成（约${approxSec}s）。`
        : `Grok Video ${clips}-clip concat done (~${approxSec}s).`, "done");
    }
    updateVideoTask(taskId, { status: "done", stage: zh ? "完成" : "Done" });
    renderGeneratedVideoCard(finalUrl, "", "", taskId);
  } catch (e) {
    if (pollBubble.parentNode) pollBubble.remove();
    if (String(e?.message || "") === "CANCELLED" || state.taskMap?.[taskId]?.cancelRequested) return;
    pushSystemStateMsg(String(e?.message || "") || t("genFail"), "blocked");
    updateVideoTask(taskId, { status: "failed", stage: zh ? "失败" : "Failed" });
    throw e;
  }
}

function syncSimpleControlsFromState() {
  if (aspectRatioSelect) aspectRatioSelect.value = state.aspectRatio || "16:9";
  if (durationSelect) durationSelect.value = String(state.duration || "8");
  updateGenerationGateUI();
}

function syncStateFromSimpleControls() {
  if (aspectRatioSelect?.value) state.aspectRatio = aspectRatioSelect.value;
  if (durationSelect?.value) state.duration = String(durationSelect.value);
}

function scrollToBottom() {
  updateChatTailWindow();
  if (_userScrolledUp) {
    // User is reading history — don't force scroll, just update badge
    _unreadCount += 1;
    const badge = document.getElementById("scrollBotBadge");
    if (badge) {
      badge.textContent = _unreadCount > 99 ? "99+" : String(_unreadCount);
      badge.hidden = false;
    }
    return;
  }
  chatList.scrollTop = chatList.scrollHeight;
}

function updateChatTailWindow() {
  if (!chatList) return;
  // Remove any previously collapsed state — chat column is fully scrollable
  const nodes = Array.from(chatList.querySelectorAll(":scope > article.msg"));
  nodes.forEach((el) => el.classList.remove("is-history-collapsed"));
}

function focusWorkspaceTop() {
  const page = document.querySelector(".agent-page");
  if (page) page.scrollIntoView({ block: "start", behavior: "smooth" });
  window.scrollTo({ top: 0, behavior: "smooth" });
  scrollToBottom();
}

function getActiveVideoCard() {
  if (!chatList || !state.activeVideoCardId) return null;
  return chatList.querySelector(`[data-task-card-id="${state.activeVideoCardId}"]`);
}

function updateActiveVideoCardState() {
  if (!chatList) return;
  chatList.querySelectorAll(".video-msg.is-active").forEach((el) => el.classList.remove("is-active"));
  chatList.querySelectorAll(".video-msg").forEach((card) => {
    const isActive = String(card.getAttribute("data-task-card-id") || "") === String(state.activeVideoCardId || "");
    card.classList.toggle("is-active", isActive);
    const ctxActive = card.querySelector(".card-status-active");
    const ctxIdle = card.querySelector(".card-status-idle");
    const bindVideo = card.querySelector(".card-binding-video-editor");
    const bindScript = card.querySelector(".card-binding-script-editor");
    const editMode = card.querySelector(".card-binding-edit-mode");
    if (ctxActive) ctxActive.hidden = !isActive;
    if (ctxIdle) ctxIdle.hidden = isActive;
    if (bindVideo) bindVideo.hidden = !(isActive && state.videoEditorOpen);
    if (bindScript) bindScript.hidden = !(isActive && state.scriptEditorOpen);
    if (editMode) {
      const label = getCurrentEditModeLabel();
      editMode.hidden = !(isActive && label);
      if (label) editMode.textContent = `${t("cardEditModeShort")} · ${label}`;
    }
  });
}

function focusActiveVideoCard(behavior = "smooth", block = "center") {
  const card = getActiveVideoCard();
  if (!card) return false;
  updateActiveVideoCardState();
  card.scrollIntoView({ behavior, block, inline: "nearest" });
  return true;
}

function restoreWorkspaceAnchor(behavior = "smooth", block = "center") {
  requestAnimationFrame(() => {
    if (!focusActiveVideoCard(behavior, block) && state.canUseEditors) {
      const page = document.querySelector(".agent-page");
      if (page) page.scrollIntoView({ block: "start", behavior });
    }
  });
}

function normalizePointsList(raw = "") {
  return String(raw)
    .split(/[，,；;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function getFocusText() {
  if (state.mainBusiness) return state.mainBusiness;
  if (state.productName) return state.productName;
  return currentLang === "zh" ? "该商品" : "this product";
}

function detectProductCategory() {
  const source = `${state.productName || ""} ${state.mainBusiness || ""}`.toLowerCase();
  if (/dress|连衣裙|半身裙|裙/.test(source)) return "dress";
  if (/shoe|鞋|高跟|靴|sneaker|heel|boot/.test(source)) return "shoe";
  if (/bag|包|tote|handbag|backpack|链条包/.test(source)) return "bag";
  if (/shirt|衬衫|上衣|外套|夹克|针织|毛衣|top|jacket|coat/.test(source)) return "top";
  if (/pants|trouser|jeans|裤|西裤|牛仔裤/.test(source)) return "bottom";
  return "general";
}

function extractProductHintFromText(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return "";
  const knownPairs = [
    [/连衣裙|裙子|半身裙|长裙|短裙/i, currentLang === "zh" ? "连衣裙" : "dress"],
    [/高跟鞋|凉鞋|运动鞋|靴子|女鞋|男鞋|鞋/i, currentLang === "zh" ? "鞋子" : "shoes"],
    [/手提包|斜挎包|双肩包|托特包|包包|包/i, currentLang === "zh" ? "包" : "bag"],
    [/衬衫|上衣|外套|夹克|毛衣|针织衫/i, currentLang === "zh" ? "上衣" : "top"],
    [/牛仔裤|西裤|长裤|短裤|裤子/i, currentLang === "zh" ? "裤装" : "pants"],
  ];
  for (const [re, value] of knownPairs) {
    if (re.test(text)) return value;
  }

  const m = text.match(/(?:生成|制作|做|拍|create|generate|make)\s*(?:一个|一条|一款|一件|a|an)?\s*(.+?)\s*(?:视频|短视频|广告|video|ad)/i);
  if (!m || !m[1]) return "";
  const candidate = m[1]
    .replace(/^(帮我|请|麻烦|我想|我想要|我要|给我|please)\s*/i, "")
    .replace(/^(一个|一条|一款|一件|a|an)\s*/i, "")
    .replace(/[，。,.!！?？]/g, "")
    .trim();
  if (!candidate || candidate.length > 20) return "";
  return candidate;
}

function applyTextInsightIfPossible(raw = "") {
  const hintProduct = extractProductHintFromText(raw);
  if (hintProduct && !state.productName) state.productName = hintProduct;
  if (!state.mainBusiness) {
    state.mainBusiness = hintProduct ? guessBusinessByName(hintProduct) : String(raw || "").trim();
  }
}

function safeParseJsonObject(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_e) {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_e) {}
  }
  const objBlock = text.match(/\{[\s\S]*\}/);
  if (objBlock?.[0]) {
    try {
      return JSON.parse(objBlock[0]);
    } catch (_e) {}
  }
  return null;
}

function normalizeOptionPool(pool, maxCount = 6) {
  if (!Array.isArray(pool)) return [];
  const out = [];
  for (const item of pool) {
    const title = String(item?.title || "").trim();
    const desc = String(item?.desc || "").trim();
    if (!title || !desc) continue;
    out.push({ title, desc });
    if (out.length >= maxCount) break;
  }
  return out;
}

function pickOptionBatch(pool = [], idx = 0, size = 3) {
  if (!pool.length) return [];
  if (pool.length <= size) return pool.slice(0, size);
  const start = idx % pool.length;
  const out = [];
  for (let i = 0; i < size; i += 1) out.push(pool[(start + i) % pool.length]);
  return out;
}

function getSmartOptionSignature() {
  return [
    currentLang,
    state.productName || "",
    state.mainBusiness || "",
    state.salesRegion || "",
    state.template || "clean",
  ].join("|");
}

function buildSmartOptionPrompt() {
  const lang = currentLang === "zh" ? "zh" : "en";
  const product = state.productName || (lang === "zh" ? "未知商品" : "unknown product");
  const business = state.mainBusiness || (lang === "zh" ? "电商商品" : "ecommerce product");
  const region = state.salesRegion || (lang === "zh" ? "未指定地区" : "unspecified region");
  const template = state.template || "clean";
  if (lang === "zh") {
    return [
      "你是电商视频营销策略助手。基于输入商品，生成候选“目标客群”和“品牌方向”选项。",
      "要求：结合商品特征、售卖地区与投放语境，避免空泛描述；输出中文。",
      "输出必须是 JSON：",
      '{"target_options":[{"title":"", "desc":""}], "brand_options":[{"title":"", "desc":""}]}',
      "每个数组返回 6 条；title 不超过 12 字，desc 不超过 28 字。",
      `商品名称: ${product}`,
      `主营方向: ${business}`,
      `售卖地区: ${region}`,
      `风格模板: ${template}`,
    ].join("\n");
  }
  return [
    "You are an ecommerce video strategy assistant.",
    "Generate candidate options for target audience and brand direction using product traits and sales region.",
    "Output JSON only:",
    '{"target_options":[{"title":"", "desc":""}], "brand_options":[{"title":"", "desc":""}]}',
    "Return 6 items per list; concise and specific.",
    `Product: ${product}`,
    `Business focus: ${business}`,
    `Sales region: ${region}`,
    `Style template: ${template}`,
  ].join("\n");
}

async function ensureSmartOptionPools() {
  const signature = getSmartOptionSignature();
  if (!state.productName && !state.mainBusiness) return null;
  if (
    smartOptionCache.signature === signature &&
    smartOptionCache.targetPool.length &&
    smartOptionCache.brandPool.length
  ) {
    return { targetPool: smartOptionCache.targetPool, brandPool: smartOptionCache.brandPool };
  }
  if (smartOptionCache.loading && smartOptionCache.signature === signature) {
    return smartOptionCache.loading;
  }

  const base = getApiBase();
  smartOptionCache.signature = signature;
  smartOptionCache.loading = (async () => {
    try {
      const resp = await postJson(
        `${base}/api/agent/chat`,
        {
          prompt: buildSmartOptionPrompt(),
          temperature: 0.4,
          max_tokens: 700,
        },
        22000
      );
      const parsed = safeParseJsonObject(resp?.content || "");
      const targetPool = normalizeOptionPool(parsed?.target_options);
      const brandPool = normalizeOptionPool(parsed?.brand_options);
      if (targetPool.length) smartOptionCache.targetPool = targetPool;
      if (brandPool.length) smartOptionCache.brandPool = brandPool;
      return { targetPool: smartOptionCache.targetPool, brandPool: smartOptionCache.brandPool };
    } catch (_e) {
      return null;
    } finally {
      smartOptionCache.loading = null;
    }
  })();
  return smartOptionCache.loading;
}

function buildTargetOptions() {
  const focus = getFocusText();
  const category = detectProductCategory();
  if (currentLang === "zh") {
    const poolMap = {
      dress: [
        { title: "都市通勤女性", desc: `偏好${focus}的版型、垂感与通勤气质` },
        { title: "约会出游人群", desc: `关注${focus}的上镜效果与场景搭配` },
        { title: "轻熟职场人群", desc: `重视${focus}在通勤与社交场景的切换` },
        { title: "礼赠消费人群", desc: `更在意${focus}的质感、包装与仪式感` },
      ],
      shoe: [
        { title: "长时通勤人群", desc: `看重${focus}的舒适支撑与久穿稳定性` },
        { title: "时尚穿搭人群", desc: `关注${focus}的鞋型线条与搭配表现` },
        { title: "学生与初职场", desc: `偏好${focus}的高性价比与百搭属性` },
        { title: "功能场景用户", desc: `重视${focus}在不同路况/天气下的实用性` },
      ],
      bag: [
        { title: "日常通勤人群", desc: `关注${focus}的容量分区与轻便性` },
        { title: "精致生活人群", desc: `看重${focus}的材质质感与五金细节` },
        { title: "短途出行人群", desc: `偏好${focus}的收纳效率与场景适配` },
        { title: "礼赠消费人群", desc: `重视${focus}的品牌感与开箱体验` },
      ],
      top: [
        { title: "都市通勤女性", desc: `关注${focus}的版型、面料与利落度` },
        { title: "轻熟职场人群", desc: `重视${focus}在办公室场景的体面度` },
        { title: "潮流穿搭爱好者", desc: `看重${focus}的风格表达与叠穿潜力` },
        { title: "学生群体", desc: `偏好${focus}的舒适、耐穿与性价比` },
      ],
      bottom: [
        { title: "都市通勤女性", desc: `关注${focus}的修饰线条与久坐舒适` },
        { title: "轻熟职场人群", desc: `重视${focus}与衬衫/西装的搭配效率` },
        { title: "高频出行人群", desc: `偏好${focus}的抗皱与易打理属性` },
        { title: "学生与初职场", desc: `看重${focus}的百搭与预算友好度` },
      ],
      general: [
        { title: "都市通勤女性", desc: `偏好${focus}的版型、舒适与质感表达` },
        { title: "甜美学生群体", desc: `关注${focus}的颜值、搭配和性价比` },
        { title: "轻熟职场人群", desc: `重视${focus}的剪裁、面料与场景适配` },
        { title: "潮流穿搭爱好者", desc: `看重${focus}的风格表达与上新速度` },
      ],
    };
    const pool = poolMap[category] || poolMap.general;
    const start = state.targetBatchIdx % pool.length;
    return [pool[start], pool[(start + 1) % pool.length], pool[(start + 2) % pool.length]];
  }
  const poolMap = {
    dress: [
      { title: "Office-ready women", desc: `Care about drape, fit, and commute-ready polish for ${focus}` },
      { title: "Date & outing shoppers", desc: `Value on-camera effect and styling flexibility for ${focus}` },
      { title: "Young professionals", desc: `Need smooth scene-switching between work and social for ${focus}` },
      { title: "Gift shoppers", desc: `Care about texture, packaging, and gifting moment for ${focus}` },
    ],
    shoe: [
      { title: "Long-commute users", desc: `Need comfort support and stability for ${focus}` },
      { title: "Style-forward shoppers", desc: `Care about silhouette and outfit compatibility for ${focus}` },
      { title: "Students & early career", desc: `Need value-for-money and versatile matching for ${focus}` },
      { title: "Functional users", desc: `Focus on practical use across weather and routes for ${focus}` },
    ],
    bag: [
      { title: "Daily commuters", desc: `Care about compartment layout and lightweight carry for ${focus}` },
      { title: "Refined lifestyle shoppers", desc: `Focus on material texture and hardware details for ${focus}` },
      { title: "Short-trip users", desc: `Need storage efficiency and scene flexibility for ${focus}` },
      { title: "Gift shoppers", desc: `Value brand feel and unboxing experience for ${focus}` },
    ],
    top: [
      { title: "Urban office women", desc: `Care about tailoring, fabric, and clean structure for ${focus}` },
      { title: "Young professionals", desc: `Need presentable office styling performance for ${focus}` },
      { title: "Trend-driven audience", desc: `Value style expression and layering potential for ${focus}` },
      { title: "Student segment", desc: `Need comfort, durability, and price-performance for ${focus}` },
    ],
    bottom: [
      { title: "Urban office women", desc: `Care about silhouette shaping and seated comfort for ${focus}` },
      { title: "Young professionals", desc: `Need fast matching with shirts/blazers for ${focus}` },
      { title: "Frequent movers", desc: `Value wrinkle resistance and easy care for ${focus}` },
      { title: "Students & early career", desc: `Need versatile and budget-friendly options for ${focus}` },
    ],
    general: [
      { title: "Urban office women", desc: `Care about fit, comfort, and texture for ${focus}` },
      { title: "Student segment", desc: `Value style, matching ease, and price-performance for ${focus}` },
      { title: "Young professionals", desc: `Focus on tailoring, fabric, and occasion fit for ${focus}` },
      { title: "Trend-driven audience", desc: `Prefer style expression and fresh drops for ${focus}` },
    ],
  };
  const pool = poolMap[category] || poolMap.general;
  const start = state.targetBatchIdx % pool.length;
  return [pool[start], pool[(start + 1) % pool.length], pool[(start + 2) % pool.length]];
}

function buildBrandOptions() {
  const focus = getFocusText();
  const category = detectProductCategory();
  if (currentLang === "zh") {
    const poolMap = {
      dress: [
        { title: "轻奢质感型", desc: `围绕${focus}强化垂感面料与细节工艺` },
        { title: "优雅气质型", desc: `围绕${focus}强化线条修饰与场景氛围` },
        { title: "高性价比型", desc: `围绕${focus}强调百搭与多场景复用` },
        { title: "设计师风格型", desc: `围绕${focus}突出轮廓识别与视觉记忆点` },
      ],
      shoe: [
        { title: "舒适科技型", desc: `围绕${focus}强调脚感支撑与稳定防滑` },
        { title: "轻奢质感型", desc: `围绕${focus}强调材质触感与鞋型质感` },
        { title: "高性价比型", desc: `围绕${focus}突出耐穿、百搭与价格优势` },
        { title: "潮流设计型", desc: `围绕${focus}强调线条辨识与穿搭风格` },
      ],
      bag: [
        { title: "轻奢质感型", desc: `围绕${focus}强调材质、五金与细节做工` },
        { title: "实用收纳型", desc: `围绕${focus}强调容量结构与取放效率` },
        { title: "通勤百搭型", desc: `围绕${focus}强调场景覆盖与耐用表现` },
        { title: "礼赠精品型", desc: `围绕${focus}强化品牌感与开箱体验` },
      ],
      top: [
        { title: "版型质感型", desc: `围绕${focus}强调版型线条与面料触感` },
        { title: "通勤利落型", desc: `围绕${focus}强化职场场景的体面与效率` },
        { title: "高性价比型", desc: `围绕${focus}突出耐穿百搭与日常复购` },
        { title: "潮流设计型", desc: `围绕${focus}强调叠穿潜力与风格表达` },
      ],
      bottom: [
        { title: "修身显型型", desc: `围绕${focus}强调线条优化与上身效果` },
        { title: "通勤实穿型", desc: `围绕${focus}强调久坐舒适与抗皱易打理` },
        { title: "高性价比型", desc: `围绕${focus}突出百搭与预算友好` },
        { title: "简约功能型", desc: `围绕${focus}强调耐穿、场景通用与稳定品质` },
      ],
      general: [
        { title: "轻奢质感型", desc: `围绕${focus}强调高级面料与精致工艺` },
        { title: "高性价比型", desc: `围绕${focus}强调百搭、实穿与价格优势` },
        { title: "设计师风格型", desc: `围绕${focus}强调轮廓辨识度与个性表达` },
        { title: "简约功能型", desc: `围绕${focus}强调耐穿、易打理与场景通用` },
      ],
    };
    const pool = poolMap[category] || poolMap.general;
    const start = state.brandBatchIdx % pool.length;
    return [pool[start], pool[(start + 1) % pool.length], pool[(start + 2) % pool.length]];
  }
  const poolMap = {
    dress: [
      { title: "Premium texture", desc: `For ${focus}, emphasize drape fabric and detail craft` },
      { title: "Elegant mood", desc: `For ${focus}, emphasize flattering lines and scene mood` },
      { title: "Value-first", desc: `For ${focus}, emphasize versatile multi-scene wearing` },
      { title: "Designer-led", desc: `For ${focus}, emphasize silhouette identity and memory points` },
    ],
    shoe: [
      { title: "Comfort-tech", desc: `For ${focus}, emphasize support, grip, and all-day wear` },
      { title: "Premium texture", desc: `For ${focus}, emphasize material feel and shape quality` },
      { title: "Value-first", desc: `For ${focus}, emphasize durability and outfit versatility` },
      { title: "Trend design", desc: `For ${focus}, emphasize visual line and styling impact` },
    ],
    bag: [
      { title: "Premium texture", desc: `For ${focus}, emphasize material, hardware, and detail quality` },
      { title: "Utility storage", desc: `For ${focus}, emphasize capacity and access efficiency` },
      { title: "Commuter versatile", desc: `For ${focus}, emphasize scene coverage and durability` },
      { title: "Gift boutique", desc: `For ${focus}, emphasize branding and unboxing feel` },
    ],
    top: [
      { title: "Tailoring texture", desc: `For ${focus}, emphasize silhouette and fabric touch` },
      { title: "Office clean", desc: `For ${focus}, emphasize presentable and efficient styling` },
      { title: "Value-first", desc: `For ${focus}, emphasize durability and repeat daily use` },
      { title: "Trend design", desc: `For ${focus}, emphasize layering and style expression` },
    ],
    bottom: [
      { title: "Shape-enhancing", desc: `For ${focus}, emphasize silhouette optimization` },
      { title: "Commuter practical", desc: `For ${focus}, emphasize seated comfort and easy care` },
      { title: "Value-first", desc: `For ${focus}, emphasize versatile and budget-friendly use` },
      { title: "Minimal functional", desc: `For ${focus}, emphasize durability and stable quality` },
    ],
    general: [
      { title: "Premium texture", desc: `For ${focus}, highlight refined materials and craftsmanship` },
      { title: "Value-first", desc: `For ${focus}, emphasize versatility and pricing advantage` },
      { title: "Designer-led", desc: `For ${focus}, emphasize silhouette identity and style signature` },
      { title: "Minimal functional", desc: `For ${focus}, emphasize durability and easy care` },
    ],
  };
  const pool = poolMap[category] || poolMap.general;
  const start = state.brandBatchIdx % pool.length;
  return [pool[start], pool[(start + 1) % pool.length], pool[(start + 2) % pool.length]];
}

function buildStoryboardText() {
  const points = normalizePointsList(state.sellingPoints);
  const scenes = points.length ? points : [currentLang === "zh" ? "突出产品核心卖点" : "Highlight core product value"];
  const lines = scenes.map((p, idx) =>
    currentLang === "zh"
      ? `镜头${idx + 1}：${p}，面向「${state.targetUser || "目标人群"}」，突出「${state.salesRegion || "目标地区"}」表达。`
      : `Scene ${idx + 1}: ${p}; target "${state.targetUser || "audience"}"; localized for "${state.salesRegion || "region"}".`
  );
  return lines.join("\n");
}

function buildWorkflowInput() {
  return {
    product_name: state.productName || "",
    main_business: state.mainBusiness || "",
    style_template: state.template || "clean",
    selling_points: state.sellingPoints || "",
    target_user: state.targetUser || "",
    sales_region: state.salesRegion || "",
    brand_direction: state.brandInfo || "",
    duration: Number(state.duration || 8),
    aspect_ratio: state.aspectRatio || "16:9",
    need_model: Boolean(state.needModel),
    image_count: Math.max((state.images || []).length, (state.productImageUrls || []).length, 0),
    product_anchors: normalizeProductAnchors(state.productAnchors),
  };
}

function hasWorkflowRequiredInput() {
  return Boolean(
    state.productName &&
      state.mainBusiness &&
      state.sellingPoints &&
      state.targetUser &&
      state.salesRegion
  );
}

async function callShopliveWorkflow(action, extra = {}) {
  const base = getApiBase();
  return postJson(`${base}/api/shoplive/video/workflow`, {
    action,
    input: buildWorkflowInput(),
    model: "azure-gpt-5",
    ...extra,
  });
}

async function hydrateWorkflowTexts(force = false) {
  if (state.workflowHydrating) return;
  if (!force && state.workflowHydrated && state.lastStoryboard && state.lastPrompt) return;
  if (!hasWorkflowRequiredInput()) {
    if (!state.lastStoryboard) state.lastStoryboard = buildStoryboardText();
    if (!state.lastPrompt) state.lastPrompt = buildPrompt();
    return;
  }
  state.workflowHydrating = true;
  try {
    let script = state.lastStoryboard || "";
    try {
      const scriptResp = await callShopliveWorkflow("generate_script", {
        user_message: state.mainBusiness || state.productName || "",
      });
      if (scriptResp?.ok && scriptResp?.ready && scriptResp?.script) {
        script = String(scriptResp.script).trim();
      }
    } catch (_e) {}
    if (!script) script = buildStoryboardText();

    let prompt = "";
    try {
      const promptResp = await callShopliveWorkflow("build_export_prompt", { script_text: script });
      if (promptResp?.ok && promptResp?.ready && promptResp?.prompt) {
        prompt = sanitizePromptForUser(String(promptResp.prompt).trim());
      }
    } catch (_e) {}
    if (!prompt) prompt = buildPrompt();

    state.lastStoryboard = script;
    state.lastPrompt = sanitizePromptForUser(prompt);
    state.workflowHydrated = true;
  } finally {
    state.workflowHydrating = false;
  }
}

function applyWorkspaceMode() {
  if (!workspaceEl) return;
  hasOpenEditors = Boolean(state.canUseEditors && (state.videoEditorOpen || state.scriptEditorOpen));
  workspaceEl.classList.toggle("has-editors", hasOpenEditors);
  updateWorkspaceToolbarVisibility();
  workspaceEl.classList.toggle("entry-focus", Boolean(state.entryFocusMode && !state.canUseEditors));
  if (!state.canUseEditors) {
    state.videoEditorOpen = false;
    state.scriptEditorOpen = false;
    workspaceEl.classList.remove("mode-chat", "mode-two-video", "mode-two-script", "mode-three");
    workspaceEl.classList.remove("has-editors");
    workspaceEl.classList.add("mode-chat");
    if (scriptEditorPanel) scriptEditorPanel.hidden = true;
    if (videoEditorPanel) videoEditorPanel.hidden = true;
    updateWorkspaceTabs();
    updateChatTailWindow();
    return;
  }
  const mode = state.videoEditorOpen && state.scriptEditorOpen
    ? "mode-three"
    : state.videoEditorOpen
      ? "mode-two-video"
      : state.scriptEditorOpen
        ? "mode-two-script"
        : "mode-chat";
  workspaceEl.classList.remove("mode-chat", "mode-two-video", "mode-two-script", "mode-three");
  workspaceEl.classList.add(mode);
  if (scriptEditorPanel) scriptEditorPanel.hidden = !state.scriptEditorOpen;
  if (videoEditorPanel) videoEditorPanel.hidden = !state.videoEditorOpen;
  updateWorkspaceTabs();
  updateChatTailWindow();
  updateActiveVideoCardState();
  _updateEditCmdsBar();
}

function updateWorkspaceTabs() {
  if (toggleScriptTab) {
    const active = Boolean(state.scriptEditorOpen);
    toggleScriptTab.classList.toggle("is-active", active);
    toggleScriptTab.dataset.state = active ? "progress" : "idle";
    toggleScriptTab.setAttribute("aria-pressed", active ? "true" : "false");
    toggleScriptTab.title = active ? `${t("tabScript")} · ${t("tabHideHint")}` : `${t("tabScript")} · ${t("tabShowHint")}`;
  }
  if (toggleVideoTab) {
    const active = Boolean(state.videoEditorOpen);
    toggleVideoTab.classList.toggle("is-active", active);
    toggleVideoTab.dataset.state = active ? "progress" : "idle";
    toggleVideoTab.setAttribute("aria-pressed", active ? "true" : "false");
    toggleVideoTab.title = active ? `${t("tabVideo")} · ${t("tabHideHint")}` : `${t("tabVideo")} · ${t("tabShowHint")}`;
  }
  updateToolbarIndicator();
}

function updateWorkspaceToolbarVisibility() {
  if (!workspaceToolbar) return;
  hasOpenEditors = Boolean(state.canUseEditors && (state.videoEditorOpen || state.scriptEditorOpen));
  workspaceToolbar.hidden = !hasOpenEditors;
}

function updateToolbarIndicator() {
  if (!workspaceToolbar || !toggleScriptTab || !toggleVideoTab) return;
  const activeTabs = [toggleScriptTab, toggleVideoTab].filter((el) => el.classList.contains("is-active"));
  if (activeTabs.length !== 1) {
    workspaceToolbar.classList.remove("has-indicator");
    return;
  }
  const active = activeTabs[0];
  const host = workspaceToolbar.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  const x = Math.max(0, rect.left - host.left);
  const w = rect.width;
  workspaceToolbar.style.setProperty("--tab-indicator-x", `${x}px`);
  workspaceToolbar.style.setProperty("--tab-indicator-w", `${w}px`);
  workspaceToolbar.classList.add("has-indicator");
}

function buildSegmentedStoryboard(segCount = 1) {
  const points = normalizePointsList(state.sellingPoints);
  const fallback = currentLang === "zh" ? "突出产品核心卖点" : "Highlight core product value";
  if (segCount <= 1) {
    const scenes = points.length ? points : [fallback];
    return [
      scenes
        .map((p, idx) =>
          currentLang === "zh"
            ? `镜头${idx + 1}：${p}，面向「${state.targetUser || "目标人群"}」，突出「${state.salesRegion || "目标地区"}」表达。`
            : `Scene ${idx + 1}: ${p}; target "${state.targetUser || "audience"}"; localized for "${state.salesRegion || "region"}".`
        )
        .join("\n"),
    ];
  }
  const half = Math.ceil(points.length / segCount);
  const segments = [];
  for (let s = 0; s < segCount; s++) {
    const chunk = points.slice(s * half, (s + 1) * half);
    if (!chunk.length) chunk.push(fallback);
    const segLabel = currentLang === "zh" ? `第${s + 1}段（8秒）` : `Segment ${s + 1} (8s)`;
    const lines = chunk.map((p, idx) =>
      currentLang === "zh"
        ? `镜头${idx + 1}：${p}，面向「${state.targetUser || "目标人群"}」。`
        : `Scene ${idx + 1}: ${p}; target "${state.targetUser || "audience"}".`
    );
    segments.push(`[${segLabel}]\n${lines.join("\n")}`);
  }
  return segments;
}

function buildStoryboardFromPromptSegments(prompts = [], segDuration = 8) {
  const list = Array.isArray(prompts)
    ? prompts.map((p) => String(p || "").trim()).filter(Boolean)
    : [];
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return list
    .map((p, i) => {
      const label = currentLang === "zh"
        ? `[第${i + 1}段（${segDuration}秒）]`
        : `[Segment ${i + 1} (${segDuration}s)]`;
      return `${label}\n${p}`;
    })
    .join("\n\n");
}

function parseStoryboardSegments(storyboardText = "") {
  const raw = String(storyboardText || "").trim();
  if (!raw) return [];
  const parts = raw
    .split(/\n*\[(?:第\d+段（\d+秒）|Segment \d+ \(\d+s\))\]\s*/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts;
}

function getBoundScriptSummary(storyboardText = "") {
  const parts = parseStoryboardSegments(storyboardText);
  if (parts.length > 1) {
    return currentLang === "zh" ? `${parts.length} 段分镜` : `${parts.length} scenes`;
  }
  const raw = String((parts[0] || storyboardText || "")).trim();
  const firstLine = raw.split("\n").map((s) => s.trim()).find(Boolean) || "";
  if (!firstLine) {
    return currentLang === "zh" ? "单段脚本" : "single scene";
  }
  return firstLine.length > 20 ? `${firstLine.slice(0, 20)}…` : firstLine;
}

function getCurrentEditModeLabel() {
  if (state.videoEditorOpen && state.scriptEditorOpen) return t("cardEditModeHybrid");
  if (state.videoEditorOpen) return t("cardEditModeVideo");
  if (state.scriptEditorOpen) return t("cardEditModeScript");
  return "";
}

function renderScriptEditor() {
  if (!scriptEditorPanel) return;
  if (!state.scriptEditorOpen) return;

  const dur = Number(state.duration || 8);
  const segCount = dur >= 16 ? Math.floor(dur / 8) : 1;
  const existingSegments = parseStoryboardSegments(state.lastStoryboard);
  const segments = existingSegments.length === segCount
    ? existingSegments
    : buildSegmentedStoryboard(segCount);

  const durationLabel = currentLang === "zh" ? "视频时长" : "Duration";
  const segmentLabel = currentLang === "zh" ? "分镜段" : "Segment";

  let segmentHtml = "";
  for (let i = 0; i < segCount; i++) {
    const title = segCount > 1
      ? (currentLang === "zh" ? `${segmentLabel} ${i + 1}（8秒）` : `${segmentLabel} ${i + 1} (8s)`)
      : (currentLang === "zh" ? "分镜脚本" : "Storyboard");
    segmentHtml += `
      <label class="editor-label">${title}</label>
      <textarea id="storyboardSeg${i}" class="editor-textarea" rows="6">${sanitizeInputValue(segments[i] || "")}</textarea>
    `;
  }

  scriptEditorPanel.innerHTML = `
    <div class="editor-head">
      <strong>${t("scriptEditTitle")}</strong>
      <button class="editor-close-btn" id="closeScriptPanelBtn">${t("closePanel")}</button>
    </div>
    <p class="editor-hint">${t("scriptEditHint")}</p>
    <div class="editor-duration-row" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <label class="editor-label" style="margin:0;">${durationLabel}</label>
      <select id="scriptDurationSelect" style="padding:4px 8px;border-radius:8px;border:1px solid #c0d2ec;">
        <option value="4" ${dur === 4 ? "selected" : ""}>4${currentLang === "zh" ? "秒" : "s"}</option>
        <option value="6" ${dur === 6 ? "selected" : ""}>6${currentLang === "zh" ? "秒" : "s"}</option>
        <option value="8" ${dur === 8 ? "selected" : ""}>8${currentLang === "zh" ? "秒" : "s"}</option>
        <option value="16" ${dur === 16 ? "selected" : ""}>16${currentLang === "zh" ? "秒（2段拼接）" : "s (2 segments)"}</option>
      </select>
    </div>
    ${segmentHtml}
    <label class="editor-label">${t("promptLabel")}</label>
    <textarea id="promptTextarea" class="editor-textarea" rows="10">${sanitizeInputValue(state.lastPrompt || buildPrompt())}</textarea>
    <div class="editor-actions">
      <button id="regenFromScriptBtn" class="action-chip-btn action-chip-primary">${t("storyboardRegenerate")}</button>
    </div>
  `;

  scriptEditorPanel.querySelector("#scriptDurationSelect")?.addEventListener("change", (e) => {
    const newDur = String(e.target.value || "8");
    state.duration = newDur;
    if (durationSelect) durationSelect.value = newDur;
    renderScriptEditor();
  });

  scriptEditorPanel.querySelector("#closeScriptPanelBtn")?.addEventListener("click", () => {
    state.scriptEditorOpen = false;
    applyWorkspaceMode();
  });

  scriptEditorPanel.querySelector("#regenFromScriptBtn")?.addEventListener("click", async () => {
    const btn = scriptEditorPanel.querySelector("#regenFromScriptBtn");
    setActionButtonState(btn, "progress", t("storyboardRegenerate"));
    const currentSegCount = Number(state.duration || 8) >= 16 ? Math.floor(Number(state.duration) / 8) : 1;
    const segs = [];
    for (let i = 0; i < currentSegCount; i++) {
      const el = scriptEditorPanel.querySelector(`#storyboardSeg${i}`);
      segs.push(el?.value?.trim() || "");
    }
    if (currentSegCount > 1) {
      state.lastStoryboard = segs.map((s, i) => {
        const label = currentLang === "zh" ? `[第${i + 1}段（8秒）]` : `[Segment ${i + 1} (8s)]`;
        return `${label}\n${s}`;
      }).join("\n\n");
    } else {
      state.lastStoryboard = segs[0] || "";
    }
    state.lastPrompt = scriptEditorPanel.querySelector("#promptTextarea")?.value?.trim() || buildPrompt();
    try {
      await generateVideo(state.lastPrompt);
      setActionButtonState(btn, "done", t("storyboardRegenerate"));
      setTimeout(() => setActionButtonState(btn, "idle"), 1400);
    } catch (_e) {
      setActionButtonState(btn, "blocked", t("storyboardRegenerate"));
      setTimeout(() => setActionButtonState(btn, "idle"), 1800);
      throw _e;
    }
  });
}

function getVideoDurationSec() {
  const d = Number(state.duration || 8);
  return Number.isFinite(d) && d > 0 ? d : 8;
}

function fmtSec(sec = 0) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `0:${String(s).padStart(2, "0")}`;
}

function getTimelineSnapCandidates(ignoreTrack = "", ignoreIdx = -1) {
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

function snapTimelineSec(sec, maxDelta = 0.2, ignoreTrack = "", ignoreIdx = -1) {
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

function ensureTimelineState() {
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

function buildTrackSegmentsHtml(trackId, points = [], maxSec = 8, isVisible = true) {
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

function getTrackRangesByKeyframes(points = []) {
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

function isTrackActiveAtTime(trackId = "mask", sec = 0, timeline = null) {
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

function buildTimelineRowsHtml(maxSec) {
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

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function revokeLocalObjectUrl(url = "") {
  if (typeof url === "string" && url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch (_e) {}
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read file failed"));
    reader.readAsDataURL(file);
  });
}

function setupSurfaceFullscreen(surface) {
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
    if (req) req.call(surface).then(() => applyVideoEditsToPreview()).catch(err => console.debug('[shoplive]', err));
  });
  surface.appendChild(btn);

  // Re-apply all effects when fullscreen is entered (sizes may change)
  const onFsChange = () => {
    const isFs = document.fullscreenElement === surface || document.webkitFullscreenElement === surface;
    if (isFs) applyVideoEditsToPreview();
  };
  surface.addEventListener("fullscreenchange", onFsChange);
  surface.addEventListener("webkitfullscreenchange", onFsChange);
}

function setupMaskDrag(surface) {
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
    const xr = videoEditorPanel?.querySelector("#maskXRange");
    const yr = videoEditorPanel?.querySelector("#maskYRange");
    const xv = videoEditorPanel?.querySelector("#maskXVal");
    const yv = videoEditorPanel?.querySelector("#maskYVal");
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

function applyVideoEditsToPreview() {
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

function renderVideoEditor() {
  if (!videoEditorPanel) return;
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
  if (_currentHash === state.videoEdit._renderHash && videoEditorPanel?.innerHTML) return;
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
        <label>${t("textMaskText")}<input id="maskTextInput" value="${sanitizeInputValue(fx.maskText)}" placeholder="${currentLang === 'zh' ? '输入文字蒙版内容…' : 'Enter overlay text…'}" /></label>
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
              <span id="bgmFileName">${sanitizeInputValue(fx.localBgmName || t("bgmNoLocalFile"))}</span>
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
  videoEditorPanel.innerHTML = `
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
  const speedSelect = videoEditorPanel.querySelector("#videoEditSpeed");
  const maskStyleSelect = videoEditorPanel.querySelector("#maskStyleSelect");
  const moodSelect = videoEditorPanel.querySelector("#bgmMoodSelect");
  const replaceSelect = videoEditorPanel.querySelector("#bgmReplaceModeSelect");
  if (speedSelect) speedSelect.value = String(fx.speed || "1.0");
  if (maskStyleSelect) maskStyleSelect.value = String(fx.maskStyle || "elegant");
  if (moodSelect) moodSelect.value = String(fx.bgmMood || "elegant");
  if (replaceSelect) replaceSelect.value = String(fx.bgmReplaceMode || "auto");

  const bindRange = (id, outId, suffix = "") => {
    const input = videoEditorPanel.querySelector(id);
    const out = videoEditorPanel.querySelector(outId);
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
  const maskFontSelect = videoEditorPanel.querySelector("#maskFontSelect");
  if (maskFontSelect) maskFontSelect.value = String(fx.maskFont || "sans");

  // Live-preview: write slider/select values back to state.videoEdit immediately
  const liveNum = (sel, key) => {
    videoEditorPanel.querySelector(sel)?.addEventListener("input", (e) => {
      state.videoEdit[key] = Number(e.target.value);
      applyVideoEditsToPreview();
    });
  };
  const liveStr = (sel, key, evtName = "change") => {
    videoEditorPanel.querySelector(sel)?.addEventListener(evtName, (e) => {
      state.videoEdit[key] = e.target.value;
      applyVideoEditsToPreview();
    });
  };
  // Mask preset cards
  videoEditorPanel.querySelectorAll(".mask-preset-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.videoEdit.maskStyle = btn.getAttribute("data-preset") || "elegant";
      renderVideoEditor();  // re-render to update active card highlight
    });
  });
  // Mask text + font + color
  videoEditorPanel.querySelector("#maskTextInput")?.addEventListener("input", (e) => {
    state.videoEdit.maskText = e.target.value;
    applyVideoEditsToPreview();
  });
  liveStr("#maskFontSelect", "maskFont");
  videoEditorPanel.querySelector("#maskColorInput")?.addEventListener("input", (e) => {
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
  videoEditorPanel.querySelector("#bgmExtractChk")?.addEventListener("change", (e) => {
    state.videoEdit.bgmExtract = e.target.checked;
    applyVideoEditsToPreview();
  });
  liveStr("#bgmMoodSelect", "bgmMood");
  liveStr("#bgmReplaceModeSelect", "bgmReplaceMode");

  if (activeTrackState.locked) {
    videoEditorPanel.querySelectorAll(".module-body input, .module-body select, .module-body button, #addKeyframeBtn, #removeKeyframeBtn").forEach((el) => {
      el.disabled = true;
    });
  }
  videoEditorPanel.querySelectorAll(".module-switch-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mod = btn.getAttribute("data-module") || "mask";
      state.videoEdit.activeModule = mod;
      state.videoEdit.timeline.selectedTrack = mod;
      renderVideoEditor();
    });
  });

  const bgmFileInput = videoEditorPanel.querySelector("#bgmFileInput");
  const bgmFileName = videoEditorPanel.querySelector("#bgmFileName");
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
  videoEditorPanel.querySelector("#clearBgmFileBtn")?.addEventListener("click", () => {
    const oldUrl = state.videoEdit.localBgmUrl || "";
    state.videoEdit.localBgmUrl = "";
    state.videoEdit.localBgmName = "";
    state.videoEdit.localBgmDataUrl = "";
    revokeLocalObjectUrl(oldUrl);
    renderVideoEditor();
    applyVideoEditsToPreview();
  });

  const playheadRange = videoEditorPanel.querySelector("#timelinePlayheadRange");
  const playheadVal = videoEditorPanel.querySelector("#playheadVal");
  const playheadLine = videoEditorPanel.querySelector("#kfPlayheadLine");
  const pendingTip = videoEditorPanel.querySelector("#timelinePendingTip");
  const miniToast = videoEditorPanel.querySelector("#timelineMiniToast");
  const previewVideo = videoEditorPanel.querySelector(".video-edit-surface video");
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
        const ruler = videoEditorPanel.querySelector(".kf-ruler");
        if (ruler) {
          const spans = ruler.querySelectorAll("span");
          if (spans[0]) spans[0].textContent = "0:00";
          if (spans[1]) spans[1].textContent = fmtSec(Math.round(newMax / 2));
          if (spans[2]) spans[2].textContent = fmtSec(Math.round(newMax));
        }
        // Update all kf-track data-max attributes
        videoEditorPanel.querySelectorAll(".kf-track[data-max]").forEach((el) => {
          el.dataset.max = String(newMax);
        });
      }
      syncPlayheadFromVideo();
    });
    previewVideo.dataset.timelineSyncBound = "1";
  }
  videoEditorPanel.querySelectorAll(".kf-row .kf-label").forEach((labelNode) => {
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
  videoEditorPanel.querySelectorAll(".kf-track").forEach((trackNode) => {
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
  videoEditorPanel.querySelectorAll(".kf-ctrl").forEach((btn) => {
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

  videoEditorPanel.querySelectorAll(".kf-dot").forEach((dot) => {
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
  videoEditorPanel.querySelectorAll(".kf-seg[data-start-idx][data-end-idx]").forEach((seg) => {
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

  videoEditorPanel.querySelector("#addKeyframeBtn")?.addEventListener("click", () => {
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

  videoEditorPanel.querySelector("#removeKeyframeBtn")?.addEventListener("click", () => {
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

  videoEditorPanel.querySelector("#closeVideoPanelBtn")?.addEventListener("click", () => {
    if (typeof state.videoEdit._timelineKeydownHandler === "function") {
      window.removeEventListener("keydown", state.videoEdit._timelineKeydownHandler);
      state.videoEdit._timelineKeydownHandler = null;
    }
    if (state.videoEdit._timelineToastTimer) {
      clearTimeout(state.videoEdit._timelineToastTimer);
      state.videoEdit._timelineToastTimer = null;
    }
    state.videoEditorOpen = false;
    applyWorkspaceMode();
  });
  videoEditorPanel.querySelector("#downloadVideoBtn")?.addEventListener("click", async () => {
    const btn = videoEditorPanel.querySelector("#downloadVideoBtn");
    setActionButtonState(btn, "progress", t("videoDownload"));
    const url = state.lastVideoUrl;
    if (!url) {
      setActionButtonState(btn, "idle");
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
      setActionButtonState(btn, "done", t("videoDownload"));
    } catch (_e) {
      // Fallback: open in new tab
      window.open(url, "_blank", "noopener");
      setActionButtonState(btn, "blocked", t("videoDownload"));
    }
    setTimeout(() => setActionButtonState(btn, "idle"), 1400);
  });
  videoEditorPanel.querySelector("#regenFromVideoEditorBtn")?.addEventListener("click", async () => {
    const btn = videoEditorPanel.querySelector("#regenFromVideoEditorBtn");
    setActionButtonState(btn, "progress", t("videoRegenerate"));
    const pickValue = (selector, fallback) => {
      const el = videoEditorPanel.querySelector(selector);
      return el ? el.value : fallback;
    };
    const pickChecked = (selector, fallback) => {
      const el = videoEditorPanel.querySelector(selector);
      return el ? Boolean(el.checked) : Boolean(fallback);
    };
    state.videoEdit = {
      maskText: String(pickValue("#maskTextInput", fx.maskText || "")).trim(),
      maskStyle: state.videoEdit.maskStyle || "elegant",
      maskFont: pickValue("#maskFontSelect", fx.maskFont || "sans"),
      maskColor: String(videoEditorPanel.querySelector("#maskColorInput")?.value || fx.maskColor || "#ffffff"),
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
      pushSystemStateMsg(t("videoApplyDone"), "done");
      setActionButtonState(btn, "done", t("videoRegenerate"));
      setTimeout(() => setActionButtonState(btn, "idle"), 1400);
      return;
    }
    pushSystemStateMsg(t("videoExporting"), "progress");
    try {
      const base = getApiBase();
      const resp = await postJson(
        `${base}/api/video/edit/export`,
        {
          video_url: state.lastVideoUrl,
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
      pushSystemStateMsg(t("videoApplyDone"), "done");
      if (state.videoEdit.maskText && resp?.mask_applied === false) {
      pushSystemStateMsg(t("videoMaskUnsupported"), "blocked");
      }
      setActionButtonState(btn, "done", t("videoRegenerate"));
    } catch (_e) {
      applyVideoEditsToPreview();
      pushSystemStateMsg(t("videoExportFail"), "blocked");
      setActionButtonState(btn, "blocked", t("videoRegenerate"));
    }
    setTimeout(() => setActionButtonState(btn, "idle"), 1600);
  });
  videoEditorPanel.querySelector("#resetVideoEditorBtn")?.addEventListener("click", () => {
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
  const editorSurface = videoEditorPanel.querySelector(".video-edit-surface");
  if (editorSurface) {
    setupMaskDrag(editorSurface);
    setupSurfaceFullscreen(editorSurface);
  }
}

function openEditorPanel(type) {
  if (!state.canUseEditors) return;
  if (type === "video") state.videoEditorOpen = true;
  if (type === "script") state.scriptEditorOpen = true;
  applyWorkspaceMode();
  renderVideoEditor();
  renderScriptEditor();
  restoreWorkspaceAnchor();
  if (type === "script" && (!state.lastStoryboard || !state.lastPrompt)) {
    hydrateWorkflowTexts(true).then(() => {
      if (state.scriptEditorOpen) renderScriptEditor();
      restoreWorkspaceAnchor("auto", "nearest");
    });
  }
}

function toggleEditorPanel(type) {
  if (!state.canUseEditors) return;
  if (type === "video") state.videoEditorOpen = !state.videoEditorOpen;
  if (type === "script") state.scriptEditorOpen = !state.scriptEditorOpen;
  applyWorkspaceMode();
  renderVideoEditor();
  renderScriptEditor();
  restoreWorkspaceAnchor();
}

function setThinking(show, text = "") {
  if (show) {
    if (thinkingNode) return;
    thinkingNode = document.createElement("article");
    thinkingNode.className = "msg system typing";
    thinkingNode.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span><span>${text || "..."}</span>`;
    chatList.appendChild(thinkingNode);
    scrollToBottom();
    return;
  }
  if (thinkingNode) {
    thinkingNode.remove();
    thinkingNode = null;
  }
}

// ── Markdown renderer (graceful fallback if marked/DOMPurify not loaded) ────
function _renderMd(el, text) {
  if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text || ""));
  } else {
    el.textContent = text || "";
  }
}

function typewriter(el, text, speed = 24) {
  const content = String(text || "");
  // Skip animation for long messages — instant render feels faster
  if (content.length > 160) {
    _renderMd(el, content);
    scrollToBottom();
    return;
  }
  let i = 0;
  let accumulated = "";
  const tick = () => {
    if (i >= content.length) return;
    const ch = content[i];
    accumulated += ch;
    i += 1;
    _renderMd(el, accumulated);
    scrollToBottom();
    setTimeout(tick, /[，。！？,.!?]/.test(ch) ? speed * 2.5 : speed);
  };
  tick();
}

// ── Streaming bubble: returns append(delta) / finish() handles ──────────────
function pushStreamingMsg(role) {
  if (state.entryFocusMode) {
    state.entryFocusMode = false;
    applyWorkspaceMode();
  }
  const el = document.createElement("article");
  el.className = `msg ${role} is-streaming`;
  _attachHoverBar(el, role);
  let body = el;
  if (role === "system") {
    const inferred = inferSystemCardMeta("", { cardKind: "status" });
    const meta = createSystemCardMeta(inferred.label, inferred.status, inferred.kind, inferred.tone);
    body = document.createElement("div");
    body.className = "msg-body";
    body.setAttribute("data-msg-body", "1");
    el.classList.add("has-card-meta");
    el.appendChild(meta);
    el.appendChild(body);
  }
  chatList.appendChild(el);
  _applyGroupRadius();
  scrollToBottom();
  let accumulated = "";
  return {
    el,
    append(delta) {
      accumulated += delta;
      _renderMd(body, accumulated);
      scrollToBottom();
    },
    finish() {
      el.classList.remove("is-streaming");
    },
    remove() {
      el.remove();
      _applyGroupRadius();
    },
  };
}

// ── Message grouping: tighten radius between consecutive same-role bubbles ───
function _applyGroupRadius() {
  const msgs = Array.from(
    chatList.querySelectorAll(":scope > article.msg:not(.video-msg):not(.form-card)")
  );
  msgs.forEach((el, i) => {
    const role = el.classList.contains("user") ? "user" : "system";
    const prev = i > 0 ? msgs[i - 1] : null;
    const next = i < msgs.length - 1 ? msgs[i + 1] : null;
    const prevRole = prev ? (prev.classList.contains("user") ? "user" : "system") : null;
    const nextRole = next ? (next.classList.contains("user") ? "user" : "system") : null;
    el.classList.toggle("group-top", prevRole === role);
    el.classList.toggle("group-bottom", nextRole === role);
  });
}

// ── Hover action bar: copy + retry ──────────────────────────────────────────
function _attachHoverBar(el, role) {
  const bar = document.createElement("div");
  bar.className = "msg-hover-bar";
  bar.innerHTML = `
    <button class="msg-action-btn" data-action="copy" title="${currentLang === "zh" ? "复制" : "Copy"}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
      </svg>
    </button>
    ${role === "system" ? `<button class="msg-action-btn" data-action="retry" title="${currentLang === "zh" ? "重试" : "Retry"}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 12a9 9 0 109-9M3 12V4M3 12H11"/>
      </svg>
    </button>` : ""}
  `;
  bar.querySelector('[data-action="copy"]')?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const bodyNode = el.querySelector("[data-msg-body]");
    const content = ((bodyNode?.innerText || bodyNode?.textContent || el.innerText || el.textContent || "")).trim();
    try {
      await navigator.clipboard.writeText(content);
    } catch (_) {
      // fallback for non-HTTPS
      const ta = document.createElement("textarea");
      ta.value = content;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    const btn = e.currentTarget;
    btn.classList.add("is-copied");
    setTimeout(() => btn.classList.remove("is-copied"), 1500);
  });
  bar.querySelector('[data-action="retry"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    // Re-trigger send with the last user message text
    const lastUser = [...chatList.querySelectorAll(".msg.user")].at(-1);
    if (lastUser) {
      const txt = (lastUser.innerText || lastUser.textContent || "").trim();
      if (txt && chatInput) {
        chatInput.value = txt;
        sendBtn?.click();
      }
    }
  });
  el.appendChild(bar);
}

function createSystemCardMeta(label = "", status = "", kind = "reply", tone = "neutral") {
  const meta = document.createElement("div");
  meta.className = `msg-card-meta msg-card-meta-${kind} status-tone-${tone}`;
  const safeLabel = String(label || "").trim();
  const safeStatus = String(status || "").trim();
  meta.innerHTML = `
    <span class="msg-card-label">${safeLabel}</span>
    ${safeStatus ? `<span class="msg-card-status">${safeStatus}</span>` : ""}
  `;
  return meta;
}

function inferSystemCardMeta(text = "", opts = {}) {
  if (opts.cardKind === "guide") {
    return { label: t("agentReplyLabel"), status: t("agentGuideStatus"), kind: "guide", tone: "neutral" };
  }
  if (opts.cardKind === "status") {
    return { label: t("agentReplyLabel"), status: t("agentUpdateStatus"), kind: "status", tone: String(opts.tone || "progress") };
  }
  if (opts.cardKind === "reply") {
    return { label: t("agentReplyLabel"), status: "", kind: "reply", tone: "neutral" };
  }
  const raw = String(text || "").trim();
  if (/失败|超时|异常|取消|权限|缺少|阻塞|重试|failed|timeout|error|cancel|retry|blocked|permission/i.test(raw)) {
    return { label: t("agentReplyLabel"), status: t("agentUpdateStatus"), kind: "status", tone: "blocked" };
  }
  if (/已完成|完成|已应用|已提交|已收到|done|completed|applied|submitted|received/i.test(raw)) {
    return { label: t("agentReplyLabel"), status: t("agentUpdateStatus"), kind: "status", tone: "done" };
  }
  if (/正在|进行中|已开始|已完成|完成|失败|导出|轮询|识别|解析|生成中|处理中|等待|提交|重试|polling|generating|processing|completed|failed|exporting|submitted|retry/i.test(raw)) {
    return { label: t("agentReplyLabel"), status: t("agentUpdateStatus"), kind: "status", tone: "progress" };
  }
  if (/请|点击|选择|上传|补充|继续|确认|输入|告诉我|先|下一步|立即|click|choose|upload|confirm|continue|provide|tell me|next/i.test(raw)) {
    return { label: t("agentReplyLabel"), status: t("agentGuideStatus"), kind: "guide", tone: "neutral" };
  }
  return { label: t("agentReplyLabel"), status: "", kind: "reply", tone: "neutral" };
}

function pushSystemStateMsg(text, tone = "progress", extra = {}) {
  return pushMsg("system", text, {
    typewriter: false,
    cardKind: "status",
    tone,
    ...extra,
  });
}

function pushSystemGuideMsg(text, extra = {}) {
  return pushMsg("system", text, {
    typewriter: false,
    cardKind: "guide",
    ...extra,
  });
}

function pushSystemReplyMsg(text, extra = {}) {
  return pushMsg("system", text, {
    typewriter: false,
    cardKind: "reply",
    ...extra,
  });
}

function setActionButtonState(btn, state = "idle", label = "") {
  if (!btn) return;
  const nextState = ["idle", "loading", "progress", "done", "blocked"].includes(String(state))
    ? String(state)
    : "idle";
  const baseLabel = btn.dataset.baseLabel || btn.textContent || "";
  if (!btn.dataset.baseLabel) btn.dataset.baseLabel = baseLabel;
  btn.classList.add("action-chip-btn");
  btn.dataset.actionState = nextState;
  if (nextState === "idle") {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.dataset.loading = "false";
    btn.textContent = btn.dataset.baseLabel;
    return;
  }
  const isLoading = nextState === "loading" || nextState === "progress";
  btn.disabled = isLoading;
  if (isLoading) {
    btn.setAttribute("aria-busy", "true");
    btn.dataset.loading = "true";
  } else {
    btn.removeAttribute("aria-busy");
    btn.dataset.loading = "false";
  }
  const stateLabel = nextState === "done"
    ? t("actionStateDone")
    : nextState === "blocked"
      ? t("actionStateBlocked")
      : t("actionStateProgress");
  btn.textContent = `${label || btn.dataset.baseLabel} · ${stateLabel}`;
}

function pushMsg(role, text, opts = {}) {
  if (state.entryFocusMode) {
    state.entryFocusMode = false;
    applyWorkspaceMode();
  }
  const el = document.createElement("article");
  el.className = `msg ${role}${opts.error ? " error" : ""}`;
  _attachHoverBar(el, role);
  chatList.appendChild(el);
  _applyGroupRadius();
  scrollToBottom();

  if (opts.error) {
    // Error bubble: icon + text, no typewriter
    const meta = createSystemCardMeta(t("agentReplyLabel"), t("agentUpdateStatus"), "status", "blocked");
    el.classList.add("has-card-meta", "status-tone-blocked", "msg-kind-status");
    const body = document.createElement("div");
    body.className = "msg-error-body";
    const icon = document.createElement("span");
    icon.className = "msg-error-icon";
    icon.textContent = "⚠️";
    const textNode = document.createElement("span");
    textNode.textContent = text;
    body.appendChild(icon);
    body.appendChild(textNode);
    el.classList.add("has-card-meta");
    el.appendChild(meta);
    el.appendChild(body);
    return el;
  }

  if (role === "system" && opts.typewriter !== false) {
    const inferred = inferSystemCardMeta(text, opts);
    const meta = createSystemCardMeta(inferred.label, inferred.status, inferred.kind, inferred.tone);
    const body = document.createElement("div");
    body.className = "msg-body";
    body.setAttribute("data-msg-body", "1");
    el.classList.add("has-card-meta", `status-tone-${inferred.tone}`, `msg-kind-${inferred.kind}`);
    el.appendChild(meta);
    el.appendChild(body);
    typewriter(body, text, opts.speed || 22);
  } else if (role === "system") {
    const inferred = inferSystemCardMeta(text, opts);
    const meta = createSystemCardMeta(inferred.label, inferred.status, inferred.kind, inferred.tone);
    const body = document.createElement("div");
    body.className = "msg-body";
    body.setAttribute("data-msg-body", "1");
    el.classList.add("has-card-meta", `status-tone-${inferred.tone}`, `msg-kind-${inferred.kind}`);
    el.appendChild(meta);
    el.appendChild(body);
    _renderMd(body, text);
  } else {
    el.textContent = text;
  }
  return el;
}

function renderOptions(container, options = []) {
  if (!options.length) return;
  const list = document.createElement("div");
  list.className = "option-list";
  let committed = false;
  const lock = () => {
    const btns = list.querySelectorAll("button.option-btn");
    btns.forEach((b) => {
      b.disabled = true;
      b.classList.add("is-disabled");
    });
  };
  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.innerHTML = `<strong>${opt.title}</strong><small>${opt.desc || ""}</small>`;
    btn.addEventListener("click", () => {
      if (committed) return;
      committed = true;
      lock();
      opt.onClick?.();
    });
    list.appendChild(btn);
  });
  container.appendChild(list);
  scrollToBottom();
}

function pushImageMsg(images) {
  const box = pushMsg("user", "", { typewriter: false });
  const countSpan = document.createElement("span");
  countSpan.className = "img-count-label";
  countSpan.textContent = t("uploaded", { count: images.length });
  box.appendChild(countSpan);
  const thumbs = document.createElement("div");
  thumbs.className = "thumbs thumbs-interactive";
  const renderThumbs = () => {
    thumbs.innerHTML = "";
    countSpan.textContent = t("uploaded", { count: state.images.length });
    state.images.forEach((img, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "thumb-wrap";
      const node = document.createElement("img");
      node.src = img.dataUrl;
      node.alt = img.name || "product";
      node.title = currentLang === "zh" ? "点击预览大图" : "Click to preview";
      node.addEventListener("click", () => {
        showImagePreview(img.dataUrl, img.name || `image-${idx + 1}`);
      });
      const delBtn = document.createElement("button");
      delBtn.className = "thumb-del";
      delBtn.textContent = "×";
      delBtn.title = currentLang === "zh" ? "删除此图" : "Remove";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.images.splice(idx, 1);
        renderThumbs();
      });
      wrap.appendChild(node);
      wrap.appendChild(delBtn);
      thumbs.appendChild(wrap);
    });
    const addBtn = document.createElement("div");
    addBtn.className = "thumb-add";
    addBtn.innerHTML = `<span>+</span><span style="font-size:10px;">${currentLang === "zh" ? "补传" : "Add"}</span>`;
    addBtn.title = currentLang === "zh" ? "补传商品图" : "Upload more images";
    addBtn.addEventListener("click", () => imageInput?.click());
    thumbs.appendChild(addBtn);
    updateGenerationGateUI();
  };
  renderThumbs();
  box.appendChild(thumbs);
}

function showImagePreview(src, name) {
  const existing = document.getElementById("imgPreviewOverlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "imgPreviewOverlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;cursor:zoom-out;";
  overlay.addEventListener("click", () => overlay.remove());
  const img = document.createElement("img");
  img.src = src;
  img.alt = name;
  img.style.cssText = "max-width:90vw;max-height:88vh;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.5);object-fit:contain;";
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", function handler(e) {
    if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", handler); }
  });
}

function showUploadRefQuickAction() {
  const box = pushSystemGuideMsg("");
  renderOptions(box, [
    {
      title: t("uploadNow"),
      desc: "",
      onClick: () => openProductAssetPicker(),
    },
  ]);
}

function showUploadScreenshotGuide() {
  pushSystemGuideMsg(
    [
      t("uploadGuideTitle"),
      `- ${t("uploadGuideItem1")}`,
      `- ${t("uploadGuideItem2")}`,
      `- ${t("uploadGuideItem3")}`,
      `- ${t("uploadGuideItem4")}`,
    ].join("\n")
  );
}

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/i.exec(dataUrl || "");
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: m[2] };
}

function buildVeoReferencePayload() {
  const localImages = (Array.isArray(state.images) ? state.images : [])
    .map((item) => {
      const parsed = parseDataUrl(item?.dataUrl || "");
      return parsed ? { base64: parsed.base64, mime_type: parsed.mime } : null;
    })
    .filter(Boolean)
    .slice(0, 4);
  const remoteUrls = (Array.isArray(state.productImageUrls) ? state.productImageUrls : [])
    .map((url) => String(url || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  if (localImages.length > 1) {
    return {
      veo_mode: "reference",
      reference_images_base64: localImages.slice(0, 4),
    };
  }
  if (localImages.length === 1) {
    return {
      veo_mode: "image",
      image_base64: localImages[0].base64,
      image_mime_type: localImages[0].mime_type,
    };
  }
  if (remoteUrls.length > 1) {
    return {
      veo_mode: "reference",
      reference_image_urls: remoteUrls.slice(0, 4),
    };
  }
  if (remoteUrls.length === 1) {
    return {
      veo_mode: "image",
      image_url: remoteUrls[0],
    };
  }
  return { veo_mode: "text" };
}

function sanitizeInputValue(value = "") {
  return String(value).replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeStem(name = "") {
  return String(name)
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function guessBusinessByName(raw = "") {
  const s = raw.toLowerCase();
  if (/dress|连衣裙|裙|skirt/.test(s)) return currentLang === "zh" ? "女装连衣裙" : "Women's dresses";
  if (/shoe|鞋|heel|sneaker|boot/.test(s)) return currentLang === "zh" ? "女鞋" : "Women's shoes";
  if (/bag|包|tote|handbag|backpack/.test(s)) return currentLang === "zh" ? "箱包配饰" : "Bags & accessories";
  if (/coat|jacket|外套|上衣|shirt|top/.test(s)) return currentLang === "zh" ? "服装上衣" : "Apparel tops";
  return currentLang === "zh" ? "鞋服配饰" : "Fashion & accessories";
}

function guessTemplateByName(raw = "") {
  const s = raw.toLowerCase();
  if (/luxury|premium|高级|轻奢/.test(s)) return "premium";
  if (/street|social|潮流|ins|小红书/.test(s)) return "social";
  if (/daily|casual|通勤|日常|lifestyle/.test(s)) return "lifestyle";
  return "clean";
}

function guessProductNameByFile(name = "") {
  const stem = normalizeStem(name);
  if (!stem) return currentLang === "zh" ? "未命名商品" : "Unnamed product";
  return stem.length > 40 ? stem.slice(0, 40) : stem;
}

function buildFallbackInsightFromName(fileName = "") {
  const product = guessProductNameByFile(fileName);
  return {
    product_name: product,
    main_business: guessBusinessByName(product),
    style_template: guessTemplateByName(product),
    selling_points: [],
    target_user: "",
    sales_region: "",
    brand_direction: "",
    product_anchors: {},
  };
}

function mergeInsightPayloads(base = {}, extra = {}) {
  const merged = { ...(base || {}) };
  const next = extra || {};
  for (const key of [
    "product_name",
    "main_business",
    "style_template",
    "target_user",
    "sales_region",
    "brand_direction",
    "review_summary",
    "fetch_confidence",
  ]) {
    if (!merged[key] && next[key]) merged[key] = next[key];
  }
  const mergedPoints = normalizeTextList(merged.selling_points, 6);
  const nextPoints = normalizeTextList(next.selling_points, 6);
  merged.selling_points = Array.from(new Set([...mergedPoints, ...nextPoints])).slice(0, 6);
  merged.product_anchors = mergeProductAnchors(merged.product_anchors || {}, next.product_anchors || {});
  return merged;
}

function applyInsightToState(insight = {}) {
  const points = Array.isArray(insight.selling_points)
    ? insight.selling_points.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  if (!state.productName && insight.product_name) state.productName = String(insight.product_name).trim();
  if (!state.mainBusiness && insight.main_business) state.mainBusiness = String(insight.main_business).trim();
  if (insight.style_template && ["clean", "lifestyle", "premium", "social"].includes(String(insight.style_template))) {
    if (!state.template || state.template === "clean") state.template = String(insight.style_template);
  }
  if (!state.sellingPoints && points.length) state.sellingPoints = points.join(currentLang === "zh" ? "；" : ", ");
  if (!state.targetUser && insight.target_user) state.targetUser = String(insight.target_user).trim();
  if (!state.salesRegion && insight.sales_region) state.salesRegion = String(insight.sales_region).trim();
  if (!state.brandInfo && insight.brand_direction) state.brandInfo = String(insight.brand_direction).trim();
  state.productAnchors = mergeProductAnchors(state.productAnchors, insight.product_anchors || {});
  state.workflowHydrated = false;
  updateGenerationGateUI();
}

function startInsightProgress() {
  const startedAt = Date.now();
  const bubble = pushSystemStateMsg(nextInsightPulseLine(), "progress");
  let warned = false;
  const timer = setInterval(() => {
    const sec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    if (sec < 8) {
      bubble.textContent = nextInsightPulseLine();
      return;
    }
    if (sec >= 8) {
      warned = true;
      bubble.textContent = t("insightSlow", { sec });
    }
  }, 1800);
  return () => {
    clearInterval(timer);
    if (bubble && bubble.parentNode) bubble.remove();
    return warned;
  };
}

async function analyzeImageInsight(imageItems = []) {
  const normalized = (Array.isArray(imageItems) ? imageItems : [])
    .map((item) => parseDataUrl(item?.dataUrl || ""))
    .filter(Boolean)
    .slice(0, 6);
  if (!normalized.length) throw new Error("invalid image data");
  const base = getApiBase();
  return postJson(
    `${base}/api/agent/image-insight`,
    {
      project_id: "gemini-sl-20251120",
      model: "gemini-2.5-flash",
      language: currentLang,
      image_items: normalized.map((x) => ({ base64: x.base64, mime_type: x.mime })),
    },
    50000
  );
}

function askRegion() {
  state.stage = "awaitRegion";
  const box = pushSystemGuideMsg(t("pickRegion"));
  const picker = document.createElement("div");
  picker.className = "region-picker";
  const search = document.createElement("input");
  search.className = "region-search";
  search.placeholder = t("searchRegionPh");
  const list = document.createElement("div");
  list.className = "option-list";
  picker.appendChild(search);
  picker.appendChild(list);
  box.appendChild(picker);

  const matchText = (item, query) => {
    const hay = `${item.zh} ${item.en} ${item.descZh} ${item.descEn}`.toLowerCase();
    return hay.includes(query);
  };
  let expanded = false;

  const renderRegionList = () => {
    const query = search.value.trim().toLowerCase();
    const matched = REGION_ITEMS.filter((item) => (!query ? true : matchText(item, query)));
    const ordered = matched.sort((a, b) => Number(b.common) - Number(a.common));
    const limited = !query && !expanded ? ordered.slice(0, 5) : ordered;
    list.innerHTML = "";
    if (!limited.length) {
      const empty = document.createElement("div");
      empty.className = "region-empty";
      empty.textContent = t("regionNoMatch");
      list.appendChild(empty);
      return;
    }
    limited.forEach((item) => {
      const btn = document.createElement("button");
      btn.className = "option-btn";
      const title = currentLang === "zh" ? item.zh : item.en;
      const desc = currentLang === "zh" ? item.descZh : item.descEn;
      btn.innerHTML = `<strong>${item.flag} ${title}</strong><small>${desc}</small>`;
      btn.addEventListener("click", () => {
        if (state.stage !== "awaitRegion") return;
        search.disabled = true;
        list.querySelectorAll("button.option-btn").forEach((b) => {
          b.disabled = true;
          b.classList.add("is-disabled");
        });
        state.salesRegion = title;
        pushMsg("user", `${item.flag} ${title}`, { typewriter: false });
        pushSystemReplyMsg(withLead(t("regionAck", { value: title }), "region"));
        askTarget();
      });
      list.appendChild(btn);
    });

    if (!query && !expanded && ordered.length > 5) {
      const moreBtn = document.createElement("button");
      moreBtn.className = "option-btn option-more-btn";
      moreBtn.innerHTML = `<strong>${t("showMoreRegions")}</strong><small>${currentLang === "zh" ? `还有 ${ordered.length - 5} 个可选` : `${ordered.length - 5} more options`}</small>`;
      moreBtn.addEventListener("click", () => {
        expanded = true;
        renderRegionList();
      });
      list.appendChild(moreBtn);
    }
  };

  search.addEventListener("input", renderRegionList);
  renderRegionList();
}

async function askTarget() {
  state.stage = "awaitTarget";
  const box = pushSystemGuideMsg(t("pickTarget"));
  const smartPools = await ensureSmartOptionPools();
  const targetSource = smartPools?.targetPool?.length
    ? pickOptionBatch(smartPools.targetPool, state.targetBatchIdx, 3)
    : buildTargetOptions();
  const options = targetSource.map((opt) => ({
    title: opt.title,
    desc: opt.desc,
    onClick: () => {
      if (state.stage !== "awaitTarget") return;
      state.targetUser = opt.title;
      pushMsg("user", opt.title, { typewriter: false });
      pushSystemReplyMsg(withLead(t("targetAck", { value: opt.title }), "target"));
      askBrand();
    },
  }));
  options.push({
    title: t("refresh"),
    desc: t("refreshDesc"),
    onClick: () => {
      state.targetBatchIdx += 1;
      askTarget();
    },
  });
  renderOptions(box, options);
}

async function askBrand() {
  state.stage = "awaitBrand";
  const box = pushSystemGuideMsg(t("pickBrand"));
  const smartPools = await ensureSmartOptionPools();
  const brandSource = smartPools?.brandPool?.length
    ? pickOptionBatch(smartPools.brandPool, state.brandBatchIdx, 3)
    : buildBrandOptions();
  const options = brandSource.map((opt) => ({
    title: opt.title,
    desc: opt.desc,
    onClick: () => {
      if (state.stage !== "awaitBrand") return;
      state.brandInfo = opt.title;
      pushMsg("user", opt.title, { typewriter: false });
      pushSystemReplyMsg(withLead(t("brandAck", { value: opt.title }), "brand"));
      askForPointsOrSummary();
    },
  }));
  options.push({
    title: t("refresh"),
    desc: t("refreshDesc"),
    onClick: () => {
      state.brandBatchIdx += 1;
      askBrand();
    },
  });
  options.push({
    title: t("skip"),
    desc: t("skipDesc"),
    onClick: () => {
      pushMsg("user", t("skip"), { typewriter: false });
      pushSystemReplyMsg(withLead(t("skipBrand"), "general"));
      askForPointsOrSummary();
    },
  });
  renderOptions(box, options);
}

function askForPointsOrSummary() {
  state.stage = "awaitPoints";
  if (!state.images.length && !state.skipImageConfirmed) {
    showUploadOptionalStep();
    return;
  }
  if (!state.sellingPoints) {
    pushSystemGuideMsg(t("askPoints"));
    return;
  }
  showSummaryCard();
}

function showContinueAfterSkipStep() {
  const box = pushSystemGuideMsg(t("continueChatPrompt"));
  renderOptions(box, [
    {
      title: t("continueChatBtn"),
      desc: t("continueChatDesc"),
      onClick: () => {
        pushMsg("user", t("continueChatAck"), { typewriter: false });
        state.stage = "awaitPoints";
        if (!state.sellingPoints) pushSystemGuideMsg(t("askPoints"));
        else if (!state.summaryShown) showSummaryCard();
        else showQuickGenerateButton();
        chatInput?.focus();
      },
    },
  ]);
}

function showUploadOptionalStep() {
  const box = pushSystemGuideMsg(t("askUploadOptional"));
  renderOptions(box, [
    {
      title: t("uploadNow"),
      desc: "",
      onClick: () => imageInput?.click(),
    },
    {
      title: t("skipUploadNow"),
      desc: "",
      onClick: () => {
        state.skipImageConfirmed = true;
        pushMsg("user", t("skipUploadNow"), { typewriter: false });
        pushSystemStateMsg(t("skipUploadAck"), "done");
        showContinueAfterSkipStep();
      },
    },
  ]);
}

function showSummaryCard() {
  if (state.summaryShown) return;
  state.summaryShown = true;
  const wrap = document.createElement("article");
  wrap.className = "msg system form-card summary-flow-card";
  wrap.innerHTML = `
    <div class="msg-card-meta msg-card-meta-form">
      <span class="msg-card-label">${t("agentReplyLabel")}</span>
      <div class="msg-card-meta-right">
        <span class="msg-card-step">${t("flowStep", { n: 2 })}</span>
        <span class="msg-card-status">${t("cardStatusPending")}</span>
        <span class="msg-card-status">${t("cardStatusReady")}</span>
      </div>
    </div>
    <div>${t("summaryTitle")}</div>
    <div class="summary-card">
      <div class="info-grid">
        <div class="info-item"><div class="info-icon">🖼️</div><div class="info-main"><div class="info-title">${t("fImg")}</div><div class="info-value">${state.images.length}</div></div></div>
        <div class="info-item"><div class="info-icon">📦</div><div class="info-main"><div class="info-title">${t("fProduct")}</div><input id="fProductName" value="${sanitizeInputValue(state.productName)}" /></div></div>
        <div class="info-item"><div class="info-icon">✨</div><div class="info-main"><div class="info-title">${t("fPoints")}</div><input id="fSellingPoints" value="${state.sellingPoints.replace(/"/g, "&quot;")}" /></div></div>
        <div class="info-item"><div class="info-icon">👥</div><div class="info-main"><div class="info-title">${t("fTarget")}</div><input id="fTargetUser" value="${state.targetUser.replace(/"/g, "&quot;")}" /></div></div>
        <div class="info-item"><div class="info-icon">🌏</div><div class="info-main"><div class="info-title">${t("fRegion")}</div><input id="fSalesRegion" value="${state.salesRegion.replace(/"/g, "&quot;")}" /></div></div>
        <div class="info-item"><div class="info-icon">🏷️</div><div class="info-main"><div class="info-title">${t("fBrand")}</div><input id="fBrandInfo" value="${(state.brandInfo || "").replace(/"/g, "&quot;")}" /></div></div>
        <div class="info-item"><div class="info-icon">🎨</div><div class="info-main"><div class="info-title">${t("fTpl")}</div><select id="fTemplate"><option value="clean">clean</option><option value="lifestyle">lifestyle</option><option value="premium">premium</option><option value="social">social</option></select></div></div>
        <div class="info-item"><div class="info-icon">⏱️</div><div class="info-main"><div class="info-title">${t("fDur")}</div><select id="fDuration"><option value="8">8s</option><option value="6">6s</option><option value="4">4s</option></select></div></div>
        <div class="info-item"><div class="info-icon">📐</div><div class="info-main"><div class="info-title">${t("fRatio")}</div><input id="fAspect" value="16:9" readonly /></div></div>
        <div class="info-item"><div class="info-icon">🧍</div><div class="info-main"><div class="info-title">${t("fModel")}</div><label><input id="fNeedModel" type="checkbox" checked /> ${t("on")}</label></div></div>
      </div>
      <p class="table-hint">${t("hint")}</p>
      <div class="summary-actions"><button id="confirmGenerateBtn" class="action-chip-btn action-chip-primary">${t("confirm")}</button></div>
    </div>
  `;
  chatList.appendChild(wrap);
  scrollToBottom();

  wrap.querySelector("#fTemplate").value = state.template;
  wrap.querySelector("#fDuration").value = state.duration;
  wrap.querySelector("#fNeedModel").checked = state.needModel;

  wrap.querySelector("#confirmGenerateBtn").addEventListener("click", async () => {
    const btn = wrap.querySelector("#confirmGenerateBtn");
    if (btn.disabled) return;
    if (state.primarySubmitLocked) {
      pushSystemStateMsg(t("alreadySubmitted"), "blocked");
      setActionButtonState(btn, "blocked", t("confirm"));
      setTimeout(() => setActionButtonState(btn, "idle"), 1400);
      return;
    }
    setActionButtonState(btn, "progress", t("confirm"));
    state.productName = wrap.querySelector("#fProductName").value.trim();
    state.sellingPoints = wrap.querySelector("#fSellingPoints").value.trim();
    state.targetUser = wrap.querySelector("#fTargetUser").value.trim();
    state.salesRegion = wrap.querySelector("#fSalesRegion").value.trim();
    state.brandInfo = wrap.querySelector("#fBrandInfo").value.trim();
    state.template = wrap.querySelector("#fTemplate").value;
    state.duration = wrap.querySelector("#fDuration").value;
    state.needModel = wrap.querySelector("#fNeedModel").checked;
    state.workflowHydrated = false;
    if (!state.productName) {
      pushSystemGuideMsg(t("askProduct"));
      setActionButtonState(btn, "blocked", t("confirm"));
      setTimeout(() => setActionButtonState(btn, "idle"), 1400);
      return;
    }
    state.primarySubmitLocked = true;
    try {
      await generateVideo();
      setActionButtonState(btn, "done", t("confirm"));
    } catch (_e) {
      setActionButtonState(btn, "blocked", t("confirm"));
    } finally {
      state.primarySubmitLocked = false;
      setTimeout(() => setActionButtonState(btn, "idle"), 1500);
    }
  });
}

function continueAfterInsightConfirm() {
  if (!state.images.length && !state.skipImageConfirmed) {
    showUploadOptionalStep();
    return;
  }
  if (!state.salesRegion) {
    state.stage = "awaitRegion";
    askRegion();
    return;
  }
  if (!state.targetUser) {
    state.stage = "awaitTarget";
    askTarget();
    return;
  }
  if (!state.brandInfo) {
    state.stage = "awaitBrand";
    askBrand();
    return;
  }
  if (!state.sellingPoints) {
    state.stage = "awaitPoints";
    pushSystemGuideMsg(t("askPoints"));
    return;
  }
  if (!state.summaryShown) {
    showSummaryCard();
    return;
  }
  showQuickGenerateButton();
}

function showInsightEditCard() {
  const wrap = document.createElement("article");
  wrap.className = "msg system form-card insight-flow-card";
  wrap.innerHTML = `
    <div class="msg-card-meta msg-card-meta-form">
      <span class="msg-card-label">${t("agentReplyLabel")}</span>
      <div class="msg-card-meta-right">
        <span class="msg-card-step">${t("flowStep", { n: 1 })}</span>
        <span class="msg-card-status">${t("cardStatusFilled")}</span>
        <span class="msg-card-status">${t("cardStatusReady")}</span>
      </div>
    </div>
    <div>${t("insightEditTitle")}</div>
    <div class="summary-card">
      <div class="info-grid">
        <div class="info-item"><div class="info-icon">📦</div><div class="info-main"><div class="info-title">${t("fProduct")}</div><input id="insightProductName" value="${sanitizeInputValue(state.productName)}" /></div></div>
        <div class="info-item"><div class="info-icon">🧭</div><div class="info-main"><div class="info-title">${currentLang === "zh" ? "主营方向" : "Business focus"}</div><input id="insightBusiness" value="${sanitizeInputValue(state.mainBusiness)}" /></div></div>
        <div class="info-item"><div class="info-icon">🎨</div><div class="info-main"><div class="info-title">${t("fTpl")}</div><select id="insightTemplate"><option value="clean">clean</option><option value="lifestyle">lifestyle</option><option value="premium">premium</option><option value="social">social</option></select></div></div>
      </div>
      <div class="summary-actions"><button id="insightConfirmBtn" class="action-chip-btn action-chip-primary">${t("insightConfirmBtn")}</button></div>
    </div>
  `;
  chatList.appendChild(wrap);
  scrollToBottom();
  const templateEl = wrap.querySelector("#insightTemplate");
  templateEl.value = state.template || "clean";
  wrap.querySelector("#insightConfirmBtn").addEventListener("click", () => {
    const btn = wrap.querySelector("#insightConfirmBtn");
    if (btn.disabled) return;
    setActionButtonState(btn, "progress", t("insightConfirmBtn"));
    state.productName = wrap.querySelector("#insightProductName").value.trim();
    state.mainBusiness = wrap.querySelector("#insightBusiness").value.trim();
    state.template = templateEl.value || "clean";
    pushMsg("user", t("insightConfirmUser"), { typewriter: false });
    if (!state.productName) {
      pushSystemGuideMsg(t("askProduct"));
      setActionButtonState(btn, "blocked", t("insightConfirmBtn"));
      setTimeout(() => setActionButtonState(btn, "idle"), 1400);
      return;
    }
    if (state.stage === "awaitMain") {
      state.stage = "awaitRegion";
      askRegion();
      setActionButtonState(btn, "done", t("insightConfirmBtn"));
      setTimeout(() => setActionButtonState(btn, "idle"), 1200);
      return;
    }
    continueAfterInsightConfirm();
    setActionButtonState(btn, "done", t("insightConfirmBtn"));
    setTimeout(() => setActionButtonState(btn, "idle"), 1200);
  });
}

function showQuickGenerateButton() {
  const wrap = document.createElement("article");
  wrap.className = "msg system form-card quick-action-card";
  wrap.innerHTML = `
    <div class="msg-card-meta msg-card-meta-form">
      <span class="msg-card-label">${t("agentReplyLabel")}</span>
      <div class="msg-card-meta-right">
        <span class="msg-card-step">${t("flowStep", { n: 3 })}</span>
        <span class="msg-card-status">${t("cardStatusReady")}</span>
      </div>
    </div>
    <div class="summary-actions">
      <button id="quickGenerateBtn" class="action-chip-btn action-chip-primary">${t("quickGen")}</button>
    </div>
  `;
  chatList.appendChild(wrap);
  scrollToBottom();
  wrap.querySelector("#quickGenerateBtn").addEventListener("click", async () => {
    const btn = wrap.querySelector("#quickGenerateBtn");
    if (state.primarySubmitLocked) {
      pushSystemStateMsg(t("alreadySubmitted"), "blocked");
      setActionButtonState(btn, "blocked", t("quickGen"));
      setTimeout(() => setActionButtonState(btn, "idle"), 1400);
      return;
    }
    if (!state.productName) {
      pushSystemGuideMsg(t("askProduct"));
      setActionButtonState(btn, "blocked", t("quickGen"));
      setTimeout(() => setActionButtonState(btn, "idle"), 1400);
      return;
    }
    if (!state.salesRegion || !state.targetUser || !state.sellingPoints) {
      showSummaryCard();
      setActionButtonState(btn, "blocked", t("quickGen"));
      setTimeout(() => setActionButtonState(btn, "idle"), 1000);
      return;
    }
    state.primarySubmitLocked = true;
    setActionButtonState(btn, "progress", t("quickGen"));
    try {
      await generateVideo();
      setActionButtonState(btn, "done", t("quickGen"));
    } catch (_e) {
      setActionButtonState(btn, "blocked", t("quickGen"));
    } finally {
      state.primarySubmitLocked = false;
      setTimeout(() => setActionButtonState(btn, "idle"), 1500);
    }
  });
}

function buildPrompt() {
  const modelText = state.needModel
    ? currentLang === "zh"
      ? "需要模特展示"
      : "need model showcase"
    : currentLang === "zh"
      ? "不需要模特展示"
      : "no model showcase";
  const points = normalizePointsList(state.sellingPoints);
  const focusPoints = points.slice(0, 2);
  const pointsText =
    focusPoints.join(currentLang === "zh" ? "；" : "; ") ||
    (currentLang === "zh" ? "核心卖点" : "core selling points");
  const positiveReviewLine = Array.isArray(state.reviewPositivePoints) && state.reviewPositivePoints.length
    ? currentLang === "zh"
      ? `可放大的正向评论信号：${state.reviewPositivePoints.slice(0, 3).join("；")}。`
      : `Positive review highlights to emphasize: ${state.reviewPositivePoints.slice(0, 3).join("; ")}.`
    : "";
  const negativeReviewLine = Array.isArray(state.reviewNegativePoints) && state.reviewNegativePoints.length
    ? currentLang === "zh"
      ? `需规避的负向评论痛点：${state.reviewNegativePoints.slice(0, 2).join("；")}。`
      : `Potential pain points to avoid or improve in visuals/copy: ${state.reviewNegativePoints.slice(0, 2).join("; ")}.`
    : "";
  const anchorSummary = buildProductAnchorSummary(currentLang);
  if (currentLang === "zh") {
    return [
      `${state.aspectRatio || "16:9"} 超高清商业画质，电影级影棚布光。`,
      "商品主体严格参考上传商品图或已解析信息，保持颜色、材质、结构和细节一致。",
      `商品：${state.productName || "该商品"}；主营方向：${state.mainBusiness || "电商"}。`,
      anchorSummary ? `商品锚点：${anchorSummary}。` : "",
      `核心卖点仅聚焦1-2个：${pointsText}。`,
      `目标人群：${state.targetUser || "目标用户"}；销售地区：${state.salesRegion || "目标地区"}；风格模板：${state.template || "clean"}；模特策略：${modelText}；时长：${state.duration || "8"}秒。`,
      "镜头节奏遵循主框架+辅助框架（4.1~4.6），强调可执行镜头、环境布光、情绪锚点与转化收口。",
      positiveReviewLine,
      negativeReviewLine,
      "合规后缀：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    `${state.aspectRatio || "16:9"} commercial ultra-HD quality with cinematic studio lighting.`,
    "Keep product appearance fully consistent with uploaded references or parsed product information.",
    `Product name: ${state.productName || "Unnamed product"}.`,
    `Business focus: ${state.mainBusiness || "ecommerce product"}.`,
    anchorSummary ? `${anchorSummary}.` : "",
    `Focus on only 1-2 core selling points: ${pointsText}.`,
    `Target audience: ${state.targetUser || "audience"}. Sales region: ${state.salesRegion || "region"}.`,
    `Brand direction: ${state.brandInfo || "default"}. Style template: ${state.template || "clean"}. Model strategy: ${modelText}. Duration: ${state.duration || "8"} seconds.`,
    "Use one primary + one supporting framework (4.1~4.6), with executable shots, lighting, mood anchor, and conversion close.",
    positiveReviewLine,
    negativeReviewLine,
    "Compliance suffix: clean highlight edges, controlled reflections, clear textures, sharp structure edges, no distorted limbs/structures, no third-party logos or watermarks.",
  ].join(" ");
}

function sanitizePromptForUser(raw = "") {
  let text = String(raw || "").trim();
  if (!text) return "";
  text = text
    // Strip markdown headings
    .replace(/^#{1,6}\s+/gm, "")
    // Strip bold/italic markers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
    // Strip framework header labels
    .replace(/(?:^|\n)\s*主框架\s*[：:]\s*[^\n；;]*[；;]?\s*/g, "\n")
    .replace(/(?:^|\n)\s*辅助框架\s*[：:]\s*[^\n；;]*[；;]?\s*/g, "\n")
    .replace(/(?:^|\n)\s*primary\s*framework\s*:\s*[^\n;；]*[;；]?\s*/gi, "\n")
    .replace(/(?:^|\n)\s*(supporting|secondary)\s*framework\s*:\s*[^\n;；]*[;；]?\s*/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function extractAspectRatioFromPrompt(raw = "") {
  const text = String(raw || "");
  if (!text) return "";
  const ratioMatch = text.match(/(?:aspect\s*ratio|ratio|画幅|比例)\s*[:：]?\s*(9:16|16:9|1:1)\b/i);
  if (ratioMatch?.[1]) return ratioMatch[1];
  const directMatch = text.match(/\b(9:16|16:9|1:1)\b/);
  if (!directMatch?.[1]) return "";
  const near = text.slice(Math.max(0, directMatch.index - 28), Math.min(text.length, (directMatch.index || 0) + 28)).toLowerCase();
  if (/(aspect|ratio|画幅|比例|vertical|horizontal|portrait|landscape|竖屏|横屏)/i.test(near)) {
    return directMatch[1];
  }
  return "";
}

function extractDurationFromPrompt(raw = "") {
  const text = String(raw || "");
  if (!text) return 0;
  const patterns = [
    /(?:duration|video duration|时长|秒数)\s*[:：]?\s*(\d{1,2})\s*(?:s|sec|secs|second|seconds|秒)\b/i,
    /\b(?:create|make|generate)\s+(?:a\s+)?(\d{1,2})\s*-\s*second\b/i,
    /\b(\d{1,2})\s*-\s*second\b/i,
    /\b(\d{1,2})\s*(?:s|sec|secs)\b/i,
    /(\d{1,2})\s*秒\b/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const n = Number(m?.[1] || 0);
    if (Number.isFinite(n) && n > 0) return n;
  }
  let maxEnd = 0;
  const rangeRe = /(\d{1,2})\s*(?:s|sec|秒)\s*[-~—]\s*(\d{1,2})\s*(?:s|sec|秒)/gi;
  let hit = null;
  while ((hit = rangeRe.exec(text)) !== null) {
    const end = Number(hit?.[2] || 0);
    if (Number.isFinite(end) && end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

function normalizeDurationForProvider(durationNum = 0, provider = "veo") {
  const n = Number(durationNum || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  const opts = (DURATION_OPTIONS[provider] || DURATION_OPTIONS.veo).map((o) => Number(o.value));
  if (!opts.length) return "";
  if (opts.includes(n)) return String(n);
  const nearest = opts.reduce((best, cur) => (
    Math.abs(cur - n) < Math.abs(best - n) ? cur : best
  ), opts[0]);
  return String(nearest);
}

function applyDetectedVideoSettings(config = {}) {
  const ratio = String(config?.ratio || "").trim();
  const duration = String(config?.duration || "").trim();
  if (ratio) {
    state.aspectRatio = ratio;
    if (aspectRatioSelect) aspectRatioSelect.value = ratio;
  }
  updateDurationOptions();
  if (durationSelect && duration) {
    const hasOption = Array.from(durationSelect.options || []).some((o) => o.value === duration);
    if (hasOption) {
      durationSelect.value = duration;
      state.duration = duration;
      updateDurationHint();
    }
  }
}

async function submitSimplePromptGeneration(finalText = "") {
  const text = String(finalText || "").trim();
  if (!text) return;
  if (!canStartVideoJob()) {
    pushSystemStateMsg(t("tooManyJobs"), "blocked");
    return;
  }
  if (chatInput) chatInput.value = "";
  syncStateFromSimpleControls();
  state.lastPrompt = text;
  state.primarySubmitLocked = false;
  state.workflowHydrated = true;
  pushMsg("user", text, { typewriter: false });
  await generateVideo(text);
}

function showPromptConfigConfirmBubble(finalText = "") {
  const text = String(finalText || "").trim();
  if (!text) return false;
  const detectedRatio = extractAspectRatioFromPrompt(text);
  const detectedDurationRaw = extractDurationFromPrompt(text);
  const provider = getModelProvider();
  const recommendedDuration = normalizeDurationForProvider(detectedDurationRaw, provider);
  if (!detectedRatio && !recommendedDuration) return false;

  const lines = [t("detectedConfigTitle")];
  if (detectedRatio) lines.push(`- ${t("detectedConfigRatio", { value: detectedRatio })}`);
  if (recommendedDuration) {
    const adjusted = Number(detectedDurationRaw) > 0 && String(Number(detectedDurationRaw)) !== recommendedDuration;
    lines.push(`- ${adjusted
      ? t("detectedConfigDurationAdjusted", { input: Number(detectedDurationRaw), recommended: recommendedDuration })
      : t("detectedConfigDuration", { value: recommendedDuration })}`);
  }
  lines.push(t("detectedConfigAsk"));

  const box = pushSystemGuideMsg(lines.join("\n"));
  renderOptions(box, [
    {
      title: t("detectedConfigConfirm"),
      desc: t("detectedConfigConfirmDesc"),
      onClick: async () => {
        applyDetectedVideoSettings({ ratio: detectedRatio, duration: recommendedDuration });
        pushMsg("user", t("detectedConfigUseAck"), { typewriter: false });
        await submitSimplePromptGeneration(text);
      },
    },
    {
      title: t("detectedConfigEdit"),
      desc: t("detectedConfigEditDesc"),
      onClick: () => {
        applyDetectedVideoSettings({ ratio: detectedRatio, duration: recommendedDuration });
        pushSystemStateMsg(t("detectedConfigApplied"), "done");
      },
    },
  ]);
  return true;
}

/**
 * Unified video-edit intent parser.
 * Returns { type, ...params } or null.
 *
 * Supported types:
 *   speed       – global speed:  { speed: number }
 *   speedRange  – ranged speed:  { start, end, speed }
 *   subtitle    – text overlay:  { start, end, text }
 *   color       – color grading: { bright?, sat?, contrast?, hue? }
 *   bgm         – background music: { action: 'remove'|'lower'|'raise', volume?: number }
 */
function extractVideoEditIntent(raw = "") {
  const str = String(raw || "").trim();
  if (!str) return null;

  // ── helpers ────────────────────────────────────────────────────────────────
  // Time range: "1~3s" / "1秒到3秒" / "1s to 3s" / "第1到第3秒"
  const TIME_RANGE = /第?(\d+(?:\.\d+)?)\s*[秒s]?\s*[~\-–到至]\s*第?(\d+(?:\.\d+)?)\s*[秒s]/i;
  const parseTimeRange = (s) => {
    const m = TIME_RANGE.exec(s);
    if (!m) return null;
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
    return { start: Math.max(0, a), end: b };
  };

  // ── 0a. undo ──────────────────────────────────────────────────────────────
  if (/(撤销|undo|回退|上一步|还原)/i.test(str)) {
    return { type: "undo" };
  }

  // ── 0a-asr. auto-subtitle / speech recognition ────────────────────────────
  if (/(自动字幕|自动生成字幕|识别字幕|转录|语音识别|识别语音|字幕识别|auto.*subtitle|transcri|asr\b)/i.test(str)) {
    return { type: "asr" };
  }

  // ── 0a-cover. overlay product image on video ──────────────────────────────
  if (/(换封面|替换封面|叠加图|覆盖图|产品图.*叠|商品图.*放|把.*图.*放|图片.*覆盖|cover.*replace|overlay.*image|image.*overlay)/i.test(str)) {
    // Parse scale: "缩小到20%" / "放大到60%" / "占视频40%"
    const scaleM = str.match(/(\d+)\s*[%％]/);
    const scale = scaleM ? Math.max(5, Math.min(100, parseInt(scaleM[1]))) / 100 : 0.35;
    // Parse position
    let position = "top-right";
    if (/(左上|top.left)/i.test(str)) position = "top-left";
    else if (/(右上|top.right)/i.test(str)) position = "top-right";
    else if (/(左下|bottom.left)/i.test(str)) position = "bottom-left";
    else if (/(右下|bottom.right)/i.test(str)) position = "bottom-right";
    else if (/(居中|中间|中央|center)/i.test(str)) position = "center";
    return { type: "coverReplace", scale, position };
  }

  // ── 0b-multi. multi-segment keep: "保留1-3s和7-10s" ──────────────────────
  if (/(保留|裁剪|截取|trim|keep)/.test(str) && /(和|与|及|and|\+)/.test(str)) {
    const SEG_PAT = /第?(\d+(?:\.\d+)?)\s*[秒s]?\s*[~\-–到至]\s*第?(\d+(?:\.\d+)?)\s*[秒s]/gi;
    const segs = [];
    let _m;
    while ((_m = SEG_PAT.exec(str)) !== null) {
      const a = parseFloat(_m[1]), b = parseFloat(_m[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) segs.push({ start: Math.max(0, a), end: b });
    }
    if (segs.length >= 2) return { type: "multiTrim", segments: segs };
  }

  // ── 0b. trim / keep range (single segment) ───────────────────────────────
  if (/(裁剪|截取|只保留|保留第|保留.*[秒s]|trim|crop|剪切)/i.test(str)) {
    const range = parseTimeRange(str);
    if (range) return { type: "trim", start: range.start, end: range.end };
  }

  // ── 0c. subtitle style (color / position) ─────────────────────────────────
  if (/(字幕.*颜色|字体颜色|文字.*颜色|把.*字幕.*改|改成.*色.*字幕|红色字幕|蓝色字幕|黄色字幕|字幕.*居中|subtitle.*color|text.*color)/i.test(str)) {
    const COLOR_MAP = { 红: "#ff3b3b", 蓝: "#3b6fff", 黄: "#ffe933", 绿: "#33ff57", 白: "#ffffff", 黑: "#111111", 橙: "#ff8c00", 粉: "#ff69b4" };
    let color = null;
    for (const [k, v] of Object.entries(COLOR_MAP)) {
      if (str.includes(k)) { color = v; break; }
    }
    const posCenter = /(居中|中间|中央|center)/i.test(str);
    if (color || posCenter) return { type: "subtitleStyle", color, position: posCenter ? "center" : null };
  }

  // ── 1. ranged speed ────────────────────────────────────────────────────────
  // Must have time range + speed keyword + multiplier
  if (/(倍速|加速|减速|speed|playback|慢速|快速)/i.test(str)) {
    const speedM = str.match(/([0-2](?:\.\d+)?)\s*[xX倍速]/);
    const speed = speedM ? Math.max(0.5, Math.min(2, parseFloat(speedM[1]))) : 0;
    const range = parseTimeRange(str);
    if (speed > 0 && range) {
      return { type: "speedRange", start: range.start, end: range.end, speed };
    }
    // Global speed (no range)
    if (speed > 0) {
      return { type: "speed", speed };
    }
    // Descriptive speed: "加速" "快一倍" "慢一半"
    if (/加速|speed\s*up|fast/i.test(str)) return { type: "speed", speed: 1.5 };
    if (/减速|slow\s*down|慢/i.test(str)) return { type: "speed", speed: 0.75 };
  }

  // ── 2. subtitle / text overlay ─────────────────────────────────────────────
  if (/(字幕|caption|subtitle|文字|文案|加字|叠字)/i.test(str)) {
    const range = parseTimeRange(str);
    // Single time point: "在第2秒加字幕"
    let start = 0;
    let end = 0;
    if (range) {
      start = range.start;
      end = range.end;
    } else {
      const sp = /第?(\d+(?:\.\d+)?)\s*[秒s]/i.exec(str);
      if (sp) { start = parseFloat(sp[1]); end = start + 3; }
    }
    // Extract caption text
    let captionText = "";
    const quotedM = str.match(/[：:"'「『]\s*([^」』"'：:"]{1,80}?)\s*[」』"']|[：:]\s*(.{1,80}?)(?:\s*$)/);
    if (quotedM) {
      captionText = (quotedM[1] || quotedM[2] || "").trim();
    } else {
      captionText = str
        .replace(TIME_RANGE, "")
        .replace(/(?:给|在|为|对|add|insert|put|字幕|caption|subtitle|文字|文案|第|秒|s\b|[~～：:])+/gi, " ")
        .replace(/\s+/g, " ").trim().slice(0, 60);
    }
    if (captionText && end > start) {
      return { type: "subtitle", start, end, text: captionText };
    }
  }

  // ── 3. color grading ───────────────────────────────────────────────────────
  if (/(调色|亮|暗|饱和|色调|对比|暖色|冷色|偏黄|偏蓝|偏绿|偏红|color|bright|dark|saturate|warm|cool|hue|contrast|vivid|cinematic|vintage|黑白|灰度|tint)/i.test(str)) {
    const color = {};
    // Brightness
    if (/(亮一点|亮度|提亮|brighter|lighten|增加亮度)/i.test(str)) color.bright = 18;
    else if (/(暗一点|降暗|darker|darken|减少亮度)/i.test(str)) color.bright = -18;
    // Saturation
    if (/(饱和|鲜艳|vivid|saturate)/i.test(str)) color.sat = 20;
    else if (/(去饱和|淡|desaturate|faded|pale)/i.test(str)) color.sat = -20;
    // Warmth/hue
    if (/(暖色|偏黄|偏橙|warm|golden)/i.test(str)) color.hue = 15;
    else if (/(冷色|偏蓝|cool|cooler)/i.test(str)) color.hue = -15;
    // Contrast
    if (/(对比|cinematic|contrast)/i.test(str)) color.contrast = 20;
    // Vintage/film look
    if (/(vintage|胶片|film|电影感)/i.test(str)) { color.sat = 15; color.hue = 8; color.contrast = 15; }
    // Black & white
    if (/(黑白|灰度|grayscale|black.*white)/i.test(str)) { color.sat = -100; }
    if (Object.keys(color).length > 0) {
      return { type: "color", ...color };
    }
  }

  // ── 4. BGM ─────────────────────────────────────────────────────────────────
  if (/(bgm|背景音乐|音乐|配乐|background music|music|音效)/i.test(str)) {
    if (/(去掉|删除|移除|关闭|静音|remove|delete|mute|off|no music)/i.test(str)) {
      return { type: "bgm", action: "remove" };
    }
    if (/(小声|降低|低一点|quieter|lower|reduce)/i.test(str)) {
      const volM = str.match(/(\d+)\s*[%％]/);
      return { type: "bgm", action: "lower", volume: volM ? parseInt(volM[1]) : 30 };
    }
    if (/(大声|提高|高一点|louder|raise|increase)/i.test(str)) {
      const volM = str.match(/(\d+)\s*[%％]/);
      return { type: "bgm", action: "raise", volume: volM ? parseInt(volM[1]) : 80 };
    }
  }

  return null;
}

// Keep old simple extractor for backward compat
function extractPlaybackSpeedIntent(raw = "") {
  const r = extractVideoEditIntent(raw);
  if (r?.type === "speed") return r.speed;
  return 0;
}

function extractSubtitleIntent(raw = "") {
  const r = extractVideoEditIntent(raw);
  if (r?.type === "subtitle") return r;
  return null;
}

/**
 * Dispatch any recognized video-edit intent to the appropriate handler.
 * Supports batch: "1~3s字幕：你好，整体加速1.2x" splits into sequential intents.
 * Returns true if intent was handled.
 */
async function dispatchVideoEditIntent(raw = "") {
  // Batch: split by full-width/half-width comma or semicolon and try each part
  const parts = raw.split(/[，；;,]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const intents = parts.map((p) => extractVideoEditIntent(p)).filter(Boolean);
    if (intents.length > 1) {
      if (!state.lastVideoUrl && intents.some((i) => i.type !== "undo")) {
        pushSystemStateMsg(t("speedIntentNoVideo"), "blocked");
        return true;
      }
      pushSystemStateMsg(t("batchEditApplying", { count: intents.length }), "progress");
      for (const intent of intents) {
        await _dispatchSingleIntent(intent);
      }
      pushSystemStateMsg(t("batchEditApplied", { count: intents.length }), "done");
      return true;
    }
  }

  const intent = extractVideoEditIntent(raw);
  if (!intent) return false;
  return _dispatchSingleIntent(intent);
}

async function _dispatchSingleIntent(intent) {
  if (intent.type !== "undo" && !state.lastVideoUrl) {
    pushSystemStateMsg(t("speedIntentNoVideo"), "blocked");
    return true;
  }
  switch (intent.type) {
    case "undo":
      await applyUndoLastEdit();
      return true;
    case "asr":
      await applyAsrSubtitlesToCurrentVideo();
      return true;
    case "coverReplace":
      await applyImageOverlayToCurrentVideo(intent);
      return true;
    case "multiTrim":
      await applyMultiTrimToCurrentVideo(intent);
      return true;
    case "trim":
      await applyTrimToCurrentVideo(intent);
      return true;
    case "subtitleStyle":
      applySubtitleStyleToCurrentVideo(intent);
      return true;
    case "speed":
      await applyPlaybackSpeedToCurrentVideo(intent.speed);
      return true;
    case "speedRange":
      await applyRangedSpeedToCurrentVideo(intent);
      return true;
    case "subtitle":
      await applySubtitleToCurrentVideo(intent);
      return true;
    case "color":
      await applyColorGradingToCurrentVideo(intent);
      return true;
    case "bgm":
      await applyBgmEditToCurrentVideo(intent);
      return true;
    default:
      return false;
  }
}


function sanitizePromptForVeo(raw = "") {
  let text = String(raw || "").trim();
  if (!text) return text;
  text = text.replace(/\$[\d,.]+/g, "");
  text = text.replace(/¥[\d,.]+/g, "");
  text = text.replace(/(?:USD|EUR|GBP|CNY|JPY)\s*[\d,.]+/gi, "");
  text = text.replace(/\d+%\s*(?:off|discount|折)/gi, "");
  text = text.replace(/(?:free\s+returns?|free\s+shipping|包邮|免运费|免费退[货换])/gi, "");
  text = text.replace(/(?:buy\s+now|shop\s+now|add\s+to\s+cart|立即购买|加入购物车|立即下单)/gi, "");
  text = text.replace(/(?:limited\s+time|flash\s+sale|限时|秒杀|大促)/gi, "");
  text = text.replace(/(?:Amazon|Walmart|Shein|Temu|AliExpress|eBay|Etsy)\s*(?:Luxury|Prime|Plus)?/gi, "brand");
  text = text.replace(/\b(?:TM|®|©)\b/g, "");
  text = text.replace(/(?:text\s+overlay|文字叠加|字幕覆盖|字幕|subtitle|caption)[^.;；。]*[.;；。]?/gi, "");
  // Remove quotation marks — Veo renders quoted text as on-screen text (official best practice).
  text = text.replace(/(?:CTA\s*:\s*"[^"]*")/gi, "CTA: confident closing gesture.");
  text = text.replace(/[""\u201c\u201d]/g, "");
  text = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g, " ");
  text = text
    .split(/\n+/)
    .filter((line) => !/(禁用词|合规要求|support codes|allowlisting)/i.test(line))
    .join("\n")
    .replace(/\s{3,}/g, " ")
    .trim();
  if (!/no\s+text/i.test(text)) {
    text += " No text overlay, no subtitles, no captions, no on-screen characters in any language.";
  }
  return text.slice(0, 1600);
}

function hasCjkChars(raw = "") {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(raw || ""));
}

function buildSingleVeoFallbackPrompt() {
  const duration = Math.max(4, Math.min(8, Number(state.duration) || 8));
  const ratio = state.aspectRatio || "16:9";
  const product = String(state.productName || "ecommerce product").trim() || "ecommerce product";
  const business = String(state.mainBusiness || "ecommerce").trim() || "ecommerce";
  const region = String(state.salesRegion || "target market").trim() || "target market";
  const target = String(state.targetUser || "target audience").trim() || "target audience";
  const style = String(state.template || "clean cinematic").trim() || "clean cinematic";
  const points = normalizePointsList(state.sellingPoints || "").slice(0, 2).join("; ") || "one core selling point";
  const modelText = state.needModel === false ? "without model showcase" : "with model showcase";
  const anchorSummary = buildProductAnchorSummary("en");
  return [
    `[Style] ${style}, commercial ultra-HD quality, cinematic lighting.`,
    `[Subject] ${product} for ${business}, keep identity consistent with uploaded references.`,
    anchorSummary ? `[Anchors] ${anchorSummary}.` : "",
    `[Context] For ${region}, aimed at ${target}, ${modelText}.`,
    `[Action] Focus on ${points}.`,
    `[00:00-00:02] Hero intro shot and product silhouette.`,
    `[00:02-00:04] Medium shot of key usage moment.`,
    `[00:04-00:06] Macro close-up for texture and material details.`,
    `[00:06-00:08] Confident closing composition with conversion intent.`,
    `[Technical] Aspect ratio ${ratio}, duration ${duration}s, natural camera movement, realistic texture.`,
  ].join(" ");
}

async function rewritePromptForVeoSingle(base, rawPrompt, taskId = "") {
  const source = String(rawPrompt || "").trim();
  if (!source) return "";
  const anchorHint = buildProductAnchorSummary("en");
  const needsRewrite = hasCjkChars(source);
  if (!needsRewrite) {
    return sanitizePromptForVeo([source, anchorHint ? `Preserve these product anchors exactly: ${anchorHint}.` : ""].filter(Boolean).join(" ")) || source;
  }
  try {
    updateVideoTask(taskId, { status: "queued", stage: currentLang === "zh" ? "提示词语义对齐中" : "Aligning prompt semantics" });
    const rewriteResp = await postJson(
      `${base}/api/agent/chat`,
      {
        model: "bedrock-claude-4-5-haiku",
        messages: [
          {
            role: "system",
            content:
              "Rewrite the user's ecommerce video prompt into ONE Veo-ready English prompt.\n"
              + "Keep original product intent and selling points.\n"
              + "Do not change the product category, silhouette, color family, materials, or key details when anchors are provided.\n"
              + "Output must be plain text only (no markdown), max 220 words.\n"
              + "Must include four timestamp shots: [00:00-00:02], [00:02-00:04], [00:04-00:06], [00:06-00:08].\n"
              + "Must avoid text overlays/subtitles/captions and avoid quotation marks.",
          },
          { role: "user", content: [source, anchorHint ? `Product anchors to preserve exactly: ${anchorHint}.` : ""].filter(Boolean).join("\n") },
        ],
        temperature: 0.3,
        max_tokens: 700,
      },
      20000
    );
    const rewritten = String(rewriteResp?.content || "").trim();
    const cleaned = sanitizePromptForVeo(rewritten);
    if (cleaned && cleaned.length > 40) return cleaned;
  } catch (_e) {}
  const fallback = buildSingleVeoFallbackPrompt();
  return sanitizePromptForVeo(fallback) || sanitizePromptForVeo(source) || source;
}

function isVeoSafetyRejection(msg = "") {
  return /violate.*usage guidelines|Responsible AI|sensitive words|support codes/i.test(String(msg));
}

function isVeoRetryableLoadError(msg = "") {
  return /currently experiencing high load|try again later|service unavailable|resource exhausted/i.test(String(msg || ""));
}

function buildAutoPromptDraftFromParsed(source = "image") {
  const duration = state.duration || "8";
  const ratio = state.aspectRatio || "16:9";
  const product = state.productName || (currentLang === "zh" ? "该商品" : "this product");
  const business = state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion and accessories");
  const style = state.template || "clean";
  const pointList = normalizePointsList(state.sellingPoints || "");
  const focusPoints = pointList.slice(0, 2);
  const sellingText =
    focusPoints.join(currentLang === "zh" ? "；" : "; ") ||
    (currentLang === "zh" ? "突出核心卖点与真实质感" : "highlight core selling points with realistic texture");
  const target = state.targetUser || (currentLang === "zh" ? "目标人群" : "target audience");
  const region = state.salesRegion || (currentLang === "zh" ? "目标地区" : "target region");
  const modelText =
    state.needModel === false
      ? currentLang === "zh"
        ? "不需要模特展示"
        : "no model showcase"
      : currentLang === "zh"
        ? "需要模特展示"
        : "need model showcase";
  const sourceHint =
    source === "image"
      ? currentLang === "zh"
        ? "请严格参考我上传的商品图，保持商品主体与细节一致。"
        : "Strictly follow uploaded reference images and keep product details consistent."
      : currentLang === "zh"
        ? "请严格参考已解析商品信息，保持商品特征一致。"
        : "Strictly follow parsed product information and keep product details consistent.";
  const anchorSummary = buildProductAnchorSummary(currentLang);
  if (currentLang === "zh") {
    return [
      `[Style] ${style}，超高清商业画质，电影级影棚布光，真实可拍可剪。`,
      `[Environment] 结合${region}审美与${business}消费场景，背景保持干净、道具适度。`,
      `[Tone & Pacing] ${duration}秒内快慢有序，核心卖点仅聚焦1-2个：${sellingText}。`,
      `[Camera] 轻微手持+稳定推进结合，突出产品主体与关键细节。`,
      `[Lighting] 自然光+柔和补光，强化材质纹理与高光边缘。`,
      `[Actions / Scenes] 商品引入 -> 使用动作 -> 卖点特写 -> 体验展示 -> 收尾CTA。`,
      `[Background Sound] 轻节奏BGM + 合理环境音。`,
      `[Transition / Editing] 节奏匹配剪辑，关键动作点顺滑衔接。`,
      `[Call to Action] 以推荐动作和购买动机收口。`,
      `基础约束：画幅${ratio}，时长${duration}秒，商品${product}，目标人群${target}，模特策略${modelText}。`,
      anchorSummary ? `商品锚点：${anchorSummary}。` : "",
      sourceHint,
      "请从4.1~4.6选择最合适的组合完成上述结构，避免空话。",
      "合规后缀：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。",
    ].join(" ");
  }
  return [
    `[Style] ${style}; commercial ultra-HD quality and cinematic studio lighting.`,
    `[Environment] Built for ${region} aesthetics and ${business} shopping context.`,
    `[Tone & Pacing] ${duration}s rhythm with only 1-2 core selling points: ${sellingText}.`,
    `[Camera] Light handheld + controlled push-ins for executable shots.`,
    `[Lighting] Natural + soft fill, emphasize texture and edge highlights.`,
    `[Actions / Scenes] Product intro -> usage -> selling-point close-up -> experience -> CTA close.`,
    `[Background Sound] Light rhythmic BGM plus contextual SFX.`,
    `[Transition / Editing] Beat-matched transitions with smooth action continuity.`,
    `[Call to Action] End with recommendation intent and conversion hook.`,
    `Base constraints: ratio ${ratio}, duration ${duration}s, product ${product}, audience ${target}, model strategy ${modelText}.`,
    anchorSummary ? `${anchorSummary}.` : "",
    sourceHint,
    "Select the best mix from 4.1~4.6 to complete this structure.",
    "Compliance suffix: clean highlight edges, controlled reflections, clear textures, sharp structure edges, no distorted limbs/structures, no third-party logos or watermarks.",
  ].join(" ");
}

function pickPlayableUrl(data) {
  return data?.inline_videos?.[0]?.data_url || data?.signed_video_urls?.[0]?.url || data?.signed_all_urls?.[0]?.url || "";
}


function buildPlayableUrlFromGcs(gcsUri) {
  const uri = String(gcsUri || "").trim();
  if (!uri || !uri.startsWith("gs://")) return "";
  return `${getApiBase()}/api/veo/play?gcs_uri=${encodeURIComponent(uri)}`;
}

function buildVideoSourceCandidates(videoUrl, gcsUri = "") {
  const direct = String(videoUrl || "").trim();
  const proxy = buildPlayableUrlFromGcs(gcsUri);
  const result = [];
  if (proxy) result.push(proxy);
  if (direct && direct !== proxy) result.push(direct);
  return result;
}

async function refreshPlayableUrlByOperation(operationName) {
  const op = String(operationName || "").trim();
  if (!op) return "";
  try {
    const status = await postJson(
      `${getApiBase()}/api/veo/status`,
      {
        project_id: "gemini-sl-20251120",
        model: getVeoModel(),
        operation_name: op,
      },
      25000
    );
    return String(pickPlayableUrl(status) || "").trim();
  } catch (_e) {
    return "";
  }
}

function isChainDuration(value) {
  return String(value || "") === "16";
}

function renderChainSummary(chainResp) {
  const segments = Array.isArray(chainResp?.segments) ? chainResp.segments : [];
  if (!segments.length) return;
  const seed = String(chainResp?.seed || "");
  const lines = [t("chainSummaryTitle")];
  for (const seg of segments) {
    const step = Number(seg?.step || 0) || 0;
    const attempt = Number(seg?.attempt_count || 1) || 1;
    const uri = String(seg?.video_gcs_uri || "").trim() || "-";
    if (String(seg?.type || "") === "base_generate") {
      lines.push(
        t("chainSummaryLineBase", {
          step,
          seed: seed || "-",
          attempt,
          uri,
        })
      );
    } else {
      lines.push(
        t("chainSummaryLineExtend", {
          step,
          attempt,
          source: String(seg?.source_video_gcs_uri || "-"),
          uri,
        })
      );
    }
  }
  pushSystemReplyMsg(lines.join("\n"), { typewriter: true, speed: 20 });
}

function renderGeneratedVideoCard(videoUrl, gcsUri = "", operationName = "", taskId = "") {
  // Always return to chat-first preview mode after a new video is produced.
  // Editors should open only when user clicks action buttons on the video card.
  state.videoEditorOpen = false;
  state.scriptEditorOpen = false;
  applyWorkspaceMode();

  const sourceCandidates = buildVideoSourceCandidates(videoUrl, gcsUri);
  const finalPlayableUrl = sourceCandidates[0] || "";
  state.lastVideoUrl = finalPlayableUrl;
  state.canUseEditors = true;
  // Snapshot this card's context so concurrent videos don't overwrite each other
  const cardVideoUrl = finalPlayableUrl;
  const cardPrompt = state.lastPrompt;
  const cardStoryboard = state.lastStoryboard;
  const cardDuration = String(state.duration || "8");
  const cardAspectRatio = String(state.aspectRatio || "16:9");
  const taskSourceLabel = String(state.taskMap?.[taskId]?.sourceLabel || "").trim();
  const taskRunLabel = String(state.taskMap?.[taskId]?.title || "").trim();
  const card = document.createElement("article");
  card.className = "msg system video-msg";
  const cardId = `task-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  card.dataset.taskCardId = cardId;
  state.activeVideoCardId = cardId;
  const meta = document.createElement("div");
  meta.className = "msg-card-meta msg-card-meta-video";
  const boundScriptSummary = getBoundScriptSummary(cardStoryboard);
  meta.innerHTML = `
    <span class="msg-card-label">${t("cardRecentResult")}</span>
    <div class="msg-card-meta-right">
      ${taskRunLabel ? `<span class="msg-card-status card-source-run status-dot-info">${sanitizeInputValue(taskRunLabel)}</span>` : ""}
      ${taskSourceLabel ? `<span class="msg-card-status card-source-route status-dot-info">${sanitizeInputValue(taskSourceLabel)}</span>` : ""}
      <span class="msg-card-status status-dot-info">${t("cardDurationShort")} · ${sanitizeInputValue(cardDuration)}s</span>
      <span class="msg-card-status status-dot-info">${t("cardRatioShort")} · ${sanitizeInputValue(cardAspectRatio)}</span>
      <span class="msg-card-status card-binding-script-name status-dot-done">${t("cardScriptNameShort")} · ${sanitizeInputValue(boundScriptSummary)}</span>
      <span class="msg-card-status card-binding-video-editor status-dot-done" hidden>${t("cardVideoEditorOpen")}</span>
      <span class="msg-card-status card-binding-script-editor status-dot-done" hidden>${t("cardScriptEditorOpen")}</span>
      <span class="msg-card-status card-binding-edit-mode status-dot-progress" hidden></span>
      <span class="msg-card-status card-status-active status-dot-progress" hidden>${t("cardCurrentContext")}</span>
      <span class="msg-card-status card-status-idle status-dot-info">${t("cardSwitchContext")}</span>
    </div>
  `;
  const title = document.createElement("div");
  title.textContent = t("done");

  const surface = document.createElement("div");
  surface.className = "video-edit-surface";
  surface.style.cssText = "display:block;width:100%;position:relative;";

  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.style.cssText = "display:block;width:100%;max-height:280px;border-radius:14px;background:#000;";
  // Disable native video fullscreen so the surface-level fullscreen (which
  // keeps overlays, color filter and BGM visible) is used instead.
  video.controlsList?.add?.("nofullscreen");
  video.src = finalPlayableUrl;
  let idx = 0;
  let refreshedByOp = false;
  video.addEventListener("error", async () => {
    if (idx + 1 < sourceCandidates.length) {
      idx += 1;
      const nextUrl = sourceCandidates[idx];
      video.src = nextUrl;
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(err => console.debug('[shoplive]', err));
      return;
    }
    if (!refreshedByOp) {
      refreshedByOp = true;
      const refreshedUrl = await refreshPlayableUrlByOperation(operationName);
      if (refreshedUrl) {
        video.src = refreshedUrl;
        const p = video.play();
        if (p && typeof p.catch === "function") p.catch(err => console.debug('[shoplive]', err));
        return;
      }
    }
    const hasGcsSource = String(gcsUri || "").startsWith("gs://");
    if (hasGcsSource) {
      pushSystemStateMsg(
        currentLang === "zh"
          ? "视频播放失败：当前账号缺少 GCS 对象读取权限（storage.objects.get）。请联系管理员授权后重试，或重新生成（不指定 storage_uri）。"
          : "Video playback failed: current account lacks GCS object read permission (storage.objects.get). Grant permission and retry, or regenerate without storage_uri.",
        "blocked",
        { error: true }
      );
      return;
    }
    pushSystemStateMsg(
      currentLang === "zh" ? "视频播放失败：地址无效或已过期，请重新生成。" : "Video playback failed: URL invalid or expired. Please regenerate.",
      "blocked",
      { error: true }
    );
  });
  surface.appendChild(video);
  setupSurfaceFullscreen(surface);

  const actions = document.createElement("div");
  actions.className = "video-actions";
  actions.innerHTML = `
    <button class="openVideoEditorBtn action-chip-btn action-chip-primary">${t("editVideo")}</button>
    <button class="openScriptEditorBtn action-chip-btn action-chip-secondary">${t("editScript")}</button>
  `;

  card.appendChild(meta);
  card.appendChild(title);
  card.appendChild(surface);
  card.appendChild(actions);
  chatList.appendChild(card);
  // Restore this card's snapshot and open BOTH editor panels (mode-three)
  // so the full 3-column view is always tied to the clicked video.
  const openCardEditors = (focusScript = false) => {
    state.lastVideoUrl = cardVideoUrl;
    state.lastPrompt = cardPrompt;
    state.lastStoryboard = cardStoryboard;
    state.activeVideoCardId = cardId;
    // Reset per-card edit state so previous card's edits don't bleed into this card
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
      activeModule: "mask",
      timeline: {
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
      },
      _renderHash: null,  // force re-render
    };
    state.videoEditorOpen = true;
    state.scriptEditorOpen = true;
    applyWorkspaceMode();
    renderVideoEditor();
    renderScriptEditor();
    restoreWorkspaceAnchor("smooth", "center");
    if (focusScript && (!state.lastStoryboard || !state.lastPrompt)) {
      hydrateWorkflowTexts(true).then(() => {
        if (state.scriptEditorOpen) renderScriptEditor();
        restoreWorkspaceAnchor("auto", "nearest");
      });
    }
  };
  card.querySelector(".openVideoEditorBtn")?.addEventListener("click", () => openCardEditors(false));
  card.querySelector(".openScriptEditorBtn")?.addEventListener("click", () => openCardEditors(true));
  if (taskId && state.taskMap?.[taskId]) {
    updateVideoTask(taskId, {
      resultCardId: cardId,
      resultVideoUrl: finalPlayableUrl,
      resultGcsUri: String(gcsUri || ""),
      resultOperationName: String(operationName || ""),
    });
  }
  applyWorkspaceMode();
  renderVideoEditor();
  renderScriptEditor();
  applyVideoEditsToPreview();
  // Video results should always be visible in chat immediately, even if the
  // user previously scrolled up while waiting for polling/task updates.
  _userScrolledUp = false;
  _unreadCount = 0;
  const badge = document.getElementById("scrollBotBadge");
  if (badge) {
    badge.hidden = true;
    badge.textContent = "0";
  }
  if (chatList) {
    chatList.scrollTo({ top: chatList.scrollHeight, behavior: "smooth" });
  }
  return cardId;
}


async function generate16sWithProgress(base, startBody, finalPrompt, workflowStartedAt = Date.now(), taskId = "") {
  const zh = currentLang === "zh";
  const statusBubble = pushSystemStateMsg(zh ? "⏳ 步骤 1/4：正在用 AI 拆分提示词为前后两段…" : "Step 1/4: Splitting prompt into two segments…", "progress");
  updateVideoTask(taskId, { status: "running", stage: zh ? "步骤1/5 拆分提示词" : "Step 1/5 split prompt" });

  let promptA = "";
  let promptB = "";
  try {
    const splitResp = await postJson(
      `${base}/api/agent/chat`,
      {
        model: "bedrock-claude-4-5-haiku",
        messages: [
          {
            role: "system",
            content: _buildSplitSystemPrompt(2, 8),
          },
          {
            role: "user",
            content:
              `Split this into 2 segments of 8s each (total 16s).\n`
              + `Preserve ALL visual anchors faithfully. Make each segment narratively distinct.\n\n`
              + `Original prompt:\n${finalPrompt}`,
          },
        ],
        temperature: 0.25,
        max_tokens: 1800,
      },
      30000
    );
    const raw = String(splitResp?.content || "").trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_e) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch (_e2) {}
    }
    promptA = sanitizePromptForVeo(String(parsed?.part1 || "").trim()) || "";
    promptB = sanitizePromptForVeo(String(parsed?.part2 || "").trim()) || "";
  } catch (_e) {}

  // Smart fallback: structural scene templates anchored to original prompt
  if (!promptA || !promptB) {
    const basePrompt = sanitizePromptForVeo(finalPrompt) || finalPrompt;
    promptA = promptA || (
      basePrompt
      + " SEGMENT 1/2 — PRODUCT HERO OPENING: "
      + "[00:00-00:02] Camera pushes in from wide, product silhouette emerging against background. "
      + "[00:02-00:04] Medium close-up on the product's primary feature with sharp focus and studio lighting. "
      + "[00:04-00:06] Detail shot — texture and key design element highlighted. "
      + "[00:06-00:08] Hero framing — product centered, mood and color palette fully established."
    );
    promptB = promptB || (
      basePrompt
      + " SEGMENT 2/2 — USAGE & CLOSING: "
      + "[00:00-00:02] Lifestyle context — product in its intended use environment, different angle from Segment 1. "
      + "[00:02-00:04] Close-up of product during natural use, secondary feature visible. "
      + "[00:04-00:06] Emotional moment — satisfaction and connection with the product. "
      + "[00:06-00:08] Confident closing hero shot — product alone, perfect lighting, camera holds still for final reveal."
    );
  }
  state.lastStoryboard = buildStoryboardFromPromptSegments([promptA, promptB], 8) || state.lastStoryboard;

  const segBody = { ...startBody, duration_seconds: 8 };
  // Snapshot the model at start time — polling MUST use the same model name as submission.
  const lockedModel = segBody.model || getVeoModel();

  async function submitSafe(prompt, label) {
    try {
      return await postJson(`${base}/api/veo/start`, { ...segBody, prompt }, 30000);
    } catch (e) {
      if (isVeoSafetyRejection(String(e?.message || ""))) {
        const saferPrompt = `Clean cinematic ecommerce product video, 8 seconds, natural lighting, smooth camera. ${label === "A" ? "Product introduction." : "Usage and confident closing."}`;
        return await postJson(`${base}/api/veo/start`, { ...segBody, prompt: saferPrompt }, 30000);
      }
      throw e;
    }
  }

  async function pollUntilDone(op, label) {
    const start = Date.now();
    const transientBackoff = createTransientBackoffByPreset("agentChainPoll");
    const SOFT_TIMEOUT_MS = 360000; // soft limit, keep polling after notice
    const SOFT_TIMEOUT_STEP_MS = 180000;
    const HARD_TIMEOUT_MS = 1800000;
    let nextSoftTimeoutAt = SOFT_TIMEOUT_MS;
    let lastContinueNoticeAt = 0;
    while (true) {
      // 取消检查
      if (state.taskMap?.[taskId]?.cancelRequested) {
        throw new Error("CANCELLED");
      }
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const totalElapsed = Math.floor((Date.now() - workflowStartedAt) / 1000);
      statusBubble.textContent = zh
        ? `⏳ 步骤 ${label}：生成中（总计 ${totalElapsed}s）…`
        : `Step ${label}: Generating (${totalElapsed}s total)…`;
      updateVideoTask(taskId, { status: "running", stage: zh ? `步骤 ${label} 生成中（总计${totalElapsed}s）` : `Step ${label} running (${totalElapsed}s total)` });
      const waitMs = elapsed < 40 ? 3000 : 12000;
      await new Promise((r) => setTimeout(r, waitMs));
      if (elapsed < 30) continue;
      try {
        const st = await postJson(`${base}/api/veo/status`, { project_id: "gemini-sl-20251120", model: lockedModel, operation_name: op }, 15000);
        if (st?.transient) {
          const retryAttempts = Math.max(0, Number(st?.retry_attempts || 0));
          const waitMs = transientBackoff.apply(retryAttempts);
          if (transientBackoff.shouldNotify()) {
            pushSystemStateMsg(t("pollTransient", { retry: retryAttempts }), "progress");
          }
          updateVideoTask(taskId, { status: "running", stage: zh ? `步骤 ${label} 退避重试` : `Step ${label} backoff retry` });
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        const pUrl = pickPlayableUrl(st);
        const gUri = String(st?.video_uris?.[0] || "").trim();
        if (pUrl || gUri) return { url: pUrl, gcs: gUri };
        const errMsg = st?.response?.done ? (st?.response?.error?.message || "") : "";
        if (errMsg) throw new Error(errMsg);
      } catch (e) {
        const msg = String(e?.message || "");
        if (msg.length > 5 && !/timeout|abort/i.test(msg)) throw e;
      }
      const elapsedMs = Date.now() - start;
      if (elapsedMs > nextSoftTimeoutAt && Date.now() - lastContinueNoticeAt > 30000) {
        lastContinueNoticeAt = Date.now();
        pushSystemStateMsg(t("pollContinue", { sec: totalElapsed }), "progress");
        nextSoftTimeoutAt += SOFT_TIMEOUT_STEP_MS;
        updateVideoTask(taskId, { status: "running", stage: zh ? `步骤 ${label} 自动续轮询` : `Step ${label} auto-continue polling` });
      }
      if (elapsedMs > HARD_TIMEOUT_MS) {
        throw new Error(
          zh
            ? `第${label}段超时（总计>${Math.floor(HARD_TIMEOUT_MS / 1000)}s）`
            : `Segment ${label} timed out (>${Math.floor(HARD_TIMEOUT_MS / 1000)}s total)`
        );
      }
    }
  }

  // Step 2/5: Generate segment 1
  statusBubble.textContent = zh ? "⏳ 步骤 2/5：正在生成第 1 段（8s）…" : "Step 2/5: Generating segment 1 (8s)…";
  updateVideoTask(taskId, { status: "running", stage: zh ? "步骤2/5 生成第1段" : "Step 2/5 segment A" });
  scrollToBottom();
  const startA = await submitSafe(promptA, "A");
  const opA = startA?.operation_name;
  if (!opA) throw new Error(zh ? "第1段提交失败" : "Segment 1 submit failed");
  const resA = await pollUntilDone(opA, "2/5");

  // Step 3/5: Extract last frame from segment 1 for seamless bridging
  statusBubble.textContent = zh ? "⏳ 步骤 3/5：提取第 1 段尾帧用于衔接…" : "Step 3/5: Extracting last frame for bridging…";
  updateVideoTask(taskId, { status: "running", stage: zh ? "步骤3/5 提取尾帧" : "Step 3/5 extract bridge frame" });
  scrollToBottom();
  let bridgeFrameB64 = "";
  let bridgeFrameMime = "image/png";
  try {
    const frameBody = {
      project_id: "gemini-sl-20251120",
      position: "last",
    };
    if (resA.gcs) frameBody.gcs_uri = resA.gcs;
    else if (resA.url && resA.url.startsWith("data:video/")) frameBody.video_data_url = resA.url;
    if (frameBody.gcs_uri || frameBody.video_data_url) {
      const frameResp = await postJson(`${base}/api/veo/extract-frame`, frameBody, 45000);
      bridgeFrameB64 = String(frameResp?.frame_base64 || "").trim();
      bridgeFrameMime = String(frameResp?.mime_type || "image/png").trim();
    }
  } catch (_e) {}

  // Step 4/5: Generate segment 2 with bridging frame as first frame
  statusBubble.textContent = zh ? "⏳ 步骤 4/5：正在生成第 2 段（8s，首帧衔接）…" : "Step 4/5: Generating segment 2 (8s, bridged)…";
  updateVideoTask(taskId, { status: "running", stage: zh ? "步骤4/5 生成第2段" : "Step 4/5 segment B" });
  scrollToBottom();
  const seg2Body = { ...segBody, prompt: promptB };
  if (bridgeFrameB64) {
    if (segBody.veo_mode === "reference") {
      const mergedRefs = [
        { base64: bridgeFrameB64, mime_type: bridgeFrameMime },
        ...((Array.isArray(segBody.reference_images_base64) ? segBody.reference_images_base64 : []).slice(0, 3)),
      ].slice(0, 4);
      seg2Body.veo_mode = "reference";
      seg2Body.reference_images_base64 = mergedRefs;
      delete seg2Body.image_base64;
      delete seg2Body.image_mime_type;
      delete seg2Body.image_url;
    } else {
      seg2Body.veo_mode = "image";
      seg2Body.image_base64 = bridgeFrameB64;
      seg2Body.image_mime_type = bridgeFrameMime;
    }
  }
  let startB;
  try {
    startB = await postJson(`${base}/api/veo/start`, seg2Body, 30000);
  } catch (e) {
    if (isVeoSafetyRejection(String(e?.message || ""))) {
      const saferBody = { ...segBody, prompt: `Clean cinematic product video continuation, 8 seconds, natural lighting, smooth camera, usage experience.` };
      if (bridgeFrameB64) {
        if (segBody.veo_mode === "reference") {
          const mergedRefs = [
            { base64: bridgeFrameB64, mime_type: bridgeFrameMime },
            ...((Array.isArray(segBody.reference_images_base64) ? segBody.reference_images_base64 : []).slice(0, 3)),
          ].slice(0, 4);
          saferBody.veo_mode = "reference";
          saferBody.reference_images_base64 = mergedRefs;
          delete saferBody.image_base64;
          delete saferBody.image_mime_type;
          delete saferBody.image_url;
        } else {
          saferBody.veo_mode = "image";
          saferBody.image_base64 = bridgeFrameB64;
          saferBody.image_mime_type = bridgeFrameMime;
        }
      }
      startB = await postJson(`${base}/api/veo/start`, saferBody, 30000);
    } else { throw e; }
  }
  const opB = startB?.operation_name;
  if (!opB) throw new Error(zh ? "第2段提交失败" : "Segment 2 submit failed");
  const resB = await pollUntilDone(opB, "4/5");

  // Step 5/5: Concatenate
  statusBubble.textContent = zh ? "⏳ 步骤 5/5：正在拼接为 16 秒视频…" : "Step 5/5: Concatenating into 16s video…";
  updateVideoTask(taskId, { status: "running", stage: zh ? "步骤5/5 拼接中" : "Step 5/5 concatenating" });
  scrollToBottom();

  let concatUrl = "";
  try {
    const concatBody = { project_id: "gemini-sl-20251120" };
    if (resA.gcs && resB.gcs) {
      concatBody.gcs_uri_a = resA.gcs;
      concatBody.gcs_uri_b = resB.gcs;
    } else if (
      resA.url && resA.url.startsWith("data:video/")
      && resB.url && resB.url.startsWith("data:video/")
    ) {
      concatBody.video_data_url_a = resA.url;
      concatBody.video_data_url_b = resB.url;
    } else if (resA.url && resB.url) {
      concatBody.video_http_url_a = resA.url;
      concatBody.video_http_url_b = resB.url;
    }
    if (concatBody.gcs_uri_a || concatBody.video_data_url_a || concatBody.video_http_url_a) {
      try {
        const concatResp = await postJson(`${base}/api/veo/concat-segments`, concatBody, 120000);
        concatUrl = String(concatResp?.video_url || concatResp?.video_data_url || "").trim();
        if (!concatUrl) {
          pushSystemStateMsg(zh
            ? "⚠️ 拼接接口返回为空，已降级展示第一段视频。"
            : "⚠️ Concat returned empty, showing segment 1 only.", "blocked");
        }
      } catch (concatErr) {
        pushSystemStateMsg(zh
          ? `⚠️ 视频拼接失败（${String(concatErr?.message || "unknown")}），已降级展示第一段视频。`
          : `⚠️ Concat failed (${String(concatErr?.message || "unknown")}), showing segment 1 only.`, "blocked");
      }
    }
  } catch (_outerErr) {}

  const playable = String(
    concatUrl
    || resA.url
    || buildPlayableUrlFromGcs(resA.gcs)
    || resB.url
    || buildPlayableUrlFromGcs(resB.gcs)
    || ""
  ).trim();
  if (statusBubble.parentNode) statusBubble.remove();
  if (!playable) throw new Error(zh ? "16s 视频播放地址缺失" : "16s video URL missing");

  pushSystemStateMsg(zh
    ? `16 秒视频生成完成（2 段串行衔接）。${concatUrl ? "" : "⚠️ 拼接未完成，暂展示第一段。"}`
    : `16s video ready (2 segments, frame-bridged).${concatUrl ? "" : " Concat incomplete, showing first segment."}`, "done");
  updateVideoTask(taskId, { status: "done", stage: zh ? "16秒任务完成" : "16s completed" });
  renderGeneratedVideoCard(playable, resA.gcs || resB.gcs || "", opA || "", taskId);
}

async function generateVideo(promptOverride = "") {
  if (!canStartVideoJob()) {
    pushSystemStateMsg(t("tooManyJobs"), "blocked");
    return;
  }
  // New generation should not keep old split-panel state.
  // Keep chat list as the primary surface while task is running.
  if (state.videoEditorOpen || state.scriptEditorOpen) {
    state.videoEditorOpen = false;
    state.scriptEditorOpen = false;
    applyWorkspaceMode();
  }
  acquireVideoJobSlot();
  let slotReleased = false;
  const releaseSlotOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseVideoJobSlot();
  };
  const taskId = createVideoTask(`${state.duration || "8"}s`);
  // Register release & abort handle so cancelVideoTask() can use them
  if (state.taskMap[taskId]) {
    state.taskMap[taskId]._releaseSlot = releaseSlotOnce;
    state.taskMap[taskId]._abortCtrl   = new AbortController();
  }
  try {
    if (!promptOverride) {
      await hydrateWorkflowTexts(false);
    }
    const finalPrompt = String(promptOverride || state.lastPrompt || buildPrompt()).trim();
    const promptRatio = extractAspectRatioFromPrompt(finalPrompt);
    if (promptRatio) {
      state.aspectRatio = promptRatio;
      if (aspectRatioSelect) aspectRatioSelect.value = promptRatio;
    }
    state.lastPrompt = finalPrompt;
    if (!state.lastStoryboard) state.lastStoryboard = buildStoryboardText();
    pushSystemStateMsg(t("submit"), "progress");
    updateVideoTask(taskId, { status: "queued", stage: currentLang === "zh" ? "提交任务中" : "Submitting job" });
    const useFrameMode = Boolean(state.frameMode && state.firstFrame && state.lastFrame);
    const base = getApiBase();
    const safePrompt = await rewritePromptForVeoSingle(base, finalPrompt, taskId);
    const imagePayload = buildVeoReferencePayload();
    const startBody = {
      project_id: "gemini-sl-20251120",
      model: getVeoModel(),
      prompt: safePrompt,
      sample_count: 1,
      veo_mode: useFrameMode ? "frame" : imagePayload.veo_mode,
      duration_seconds: Number(state.duration),
      aspect_ratio: state.aspectRatio || "16:9",
    };
    if (useFrameMode) {
      const firstParsed = parseDataUrl(state.firstFrame);
      const lastParsed = parseDataUrl(state.lastFrame);
      if (firstParsed?.base64) {
        startBody.image_base64 = firstParsed.base64;
        startBody.image_mime_type = firstParsed.mime;
      }
      if (lastParsed?.base64) {
        startBody.last_frame_base64 = lastParsed.base64;
        startBody.last_frame_mime_type = lastParsed.mime;
      }
    } else {
      Object.assign(startBody, imagePayload);
    }
    if (getModelProvider() === "tabcode") {
      const targetDuration = Number(state.duration) || 6;
      const grokPrompt = buildGrokVideoPrompt(safePrompt, targetDuration);
      await generateTabcodeVideo(grokPrompt, taskId, targetDuration);
      finishVideoTask(taskId, true, currentLang === "zh" ? "完成" : "Done");
      releaseSlotOnce();
      return;
    }

    if (isChainDuration(state.duration)) {
      await generate16sWithProgress(base, startBody, finalPrompt, Date.now(), taskId);
      finishVideoTask(taskId, true, currentLang === "zh" ? "完成" : "Done");
      releaseSlotOnce();
      return;
    }

    const start = await postJson(`${base}/api/veo/start`, startBody);
    let operationName = start?.operation_name;
    let submitAttempts = 1;
    if (!operationName) throw new Error("operation_name missing");
    updateVideoTask(taskId, {
      status: "running",
      stage: currentLang === "zh" ? "已提交，轮询中" : "Submitted, polling",
      operationName,
    });
    const zh = currentLang === "zh";
    const pollBubble = pushSystemStateMsg(zh ? "视频生成中（Fast 模式），预计 60-90 秒…" : "Generating video (Fast mode), ~60-90s…", "progress");
    const pollStartedAt = Date.now();
    const POLL_SOFT_TIMEOUT_MS = 300000;
    const POLL_SOFT_STEP_MS = 180000;
    const POLL_HARD_TIMEOUT_MS = 1800000;
    let pollStopped = false;
    let nextSoftTimeoutAt = POLL_SOFT_TIMEOUT_MS;
    let lastContinueNoticeAt = 0;
    const transientBackoff = createTransientBackoffByPreset("agentFastPoll");

    const doPoll = async () => {
      if (pollStopped) return;
      // 用户取消
      if (state.taskMap?.[taskId]?.cancelRequested) {
        pollStopped = true;
        if (pollBubble.parentNode) pollBubble.remove();
        return;
      }
      const elapsedMs = Date.now() - pollStartedAt;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      pollBubble.textContent = zh
        ? `视频生成中（${elapsedSec}s）…`
        : `Generating video (${elapsedSec}s)…`;
      updateVideoTask(taskId, { status: "running", stage: zh ? `轮询中（总计${elapsedSec}s）` : `Polling (${elapsedSec}s total)` });

      if (elapsedMs > nextSoftTimeoutAt && Date.now() - lastContinueNoticeAt > 30000) {
        lastContinueNoticeAt = Date.now();
        pushSystemStateMsg(t("pollContinue", { sec: elapsedSec }), "progress");
        nextSoftTimeoutAt += POLL_SOFT_STEP_MS;
      }
      if (elapsedMs > POLL_HARD_TIMEOUT_MS) {
        pollStopped = true;
        if (pollBubble.parentNode) pollBubble.remove();
        pushSystemStateMsg(zh
          ? `视频生成超时（总计 ${elapsedSec}s）。请稍后重试或简化提示词。`
          : `Video generation timed out (${elapsedSec}s total). Retry later or simplify the prompt.`, "blocked");
        finishVideoTask(taskId, false, zh ? "超时" : "Timeout");
        releaseSlotOnce();
        return;
      }

      if (elapsedMs < 30000) {
        scheduleNext(2000);
        return;
      }

      try {
        const status = await postJson(
          `${base}/api/veo/status`,
          {
            project_id: "gemini-sl-20251120",
            model: getVeoModel(),
            operation_name: operationName,
          },
          20000
        );
        if (status?.transient) {
          const retryAttempts = Math.max(0, Number(status?.retry_attempts || 0));
          const waitMs = transientBackoff.apply(retryAttempts);
          if (transientBackoff.shouldNotify()) {
            pushSystemStateMsg(t("pollTransient", { retry: retryAttempts }), "progress");
          }
          scheduleNext(waitMs);
          return;
        }
        const opError = status?.response?.error?.message || "";
        if (status?.response?.done && opError) {
          if (isVeoRetryableLoadError(opError) && submitAttempts < 2) {
            submitAttempts += 1;
            pushSystemStateMsg(zh
              ? "Veo 上游当前负载较高，已自动重新提交一次任务…"
              : "Veo upstream is under high load. Retrying submission once automatically…", "progress");
            const retryStart = await postJson(`${base}/api/veo/start`, startBody);
            const retryOp = retryStart?.operation_name;
            if (retryOp) {
              operationName = retryOp;
              updateVideoTask(taskId, {
                status: "running",
                stage: zh ? "已重提，轮询中" : "Resubmitted, polling",
                operationName,
              });
              scheduleNext(8000);
              return;
            }
          }
          pollStopped = true;
          if (pollBubble.parentNode) pollBubble.remove();
          if (isVeoSafetyRejection(opError)) {
            pushSystemStateMsg(zh
              ? `视频生成被安全策略拦截：${opError.slice(0, 120)}。请简化提示词后重试。`
              : `Video blocked by safety policy: ${opError.slice(0, 120)}. Simplify prompt and retry.`, "blocked");
          } else {
            pushSystemStateMsg(t("genFail"), "blocked");
          }
          finishVideoTask(taskId, false, zh ? "失败" : "Failed");
          releaseSlotOnce();
          return;
        }
        const videoUrl = pickPlayableUrl(status);
        const gcsUri = String(status?.video_uris?.[0] || "").trim();
        if (videoUrl || gcsUri) {
          pollStopped = true;
          if (pollBubble.parentNode) pollBubble.remove();
          renderGeneratedVideoCard(videoUrl, gcsUri, operationName, taskId);
          finishVideoTask(taskId, true, zh ? "完成" : "Done");
          releaseSlotOnce();
          return;
        }
      } catch (_e) {
        pollStopped = true;
        if (pollBubble.parentNode) pollBubble.remove();
        pushSystemStateMsg(t("pollFail"), "blocked");
        finishVideoTask(taskId, false, zh ? "轮询异常" : "Polling error");
        releaseSlotOnce();
        return;
      }
      scheduleNext(elapsedMs < 90000 ? 10000 : 15000);
    };
    function scheduleNext(ms) { if (!pollStopped) setTimeout(doPoll, ms); }
    scheduleNext(2000);
  } catch (e) {
    const detailRaw = String(e?.message || "").trim();
    if (detailRaw === "CANCELLED" || state.taskMap?.[taskId]?.cancelRequested) {
      // 用户主动取消：task 已被 cancelVideoTask 标记，只需释放 slot
      releaseSlotOnce();
      return;
    }
    const detail = /aborted|abort/i.test(detailRaw)
      ? currentLang === "zh" ? "请求超时，请重试" : "request timeout, please retry"
      : detailRaw;
    pushSystemStateMsg(detail ? `${t("genFail")} (${detail})` : t("genFail"), "blocked");
    finishVideoTask(taskId, false, currentLang === "zh" ? "任务失败" : "Failed");
    releaseSlotOnce();
  }
}

async function onUpload(files) {
  const picked = Array.from(files || [])
    .filter((f) => /^image\/(png|jpeg)$/.test(f.type))
    .slice(0, 6);
  if (!picked.length) {
    pushSystemStateMsg(t("invalidType"), "blocked");
    return;
  }
  const images = await Promise.all(
    picked.map(
      (f) =>
        new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve({ name: f.name, dataUrl: String(r.result || "") });
          r.onerror = () => reject(new Error(`read failed: ${f.name}`));
          r.readAsDataURL(f);
        })
    )
  );
  state.images = images;
  state.skipImageConfirmed = false;
  pushImageMsg(images);
  const stopProgress = startInsightProgress();
  let usedFallback = false;
  try {
    const result = await analyzeImageInsight(images);
    const insight = result?.insight || {};
    const hasModelInsight = Boolean(
      insight.product_name || insight.main_business || insight.style_template || (insight.selling_points || []).length
    );
    if (hasModelInsight) {
      applyInsightToState(insight);
    } else {
      usedFallback = true;
      applyInsightToState(buildFallbackInsightFromName(images[0]?.name || ""));
    }
  } catch (_e) {
    usedFallback = true;
    applyInsightToState(buildFallbackInsightFromName(images[0]?.name || ""));
  }
  stopProgress();
  if (usedFallback) {
    pushSystemReplyMsg(withLead(t("parseFallback"), "general"));
  }
  if (SIMPLE_AGENT_MODE) {
    chatInput.value = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image"));
    state.lastPrompt = chatInput.value.trim();
    state.lastStoryboard = buildStoryboardText();
    try {
      await hydrateWorkflowTexts(true);
    } catch (_e) {}
    if (state.lastPrompt) chatInput.value = sanitizePromptForUser(state.lastPrompt);
    syncSimpleControlsFromState();
    pushSystemStateMsg(
      t("parseDone", {
        product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
        business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
        style: state.template || "clean",
      }),
      "done"
    );
    return;
  }
  pushSystemReplyMsg(t("insightRecapTitle"));
  state.lastStoryboard = buildStoryboardText();
  state.lastPrompt = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image"));
  try {
    await hydrateWorkflowTexts(true);
  } catch (_e) {}
  pushSystemReplyMsg(
    [
      `- ${t("insightRecapProduct", { value: state.productName || (currentLang === "zh" ? "未识别商品" : "Unknown product") })}`,
      `- ${t("insightRecapBusiness", { value: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "Fashion & accessories") })}`,
      `- ${t("insightRecapStyle", { value: state.template || "clean" })}`,
    ].join("\n"),
    { speed: 24 }
  );
  showInsightEditCard();
  if (state.stage === "awaitMain") {
    pushSystemStateMsg(currentLang === "zh" ? "已预填完成。可直接在上方编辑后点击“确认这些信息”。" : "Prefill complete. Edit above and click \"Confirm these fields\".", "done");
  } else if (!state.sellingPoints) {
    pushSystemGuideMsg(t("askPoints"));
  }
}

async function onSend() {
  if (SIMPLE_AGENT_MODE) {
    const linkText = String(productUrlInput?.value || "").trim();
    const promptText = String(chatInput.value || "").trim();
    const firstUrlMatch = (linkText || promptText).match(/(?:https?:\/\/|www\.)[^\s]+/i);
    const urlCandidate = firstUrlMatch?.[0] ? String(firstUrlMatch[0]).trim() : "";
    const needPrefillFromUrl = Boolean(
      urlCandidate && (!state.productName || !state.mainBusiness || !state.sellingPoints || !hasEffectiveProductAsset())
    );
    if (needPrefillFromUrl) {
      await parseShopProductByUrl(urlCandidate);
    }
    const finalText = String(chatInput.value || "").trim() || promptText;
    if (!finalText) return;
    // Single dispatch for all video-edit intents
    const handled = await dispatchVideoEditIntent(finalText);
    if (handled) {
      if (chatInput) chatInput.value = "";
      pushMsg("user", finalText, { typewriter: false });
      return;
    }
    if (showPromptConfigConfirmBubble(finalText)) return;
    // If a video is loaded and the text looks like a question/analysis/edit request → Agent Run
    if (
      state.lastVideoUrl &&
      /(帮我|分析|看看|检查|建议|评估|修改|调整|什么|如何|怎么|为什么|能否|是否|有没有|对吗|好吗|给我)/i.test(finalText) &&
      finalText.length < 120
    ) {
      if (chatInput) chatInput.value = "";
      pushMsg("user", finalText, { typewriter: false });
      await callAgentRunAndRender(finalText);
      return;
    }
    await submitSimplePromptGeneration(finalText);
    return;
  }

  const text = (chatInput.value || "").trim();
  if (!text) return;
  pushMsg("user", text, { typewriter: false });
  chatInput.value = "";

  if (state.stage === "awaitMain") {
    const isConfirm =
      /^(确认|好|ok|okay|yes|y|confirm)$/i.test(text) && Boolean(state.mainBusiness);
    if (!isConfirm) {
      state.mainBusiness = text;
      applyTextInsightIfPossible(text);
    }
    state.stage = "awaitRegion";
    askRegion();
    return;
  }

  if (state.stage === "awaitRegion") {
    state.salesRegion = text;
    pushSystemReplyMsg(withLead(t("regionAck", { value: text }), "region"));
    askTarget();
    return;
  }
  if (state.stage === "awaitTarget") {
    state.targetUser = text;
    pushSystemReplyMsg(withLead(t("targetAck", { value: text }), "target"));
    askBrand();
    return;
  }
  if (state.stage === "awaitBrand") {
    state.brandInfo = text;
    pushSystemReplyMsg(withLead(t("brandAck", { value: text }), "brand"));
    askForPointsOrSummary();
    return;
  }

  if (!state.images.length && !state.skipImageConfirmed) {
    if (/^(跳过上传|跳过|skip upload|skip)$/i.test(text)) {
      state.skipImageConfirmed = true;
      pushSystemStateMsg(t("skipUploadAck"), "done");
      showContinueAfterSkipStep();
    } else {
      showUploadOptionalStep();
    }
    return;
  }
  const readyForGenerate = Boolean(state.salesRegion && state.targetUser && state.sellingPoints);
  if (readyForGenerate) {
    const isGenerateIntent = /^(生成|生成视频|开始生成|立即生成|go|generate|start)$/i.test(text);
    if (isGenerateIntent) {
      generateVideo();
      return;
    }
    if (!state.summaryShown) {
      showSummaryCard();
      return;
    }
    pushSystemStateMsg(t("gotMore"), "done");
    showQuickGenerateButton();
    return;
  }
  if (!state.sellingPoints) {
    state.sellingPoints = text;
    if (!state.targetUser) {
      state.stage = "awaitTarget";
      askTarget();
      return;
    }
  } else if (!state.targetUser) {
    state.targetUser = text;
  } else if (!state.salesRegion) {
    state.salesRegion = text;
  } else {
    pushSystemStateMsg(t("gotMore"), "done");
    showQuickGenerateButton();
    return;
  }

  if (state.salesRegion && state.targetUser && state.sellingPoints) {
    if (!state.summaryShown) showSummaryCard();
    else {
      pushSystemStateMsg(t("gotMore"), "done");
      showQuickGenerateButton();
    }
  } else if (!state.salesRegion) {
    state.stage = "awaitRegion";
    askRegion();
  } else if (!state.targetUser) {
    state.stage = "awaitTarget";
    askTarget();
  } else if (!state.sellingPoints) {
    pushSystemGuideMsg(t("askPoints"));
  }
}

async function enhancePromptByAgent() {
  const raw = (chatInput.value || "").trim();
  if (!raw) return;
  if (state.enhancing) return;
  state.enhancing = true;
  if (enhancePromptBtn) enhancePromptBtn.disabled = true;
  syncStateFromSimpleControls();
  if (!state.lastStoryboard) state.lastStoryboard = buildStoryboardText();
  let templateText = "";
  try {
    const tplResp = await callShopliveWorkflow("build_enhance_template", {
      raw_prompt: raw,
      script_text: state.lastStoryboard || "",
    });
    if (tplResp?.ok && tplResp?.ready && tplResp?.template) {
      templateText = String(tplResp.template).trim();
    }
  } catch (_e) {}

  const reviewHint = [
    Array.isArray(state.reviewPositivePoints) && state.reviewPositivePoints.length
      ? `Positive reviews to amplify: ${state.reviewPositivePoints.slice(0, 4).join("; ")}.`
      : "",
    Array.isArray(state.reviewNegativePoints) && state.reviewNegativePoints.length
      ? `Negative reviews to avoid: ${state.reviewNegativePoints.slice(0, 3).join("; ")}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const base = getApiBase();
  try {
    pushSystemStateMsg(t("enhanceWorking"), "progress");
    const fallbackTemplate =
      currentLang === "zh"
        ? [
            "你是一位电商视频提示词优化专家。",
            "请根据用户输入，按以下框架优化为可直接用于生成的一条提示词：",
            "4.1产品口播、4.2UGC评测、4.3痛点与解决、4.4产品演示、4.5前后对比、4.6故事讲述。",
            "必须选择1个主框架+1个辅助框架，不要全部堆叠。",
            "最终语义必须覆盖：Style、Environment、Tone & Pacing、Camera、Lighting、Actions/Scenes、Background Sound、Transition/Editing、CTA。",
            "卖点只聚焦1-2个；单段时长遵守4/6/8秒，若目标总时长是16/24秒请按8秒链式延展，镜头可执行可拍可剪。",
            "必须包含合规后缀：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。",
            "只输出最终提示词，不要解释。",
          ].join("\n")
        : [
            "You are an ecommerce video prompt optimizer.",
            "Rewrite the input as a final, production-ready single prompt using frameworks 4.1~4.6.",
            "Select one primary framework + one supporting framework only.",
            "The final prompt must cover: Style, Environment, Tone & Pacing, Camera, Lighting, Actions/Scenes, Background Sound, Transition/Editing, CTA.",
            "Focus on only 1-2 selling points; keep per-segment duration in 4/6/8s, and for 16/24s use chained 8s extension.",
            "Must append compliance suffix: clean highlight edges, controlled reflections, clear textures, sharp structure edges, no distorted limbs/structures, no third-party logos/watermarks.",
            "Output only the final prompt text without explanations.",
          ].join("\n");
    // System message: enhancement instructions (with product constraints)
    // User message: the raw prompt the user typed — kept separate so LLM
    // actually focuses on rewriting *that* specific text.
    const systemContent = [
      templateText || fallbackTemplate,
      `Aspect ratio: ${state.aspectRatio || "16:9"}. Duration: ${state.duration || "8"} seconds.`,
      `Product: ${state.productName || "unknown"}. Business: ${state.mainBusiness || "ecommerce"}. Template: ${state.template || "clean"}.`,
      reviewHint,
      "Final output constraint: only one final video prompt text, no markdown, no bullet list, no explanation.",
    ].filter(Boolean).join("\n");
    const enhanceMessages = [
      { role: "system", content: systemContent },
      { role: "user", content: raw },
    ];
    let optimized = "";
    try {
      let streamed = "";
      let donePayload = null;
      await postSse(
        `${base}/api/agent/chat`,
        {
          model: "bedrock-claude-4-5-haiku",
          messages: enhanceMessages,
          stream: true,
          temperature: 0.4,
          max_tokens: 640,
        },
        (eventName, payload) => {
          if (eventName === "delta") {
            const delta = String(payload?.delta || "");
            if (!delta) return;
            streamed += delta;
            chatInput.value = sanitizePromptForUser(streamed);
            state.lastPrompt = chatInput.value.trim();
            return;
          }
          if (eventName === "done") {
            donePayload = payload || {};
            return;
          }
          if (eventName === "error") {
            throw new Error(String(payload?.error || "stream error"));
          }
        },
        30000
      );
      optimized = String(donePayload?.content || streamed || "").trim();
    } catch (_firstErr) {
      try {
        const retryResp = await postJson(
          `${base}/api/agent/chat`,
          { model: "bedrock-claude-4-5-haiku", messages: enhanceMessages },
          20000
        );
        optimized = String(retryResp?.content || "").trim();
      } catch (_secondErr) {
        // Both LLM attempts failed — append framework draft to user's raw input
        // so at least the user's text is preserved.
        optimized = sanitizePromptForUser(raw + ". " + buildAutoPromptDraftFromParsed("url"));
      }
    }
    if (!optimized) {
      optimized = sanitizePromptForUser(raw + ". " + buildAutoPromptDraftFromParsed("url"));
    }
    const cleaned = sanitizePromptForUser(optimized);
    chatInput.value = cleaned;
    state.lastPrompt = cleaned;
    pushSystemStateMsg(t("enhanceDone"), "done");
  } catch (e) {
    const detailRaw = String(e?.message || "").trim();
    const detail = /aborted|abort/i.test(detailRaw)
      ? currentLang === "zh"
        ? "请求超时，请重试"
        : "request timeout, please retry"
      : detailRaw;
    const box = pushSystemStateMsg(detail ? `${t("enhanceFail")} (${detail})` : t("enhanceFail"), "blocked");
    renderOptions(box, [
      {
        title: t("enhanceRetry"),
        desc: t("enhanceRetryDesc"),
        onClick: () => {
          pushMsg("user", t("enhanceRetryAck"), { typewriter: false });
          enhancePromptByAgent();
        },
      },
    ]);
  } finally {
    state.enhancing = false;
    if (enhancePromptBtn) enhancePromptBtn.disabled = false;
  }
}

async function parseShopProductByUrl(inputUrl = "") {
  const normalizeProductUrl = (raw = "") => {
    const cleaned = String(raw || "")
      .replace(/[<>"'`]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "";
    const firstUrlMatch = cleaned.match(/https?:\/\/[^\s]+/i);
    const picked = firstUrlMatch?.[0] ? String(firstUrlMatch[0]).trim() : cleaned;
    if (/^www\./i.test(picked)) return `https://${picked}`;
    return picked;
  };
  const inferProductNameFromUrl = (rawUrl = "") => {
    const text = String(rawUrl || "").trim();
    if (!text) return "";
    try {
      const u = new URL(text);
      const path = decodeURIComponent(u.pathname || "");
      const seg = String(path.split("/").filter(Boolean).pop() || "")
        .replace(/\.(html|htm)$/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/\b(?:dp|product|products|item)\b/gi, " ")
        .replace(/\bB0[A-Z0-9]{8,}\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!seg) return "";
      return seg.slice(0, 48);
    } catch (_e) {
      return "";
    }
  };
  const isLikelyUrlOnlyText = (raw = "") => {
    const txt = String(raw || "").trim();
    if (!txt) return false;
    const normalized = txt.replace(/[，；;,\n\r\t]+/g, " ").trim();
    if (!normalized) return false;
    const parts = normalized.split(/\s+/).filter(Boolean);
    if (!parts.length || parts.length > 4) return false;
    const urlLike = parts.filter((p) => /^(https?:\/\/|www\.)/i.test(p));
    return urlLike.length === parts.length;
  };

  const url = normalizeProductUrl(inputUrl || productUrlInput?.value || "");
  if (!url) return;
  if (productUrlInput) productUrlInput.value = url;
  const base = getApiBase();
  const stopParseProgress = startLinkParseProgress();
  try {
    const data = await postJson(
      `${base}/api/agent/shop-product-insight`,
      {
        product_url: url,
        language: currentLang,
      },
      45000
    );
    stopParseProgress();
    let insight = data?.insight || {};
    const parsedImageUrls = Array.isArray(insight.image_urls)
      ? insight.image_urls.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 10)
      : [];
    const imageItems = Array.isArray(insight.image_items)
      ? insight.image_items
          .map((x, idx) => {
            const b64 = String(x?.base64 || "").trim();
            const mime = String(x?.mime_type || "image/jpeg").trim();
            if (!b64 || !/^image\/(png|jpeg)$/i.test(mime)) return null;
            return {
              name: `product-ref-${idx + 1}.${mime.includes("png") ? "png" : "jpg"}`,
              dataUrl: `data:${mime};base64,${b64}`,
            };
          })
          .filter(Boolean)
      : [];

    if (imageItems.length) {
      try {
        const visualResp = await analyzeImageInsight(imageItems);
        insight = mergeInsightPayloads(insight, visualResp?.insight || {});
      } catch (_e) {}
    }

    const parsedProductName = String(insight.product_name || "").trim();
    const parsedSellingPoints = Array.isArray(insight.selling_points)
      ? insight.selling_points.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6)
      : [];

    if (!parsedProductName && !parsedSellingPoints.length && !parsedImageUrls.length && !imageItems.length) {
      const urlFallbackName = inferProductNameFromUrl(url);
      if (urlFallbackName) {
        state.productName = state.productName || urlFallbackName;
        state.mainBusiness = state.mainBusiness || guessBusinessByName(urlFallbackName);
        state.template = state.template || guessTemplateByName(urlFallbackName);
        const draft = sanitizePromptForUser(buildAutoPromptDraftFromParsed("url"));
        const currentText = String(chatInput.value || "").trim();
        if (!currentText || isLikelyUrlOnlyText(currentText)) {
          chatInput.value = draft;
          state.lastPrompt = draft;
        }
      }
      pushSystemGuideMsg(t("parseLinkWeak"));
      showUploadScreenshotGuide();
      showUploadRefQuickAction();
      return;
    }

    if (insight.product_name) state.productName = String(insight.product_name).trim();
    if (insight.main_business) state.mainBusiness = String(insight.main_business).trim();
    if (insight.style_template) state.template = String(insight.style_template).trim();
    if (Array.isArray(insight.selling_points) && insight.selling_points.length) {
      state.sellingPoints = insight.selling_points.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6).join("，");
    }
    state.productAnchors = mergeProductAnchors(state.productAnchors, insight.product_anchors || {});
    state.productImageUrls = parsedImageUrls;
    state.reviewPositivePoints = Array.isArray(insight.review_positive_points)
      ? insight.review_positive_points.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6)
      : [];
    state.reviewNegativePoints = Array.isArray(insight.review_negative_points)
      ? insight.review_negative_points.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6)
      : [];
    if (imageItems.length) {
      state.images = imageItems.slice(0, 6);
      state.skipImageConfirmed = false;
      pushImageMsg(state.images);
    } else if (!state.images.length) {
      pushSystemGuideMsg(t("parseLinkWeakInfo"));
      showUploadScreenshotGuide();
      showUploadRefQuickAction();
    }
    state.workflowHydrated = false;
    updateGenerationGateUI();
    const fetchConfidence = String(insight.fetch_confidence || data?.confidence || "").trim().toLowerCase();
    if (!state.productName) {
      const urlFallbackName = inferProductNameFromUrl(url);
      if (urlFallbackName) state.productName = urlFallbackName;
    }
    if (!state.mainBusiness) state.mainBusiness = guessBusinessByName(state.productName || "");
    if (!state.template) state.template = guessTemplateByName(state.productName || "");
    const currentText = String(chatInput.value || "").trim();
    const shouldOverwriteDraft = !currentText || isLikelyUrlOnlyText(currentText) || currentText === url;
    if (shouldOverwriteDraft) {
      chatInput.value = sanitizePromptForUser(buildAutoPromptDraftFromParsed("url"));
      state.lastPrompt = String(chatInput.value || "").trim();
    }
    const refillOk = Boolean(state.productName && state.mainBusiness && state.template);
    if (!refillOk) {
      pushSystemStateMsg(
        currentLang === "zh"
          ? "解析已完成，但关键信息回填不完整。请补充商品名称后重试解析，或上传商品图辅助识别。"
          : "Parsing finished, but key fields are not fully backfilled. Please add product name and retry, or upload product images.",
        "blocked"
      );
    }
    if (fetchConfidence === "low") {
      pushSystemStateMsg(
        currentLang === "zh"
          ? "链接解析结果可信度较低，建议补充商品截图或手动补充卖点。"
          : "Parsed result confidence is low. Add product screenshots or fill selling points manually.",
        "blocked"
      );
    }
    pushSystemStateMsg(t("parseLinkDone"), "done");
    pushSystemStateMsg(
      t("parseDone", {
        product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
        business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
        style: state.template || "clean",
      }),
      "done"
    );
  } catch (_e) {
    stopParseProgress();
    pushSystemStateMsg(t("parseLinkFail"), "blocked");
  }
}

function consumeLandingParams() {
  const from = (queryParams.get("from") || "").trim();
  const productUrl = (queryParams.get("product_url") || "").trim();
  const aspect = (queryParams.get("aspect_ratio") || "").trim();
  const duration = (queryParams.get("duration") || "").trim();
  const draft = (queryParams.get("draft") || "").trim();

  if (["landing-prompt", "landing-product-link", "landing-upload", "landing-ref"].includes(from)) {
    // 只有没有携带具体配置参数（aspect/duration/draft）时才进入大居中入口模式；
    // 带了首页设置的跳转直接用正常对话布局，避免 entry-focus 把 chatList 隐藏。
    const hasSettings = Boolean(aspect || duration || draft || productUrl);
    if (!hasSettings) {
      state.entryFocusMode = true;
    }
  }

  if (aspect && ["16:9", "9:16", "1:1"].includes(aspect)) {
    state.aspectRatio = aspect;
  }
  if (duration && ["4", "6", "8", "10", "12", "15", "16", "18", "24"].includes(duration)) {
    state.duration = duration;
  }
  if (draft && !chatInput.value.trim()) {
    chatInput.value = draft;
  }
  syncSimpleControlsFromState();
  applyWorkspaceMode();

  if (from && (aspect || duration || draft)) {
    const durLabel = state.duration ? `${state.duration}s` : "";
    const ratioLabel = state.aspectRatio || "";
    const parts = [durLabel, ratioLabel].filter(Boolean);
    state._landingHint = parts.length
      ? (currentLang === "zh"
          ? `已应用首页设置：${parts.join(" · ")}${draft ? "，提示词已预填。" : "。"}`
          : `Landing settings applied: ${parts.join(" · ")}${draft ? ". Prompt pre-filled." : "."}`)
      : "";
  }

  const shouldEnhance = queryParams.get("enhance") === "1";
  if (shouldEnhance && draft) {
    setTimeout(() => enhancePromptByAgent(), 800);
  }

  if (from === "landing-upload") {
    setTimeout(() => imageInput?.click(), 280);
  }
  if (from === "landing-ref") {
    try {
      const dataUrl = String(sessionStorage.getItem("shoplive.landingRefImage") || "").trim();
      if (dataUrl && !state.images.length) {
        state.images = [{ dataUrl, name: "landing-reference.png", source: "landing-ref" }];
        pushImageMsg(state.images);
        setTimeout(async () => {
          const stopProgress = startInsightProgress();
          let usedFallback = false;
          try {
            const result = await analyzeImageInsight(state.images);
            const insight = result?.insight || {};
            const hasInsight = Boolean(insight.product_name || insight.main_business || (insight.selling_points || []).length);
            if (hasInsight) { applyInsightToState(insight); } else { usedFallback = true; applyInsightToState(buildFallbackInsightFromName("landing-reference")); }
          } catch (_) { usedFallback = true; applyInsightToState(buildFallbackInsightFromName("landing-reference")); }
          stopProgress();
          chatInput.value = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image"));
          state.lastPrompt = chatInput.value.trim();
          state.lastStoryboard = buildStoryboardText();
          try { await hydrateWorkflowTexts(true); } catch (_) {}
          if (state.lastPrompt) chatInput.value = sanitizePromptForUser(state.lastPrompt);
          syncSimpleControlsFromState();
          pushSystemStateMsg(t("parseDone", {
            product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
            business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
            style: state.template || "clean",
          }), "done");
        }, 600);
      }
    } catch (_e) {}
  }
  if (from === "landing-ai-image") {
    try {
      const primaryUrl = String(sessionStorage.getItem("shoplive.landingRefImage") || "").trim();
      let allUrls = [];
      try { allUrls = JSON.parse(sessionStorage.getItem("shoplive.landingAiImages") || "[]"); } catch (_e) {}
      if (!Array.isArray(allUrls) || !allUrls.length) allUrls = primaryUrl ? [primaryUrl] : [];
      if (allUrls.length && !state.images.length) {
        state.images = allUrls.map((url, i) => ({
          dataUrl: url,
          name: `ai-product-${i + 1}.png`,
          source: "landing-ai-image",
        }));
        pushImageMsg(state.images);
        setTimeout(async () => {
          const stopProgress = startInsightProgress();
          let usedFallback = false;
          try {
            const result = await analyzeImageInsight(state.images);
            const insight = result?.insight || {};
            const hasInsight = Boolean(insight.product_name || insight.main_business || (insight.selling_points || []).length);
            if (hasInsight) { applyInsightToState(insight); } else { usedFallback = true; applyInsightToState(buildFallbackInsightFromName(state.images[0]?.name || "ai-product")); }
          } catch (_) { usedFallback = true; applyInsightToState(buildFallbackInsightFromName(state.images[0]?.name || "ai-product")); }
          stopProgress();
          chatInput.value = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image"));
          state.lastPrompt = chatInput.value.trim();
          state.lastStoryboard = buildStoryboardText();
          try { await hydrateWorkflowTexts(true); } catch (_) {}
          if (state.lastPrompt) chatInput.value = sanitizePromptForUser(state.lastPrompt);
          syncSimpleControlsFromState();
          pushSystemStateMsg(t("parseDone", {
            product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
            business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
            style: state.template || "clean",
          }), "done");
        }, 600);
      }
    } catch (_e) {}
  }
  if (productUrl) {
    composerCompact?.classList.add("show-link-row");
    if (toggleProductUrlBtn) toggleProductUrlBtn.textContent = t("toggleLinkHide");
    setTimeout(() => {
      parseShopProductByUrl(productUrl);
    }, 360);
  }
}

function consumeLandingPrefill() {
  const draft = (queryParams.get("draft") || "").trim();
  if (!draft) return;
  pushMsg("user", draft, { typewriter: false });
  state.mainBusiness = draft;
  applyTextInsightIfPossible(draft);
  state.stage = "awaitRegion";
  askRegion();
  if (window.history && window.history.replaceState) {
    const clean = `${window.location.pathname}${window.location.hash || ""}`;
    window.history.replaceState({}, document.title, clean);
  }
}

function scheduleLandingPrefillAfterWelcome() {
  const draft = (queryParams.get("draft") || "").trim();
  if (!draft) return;
  const welcomeText = t("welcome");
  const baseDelay = Math.max(1400, Math.min(4200, welcomeText.length * 26));
  setTimeout(() => {
    consumeLandingPrefill();
  }, baseDelay);
}

// ── Agent ref-image modal (mirrors landing ref panel) ──────────────────────
(function initAgentRefModal() {
  const modal        = document.getElementById("agentRefModal");
  const closeBtn     = document.getElementById("agentCloseRefPanelBtn");
  const tabUpload    = document.getElementById("agentRefTabUpload");
  const tabAi        = document.getElementById("agentRefTabAi");
  const panelUpload  = document.getElementById("agentRefUploadPanel");
  const panelAi      = document.getElementById("agentRefAiPanel");
  const uploadGrid   = document.getElementById("agentRefUploadGrid");
  const aiGrid       = document.getElementById("agentRefAiResultGrid");
  const uploadBtn2   = document.getElementById("agentRefUploadBtn");
  const mosaicBtn    = document.getElementById("agentRefMosaicBtn");
  const fileInput    = document.getElementById("agentRefFileInput");
  const aiGenBtn     = document.getElementById("agentRefAiGenerateBtn");
  const aiRegion     = document.getElementById("agentAiFieldRegion");
  const aiCategory   = document.getElementById("agentAiFieldCategory");
  const aiStyle      = document.getElementById("agentAiFieldStyle");

  if (!modal) return;

  let _uploadAssets = [];
  let _aiAssets     = [];
  let _progressTimer = null;

  function openModal() {
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }
  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }
  function setTab(tab) {
    const isUp = tab === "upload";
    tabUpload?.classList.toggle("is-active", isUp);
    tabAi?.classList.toggle("is-active", !isUp);
    panelUpload?.classList.toggle("is-active", isUp);
    panelAi?.classList.toggle("is-active", !isUp);
  }

  function renderGrid(container, items, showVideoBtn = false) {
    if (!container) return;
    if (!items.length) {
      const emptyText = currentLang === "zh" ? "资产库中暂无图片" : "No images yet";
      container.innerHTML = `<div class="ref-empty-state"><span class="ref-empty-icon"></span><span class="ref-empty">${emptyText}</span></div>`;
      return;
    }
    container.innerHTML = "";
    items.forEach((src, idx) => {
      const card = document.createElement("div");
      card.className = "ref-card";
      const imgBtn = document.createElement("button");
      imgBtn.type = "button";
      imgBtn.className = "ref-card-img-btn";
      imgBtn.innerHTML = `<img src="${src}" alt="ref-${idx + 1}" />`;
      imgBtn.addEventListener("click", async () => {
        // inject as agent image
        state.images = [{ dataUrl: src, name: `ref-${idx + 1}.png`, source: "agent-ref-modal" }];
        pushImageMsg(state.images);
        closeModal();
        // full insight + prompt-fill pipeline (same as onUpload)
        const stopProgress = startInsightProgress();
        let usedFallback = false;
        try {
          const result = await analyzeImageInsight(state.images);
          const insight = result?.insight || {};
          const hasInsight = Boolean(insight.product_name || insight.main_business || (insight.selling_points || []).length);
          if (hasInsight) { applyInsightToState(insight); } else { usedFallback = true; applyInsightToState(buildFallbackInsightFromName(`ref-${idx + 1}`)); }
        } catch (_) { usedFallback = true; applyInsightToState(buildFallbackInsightFromName(`ref-${idx + 1}`)); }
        stopProgress();
        chatInput.value = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image"));
        state.lastPrompt = chatInput.value.trim();
        state.lastStoryboard = buildStoryboardText();
        try { await hydrateWorkflowTexts(true); } catch (_) {}
        if (state.lastPrompt) chatInput.value = sanitizePromptForUser(state.lastPrompt);
        syncSimpleControlsFromState();
        pushSystemStateMsg(t("parseDone", {
          product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
          business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
          style: state.template || "clean",
        }), "done");
      });
      card.appendChild(imgBtn);
      container.appendChild(card);
    });
  }

  function showProgress(container) {
    if (!container) return;
    if (_progressTimer) clearInterval(_progressTimer);
    let pct = 0;
    const loadingTitle = currentLang === "zh" ? "AI 生图进度" : "AI image generation progress";
    container.innerHTML = `<div class="ai-loading-wrap"><div class="ai-loading-head"><strong class="ai-loading-title">${loadingTitle}</strong><span class="ai-progress-label" id="agentAiPLabel">0%</span></div><div class="ai-progress-bar-wrap"><div class="ai-progress-bar-track"><div class="ai-progress-bar-fill" id="agentAiPFill" style="width:0%"></div></div></div><div class="ai-loading-cards"><div class="ai-skeleton-card"></div></div></div>`;
    const fill  = container.querySelector("#agentAiPFill");
    const label = container.querySelector("#agentAiPLabel");
    _progressTimer = setInterval(() => {
      pct += Math.max(0.4, (90 - pct) * 0.045);
      pct = Math.min(pct, 90);
      if (fill)  fill.style.width    = `${pct.toFixed(1)}%`;
      if (label) label.textContent   = `${Math.round(pct)}%`;
    }, 400);
  }

  function finishProgress(container, ok) {
    if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
    const fill  = container?.querySelector("#agentAiPFill");
    const label = container?.querySelector("#agentAiPLabel");
    if (fill)  { fill.style.width = "100%"; fill.style.background = ok ? "linear-gradient(90deg,#5e85d8,#79a8ff)" : "linear-gradient(90deg,#c0392b,#e74c3c)"; }
    if (label) label.textContent = ok ? "100%" : (currentLang === "zh" ? "失败" : "Failed");
  }

  // Chip → input
  modal.querySelectorAll(".ai-form-chips .ai-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const map = { "agent-region": aiRegion, "agent-category": aiCategory, "agent-style": aiStyle };
      const key = chip.closest(".ai-form-chips")?.dataset.field;
      if (map[key]) { map[key].value = chip.dataset.value || chip.textContent; map[key].focus(); }
      chip.closest(".ai-form-chips")?.querySelectorAll(".ai-chip").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
    });
  });

  // Upload
  function handleFiles(files) {
    const picked = Array.from(files || []).slice(0, 8);
    if (!picked.length) return;
    Promise.all(picked.map((f) => new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(String(r.result || "")); r.onerror = rej; r.readAsDataURL(f);
    }))).then((urls) => {
      _uploadAssets = [..._uploadAssets, ...urls.filter(Boolean)].slice(0, 16);
      setTab("upload");
      renderGrid(uploadGrid, _uploadAssets);
      fileInput.value = "";
    });
  }

  uploadBtn2?.addEventListener("click", () => { setTab("upload"); fileInput?.click(); });
  mosaicBtn?.addEventListener("click",  () => { setTab("upload"); fileInput?.click(); });
  fileInput?.addEventListener("change", (e) => handleFiles(e.target.files));

  // AI generate
  aiGenBtn?.addEventListener("click", async () => {
    const category = (aiCategory?.value || "").trim();
    const region   = (aiRegion?.value   || "").trim();
    const style    = (aiStyle?.value    || "").trim();
    if (!category && !region && !style) { aiCategory?.focus(); aiCategory?.classList.add("ai-form-input--error"); return; }
    [aiRegion, aiCategory, aiStyle].forEach((f) => f?.classList.remove("ai-form-input--error"));
    const oldHtml = aiGenBtn.innerHTML;
    aiGenBtn.disabled = true;
    aiGenBtn.innerHTML = `<span class="ai-gen-submit-icon spin">◌</span><span>AI 生图中...</span>`;
    setTab("ai");
    showProgress(aiGrid);
    try {
      const resp = await fetch(`${window.location.origin}/api/shoplive/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_name: category || region || style,
          main_category: category || "ecommerce product",
          target_audience: "",
          brand_philosophy: style ? `${style} product storytelling` : "Shoplive conversion-oriented product storytelling",
          selling_region: region || "global",
          selling_points: [category, style].filter(Boolean).join(", "),
          template: "clean",
          other_info: [region, category, style].filter(Boolean).join(", "),
          sample_count: 1,
          aspect_ratio: state.aspectRatio || "16:9",
          location: "us-central1",
          language_code: currentLang === "zh" ? "zh-CN" : "en-US",
          currency_code: "CNY",
          exchange_rate: "7.2",
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok || !data?.images?.length) throw new Error(data?.error || `HTTP ${resp.status}`);
      _aiAssets = data.images.map((x) => String(x?.data_url || "")).filter(Boolean);
      finishProgress(aiGrid, true);
      await new Promise((r) => setTimeout(r, 300));
      renderGrid(aiGrid, _aiAssets, true);
    } catch (err) {
      finishProgress(aiGrid, false);
      await new Promise((r) => setTimeout(r, 400));
      aiGrid.innerHTML = `<div class="ref-empty-state"><span class="ref-empty">⚠️ 生成失败: ${String(err?.message || "")}</span></div>`;
    } finally {
      aiGenBtn.disabled = false;
      aiGenBtn.innerHTML = oldHtml;
    }
  });

  // Enter key on fields
  [aiRegion, aiCategory, aiStyle].forEach((f) => f?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); aiGenBtn?.click(); } }));

  // Tab switching
  tabUpload?.addEventListener("click", () => setTab("upload"));
  tabAi?.addEventListener("click",     () => setTab("ai"));

  // Close
  closeBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal.classList.contains("is-open")) closeModal(); });

  // Init grids
  renderGrid(uploadGrid, _uploadAssets);
  renderGrid(aiGrid, _aiAssets);

  // Expose openModal so uploadBtn can call it
  window._agentOpenRefModal = openModal;
})();

uploadBtn.addEventListener("click", () => {
  if (window._agentOpenRefModal) window._agentOpenRefModal();
  else imageInput.click(); // fallback
});
if (toggleProductUrlBtn) {
  toggleProductUrlBtn.addEventListener("click", () => {
    if (!composerCompact) return;
    composerCompact.classList.toggle("show-link-row");
    const opened = composerCompact.classList.contains("show-link-row");
    toggleProductUrlBtn.textContent = opened ? t("toggleLinkHide") : t("toggleLinkShow");
    if (opened) productUrlInput?.focus();
  });
}
imageInput.addEventListener("change", (e) => onUpload(e.target.files));
sendBtn.addEventListener("click", onSend);
if (enhancePromptBtn) enhancePromptBtn.addEventListener("click", enhancePromptByAgent);
if (parseProductUrlBtn) parseProductUrlBtn.addEventListener("click", parseShopProductByUrl);
if (productUrlInput) {
  productUrlInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    parseShopProductByUrl();
  });
}
if (aspectRatioSelect) {
  aspectRatioSelect.addEventListener("change", () => {
    state.aspectRatio = aspectRatioSelect.value || "16:9";
  });
}

// --- First & Last Frame Panel ---
const toggleFrameBtn = document.getElementById("toggleFrameBtn");
const framePanel = document.getElementById("framePanel");
const firstFrameInput = document.getElementById("firstFrameInput");
const lastFrameInput = document.getElementById("lastFrameInput");
const firstFrameDrop = document.getElementById("firstFrameDrop");
const lastFrameDrop = document.getElementById("lastFrameDrop");
const aiGenerateFramesBtn = document.getElementById("aiGenerateFramesBtn");

function renderFrameSlot(dropEl, dataUrl, inputEl, stateKey) {
  if (!dropEl) return;
  if (dataUrl) {
    dropEl.innerHTML = "";
    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = stateKey;
    dropEl.appendChild(img);
    const del = document.createElement("button");
    del.className = "frame-del";
    del.textContent = "x";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      state[stateKey] = null;
      state.frameMode = Boolean(state.firstFrame && state.lastFrame);
      renderFrameSlot(dropEl, null, inputEl, stateKey);
    });
    dropEl.appendChild(del);
  } else {
    const label = stateKey === "firstFrame"
      ? (currentLang === "zh" ? "上传首帧" : "First frame")
      : (currentLang === "zh" ? "上传尾帧" : "Last frame");
    dropEl.innerHTML = `<span>+</span><span>${label}</span>`;
  }
}

function handleFrameUpload(file, stateKey, dropEl, inputEl) {
  if (!file || !/^image\/(png|jpeg)$/i.test(file.type)) return;
  const reader = new FileReader();
  reader.onload = () => {
    state[stateKey] = String(reader.result || "");
    state.frameMode = Boolean(state.firstFrame && state.lastFrame);
    renderFrameSlot(dropEl, state[stateKey], inputEl, stateKey);
  };
  reader.readAsDataURL(file);
}

if (toggleFrameBtn && framePanel) {
  toggleFrameBtn.addEventListener("click", () => {
    const isHidden = framePanel.hidden;
    framePanel.hidden = !isHidden;
    toggleFrameBtn.textContent = isHidden
      ? (currentLang === "zh" ? "收起首尾帧" : "Hide frames")
      : (currentLang === "zh" ? "首尾帧" : "Frames");
  });
}
if (firstFrameDrop && firstFrameInput) {
  firstFrameDrop.addEventListener("click", () => firstFrameInput.click());
  firstFrameInput.addEventListener("change", (e) => {
    handleFrameUpload(e.target.files?.[0], "firstFrame", firstFrameDrop, firstFrameInput);
  });
}
if (lastFrameDrop && lastFrameInput) {
  lastFrameDrop.addEventListener("click", () => lastFrameInput.click());
  lastFrameInput.addEventListener("change", (e) => {
    handleFrameUpload(e.target.files?.[0], "lastFrame", lastFrameDrop, lastFrameInput);
  });
}
if (aiGenerateFramesBtn) {
  aiGenerateFramesBtn.addEventListener("click", async () => {
    const product = state.productName || "ecommerce product";
    const base = getApiBase();
    const zh = currentLang === "zh";
    aiGenerateFramesBtn.disabled = true;
    aiGenerateFramesBtn.textContent = zh ? "生成中…" : "Generating…";
    try {
      const firstPrompt = `Product front view, ${product}, clean studio photography, centered composition, white seamless background, 16:9 aspect ratio, professional product still, sharp focus.`;
      const lastPrompt = `Product in lifestyle context, ${product}, model using/wearing the product, natural setting, warm lighting, 16:9 aspect ratio, cinematic quality.`;
      const [firstResp, lastResp] = await Promise.all([
        postJson(`${base}/api/media/image-generate`, {
          project_id: "gemini-sl-20251120",
          prompt: firstPrompt,
          sample_count: 1,
          aspect_ratio: "16:9",
        }, 60000),
        postJson(`${base}/api/media/image-generate`, {
          project_id: "gemini-sl-20251120",
          prompt: lastPrompt,
          sample_count: 1,
          aspect_ratio: "16:9",
        }, 60000),
      ]);
      const firstImg = firstResp?.images?.[0];
      const lastImg = lastResp?.images?.[0];
      if (firstImg?.base64) {
        state.firstFrame = `data:image/png;base64,${firstImg.base64}`;
        renderFrameSlot(firstFrameDrop, state.firstFrame, firstFrameInput, "firstFrame");
      }
      if (lastImg?.base64) {
        state.lastFrame = `data:image/png;base64,${lastImg.base64}`;
        renderFrameSlot(lastFrameDrop, state.lastFrame, lastFrameInput, "lastFrame");
      }
      state.frameMode = Boolean(state.firstFrame && state.lastFrame);
      pushSystemStateMsg(
        zh
          ? `AI 已生成首尾帧${state.frameMode ? "，可直接用于视频生成。" : "（部分生成失败，请手动上传）。"}`
          : `AI generated frames${state.frameMode ? ". Ready for video generation." : " (partial failure, please upload manually)."}`,
        state.frameMode ? "done" : "blocked"
      );
    } catch (e) {
      pushSystemStateMsg(zh ? `首尾帧生成失败: ${e.message}` : `Frame generation failed: ${e.message}`, "blocked", { error: true });
    } finally {
      aiGenerateFramesBtn.disabled = false;
      aiGenerateFramesBtn.textContent = zh ? "AI 自动生成" : "AI Generate";
    }
  });
}
if (durationSelect) {
  durationSelect.addEventListener("change", () => {
    state.duration = String(durationSelect.value || "8");
    updateDurationHint();
  });
}
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
});
if (langToggleBtn) {
  langToggleBtn.addEventListener("click", () => {
    currentLang = currentLang === "zh" ? "en" : "zh";
    applyLang();
  });
}
if (toggleScriptTab) toggleScriptTab.addEventListener("click", () => toggleEditorPanel("script"));
if (toggleVideoTab) toggleVideoTab.addEventListener("click", () => toggleEditorPanel("video"));
if (taskQueueClearBtn) {
  taskQueueClearBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // 防止冒泡到 head 触发收起
    clearCompletedTasks();
  });
}
if (taskQueueToggleRow) {
  taskQueueToggleRow.addEventListener("click", (e) => {
    // 点"清理已完成"按钮不触发收起
    if (e.target instanceof Element && e.target.closest("#taskQueueClearBtn")) return;
    const isCollapsed = taskQueuePanel?.classList.toggle("is-collapsed");
    if (taskQueueCollapseBtn) {
      taskQueueCollapseBtn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
      taskQueueCollapseBtn.setAttribute("aria-label",
        isCollapsed
          ? (currentLang === "zh" ? "展开任务列表" : "Expand task list")
          : (currentLang === "zh" ? "收起任务列表" : "Collapse task list"));
    }
  });
}
if (taskQueueList) {
  taskQueueList.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest("[data-task-action]") : null;
    if (!btn) return;
    const action = btn.getAttribute("data-task-action");
    const taskId = String(btn.getAttribute("data-task-id") || "");
    if (action === "view")   scrollToTaskResult(taskId);
    if (action === "cancel") cancelVideoTask(taskId);
  });
}
window.addEventListener("resize", () => updateToolbarIndicator());

// If the browser goes fullscreen on a raw <video> inside a .video-edit-surface
// (e.g. user clicks the native video fullscreen button), redirect to the surface
// so the text-mask overlay, color filter and BGM remain visible.
document.addEventListener("fullscreenchange", () => {
  const fsEl = document.fullscreenElement;
  if (!fsEl || fsEl.tagName !== "VIDEO") return;
  const surface = fsEl.closest(".video-edit-surface");
  if (!surface) return;
  document.exitFullscreen().then(() => surface.requestFullscreen()).then(() => applyVideoEditsToPreview()).catch(err => console.debug('[shoplive]', err));
});
document.addEventListener("webkitfullscreenchange", () => {
  const fsEl = document.webkitFullscreenElement;
  if (!fsEl || fsEl.tagName !== "VIDEO") return;
  const surface = fsEl.closest(".video-edit-surface");
  if (!surface) return;
  document.webkitExitFullscreen?.();
  surface.webkitRequestFullscreen?.();
  applyVideoEditsToPreview();
});

// ── Quick-edit command chips bar ─────────────────────────────────────────────
let _editCmdsBar = null;

const _EDIT_CMDS_ZH = [
  { label: "✂️ 裁剪片段", cmd: "只保留第3到10秒" },
  { label: "⚡ 加速1.5x", cmd: "整体加速1.5倍" },
  { label: "🎨 提亮", cmd: "画面提亮一些" },
  { label: "📝 自动字幕", cmd: "自动生成字幕" },
  { label: "🖼️ 换封面", cmd: "换封面" },
  { label: "↩️ 撤销", cmd: "撤销" },
];
const _EDIT_CMDS_EN = [
  { label: "✂️ Trim", cmd: "keep 3s to 10s" },
  { label: "⚡ 1.5x speed", cmd: "speed up 1.5x" },
  { label: "🎨 Brighten", cmd: "brighten the video" },
  { label: "📝 Auto subtitles", cmd: "auto subtitle" },
  { label: "🖼️ Cover", cmd: "replace cover" },
  { label: "↩️ Undo", cmd: "undo" },
];

function _initEditCmdsBar() {
  if (!chatInput) return;
  const bar = document.createElement("div");
  bar.id = "editCmdsBar";
  bar.className = "edit-cmds-bar";
  bar.hidden = true;
  chatInput.parentNode.insertBefore(bar, chatInput.nextSibling);
  _editCmdsBar = bar;
  _renderEditCmdsBar();
}

function _renderEditCmdsBar() {
  if (!_editCmdsBar) return;
  const cmds = currentLang === "zh" ? _EDIT_CMDS_ZH : _EDIT_CMDS_EN;
  _editCmdsBar.innerHTML = cmds.map((c) =>
    `<button class="edit-cmd-chip" data-cmd="${c.cmd}" type="button">${c.label}</button>`
  ).join("");
  _editCmdsBar.querySelectorAll(".edit-cmd-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (chatInput) {
        chatInput.value = btn.dataset.cmd;
        chatInput.focus();
      }
    });
  });
}

function _updateEditCmdsBar() {
  if (!_editCmdsBar) return;
  const show = Boolean(state.lastVideoUrl) && SIMPLE_AGENT_MODE;
  _editCmdsBar.hidden = !show;
  // Re-render when language changes
  _renderEditCmdsBar();
}

applyLang();
syncSimpleControlsFromState();
updateDurationOptions();
updateGenerationGateUI();
applyWorkspaceMode();
// Wire up cross-module callbacks after all functions are defined
initVideoEditCallbacks({
  pushSystemStateMsg,
  pushSystemGuideMsg,
  pushSystemReplyMsg,
  renderVideoEditor,
  applyVideoEditsToPreview,
  scrollToBottom,
});
_loadVideoHistory(); // restore undo stack from localStorage
_initEditCmdsBar();  // quick-edit chips below chat input
consumeLandingParams();
const mergedWelcomeGuide = state._landingHint
  ? `${t("welcome")} ${state._landingHint}`
  : t("welcome");
pushSystemGuideMsg(mergedWelcomeGuide, { typewriter: true });
if (!SIMPLE_AGENT_MODE) scheduleLandingPrefillAfterWelcome();

// ── Scroll-to-bottom FAB setup ──────────────────────────────────────────────
(function initScrollFab() {
  const fab = document.getElementById("scrollBotFab");
  const badge = document.getElementById("scrollBotBadge");
  if (!fab || !chatList) return;

  chatList.addEventListener("scroll", () => {
    const dist = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight;
    _userScrolledUp = dist > 80;
    fab.hidden = !_userScrolledUp;
    if (!_userScrolledUp) {
      _unreadCount = 0;
      if (badge) { badge.hidden = true; badge.textContent = "0"; }
    }
  }, { passive: true });

  fab.addEventListener("click", () => {
    _userScrolledUp = false;
    _unreadCount = 0;
    fab.hidden = true;
    if (badge) { badge.hidden = true; badge.textContent = "0"; }
    chatList.scrollTo({ top: chatList.scrollHeight, behavior: "smooth" });
  });
})();

// 测试钩子 - 仅用于自动化测试
if (typeof window !== 'undefined') {
  window.__agentTestHook = {
    getState: () => state,
    setState: (updates) => Object.assign(state, updates),
    openVideoEditor: () => {
      state.canUseEditors = true;
      state.lastVideoUrl = state.lastVideoUrl || 'data:video/mp4;base64,test';
      state.lastPrompt = state.lastPrompt || '测试提示词';
      state.lastStoryboard = state.lastStoryboard || '测试分镜';
      if (!state.videoEdit) {
        state.videoEdit = {
          speed: 1.0,
          maskStyle: 'elegant',
          maskText: '',
          maskFont: 'sans',
          maskColor: '#ffffff',
          x: 50,
          y: 50,
          width: 80,
          height: 14,
          fontSize: 5,
          bgmMood: 'elegant',
          bgmVolume: 70,
          bgmExtract: false,
          bgmReplaceMode: 'auto',
          localBgmName: '',
          localBgmDataUrl: '',
          activeModule: 'mask',
          timeline: {
            playhead: 0,
            pendingRangeStart: null,
            keyframes: {
              mask: [],
              bgm: [],
              speed: []
            },
            trackStates: {
              mask: { visible: true, locked: false },
              bgm: { visible: true, locked: false },
              speed: { visible: true, locked: false }
            }
          },
          _renderHash: null,
          _timelineKeydownHandler: null
        };
      }
      state.videoEditorOpen = true;
      applyWorkspaceMode();
      renderVideoEditor();
      return true;
    },
    renderVideoEditor,
    applyWorkspaceMode,
    toggleEditorPanel
  };
}
