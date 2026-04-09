import { createTransientBackoffByPreset } from "../../shared/polling.js";
import { currentLang, setCurrentLang, i18n, shortFeedback, feedbackDeck, insightPulseDeck, targetBatches, brandBatches, REGION_ITEMS, t, shuffle, nextLead, withLead, nextInsightPulseLine } from './i18n.js';
import { state, smartOptionCache, MAX_CONCURRENT_VIDEO_JOBS, CHAT_TAIL_LIMIT_WHEN_SPLIT } from './state.js';
import { getApiBase, postJson, postSse, normalizeProductUrlForApi, toAbsoluteVideoUrl } from './utils.js';
import { initVideoEditCallbacks, pushVideoUrlToHistory, _loadVideoHistory, applyRangedSpeedToCurrentVideo, applyColorGradingToCurrentVideo, applyBgmEditToCurrentVideo, pollRenderJob, applyTrimToCurrentVideo, applyMultiTrimToCurrentVideo, applySubtitleStyleToCurrentVideo, applyUndoLastEdit, applyAsrSubtitlesToCurrentVideo, applyImageOverlayToCurrentVideo, applySubtitleToCurrentVideo, applyPlaybackSpeedToCurrentVideo, applyFadeToCurrentVideo } from './video-edit-ops.js';
import { initVideoEditorCallbacks, applyVideoEditsToPreview, renderVideoEditor, clampNum, fmtSec, getVideoDurationSec, getTimelineSnapCandidates, snapTimelineSec, ensureTimelineState, buildTrackSegmentsHtml, getTrackRangesByKeyframes, isTrackActiveAtTime, buildTimelineRowsHtml, revokeLocalObjectUrl, readFileAsDataUrl, setupSurfaceFullscreen, setupMaskDrag } from './video-editor-ui.js';
import { initWorkspaceCallbacks, buildStoryboardText, buildWorkflowInput, hasWorkflowRequiredInput, callShopliveWorkflow, hydrateWorkflowTexts, applyWorkspaceMode, updateWorkspaceTabs, updateWorkspaceToolbarVisibility, updateToolbarIndicator, buildSegmentedStoryboard, buildStoryboardFromPromptSegments, parseStoryboardSegments, renderScriptEditor } from './workspace.js';
import { initAgentRunCallbacks, callAgentRunAndRender } from './agent-run.js';

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
const linkParseStatusEl = document.getElementById("linkParseStatus");
const toggleProductUrlBtn = document.getElementById("toggleProductUrlBtn");
const workspaceEl = document.getElementById("workspace");
const composerCompact = document.querySelector(".composer.composer-compact");
const workspaceToolbar = document.querySelector(".workspace-toolbar");
const scriptEditorPanel = document.getElementById("scriptEditorPanel");
const videoEditorPanel = document.getElementById("videoEditorPanel");

// Pause chat-card videos that scroll out of view; resume when they return.
// Prevents off-screen videos from consuming GPU decode + memory bandwidth.
const _chatVideoObserver = new IntersectionObserver((entries) => {
  entries.forEach(({ target: v, isIntersecting }) => {
    if (!isIntersecting && !v.paused) v.pause();
  });
}, { rootMargin: "120px" }); // 120px buffer: pause slightly before fully off-screen
const toggleScriptTab = document.getElementById("toggleScriptTab");
const toggleVideoTab = document.getElementById("toggleVideoTab");
const queryParams = new URLSearchParams(window.location.search);
const SIMPLE_AGENT_MODE = true;
const LOCKED_ASPECT_RATIO = "16:9";
state.aspectRatio = LOCKED_ASPECT_RATIO;

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
  if (uploadHint) {
    const txt = hasAsset ? t("uploadHintReady") : t("uploadHintLocked");
    uploadHint.textContent = txt;
    uploadHint.hidden = !String(txt || "").trim();
  }
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

// rAF handle for batching rapid updateVideoTask() calls into one renderTaskQueue()
let _taskQueueRafId = null;
function _scheduleRenderTaskQueue() {
  if (_taskQueueRafId) return;
  _taskQueueRafId = requestAnimationFrame(() => {
    _taskQueueRafId = null;
    renderTaskQueue();
  });
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
    taskQueueTitle.innerHTML = `<span>${t("taskQueueTitle", { max: MAX_CONCURRENT_VIDEO_JOBS })}</span><span class="task-state-badge ${summaryTone}">${sanitizeInputValue(summaryText)}</span>`;
  }
  if (taskQueueClearBtn) {
    taskQueueClearBtn.textContent = t("taskClearDone");
    taskQueueClearBtn.disabled = doneCount <= 0;
  }
  const _renderedItems = items.slice(0, 8);
  const _newHtml = _renderedItems.map((item) => {
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

      // 进行中若 stage 已含「总计 / total」类计时，勿再前缀 ·Xs，避免 270s 与「总计252s」两套时钟打架
      const isRunning = item.status === "running";
      const stageHasEmbeddedTimer =
        isRunning
        && safeStage
        && /(?:总计\s*\d+|\d+\s*s\s*total|\(\d+s\))/.test(String(safeStage));
      const timeStr =
        finalSec !== null && !(isRunning && stageHasEmbeddedTimer) ? ` · ${finalSec}s` : "";
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
  // Only update DOM if content actually changed (avoids layout thrash on 1s polling)
  if (taskQueueList.innerHTML !== _newHtml) taskQueueList.innerHTML = _newHtml;
  // Start live refresh when there are running tasks
  if (runningCount > 0) _startTaskQueueRefresh();
}

function createVideoTask(durationLabel = "8s") {
  state.taskSeq = Number(state.taskSeq || 0) + 1;
  const id = `video-task-${Date.now()}-${state.taskSeq}`;
  const eng = state.videoEngine || "veo";
  const sourceLabel = currentLang === "zh"
    ? ({ ltx: "LTX 2.3", jimeng: "即梦 3.0", veo: "Veo 3.1 Fast", grok: "Grok Video" }[eng] || "Veo 3.1 Fast")
    : ({ ltx: "LTX 2.3", jimeng: "Jimeng 3.0", veo: "Veo 3.1 Fast", grok: "Grok Video" }[eng] || "Veo 3.1 Fast");
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
  _scheduleRenderTaskQueue(); // batched via rAF — coalesces burst updates into one render
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
    const recoverDuration = Number(task.resultDurationSec || 0) || null;
    if (recoverUrl) {
      const rebuiltId = renderGeneratedVideoCard(recoverUrl, recoverGcs, recoverOp, taskId, recoverDuration);
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
  if (state.entryFocusMode) {
    state.entryFocusMode = false;
    applyWorkspaceMode();
  }
  const steps = [
    t("parseLinkWorking"),
    t("parseLinkStep1"),
    t("parseLinkStep2"),
    t("parseLinkStep3"),
    t("parseLinkStep4"),
  ];
  const startedAt = Date.now();
  let stepIdx = 0;
  let timer = null;
  let visualTimer = null;
  forceScrollChatToBottom();
  setLinkParseInlineStatus(steps[0], true);
  const bubble = pushSystemStateMsg(steps[0], "progress");
  forceScrollChatToBottom();
  timer = setInterval(() => {
    const sec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    let line = "";
    if (sec < 20) {
      stepIdx = Math.min(stepIdx + 1, steps.length - 1);
      line = steps[stepIdx];
      setSystemStateMsgBodyText(bubble, line);
    } else {
      line = t("parseLinkSlow", { sec });
      setSystemStateMsgBodyText(bubble, line);
    }
    setLinkParseInlineStatus(line, true);
    forceScrollChatToBottom();
  }, 3000);

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (visualTimer) {
      clearInterval(visualTimer);
      visualTimer = null;
    }
    setLinkParseInlineStatus("", false);
    if (bubble && bubble.parentNode) bubble.remove();
  };

  /** 进入「识图」阶段：多句文案轮换，避免长时间只显示同一句。 */
  const startVisualStepRotation = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (visualTimer) {
      clearInterval(visualTimer);
      visualTimer = null;
    }
    const vSteps = [
      t("parseLinkVisual"),
      t("parseLinkVisualStep1"),
      t("parseLinkVisualStep2"),
      t("parseLinkVisualStep3"),
      t("parseLinkVisualStep4"),
    ];
    const vStarted = Date.now();
    let vIdx = 0;
    const applyLine = (line) => {
      const s = String(line || "").trim();
      if (!s) return;
      setSystemStateMsgBodyText(bubble, s);
      setLinkParseInlineStatus(s, true);
      forceScrollChatToBottom();
    };
    applyLine(vSteps[0]);
    visualTimer = setInterval(() => {
      const sec = Math.max(1, Math.floor((Date.now() - vStarted) / 1000));
      if (sec >= 40) {
        applyLine(t("parseLinkVisualSlow", { sec }));
        return;
      }
      vIdx = (vIdx + 1) % vSteps.length;
      applyLine(vSteps[vIdx]);
    }, 2800);
  };

  return { stop, startVisualStepRotation };
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
  const vel = document.getElementById("videoEngineLabel");
  if (vel) vel.textContent = t("videoEngineLabel");
  if (parseProductUrlBtn) parseProductUrlBtn.textContent = t("parseLinkBtn");
  if (productUrlInput) productUrlInput.placeholder = t("parseLinkPh");
  const ratioLabelEl = document.querySelector('label[for="aspectRatioSelect"] span');
  if (ratioLabelEl) ratioLabelEl.textContent = t("ratioLabel");
  const durationLabel = document.querySelector('label[for="durationSelect"] span');
  if (durationLabel) durationLabel.textContent = t("durationLabel");
  if (langToggleBtn) langToggleBtn.textContent = currentLang === "zh" ? "EN" : "中文";
  if (taskQueueClearBtn) taskQueueClearBtn.textContent = t("taskClearDone");
  const back = document.querySelector(".back-link");
  if (back) back.textContent = t("back");
  if (toggleScriptTab) {
    const scriptLabel = t("tabScript") || (currentLang === "zh" ? "脚本" : "Script");
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
  syncVideoEngineChips();
  updateGenerationGateUI();
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

function getDurationProviderKey() {
  const e = state.videoEngine || "veo";
  if (e === "grok") return "tabcode";
  if (e === "jimeng") return "jimeng";
  if (e === "ltx") return "ltx";
  return "veo";
}

// Duration option definitions per provider key (see getDurationProviderKey)
const DURATION_OPTIONS = {
  tabcode: [
    { value: "6",  labelZh: "6秒（单次）",        labelEn: "6s (single)" },
    { value: "12", labelZh: "12秒",               labelEn: "12s" },
    { value: "18", labelZh: "18秒",               labelEn: "18s", defaultSel: true },
  ],
  veo: [
    { value: "8",  labelZh: "8秒",          labelEn: "8s" },
    { value: "16", labelZh: "16秒", labelEn: "16s", defaultSel: true },
  ],
  jimeng: [
    { value: "5", labelZh: "5秒", labelEn: "5s" },
    { value: "10", labelZh: "10秒", labelEn: "10s", defaultSel: true },
  ],
  ltx: [6, 8, 10, 12, 14, 16, 18, 20].map((v) => ({
    value: String(v),
    labelZh: `${v}秒`,
    labelEn: `${v}s`,
    defaultSel: v === 10,
  })),
};

function syncVideoEngineChips() {
  const eng = state.videoEngine || "veo";
  document.querySelectorAll("[data-video-engine]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-video-engine") === eng);
  });
}

function updateDurationOptions() {
  if (!durationSelect) return;
  const provider = getDurationProviderKey();
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
  const provider = getDurationProviderKey();
  const dur = Number(state.duration) || 8;
  const zh  = currentLang === "zh";

  durationHint.className = "duration-hint";

  if (provider === "tabcode") {
    const hint = zh
      ? `ℹ️ 当前将生成约 ${dur}s 视频。`
      : `ℹ️ Current target duration is about ${dur}s.`;
    durationHint.textContent = hint;
    durationHint.classList.add("hint-warning");
  } else {
    const hint = zh ? `✅ 目标时长 ${dur}s。` : `✅ Target duration ${dur}s.`;
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
  const durStr = `${dur}-second continuous ecommerce product video`;
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
  // Explicit aspect ratio instruction at both the start and end of the prompt.
  // Text-only hints are often ignored by video models; flanking the prompt forces compliance.
  const ratioLabel = ratio === "9:16"
    ? "vertical 9:16 portrait, mobile-first TikTok/Reels format"
    : ratio === "1:1"
    ? "square 1:1 format"
    : "horizontal 16:9 landscape format";
  return (
    `[ASPECT RATIO: ${ratio}] [FORMAT: ${ratioLabel}] `
    + `Create a ${durStr}. `
    + `${lockLine} `
    + `${core} `
    + `[OUTPUT MUST BE ${ratio} ASPECT RATIO]`
  ).replace(/\s{2,}/g, " ").trim();
}

async function _runOneGrokGeneration(base, prompt, model, taskId, labelZh, labelEn, aspectRatio) {
  const zh = currentLang === "zh";
  let videoUrl = "";
  let posterUrl = "";
  await postSse(
    `${base}/api/tabcode/video/generate`,
    { prompt, model, aspect_ratio: aspectRatio || state.aspectRatio || "16:9" },
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
  const body = { project_id: "qy-shoplazza-02" };
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
    + `  ✓ Timestamp beats (e.g. [00:02-00:04]) must evolve GRADUALLY — keep constant exposure/white balance at boundaries; NO flash, brightness spike, or strobing\n`
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
    : (zh ? "⏳ Grok Video：正在准备生成…" : "⏳ Grok Video: Preparing generation…");
  const pollBubble = pushSystemStateMsg(startLabel, "progress");
  updateVideoTask(taskId, { status: "running", stage: zh ? "Grok 生成中" : "Grok generating" });

  try {
    const core = prompt.replace(/\d+[\s-]*second[s]?\s*continuous[^.]*\./i, "").trim();

    // For multi-clip: use LLM to generate truly distinct per-segment prompts
    let segmentPrompts;
    if (clips > 1) {
      if (pollBubble) setSystemStateMsgBodyText(pollBubble, zh
        ? "⏳ Grok Video：正在优化生成计划…"
        : "⏳ Grok Video: Optimizing generation plan…");
      segmentPrompts = await _splitPromptForGrok(base, core, clips);
    } else {
      segmentPrompts = [core];
    }
    state.lastStoryboard = buildStoryboardFromPromptSegments(segmentPrompts, 6) || state.lastStoryboard;

    const results = [];
    for (let i = 0; i < clips; i++) {
      if (state.taskMap?.[taskId]?.cancelRequested) throw new Error("CANCELLED");
      const n = i + 1;
      const labelZh = clips > 1 ? `Grok 任务 ${n}/${clips}` : "Grok 生成中";
      const labelEn = clips > 1 ? `Grok task ${n}/${clips}` : "Grok generating";
      setSystemStateMsgBodyText(pollBubble, clips > 1
        ? (zh ? `⏳ Grok Video 生成中（${n}/${clips}，0%）…` : `⏳ Grok Video generating (${n}/${clips}, 0%)…`)
        : (zh ? `⏳ Grok Video 生成中（0%）…` : `⏳ Grok Video generating (0%)…`));
      updateVideoTask(taskId, { status: "running", stage: zh ? `${labelZh} 0%` : `${labelEn} 0%` });
      // Use the LLM-split segment prompt, wrapped with Grok-friendly prefix/suffix
      const clipPrompt = buildGrokVideoPrompt(segmentPrompts[i] || core, 6);
      const res = await _runOneGrokGeneration(base, clipPrompt, model, taskId, labelZh, labelEn, state.aspectRatio);
      results.push(res.videoUrl);
    }

    // Chain concat if multiple clips — show explicit error if any step fails
    let finalUrl = results[0];
    let concatFailed = false;
    for (let i = 1; i < results.length; i++) {
      setSystemStateMsgBodyText(pollBubble, zh
        ? "⏳ 视频处理中…"
        : "⏳ Processing video…");
      updateVideoTask(taskId, { status: "running", stage: zh ? "处理中" : "Processing" });
      const merged = await _grokConcat(base, finalUrl, results[i]);
      if (merged.ok && merged.url) {
        finalUrl = merged.url;
      } else {
        concatFailed = true;
        pushSystemStateMsg(zh
          ? `⚠️ 视频处理失败（${merged.error}），已保留当前可用结果。`
          : `⚠️ Video processing failed (${merged.error}), keeping current available result.`, "blocked");
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
        ? `Grok Video 生成完成（约${approxSec}s）。`
        : `Grok Video complete (~${approxSec}s).`, "done");
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

/** 解析链接等需要用户立即看到的状态：忽略「已上滚」以免气泡在视口外。 */
function forceScrollChatToBottom() {
  _userScrolledUp = false;
  _unreadCount = 0;
  const badge = document.getElementById("scrollBotBadge");
  const fab = document.getElementById("scrollBotFab");
  if (badge) {
    badge.hidden = true;
    badge.textContent = "0";
  }
  if (fab) fab.hidden = true;
  if (chatList) chatList.scrollTop = chatList.scrollHeight;
}

function setLinkParseInlineStatus(text = "", visible = false) {
  if (!linkParseStatusEl) return;
  if (!visible || !String(text).trim()) {
    linkParseStatusEl.hidden = true;
    linkParseStatusEl.textContent = "";
    return;
  }
  linkParseStatusEl.hidden = false;
  linkParseStatusEl.textContent = text;
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

function getCurrentEditModeLabel() {
  if (state.videoEditorOpen && state.scriptEditorOpen) return t("cardEditModeHybrid");
  if (state.videoEditorOpen) return t("cardEditModeVideo");
  if (state.scriptEditorOpen) return t("cardEditModeScript");
  return "";
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
    }).catch((_e) => {});
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

/** Status cards keep copy in `.msg-body[data-msg-body]`; writing `article.textContent` wipes meta/body and breaks layout (looks “empty”). */
function setSystemStateMsgBodyText(articleEl, text) {
  if (!articleEl) return;
  const body = articleEl.querySelector("[data-msg-body]");
  if (body) body.textContent = String(text ?? "");
  else articleEl.textContent = String(text ?? "");
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

// Resize a dataURL image so its longest side ≤ maxDim.
// Smaller images upload faster and reduce Veo's reference-conditioning overhead.
function resizeDataUrlForVeo(dataUrl, maxDim = 512, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      if (scale >= 1) { resolve(dataUrl); return; }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// Fit a dataURL image into the target aspect ratio with white letterbox padding.
// Veo image-to-video uses the input image's native dimensions and ignores aspect_ratio.
// We pad (not crop) so the full product stays visible — product shots are typically
// centered on light backgrounds so the padding blends naturally.
function cropDataUrlToAspectRatio(dataUrl, aspectRatioStr) {
  const parts = String(aspectRatioStr || "16:9").split(":");
  const [aw, ah] = [Number(parts[0]) || 16, Number(parts[1]) || 9];
  const targetRatio = aw / ah;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const srcRatio = img.naturalWidth / img.naturalHeight;
      if (Math.abs(srcRatio - targetRatio) < 0.02) { resolve(dataUrl); return; }
      // Fit the whole image inside the target frame (scale-to-fit), pad the rest with white.
      const maxLong = 768;
      let canvasW, canvasH;
      if (targetRatio >= 1) {
        canvasW = maxLong; canvasH = Math.round(maxLong / targetRatio);
      } else {
        canvasH = maxLong; canvasW = Math.round(maxLong * targetRatio);
      }
      const scale = Math.min(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
      const drawW = Math.round(img.naturalWidth * scale);
      const drawH = Math.round(img.naturalHeight * scale);
      const dx = Math.round((canvasW - drawW) / 2);
      const dy = Math.round((canvasH - drawH) / 2);
      const canvas = document.createElement("canvas");
      canvas.width = canvasW; canvas.height = canvasH;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvasW, canvasH);
      ctx.drawImage(img, dx, dy, drawW, drawH);
      resolve(canvas.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
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
      setSystemStateMsgBodyText(bubble, nextInsightPulseLine());
      return;
    }
    if (sec >= 8) {
      warned = true;
      setSystemStateMsgBodyText(bubble, t("insightSlow", { sec }));
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
      project_id: "qy-shoplazza-02",
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

  // Prefer explicit total-duration statements first.
  const prioritizedPatterns = [
    /(?:目标总时长|总时长|链路时长|最终时长|成片时长)\s*[:：]?\s*(\d{1,2})\s*(?:s|sec|secs|second|seconds|秒)/i,
    /(?:total|overall|final)\s*(?:video\s*)?duration\s*[:：]?\s*(\d{1,2})\s*(?:s|sec|secs|second|seconds)/i,
    /(?:时长|秒数|duration|video duration)\s*[:：]?\s*(\d{1,2})\s*(?:s|sec|secs|second|seconds|秒)/i,
    /\b(?:create|make|generate)\s+(?:a\s+)?(\d{1,2})\s*-\s*second(?=$|\s|[，。；;,.）)\]])/i,
    /\b(\d{1,2})\s*-\s*second(?=$|\s|[，。；;,.）)\]])/i,
  ];
  for (const re of prioritizedPatterns) {
    const m = text.match(re);
    const n = Number(m?.[1] || 0);
    if (Number.isFinite(n) && n > 0) return n;
  }

  // Fallback: infer from storyboard time ranges (e.g. 0-2s, 2-5s, 5-8s => 8),
  // but only when explicit duration is absent.
  let maxEnd = 0;
  const rangeRe = /(\d{1,2})\s*(?:s|sec|秒)?\s*[-~—]\s*(\d{1,2})\s*(?:s|sec|秒)/gi;
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
  const duration = String(config?.duration || "").trim();
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
    pushSystemStateMsg(t("tooManyJobs", { max: MAX_CONCURRENT_VIDEO_JOBS }), "blocked");
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
  const detectedRatio = "";
  const detectedDurationRaw = extractDurationFromPrompt(text);
  const provider = getDurationProviderKey();
  const recommendedDuration = normalizeDurationForProvider(detectedDurationRaw, provider);
  if (!detectedRatio && !recommendedDuration) return false;

  const lines = [t("detectedConfigTitle")];
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
 * Parse small integers from Arabic or Chinese numerals (for second markers: 五、十五、23).
 */
function parseZhSecondToken(tok) {
  let s = String(tok || "").replace(/\s/g, "").replace(/^第/, "");
  if (!s) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  const d = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (s.length === 1 && d[s] !== undefined) return d[s];
  if (s === "十") return 10;
  const mTeen = /^十([一二三四五六七八九])$/.exec(s);
  if (mTeen) return 10 + d[mTeen[1]];
  const mWholeTen = /^([一二三四五六七八九])十$/.exec(s);
  if (mWholeTen) return (d[mWholeTen[1]] || 0) * 10;
  const mCombo = /^([一二三四五六七八九])十([一二三四五六七八九])$/.exec(s);
  if (mCombo) return (d[mCombo[1]] || 0) * 10 + (d[mCombo[2]] || 0);
  return NaN;
}

/**
 * Trim time range in seconds: supports "3秒到第五秒", "第3到第5秒", "1~3s".
 */
function parseTrimTimeRange(s) {
  const AR = /第?\s*(\d+(?:\.\d+)?)\s*[秒s]?\s*[~\-–到至]\s*第?\s*(\d+(?:\.\d+)?)\s*[秒s]/i;
  let m = AR.exec(s);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return { start: Math.max(0, a), end: b };
  }
  const ZH_END = /第?\s*(\d+(?:\.\d+)?)\s*[秒s]?\s*(?:到|至|~|-|–)\s*第?\s*([一二三四五六七八九十两〇零0-9]{1,5})\s*[秒s]?/i;
  m = ZH_END.exec(s);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseZhSecondToken(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return { start: Math.max(0, a), end: b };
  }
  const ZH_START = /第?\s*([一二三四五六七八九十两〇零]{1,5})\s*[秒s]?\s*(?:到|至|~|-|–)\s*第?\s*(\d+(?:\.\d+)?)\s*[秒s]?/i;
  m = ZH_START.exec(s);
  if (m) {
    const a = parseZhSecondToken(m[1]);
    const b = parseFloat(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return { start: Math.max(0, a), end: b };
  }
  return null;
}

/**
 * 「只保留第3秒」→ 保留第 3 个整秒区间 [2,3]s（与口语「第 N 秒」一条一致）。
 */
function parseKeepSingleSecondPhrase(s) {
  const t = String(s || "").trim();
  const m = /^(?:只)?(?:保留|裁剪|截取)\s*第\s*(\d+(?:\.\d+)?)\s*秒\s*$/i.exec(t);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0.5) return null;
  const i = Math.floor(n);
  if (Math.abs(n - i) > 1e-6) return { start: Math.max(0, n), end: n + 1 };
  if (i < 1) return null;
  return { start: i - 1, end: i };
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

  // ── Early exit guards ──────────────────────────────────────────────────────
  // Edit commands are always short (< 120 chars). Long text is a generation prompt.
  if (str.length > 120) return null;
  // Explicit generation starters
  if (/^(generate|create|make a|制作|生成|帮我生成|帮我制作|请生成|请制作)/i.test(str)) return null;

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
    const SEG_PAT_AR = /第?(\d+(?:\.\d+)?)\s*[秒s]?\s*[~\-–到至]\s*第?(\d+(?:\.\d+)?)\s*[秒s]/gi;
    const segs = [];
    let _m;
    while ((_m = SEG_PAT_AR.exec(str)) !== null) {
      const a = parseFloat(_m[1]), b = parseFloat(_m[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) segs.push({ start: Math.max(0, a), end: b });
    }
    const SEG_PAT_ZH = /第?\s*(\d+(?:\.\d+)?)\s*[秒s]?\s*[~\-–到至]\s*第?\s*([一二三四五六七八九十两〇零]{1,5})\s*[秒s]?/gi;
    while ((_m = SEG_PAT_ZH.exec(str)) !== null) {
      const a = parseFloat(_m[1]);
      const b = parseZhSecondToken(_m[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) segs.push({ start: Math.max(0, a), end: b });
    }
    if (segs.length >= 2) return { type: "multiTrim", segments: segs };
  }

  // ── 0b. trim / keep range (single segment) ───────────────────────────────
  if (/(裁剪|截取|只保留|保留第|保留.*[秒s]|trim|crop|剪切)/i.test(str)) {
    const singleSec = parseKeepSingleSecondPhrase(str);
    if (singleSec) return { type: "trim", start: singleSec.start, end: singleSec.end };
    const range = parseTrimTimeRange(str);
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
    const range = parseTrimTimeRange(str);
    if (speed > 0 && range) {
      return { type: "speedRange", start: range.start, end: range.end, speed };
    }
    // Global speed (no range)
    if (speed > 0) {
      return { type: "speed", speed };
    }
    // Descriptive speed: require video/edit context to avoid false positives like "加速推进项目"
    if (/加速|speed\s*up/i.test(str) && /(视频|video|帧|倍速|播放速度)/i.test(str)) return { type: "speed", speed: 1.5 };
    if (/减速|slow\s*down/i.test(str) && /(视频|video|帧|倍速|播放速度)/i.test(str)) return { type: "speed", speed: 0.75 };
  }

  // ── 2. subtitle / text overlay ─────────────────────────────────────────────
  // Exclude "文字"/"文案" from outer trigger — too common in generation prompts ("文案方向", "文字说明")
  // Exclude "字幕" when it appears in a negative/avoidance context ("避免字幕", "字幕水印")
  const _subtitleInNegCtx = /(避免.*字幕|不要.*字幕|去掉.*字幕|禁止字幕|无字幕|字幕.*水印|水印.*字幕)/i.test(str);
  if (!_subtitleInNegCtx && /(字幕|caption|subtitle|加字|叠字)/i.test(str)) {
    const range = parseTrimTimeRange(str);
    // Single time point: require 第 prefix to avoid matching video-duration specs like "生成一条6秒"
    let start = 0;
    let end = 0;
    if (range) {
      start = range.start;
      end = range.end;
    } else {
      const sp = /第(\d+(?:\.\d+)?)\s*[秒s]/i.exec(str);
      if (sp) { start = parseFloat(sp[1]); end = start + 3; }
    }
    // Extract caption text — only match quoted/colon-delimited text, not bare aspect ratios like "9:16"
    let captionText = "";
    const quotedM = str.match(/[：:"'「『]\s*([^」』"'：:"]{1,80}?)\s*[」』"']|[：：]\s*([^，。！？\n]{1,80}?)(?:\s*$)/);
    if (quotedM) {
      captionText = (quotedM[1] || quotedM[2] || "").trim();
    } else {
      const _stripTimeRange = /第?\s*\d+(?:\.\d+)?\s*[秒s]?\s*[~\-–到至]\s*第?\s*(?:\d+(?:\.\d+)?|[一二三四五六七八九十两〇零]{1,5})\s*[秒s]?/gi;
      captionText = str
        .replace(_stripTimeRange, "")
        .replace(/(?:给|在|为|对|add|insert|put|字幕|caption|subtitle|加字|叠字|第|秒|s\b|[~～：:])+/gi, " ")
        .replace(/\s+/g, " ").trim().slice(0, 60);
    }
    if (captionText && end > start) {
      return { type: "subtitle", start, end, text: captionText };
    }
  }

  // ── 3. color grading ───────────────────────────────────────────────────────
  // 不要用宽泛英文词（cinematic / vivid / color / contrast）作入口：分镜文案里到处都是
  // 「cinematic lighting」「vivid texture」，会按逗号批量拆条后每条都触发调色。
  {
    const color = {};
    if (/(亮一点|提亮|调亮|brighter|lighten|增加亮度)/i.test(str)) color.bright = 18;
    else if (/(暗一点|降暗|调暗|darker|darken|减少亮度)/i.test(str)) color.bright = -18;
    if (/(饱和度|调饱和|更鲜艳|变鲜艳)/i.test(str) || /(?:调|提高|降低)饱和度/i.test(str)) color.sat = 20;
    else if (/(去饱和|淡化|desaturate|faded|pale)/i.test(str)) color.sat = -20;
    if (/(偏黄|偏橙|调.*暖|暖色.*调|warm\s*tone|warm\s*filter)/i.test(str)) color.hue = 15;
    else if (/(偏蓝|调.*冷|冷色.*调|cool\s*tone|cool\s*filter|cooler)/i.test(str)) color.hue = -15;
    if (/(对比度|调.*对比|增.*对比|提高对比|降低对比)/i.test(str)) color.contrast = 20;
    if (/(vintage|胶片.*效果|film.*grain|调.*电影感|电影.*滤镜)/i.test(str)) {
      color.sat = 15;
      color.hue = 8;
      color.contrast = 15;
    }
    if (/(黑白|灰度|grayscale|black.*white)/i.test(str)) color.sat = -100;
    if (/(调色|color\s*grading|colour\s*grading)/i.test(str) && Object.keys(color).length === 0) {
      color.contrast = 12;
      color.sat = 6;
    }
    if (Object.keys(color).length > 0) {
      return { type: "color", ...color };
    }
  }

  // ── 3.5 淡入/淡出 ──────────────────────────────────────────────────────────
  {
    const hasFadeIn  = /(淡入|fade.?in|开头淡入|片头.*淡|gradually.*appear)/i.test(str);
    const hasFadeOut = /(淡出|fade.?out|结尾淡出|片尾.*淡|gradually.*disappear)/i.test(str);
    const hasFadeBoth = /(淡入.*淡出|fade.*in.*out|首尾淡)/i.test(str);
    // Duration: parse "淡入0.5秒" or "fade in 1s" → default 0.5s
    const durMatch = str.match(/(?:fade.?(?:in|out)[^\d]*|淡[入出][^秒\d]*)(\d+(?:\.\d+)?)\s*s?(?:秒)?/i);
    const dur = durMatch ? parseFloat(durMatch[1]) : 0.5;
    if (hasFadeBoth) return { type: "fade", fadeIn: dur, fadeOut: dur };
    if (hasFadeIn)   return { type: "fade", fadeIn: dur,  fadeOut: 0 };
    if (hasFadeOut)  return { type: "fade", fadeIn: 0,    fadeOut: dur };
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
    case "fade":
      await applyFadeToCurrentVideo(intent);
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
  if (!/stable exposure|brightness spike|abrupt.*lighting|first 0-4|0s to 4s/i.test(text)) {
    text +=
      " Stable exposure and white balance for the whole clip; smooth gradual transitions between shots; "
      + "no sudden brightness spikes, flashes, strobing, or harsh lighting jumps at any timestamp. "
      + "First 0-4 seconds: hold luminance steady — no flash, fade-to-white, or exposure pop.";
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
    `[00:00-00:04] Continuous hero build — wide to medium, same lighting and exposure throughout (no flash at 2s).`,
    `[00:04-00:06] Detail and texture; maintain identical color grade and exposure as prior beats.`,
    `[00:06-00:08] Confident closing composition; single coherent lighting setup, no new light sources.`,
    `[Technical] Aspect ratio ${ratio}, duration ${duration}s, smooth camera, realistic texture, constant exposure.`,
  ].join(" ");
}

async function rewritePromptForVeoSingle(base, rawPrompt, taskId = "") {
  const source = String(rawPrompt || "").trim();
  if (!source) return "";
  const anchorHint = buildProductAnchorSummary("en");
  const needsRewrite = hasCjkChars(source);
  if (!needsRewrite) {
    if (!anchorHint) return sanitizePromptForVeo(source) || source;
    // 本地草稿/hydrate 往往已含 Product anchors，避免再拼一段同义约束
    if (/product anchors|preserve these product anchors/i.test(source)) {
      return sanitizePromptForVeo(source) || source;
    }
    return sanitizePromptForVeo(`${source} Preserve these product anchors exactly: ${anchorHint}.`) || source;
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
              + "Timestamp boundaries must be seamless: same lighting and exposure across cuts — no sudden brightening, flash, or exposure pop (especially near 2s).\n"
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
  // 过滤掉 "ref N" 这类图片引用名，回退到通用商品名
  const rawProduct = (state.productName || "").trim();
  const product = rawProduct && !/^ref\s*\d+$/i.test(rawProduct)
    ? rawProduct
    : (currentLang === "zh" ? "该商品" : "this product");
  const business = state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion and accessories");
  const style = state.template || "clean";
  const pointList = normalizePointsList(state.sellingPoints || "");
  const focusPoints = pointList.slice(0, 2);
  const sellingText =
    focusPoints.join(currentLang === "zh" ? "；" : "; ") ||
    (currentLang === "zh" ? "核心卖点与真实质感" : "core selling points and authentic texture");
  // 避免默认占位符直接输出
  const rawTarget = (state.targetUser || "").trim();
  const target = (rawTarget && rawTarget !== "目标人群" && rawTarget !== "target audience")
    ? rawTarget
    : (currentLang === "zh" ? "大众消费者" : "general consumers");
  const rawRegion = (state.salesRegion || "").trim();
  const region = (rawRegion && rawRegion !== "目标地区" && rawRegion !== "target region")
    ? rawRegion
    : (currentLang === "zh" ? "全球市场" : "global market");
  const modelText =
    state.needModel === false
      ? currentLang === "zh" ? "纯商品镜头" : "product-only shots"
      : currentLang === "zh" ? "模特出镜展示" : "model showcase";
  const refHint =
    source === "image"
      ? currentLang === "zh" ? "严格还原商品图外观、颜色与细节。" : "Strictly replicate the uploaded product image appearance and details."
      : currentLang === "zh" ? "严格保持商品特征一致。" : "Keep product characteristics consistent.";
  const anchorSummary = buildProductAnchorSummary(currentLang);
  const compliance = currentLang === "zh"
    ? "高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。"
    : "Clean highlight edges, controlled reflections, clear material textures, sharp structure edges, no distorted limbs/structures, no third-party logos or watermarks.";

  if (currentLang === "zh") {
    const action1 = focusPoints[0] ? `${focusPoints[0]}特写` : "核心卖点特写";
    const action2 = focusPoints[1] ? `展示${focusPoints[1]}` : "使用场景展示";
    return [
      `[Style] ${style}，超高清商业画质，电影级布光，真实可拍可剪。`,
      `[Environment] ${region}${business}消费场景，背景干净，道具克制。`,
      `[Tone & Pacing] ${duration}秒，节奏紧凑，聚焦：${sellingText}。`,
      `[Camera] 稳定推进+局部特写，主体始终清晰。`,
      `[Lighting] 柔光补光强化材质纹理与高光轮廓。`,
      `[Actions / Scenes] 商品全貌引入 → ${action1} → ${action2} → ${modelText} → 购买CTA收口。`,
      `[Background Sound] 轻节奏BGM，契合场景情绪。`,
      `[Transition / Editing] 动作点顺滑衔接，节奏与卖点同步。`,
      `[Call to Action] 推荐动作+购买动机收口。`,
      `约束：${duration}秒，商品${product}，受众${target}，${modelText}。`,
      anchorSummary ? `商品锚点：${anchorSummary}。` : "",
      refHint,
      compliance,
    ].filter(Boolean).join(" ");
  }
  const action1 = focusPoints[0] ? `${focusPoints[0]} close-up` : "key feature close-up";
  const action2 = focusPoints[1] ? `showcase ${focusPoints[1]}` : "usage scene";
  return [
    `[Style] ${style}; ultra-HD commercial quality, cinematic studio lighting.`,
    `[Environment] ${region} ${business} shopping scene, clean minimal background.`,
    `[Tone & Pacing] ${duration}s, tight rhythm focused on: ${sellingText}.`,
    `[Camera] Controlled push-ins and close-ups, subject always sharp.`,
    `[Lighting] Soft fill reinforcing material texture and highlight edges.`,
    `[Actions / Scenes] Product overview → ${action1} → ${action2} → ${modelText} → CTA close.`,
    `[Background Sound] Light rhythmic BGM matching scene mood.`,
    `[Transition / Editing] Smooth action-aligned cuts synced to selling points.`,
    `[Call to Action] Close with recommendation and purchase motivation.`,
    `Constraints: ${duration}s, product ${product}, audience ${target}, ${modelText}.`,
    anchorSummary ? `Product anchors: ${anchorSummary}.` : "",
    refHint,
    compliance,
  ].filter(Boolean).join(" ");
}

function pickPlayableUrl(data) {
  return data?.inline_videos?.[0]?.data_url || data?.signed_video_urls?.[0]?.url || data?.signed_all_urls?.[0]?.url || "";
}


function buildPlayableUrlFromGcs(gcsUri) {
  const uri = String(gcsUri || "").trim();
  if (!uri || !uri.startsWith("gs://")) return "";
  return `${getApiBase()}/api/veo/play?gcs_uri=${encodeURIComponent(uri)}`;
}

/** Parse gs://… from our /api/veo/play?gcs_uri=… proxy URL. */
function extractGcsFromPlayUrl(url) {
  const s = String(url || "");
  if (!s.includes("/api/veo/play")) return "";
  try {
    const u = new URL(s, "http://local.invalid/");
    const g = u.searchParams.get("gcs_uri");
    return g ? String(g).trim() : "";
  } catch (_e) {
    return "";
  }
}

/**
 * Single-segment Veo URLs (poll / 16s fallback) skip server-side concat mitigate;
 * run the same hqdn3d+fade pass and serve /video-edits/… for playback.
 */
async function applyVeoFlickerMitigate(base, gcsHint, playableUrl) {
  const direct = String(playableUrl || "").trim();
  const gcs = String(gcsHint || "").trim();
  if (String(state.videoEngine || "veo") !== "veo") return { videoUrl: direct, gcsUri: gcs };
  if (direct && /\/video-edits\//.test(direct)) return { videoUrl: direct, gcsUri: gcs };

  const fromPlay = extractGcsFromPlayUrl(direct);
  const effectiveGcs = (gcs.startsWith("gs://") ? gcs : "") || fromPlay;
  const body = { project_id: "qy-shoplazza-02" };
  if (effectiveGcs) body.gcs_uri = effectiveGcs;
  else if (direct.startsWith("data:video/")) body.video_data_url = direct;
  else if (/^https?:\/\//i.test(direct)) body.video_http_url = direct;
  else return { videoUrl: direct, gcsUri: gcs };

  try {
    const r = await postJson(`${base}/api/veo/mitigate-output`, body, 420000);
    if (r?.ok && r?.video_url) {
      const rel = String(r.video_url).trim();
      const abs = rel.startsWith("http") ? rel : toAbsoluteVideoUrl(rel);
      return { videoUrl: abs, gcsUri: "" };
    }
  } catch (_e) {
    /* keep original */
  }
  return { videoUrl: direct, gcsUri: gcs };
}

function buildVideoSourceCandidates(videoUrl, gcsUri = "") {
  const direct = String(videoUrl || "").trim();
  const proxy = buildPlayableUrlFromGcs(gcsUri);
  const result = [];
  if (direct) result.push(direct);
  const isExportedConcatOrEdit = /\/video-edits\//.test(direct);
  if (!isExportedConcatOrEdit && proxy && proxy !== direct) result.push(proxy);
  return result;
}

async function refreshPlayableUrlByOperation(operationName) {
  const op = String(operationName || "").trim();
  if (!op) return "";
  try {
    const status = await postJson(
      `${getApiBase()}/api/veo/status`,
      {
        project_id: "qy-shoplazza-02",
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
  // Keep silent intentionally: long-duration internal steps should not be
  // exposed to end users in chat.
  void chainResp;
}

/** Reset timeline/mask/BGM edits so a new result card does not inherit the previous clip's edit state. */
function resetVideoEditStateForNewCard() {
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
    subtitles: [],
    _renderHash: null,
  };
}

function appendExportedVideoCard(url) {
  const u = String(url || "").trim();
  if (!u) return;
  resetVideoEditStateForNewCard();
  renderGeneratedVideoCard(u, "", "", "", null, { titleKey: "videoEditExportCardTitle" });
  updateActiveVideoCardState();
}

function renderGeneratedVideoCard(videoUrl, gcsUri = "", operationName = "", taskId = "", actualDurationSec = null, cardOptions = null) {
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
  let cardVideoUrl = finalPlayableUrl;
  const cardPrompt = state.lastPrompt;
  const cardStoryboard = state.lastStoryboard;
  const actualDuration = Number(actualDurationSec || 0);
  const taskSourceLabel = String(state.taskMap?.[taskId]?.sourceLabel || "").trim();
  const taskRunLabel = String(state.taskMap?.[taskId]?.title || "").trim();
  const card = document.createElement("article");
  card.className = "msg system video-msg";
  const cardId = `task-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  card.dataset.taskCardId = cardId;
  state.activeVideoCardId = cardId;
  const meta = document.createElement("div");
  meta.className = "msg-card-meta msg-card-meta-video";
  meta.innerHTML = `
    <span class="msg-card-label">${t("cardRecentResult")}</span>
    <div class="msg-card-meta-right">
      ${taskRunLabel ? `<span class="msg-card-status card-source-run status-dot-info">${sanitizeInputValue(taskRunLabel)}</span>` : ""}
      ${taskSourceLabel ? `<span class="msg-card-status card-source-route status-dot-info">${sanitizeInputValue(taskSourceLabel)}</span>` : ""}
      <span class="msg-card-status card-binding-script-name status-dot-done">${t("cardScriptNameShort")}</span>
      <span class="msg-card-status card-binding-video-editor status-dot-done" hidden>${t("cardVideoEditorOpen")}</span>
      <span class="msg-card-status card-binding-script-editor status-dot-done" hidden>${t("cardScriptEditorOpen")}</span>
      <span class="msg-card-status card-binding-edit-mode status-dot-progress" hidden></span>
      <span class="msg-card-status card-status-active status-dot-progress" hidden>${t("cardCurrentContext")}</span>
      <span class="msg-card-status card-status-idle status-dot-info">${t("cardSwitchContext")}</span>
    </div>
  `;
  const title = document.createElement("div");
  title.className = "video-msg-title";
  title.textContent = t(cardOptions?.titleKey || "done");

  const surface = document.createElement("div");
  surface.className = "video-edit-surface";
  surface.style.cssText = "display:block;width:100%;position:relative;";

  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  // Let CSS handle sizing (max-width/max-height + width/height:auto) so both 16:9
  // and 9:16 videos respect aspect ratio without distortion.  Only set decorative
  // properties here to avoid overriding the .workspace .chat-list .video-msg video rule.
  video.style.cssText = "display:block;object-fit:contain;border-radius:14px;background:#000;";
  video.src = finalPlayableUrl;
  _chatVideoObserver.observe(video); // pause when scrolled out of view
  let idx = 0;
  let refreshedByOp = false;
  const syncResolvedVideoUrl = (resolvedUrl) => {
    const nextUrl = String(resolvedUrl || "").trim();
    if (!nextUrl) return;
    cardVideoUrl = nextUrl;
    if (state.activeVideoCardId === cardId || state.lastVideoUrl === finalPlayableUrl) {
      state.lastVideoUrl = nextUrl;
    }
    if (taskId && state.taskMap?.[taskId]) {
      updateVideoTask(taskId, { resultVideoUrl: nextUrl });
    }
  };
  video.addEventListener("error", async () => {
    if (idx + 1 < sourceCandidates.length) {
      idx += 1;
      const nextUrl = sourceCandidates[idx];
      syncResolvedVideoUrl(nextUrl);
      video.src = nextUrl;
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(err => console.debug('[shoplive]', err));
      return;
    }
    if (!refreshedByOp) {
      refreshedByOp = true;
      const refreshedUrl = await refreshPlayableUrlByOperation(operationName);
      if (refreshedUrl) {
        syncResolvedVideoUrl(refreshedUrl);
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
  video.addEventListener("loadedmetadata", () => {
    const dur = Number(video.duration || 0);
    const expectedSec = Number(actualDurationSec || 0) > 0
      ? Number(actualDurationSec)
      : Number(state.duration || 8);
    const playSrc = String(video.currentSrc || video.src || "");
    // 裁剪/调色/变速等导出在 /video-edits/：时长与容器元数据常与「生成目标」不一致，勿用初剪目标去比对
    const isPostEditExport = /\/video-edits\//.test(playSrc);
    const is16sTask = /\b16(\.0)?s\b/i.test(String(state.taskMap?.[taskId]?.title || ""))
      || String(state.duration || "") === "16";
    if (is16sTask && !isPostEditExport && Number.isFinite(dur) && dur > 0 && dur < 14.5) {
      pushSystemStateMsg(
        currentLang === "zh"
          ? "⚠️ 当前播放源未达到 16 秒目标，请重试。"
          : "⚠️ Playback is below the 16s target. Please retry.",
        "blocked"
      );
    }
    // 初剪成片：元数据时长离谱时提示。二次导出（/video-edits/）经 ffmpeg 重编码后 duration 常失真，勿与「生成目标」对比以免误报（如变速后显示 125s）。
    if (
      !isPostEditExport
      && Number.isFinite(dur) && dur > 0
      && Number.isFinite(expectedSec) && expectedSec > 0
      && dur > Math.max(expectedSec * 5, 90)
    ) {
      pushSystemStateMsg(
        currentLang === "zh"
          ? "提示：播放器显示时长与目标不一致时，多为视频元数据异常；可尝试重新生成、下载后用本地播放器打开。"
          : "Note: if duration looks wrong in the player, metadata may be off — try regenerating, downloading, or a local player.",
        "progress"
      );
    }
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
    resetVideoEditStateForNewCard();
    if (focusScript) {
      state.scriptEditorOpen = true;
    } else {
      state.videoEditorOpen = true;
    }
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
      resultDurationSec: actualDuration > 0 ? actualDuration : undefined,
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
  const statusBubble = pushSystemStateMsg(zh ? "⏳ 正在准备生成任务…" : "⏳ Preparing generation task…", "progress");
  updateVideoTask(taskId, { status: "running", stage: zh ? "任务准备中" : "Preparing task" });

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
      + "[00:00-00:02] Slow push-in from wide; hold consistent key light — no exposure jump. "
      + "[00:02-00:04] Ease into medium close-up; same lighting setup and white balance as previous beat. "
      + "[00:04-00:06] Detail texture; no new light sources or brightness pop. "
      + "[00:06-00:08] Hero framing; single coherent grade end-to-end."
    );
    promptB = promptB || (
      basePrompt
      + " SEGMENT 2/2 — USAGE & CLOSING: "
      + "[00:00-00:02] Lifestyle context — match Segment 1 color temperature; gradual angle change only. "
      + "[00:02-00:04] Close-up during use; maintain exposure continuity — avoid flash or sudden brightening. "
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
      setSystemStateMsgBodyText(statusBubble, zh
        ? `⏳ 生成中（总计 ${totalElapsed}s）…`
        : `⏳ Generating (${totalElapsed}s total)…`);
      updateVideoTask(taskId, { status: "running", stage: zh ? `生成中（总计${totalElapsed}s）` : `Generating (${totalElapsed}s total)` });
      const waitMs = elapsed < 40 ? 3000 : 12000;
      await new Promise((r) => setTimeout(r, waitMs));
      if (elapsed < 30) continue;
      try {
        const st = await postJson(`${base}/api/veo/status`, { project_id: "qy-shoplazza-02", model: lockedModel, operation_name: op }, 15000);
        if (st?.transient) {
          const retryAttempts = Math.max(0, Number(st?.retry_attempts || 0));
          const waitMs = transientBackoff.apply(retryAttempts);
          if (transientBackoff.shouldNotify()) {
            pushSystemStateMsg(t("pollTransient", { retry: retryAttempts }), "progress");
          }
          updateVideoTask(taskId, { status: "running", stage: zh ? "重试中" : "Retrying" });
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
        updateVideoTask(taskId, { status: "running", stage: zh ? "持续轮询中" : "Continuous polling" });
      }
      if (elapsedMs > HARD_TIMEOUT_MS) {
        throw new Error(
          zh
            ? `生成超时（总计>${Math.floor(HARD_TIMEOUT_MS / 1000)}s）`
            : `Generation timed out (>${Math.floor(HARD_TIMEOUT_MS / 1000)}s total)`
        );
      }
    }
  }

  setSystemStateMsgBodyText(statusBubble, zh ? "⏳ 生成中…" : "⏳ Generating…");
  updateVideoTask(taskId, { status: "running", stage: zh ? "生成中" : "Generating" });
  scrollToBottom();
  const startA = await submitSafe(promptA, "A");
  const opA = startA?.operation_name;
  if (!opA) throw new Error(zh ? "任务提交失败" : "Submit failed");
  const resA = await pollUntilDone(opA, "2/5");

  setSystemStateMsgBodyText(statusBubble, zh ? "⏳ 处理中…" : "⏳ Processing…");
  updateVideoTask(taskId, { status: "running", stage: zh ? "处理中" : "Processing" });
  scrollToBottom();
  let bridgeFrameB64 = "";
  let bridgeFrameMime = "image/png";
  try {
    const frameBody = {
      project_id: "qy-shoplazza-02",
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

  setSystemStateMsgBodyText(statusBubble, zh ? "⏳ 继续生成中…" : "⏳ Continuing generation…");
  updateVideoTask(taskId, { status: "running", stage: zh ? "继续生成中" : "Continuing generation" });
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
  if (!opB) throw new Error(zh ? "任务提交失败" : "Submit failed");
  const resB = await pollUntilDone(opB, "4/5");

  setSystemStateMsgBodyText(statusBubble, zh ? "⏳ 正在完成输出…" : "⏳ Finalizing output…");
  updateVideoTask(taskId, { status: "running", stage: zh ? "输出处理中" : "Finalizing output" });
  scrollToBottom();

  let concatUrl = "";
  let concatDurationSec = 0;
  let concatTraceId = "";
  try {
    const concatBody = { project_id: "qy-shoplazza-02" };
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
        concatDurationSec = Number(concatResp?.duration_seconds || 0) || 0;
        concatTraceId = String(concatResp?.__trace_id || "").trim();
        if (!concatUrl) {
          pushSystemStateMsg(zh
            ? "⚠️ 处理结果为空，已展示可用结果。"
            : "⚠️ Processing returned empty output, showing available result.", "blocked");
        }
      } catch (concatErr) {
        pushSystemStateMsg(zh
          ? `⚠️ 视频处理失败（${String(concatErr?.message || "unknown")}），已展示可用结果。`
          : `⚠️ Video processing failed (${String(concatErr?.message || "unknown")}), showing available result.`, "blocked");
      }
    }
  } catch (_outerErr) {}

  let playable = String(
    concatUrl
    || resA.url
    || buildPlayableUrlFromGcs(resA.gcs)
    || resB.url
    || buildPlayableUrlFromGcs(resB.gcs)
    || ""
  ).trim();
  if (!concatUrl && playable) {
    const segGcs = String(resA.gcs || resB.gcs || "").trim();
    const mit = await applyVeoFlickerMitigate(base, segGcs, playable);
    playable = mit.videoUrl;
  }
  if (statusBubble.parentNode) statusBubble.remove();
  if (!playable) throw new Error(zh ? "16s 视频播放地址缺失" : "16s video URL missing");

  const actualDurationSec = concatUrl
    ? (concatDurationSec > 0 ? concatDurationSec : 0)
    : 8;
  if (concatUrl && actualDurationSec <= 0) {
    pushSystemStateMsg(
      zh
        ? `⚠️ 接口未返回时长，无法确认是否为 16 秒。trace_id=${concatTraceId || "-"}`
        : `⚠️ API returned no duration, unable to verify 16s. trace_id=${concatTraceId || "-"}`,
      "blocked"
    );
  }
  const durationLooksValid = concatUrl && actualDurationSec >= 14.5;
  const taskTitlePrefix = String(state.taskMap?.[taskId]?.title || "").split("·")[0].trim();
  if (!durationLooksValid) {
    pushSystemStateMsg(
      zh
        ? `⚠️ 当前结果未达到 16 秒目标。trace_id=${concatTraceId || "-"}`
        : `⚠️ Output is below the 16s target. trace_id=${concatTraceId || "-"}`,
      "blocked"
    );
  }

  pushSystemStateMsg(
    durationLooksValid
      ? (zh ? "16 秒视频生成完成。" : "16s video ready.")
      : (zh ? "视频已生成，但未达到 16 秒目标。" : "Video generated, but the 16s target was not met."),
    durationLooksValid ? "done" : "blocked"
  );
  updateVideoTask(taskId, {
    status: durationLooksValid ? "done" : "failed",
    stage: durationLooksValid
      ? (zh ? "16秒任务完成" : "16s completed")
      : (zh ? "时长异常" : "Duration mismatch"),
    title: taskTitlePrefix || "#?",
    resultDurationSec: actualDurationSec,
  });
  // When concat succeeds, bind card strictly to concat output; do NOT provide
  // segment gcs fallback, otherwise player error-recovery may fall back to 8s segment.
  // Also clear operationName for concat results: opA refers to the first 8s segment,
  // so passing it would cause the error handler to replace the concat URL with an 8s video.
  const cardBoundGcs = concatUrl ? "" : (resA.gcs || resB.gcs || "");
  const cardOpName   = concatUrl ? "" : (opA || "");
  renderGeneratedVideoCard(playable, cardBoundGcs, cardOpName, taskId, actualDurationSec);
}

function getAgentFirstFrameDataUrl() {
  if (state.frameMode && state.firstFrame) return String(state.firstFrame || "");
  const item = state.images?.[0];
  return item?.dataUrl ? String(item.dataUrl) : "";
}

/** Comfy LTX 预设分辨率（与 backend comfyui_ltxv_api._RES_TO_LATENT 一致） */
function ltxResolutionFromAspect(ratio) {
  const r = ratio || "16:9";
  if (r === "9:16") return "1080x1920";
  if (r === "1:1") return "1920x1080";
  return "1920x1080";
}

async function generateAgentComfyLtx(finalPrompt, taskId, base) {
  const dur = Number(state.duration) || 10;
  const body = {
    prompt: finalPrompt,
    model: "LTX-2 (Pro)",
    duration: dur,
    resolution: ltxResolutionFromAspect(state.aspectRatio),
    fps: 25,
    generate_audio: false,
  };
  const local = getAgentFirstFrameDataUrl();
  if (local) body.image_base64 = local;
  else {
    const url = state.productImageUrls?.[0];
    if (url) body.image_url = String(url).trim();
  }
  updateVideoTask(taskId, {
    status: "running",
    stage: currentLang === "zh" ? "LTX 生成中（ComfyUI）" : "LTX generating (ComfyUI)",
  });
  const data = await postJson(`${base}/api/comfyui-ltxv/generate`, body, 600000);
  const videoUrl = data.video_url;
  if (!videoUrl) throw new Error(currentLang === "zh" ? "未返回视频地址" : "No video URL");
  renderGeneratedVideoCard(videoUrl, "", "", taskId, dur);
}

async function generateAgentJimeng(finalPrompt, taskId, base) {
  const dur = Number(state.duration) === 5 ? 5 : 10;
  const body = {
    prompt: finalPrompt,
    model: "3.0",
    ratio: state.aspectRatio === "9:16" ? "9:16" : state.aspectRatio === "1:1" ? "1:1" : "16:9",
    duration: dur,
    resolution: "720p",
  };
  const local = getAgentFirstFrameDataUrl();
  if (local) body.image_base64 = local;
  else {
    const url = state.productImageUrls?.[0];
    if (url) body.image_url = String(url).trim();
  }
  updateVideoTask(taskId, {
    status: "running",
    stage: currentLang === "zh" ? "即梦生成中" : "Jimeng generating",
  });
  const data = await postJson(`${base}/api/jimeng/video`, body, 1200000);
  const urls = data.video_urls || [];
  const videoUrl = urls[0];
  if (!videoUrl) throw new Error(currentLang === "zh" ? "即梦未返回视频地址" : "Jimeng returned no video URL");
  renderGeneratedVideoCard(videoUrl, "", "", taskId, dur);
}

async function generateVideo(promptOverride = "") {
  if (!canStartVideoJob()) {
    pushSystemStateMsg(t("tooManyJobs", { max: MAX_CONCURRENT_VIDEO_JOBS }), "blocked");
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
    syncStateFromSimpleControls();
    state.lastPrompt = finalPrompt;
    if (!state.lastStoryboard) state.lastStoryboard = buildStoryboardText();
    pushSystemStateMsg(t("submit"), "progress");
    updateVideoTask(taskId, { status: "queued", stage: currentLang === "zh" ? "提交任务中" : "Submitting job" });
    const base = getApiBase();
    const engine = state.videoEngine || "veo";
    let safePrompt = String(finalPrompt || "").trim();
    if (engine === "veo") {
      safePrompt = await rewritePromptForVeoSingle(base, finalPrompt, taskId);
    }

    if (engine === "grok") {
      const targetDuration = Number(state.duration) || 6;
      const grokPrompt = buildGrokVideoPrompt(finalPrompt, targetDuration);
      await generateTabcodeVideo(grokPrompt, taskId, targetDuration);
      finishVideoTask(taskId, true, currentLang === "zh" ? "完成" : "Done");
      releaseSlotOnce();
      return;
    }

    if (engine === "ltx") {
      await generateAgentComfyLtx(finalPrompt, taskId, base);
      finishVideoTask(taskId, true, currentLang === "zh" ? "完成" : "Done");
      releaseSlotOnce();
      return;
    }

    if (engine === "jimeng") {
      await generateAgentJimeng(finalPrompt, taskId, base);
      finishVideoTask(taskId, true, currentLang === "zh" ? "完成" : "Done");
      releaseSlotOnce();
      return;
    }

    const useFrameMode = Boolean(state.frameMode && state.firstFrame && state.lastFrame);
    let imagePayload = buildVeoReferencePayload();
    if (!useFrameMode && imagePayload.veo_mode === "image" && imagePayload.image_base64) {
      // Reference mode for all single images: respects aspect_ratio and maintains
      // subject consistency. Resize to max 512px first — smaller payload uploads faster
      // and reduces Veo's reference-conditioning overhead (key latency win).
      const mime = imagePayload.image_mime_type || "image/jpeg";
      const resizedUrl = await resizeDataUrlForVeo(
        `data:${mime};base64,${imagePayload.image_base64}`, 512, 0.82
      );
      const resizedParsed = parseDataUrl(resizedUrl);
      imagePayload = {
        veo_mode: "reference",
        reference_images_base64: [{
          base64: resizedParsed?.base64 ?? imagePayload.image_base64,
          mime_type: resizedParsed?.mime ?? mime,
        }],
      };
    }
    const startBody = {
      project_id: "qy-shoplazza-02",
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

    if (isChainDuration(state.duration)) {
      const wfStart = state.taskMap?.[taskId]?.startedAt || Date.now();
      await generate16sWithProgress(base, startBody, finalPrompt, wfStart, taskId);
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
    const taskTimerStartMs = state.taskMap?.[taskId]?.startedAt || pollStartedAt;
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
      const pollElapsedMs = Date.now() - pollStartedAt;
      const taskElapsedSec = Math.max(0, Math.floor((Date.now() - taskTimerStartMs) / 1000));
      setSystemStateMsgBodyText(pollBubble, zh
        ? `视频生成中（${taskElapsedSec}s）…`
        : `Generating video (${taskElapsedSec}s)…`);
      updateVideoTask(taskId, { status: "running", stage: zh ? `轮询中（总计${taskElapsedSec}s）` : `Polling (${taskElapsedSec}s total)` });

      if (pollElapsedMs > nextSoftTimeoutAt && Date.now() - lastContinueNoticeAt > 30000) {
        lastContinueNoticeAt = Date.now();
        pushSystemStateMsg(t("pollContinue", { sec: taskElapsedSec }), "progress");
        nextSoftTimeoutAt += POLL_SOFT_STEP_MS;
      }
      if (pollElapsedMs > POLL_HARD_TIMEOUT_MS) {
        pollStopped = true;
        if (pollBubble.parentNode) pollBubble.remove();
        pushSystemStateMsg(zh
          ? `视频生成超时（总计 ${taskElapsedSec}s）。请稍后重试或简化提示词。`
          : `Video generation timed out (${taskElapsedSec}s total). Retry later or simplify the prompt.`, "blocked");
        finishVideoTask(taskId, false, zh ? "超时" : "Timeout");
        releaseSlotOnce();
        return;
      }

      if (pollElapsedMs < 18000) {
        scheduleNext(2000);
        return;
      }

      try {
        const status = await postJson(
          `${base}/api/veo/status`,
          {
            project_id: "qy-shoplazza-02",
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
        let videoUrl = pickPlayableUrl(status);
        let gcsUri = String(status?.video_uris?.[0] || "").trim();
        if (videoUrl || gcsUri) {
          pollStopped = true;
          if (pollBubble.parentNode) pollBubble.remove();
          const mit = await applyVeoFlickerMitigate(base, gcsUri, videoUrl);
          videoUrl = mit.videoUrl;
          gcsUri = mit.gcsUri;
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
      scheduleNext(pollElapsedMs < 90000 ? 8000 : 12000);
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
    state.lastPrompt = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image")).trim();
    state.lastStoryboard = buildStoryboardText();
    syncSimpleControlsFromState();
    // Show parse result immediately so user sees it before they can submit
    pushSystemStateMsg(
      t("parseDone", {
        product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
        business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
        style: state.template || "clean",
      }),
      "done"
    );
    // 仅在一次 hydrate 之后写入输入框，避免先草稿再覆盖造成的「回填两次」观感
    try { await hydrateWorkflowTexts(true); } catch (_e) {}
    if (state.lastPrompt) chatInput.value = sanitizePromptForUser(state.lastPrompt);
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
    // 先快照输入框：若随后执行商品链接解析，可能把提示词覆盖成长文案，导致剪辑短指令丢失并误走「生成视频」。
    const promptSnapshot = String(chatInput.value || "").trim();
    const linkText = String(productUrlInput?.value || "").trim();
    const urlCandidate =
      normalizeProductUrlForApi(linkText) || normalizeProductUrlForApi(promptSnapshot) || "";
    const looksLikeEditCommand =
      Boolean(state.lastVideoUrl) &&
      promptSnapshot.length > 0 &&
      promptSnapshot.length <= 120 &&
      Boolean(extractVideoEditIntent(promptSnapshot));
    const needPrefillFromUrl = Boolean(
      urlCandidate && (!state.productName || !state.mainBusiness || !state.sellingPoints || !hasEffectiveProductAsset())
    ) && !looksLikeEditCommand;
    if (needPrefillFromUrl) {
      await parseShopProductByUrl(urlCandidate);
    }
    const finalText = String(chatInput.value || "").trim() || promptSnapshot;
    if (!finalText) return;
    // 视频编辑意图：仅当以 /edit 开头时解析，避免与生成提示词混淆
    const trimmed = finalText.trimStart();
    const editMatch = /^\/edit\b(?:\s+|$)/i.exec(trimmed);
    if (editMatch) {
      const editPayload = trimmed.slice(editMatch[0].length).trimStart();
      if (!editPayload) {
        pushSystemStateMsg(t("editPrefixEmpty"), "blocked");
        return;
      }
      const handled = await dispatchVideoEditIntent(editPayload);
      if (handled) {
        if (chatInput) chatInput.value = "";
        pushMsg("user", finalText, { typewriter: false });
        return;
      }
    }
    // 已有成片时：短句且可被识别为剪辑意图 → 直接走编辑（倍速/裁剪/调色等），无需 /edit。
    // 避免「整体加速1.5倍」等误走视频生成链路（会出现「已开始生成视频」「生成中总计 xs」）。
    if (state.lastVideoUrl) {
      const editOnly = finalText.trim();
      if (editOnly.length <= 120 && extractVideoEditIntent(editOnly)) {
        const handledEdit = await dispatchVideoEditIntent(editOnly);
        if (handledEdit) {
          if (chatInput) chatInput.value = "";
          pushMsg("user", finalText, { typewriter: false });
          return;
        }
      }
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
            "卖点只聚焦1-2个；时长与节奏保持一致，镜头可执行可拍可剪。",
            "必须包含合规后缀：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。",
            "只输出最终提示词，不要解释。",
          ].join("\n")
        : [
            "You are an ecommerce video prompt optimizer.",
            "Rewrite the input as a final, production-ready single prompt using frameworks 4.1~4.6.",
            "Select one primary framework + one supporting framework only.",
            "The final prompt must cover: Style, Environment, Tone & Pacing, Camera, Lighting, Actions/Scenes, Background Sound, Transition/Editing, CTA.",
            "Focus on only 1-2 selling points; keep duration and pacing coherent, and make every shot executable.",
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
        // Both LLM attempts failed — use structured draft directly (avoid duplicating raw)
        optimized = sanitizePromptForUser(buildAutoPromptDraftFromParsed("url"));
      }
    }
    if (!optimized) {
      optimized = sanitizePromptForUser(buildAutoPromptDraftFromParsed("url"));
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
  // 按钮 click 会传入 MouseEvent，不能当 URL 字符串用。
  const raw =
    (typeof inputUrl === "string" ? inputUrl.trim() : "") ||
    String(productUrlInput?.value || "").trim();
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

  const url = normalizeProductUrlForApi(raw);
  if (!url) return;
  if (productUrlInput) productUrlInput.value = url;
  const base = getApiBase();
  const parseProgress = startLinkParseProgress();
  let parseUiEnded = false;
  const endParseUi = () => {
    if (parseUiEnded) return;
    parseUiEnded = true;
    parseProgress.stop();
  };
  if (parseProductUrlBtn) parseProductUrlBtn.disabled = true;
  try {
    const data = await postJson(
      `${base}/api/agent/shop-product-insight`,
      {
        product_url: url,
        language: currentLang,
      },
      45000
    );
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
      parseProgress.startVisualStepRotation();
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
      endParseUi();
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

    endParseUi();

    if (imageItems.length) {
      pushImageMsg(state.images);
    } else if (!state.images.length) {
      pushSystemGuideMsg(t("parseLinkWeakInfo"));
      showUploadScreenshotGuide();
      showUploadRefQuickAction();
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
    const summaryLine = t("parseDone", {
      product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
      business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
      style: state.template || "clean",
    });
    pushSystemStateMsg(`${t("parseLinkDone")}\n\n${summaryLine}`, "done");
  } catch (e) {
    endParseUi();
    const detail = String(e?.message || e || "").trim();
    const short = detail && detail.length < 220;
    pushSystemStateMsg(short ? `${t("parseLinkFail")} (${detail})` : t("parseLinkFail"), "blocked");
  } finally {
    if (parseProductUrlBtn) parseProductUrlBtn.disabled = false;
  }
}

function consumeLandingParams() {
  const from = (queryParams.get("from") || "").trim();
  const productUrl = (queryParams.get("product_url") || "").trim();
  const duration = (queryParams.get("duration") || "").trim();
  const draft = (queryParams.get("draft") || "").trim();

  if (["landing-prompt", "landing-product-link", "landing-upload", "landing-ref"].includes(from)) {
    // 只有没有携带具体配置参数（aspect/duration/draft）时才进入大居中入口模式；
    // 带了首页设置的跳转直接用正常对话布局，避免 entry-focus 把 chatList 隐藏。
    const hasSettings = Boolean(duration || draft || productUrl);
    if (!hasSettings) {
      state.entryFocusMode = true;
    }
  }

  state.aspectRatio = LOCKED_ASPECT_RATIO;
  if (duration && ["4", "6", "8", "10", "12", "15", "16", "18", "24"].includes(duration)) {
    state.duration = duration;
  }
  if (draft && !chatInput.value.trim()) {
    chatInput.value = draft;
  }
  syncSimpleControlsFromState();
  applyWorkspaceMode();

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
        if (draft) {
          // Template shortcut: draft prompt already in chatInput, image is the Veo reference frame.
          // Skip product analysis entirely — just auto-submit to start video generation.
          setTimeout(() => sendBtn?.click(), 400);
        } else {
          // User uploaded their own product image without a preset prompt:
          // run full analysis to fill in product details.
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
            state.lastPrompt = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image")).trim();
            state.lastStoryboard = buildStoryboardText();
            syncSimpleControlsFromState();
            pushSystemStateMsg(t("parseDone", {
              product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
              business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
              style: state.template || "clean",
            }), "done");
            try { await hydrateWorkflowTexts(true); } catch (_) {}
            if (state.lastPrompt) chatInput.value = sanitizePromptForUser(state.lastPrompt);
          }, 600);
        }
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
          state.lastPrompt = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image")).trim();
          state.lastStoryboard = buildStoryboardText();
          syncSimpleControlsFromState();
          pushSystemStateMsg(t("parseDone", {
            product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
            business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
            style: state.template || "clean",
          }), "done");
          try { await hydrateWorkflowTexts(true); } catch (_) {}
          if (state.lastPrompt) chatInput.value = sanitizePromptForUser(state.lastPrompt);
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
  const welcomeText = t("welcome", { max: MAX_CONCURRENT_VIDEO_JOBS });
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
        state.lastPrompt = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image")).trim();
        state.lastStoryboard = buildStoryboardText();
        syncSimpleControlsFromState();
        pushSystemStateMsg(t("parseDone", {
          product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
          business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
          style: state.template || "clean",
        }), "done");
        try { await hydrateWorkflowTexts(true); } catch (_) {}
        if (state.lastPrompt) chatInput.value = sanitizePromptForUser(state.lastPrompt);
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
    }).catch((_e) => {});
  }

  uploadBtn2?.addEventListener("click", () => { setTab("upload"); fileInput?.click(); });
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
          person_generation: "dont_allow",
          skip_category_check: true,
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

uploadBtn?.addEventListener("click", () => {
  if (window._agentOpenRefModal) window._agentOpenRefModal();
  else imageInput?.click(); // fallback
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
imageInput?.addEventListener("change", (e) => onUpload(e.target.files));
sendBtn?.addEventListener("click", onSend);
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
    if (state.videoEditorOpen) renderVideoEditor();
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
          project_id: "qy-shoplazza-02",
          prompt: firstPrompt,
          sample_count: 1,
          aspect_ratio: "16:9",
        }, 60000),
        postJson(`${base}/api/media/image-generate`, {
          project_id: "qy-shoplazza-02",
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

// Enter fullscreen: normalize video sizing for true fullscreen rendering.
function _togglePlayerFocusCard(fsEl) {
  document.querySelectorAll(".video-msg.is-player-focus").forEach((card) => {
    card.classList.remove("is-player-focus");
  });
  if (!fsEl) return;
  const host = fsEl.tagName === "VIDEO" ? fsEl.parentElement : fsEl;
  const card = host?.closest?.(".video-msg");
  if (card) card.classList.add("is-player-focus");
}

document.addEventListener("fullscreenchange", () => {
  const fsEl = document.fullscreenElement;
  _togglePlayerFocusCard(fsEl);
  if (!fsEl) return;
  let video = null;
  if (fsEl.tagName === "VIDEO") {
    video = fsEl;
  } else if (fsEl.classList?.contains("video-edit-surface")) {
    video = fsEl.querySelector("video");
  }
  if (!video) return;
  video.dataset.inlineStyleBackup = video.getAttribute("style") || "";
  video.style.cssText = "display:block;width:100vw;height:100vh;max-width:100vw;max-height:100vh;min-height:unset;object-fit:contain;border-radius:0;background:#000;";
  applyVideoEditsToPreview();
});
document.addEventListener("fullscreenchange", () => {
  // Handle exit: restore inline style
  if (!document.fullscreenElement) {
    document.querySelectorAll(".video-edit-surface[data-was-fs]").forEach((surface) => {
      surface.removeAttribute("data-was-fs");
    });
    document.querySelectorAll(".video-edit-surface video[data-inline-style-backup]").forEach((video) => {
      const backup = video.dataset.inlineStyleBackup;
      if (backup !== undefined) {
        video.setAttribute("style", backup);
        delete video.dataset.inlineStyleBackup;
      }
    });
    applyVideoEditsToPreview();
  }
}, { capture: false });
document.addEventListener("webkitfullscreenchange", () => {
  const fsEl = document.webkitFullscreenElement;
  _togglePlayerFocusCard(fsEl);
  if (!fsEl) {
    // Exiting — restore inline styles
    document.querySelectorAll(".video-edit-surface video[data-inline-style-backup]").forEach((video) => {
      const backup = video.dataset.inlineStyleBackup;
      if (backup !== undefined) {
        video.setAttribute("style", backup);
        delete video.dataset.inlineStyleBackup;
      }
    });
    applyVideoEditsToPreview();
    return;
  }
  let video = null;
  if (fsEl.tagName === "VIDEO") {
    video = fsEl;
  } else if (fsEl.classList?.contains("video-edit-surface")) {
    video = fsEl.querySelector("video");
  }
  if (!video) return;
  video.dataset.inlineStyleBackup = video.getAttribute("style") || "";
  video.style.cssText = "display:block;width:100vw;height:100vh;max-width:100vw;max-height:100vh;min-height:unset;object-fit:contain;border-radius:0;background:#000;";
  applyVideoEditsToPreview();
});

// ── Quick-edit command chips bar ─────────────────────────────────────────────
let _editCmdsBar = null;

const _EDIT_CMDS_ZH = [
  { label: "裁剪片段", cmd: "只保留第3到10秒" },
  { label: "加速 1.5x", cmd: "整体加速1.5倍" },
  { label: "提亮画面", cmd: "画面提亮一些" },
  { label: "自动字幕", cmd: "自动生成字幕" },
  { label: "换封面", cmd: "换封面" },
  { label: "撤销", cmd: "撤销" },
];
const _EDIT_CMDS_EN = [
  { label: "Trim clip", cmd: "keep 3s to 10s" },
  { label: "1.5x speed", cmd: "speed up 1.5x" },
  { label: "Brighten", cmd: "brighten the video" },
  { label: "Auto subtitles", cmd: "auto subtitle" },
  { label: "Replace cover", cmd: "replace cover" },
  { label: "Undo", cmd: "undo" },
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
(function initVideoEngineChipsOnce() {
  document.querySelectorAll("[data-video-engine]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.videoEngine = btn.getAttribute("data-video-engine") || "veo";
      syncVideoEngineChips();
      updateDurationOptions();
    });
  });
  syncVideoEngineChips();
})();
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
  appendExportedVideoCard,
});
initVideoEditorCallbacks({
  openEditorPanel,
  updateWorkspaceTabs,
  updateWorkspaceToolbarVisibility,
  updateGenerationGateUI,
  scrollToBottom,
  getActiveVideoCardId: () => state.activeVideoCardId,
  applyWorkspaceMode,
  pushSystemStateMsg,
  setActionButtonState,
  sanitizeInputValue,
});
initWorkspaceCallbacks({
  pushSystemStateMsg,
  openEditorPanel,
  renderOptions,
  normalizePointsList,
  buildTargetOptions,
  buildBrandOptions,
  updateGenerationGateUI,
  applyLang,
  syncSimpleControlsFromState,
  updateDurationHint,
  updateDurationOptions,
  buildPrompt,
  sanitizePromptForUser,
  sanitizeInputValue,
  normalizeProductAnchors,
  setActionButtonState,
  generateVideo,
  updateChatTailWindow,
  updateActiveVideoCardState,
  updateEditCmdsBar: _updateEditCmdsBar,
});
initAgentRunCallbacks({
  pushSystemStateMsg,
  pushSystemReplyMsg,
  renderVideoEditor,
  applyVideoEditsToPreview,
  scrollToBottom,
});
_loadVideoHistory(); // restore undo stack from localStorage
_initEditCmdsBar();  // quick-edit chips below chat input
consumeLandingParams();
pushSystemGuideMsg(t("welcome", { max: MAX_CONCURRENT_VIDEO_JOBS }), { typewriter: true });
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
      state.lastStoryboard = state.lastStoryboard || '测试脚本';
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
