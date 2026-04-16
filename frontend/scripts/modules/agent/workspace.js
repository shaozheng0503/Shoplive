import { state } from './state.js';
import { currentLang, t } from './i18n.js';
import { getApiBase, postJson } from './utils.js';

let hasOpenEditors = false;

// Callbacks injected by index.js
let _pushSystemStateMsg = () => null;
let _openEditorPanel = () => {};
let _renderOptions = () => {};
let _normalizePointsList = (v) => v ? String(v).split(/[,;；，]+/).map(s=>s.trim()).filter(Boolean) : [];
let _buildTargetOptions = () => [];
let _buildBrandOptions = () => [];
let _updateGenerationGateUI = () => {};
let _applyLang = () => {};
let _syncSimpleControlsFromState = () => {};
let _updateDurationHint = () => {};
let _updateDurationOptions = () => {};
let _buildPrompt = () => "";
let _sanitizePromptForUser = (v) => String(v || "");
let _sanitizeInputValue = (v) => String(v || "");
let _normalizeProductAnchors = (v) => v || [];
let _setActionButtonState = () => {};
let _generateVideo = () => Promise.resolve();
let _updateChatTailWindow = () => {};
let _updateActiveVideoCardState = () => {};
let _updateEditCmdsBar = () => {};

export function initWorkspaceCallbacks(cbs) {
  if (cbs.pushSystemStateMsg) _pushSystemStateMsg = cbs.pushSystemStateMsg;
  if (cbs.openEditorPanel) _openEditorPanel = cbs.openEditorPanel;
  if (cbs.renderOptions) _renderOptions = cbs.renderOptions;
  if (cbs.normalizePointsList) _normalizePointsList = cbs.normalizePointsList;
  if (cbs.buildTargetOptions) _buildTargetOptions = cbs.buildTargetOptions;
  if (cbs.buildBrandOptions) _buildBrandOptions = cbs.buildBrandOptions;
  if (cbs.updateGenerationGateUI) _updateGenerationGateUI = cbs.updateGenerationGateUI;
  if (cbs.applyLang) _applyLang = cbs.applyLang;
  if (cbs.syncSimpleControlsFromState) _syncSimpleControlsFromState = cbs.syncSimpleControlsFromState;
  if (cbs.updateDurationHint) _updateDurationHint = cbs.updateDurationHint;
  if (cbs.updateDurationOptions) _updateDurationOptions = cbs.updateDurationOptions;
  if (cbs.buildPrompt) _buildPrompt = cbs.buildPrompt;
  if (cbs.sanitizePromptForUser) _sanitizePromptForUser = cbs.sanitizePromptForUser;
  if (cbs.sanitizeInputValue) _sanitizeInputValue = cbs.sanitizeInputValue;
  if (cbs.normalizeProductAnchors) _normalizeProductAnchors = cbs.normalizeProductAnchors;
  if (cbs.setActionButtonState) _setActionButtonState = cbs.setActionButtonState;
  if (cbs.generateVideo) _generateVideo = cbs.generateVideo;
  if (cbs.updateChatTailWindow) _updateChatTailWindow = cbs.updateChatTailWindow;
  if (cbs.updateActiveVideoCardState) _updateActiveVideoCardState = cbs.updateActiveVideoCardState;
  if (cbs.updateEditCmdsBar) _updateEditCmdsBar = cbs.updateEditCmdsBar;
}

export function buildStoryboardText() {
  const points = _normalizePointsList(state.sellingPoints);
  const scenes = points.length ? points : [currentLang === "zh" ? "突出产品核心卖点" : "Highlight core product value"];
  const lines = scenes.map((p, idx) =>
    currentLang === "zh"
      ? `镜头${idx + 1}：${p}，面向「${state.targetUser || "目标人群"}」，突出「${state.salesRegion || "目标地区"}」表达。`
      : `Scene ${idx + 1}: ${p}; target "${state.targetUser || "audience"}"; localized for "${state.salesRegion || "region"}".`
  );
  return lines.join("\n");
}

export function buildWorkflowInput() {
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
    product_anchors: _normalizeProductAnchors(state.productAnchors),
  };
}

export function hasWorkflowRequiredInput() {
  return Boolean(
    state.productName &&
      state.mainBusiness &&
      state.sellingPoints &&
      state.targetUser &&
      state.salesRegion
  );
}

export async function callShopliveWorkflow(action, extra = {}) {
  const base = getApiBase();
  return postJson(`${base}/api/shoplive/video/workflow`, {
    action,
    input: buildWorkflowInput(),
    model: "azure-gpt-5",
    ...extra,
  });
}

export async function hydrateWorkflowTexts(force = false) {
  if (state.workflowHydrating) return;
  if (!force && state.workflowHydrated && state.lastStoryboard && state.lastPrompt) return;
  if (!force && state.hotVideoRemake?.remakePrompt && state.hotVideoRemake?.remakeScript) {
    state.lastStoryboard = String(state.hotVideoRemake.remakeScript || "").trim() || state.lastStoryboard;
    state.lastPrompt = _sanitizePromptForUser(String(state.hotVideoRemake.remakePrompt || "").trim()) || state.lastPrompt;
    state.workflowHydrated = true;
    return;
  }
  if (!hasWorkflowRequiredInput()) {
    if (!state.lastStoryboard) state.lastStoryboard = buildStoryboardText();
    if (!state.lastPrompt) state.lastPrompt = _buildPrompt();
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
        prompt = _sanitizePromptForUser(String(promptResp.prompt).trim());
      }
    } catch (_e) {}
    if (!prompt) prompt = _buildPrompt();

    state.lastStoryboard = script;
    state.lastPrompt = _sanitizePromptForUser(prompt);
    state.workflowHydrated = true;
  } finally {
    state.workflowHydrating = false;
  }
}

export function hydrateHotVideoRemakeWorkspace(remake = {}) {
  const payload = remake && typeof remake === "object" ? remake : {};
  const shotPlan = Array.isArray(payload.shotPlan) ? payload.shotPlan : (Array.isArray(payload.shot_plan) ? payload.shot_plan : []);
  let remakeScript = String(payload.remakeScript || payload.remake_script || "").trim();
  const durationValue = Number(payload.duration || state.duration || 8);
  const segCount = durationValue >= 16 ? Math.floor(durationValue / 8) : 1;
  if ((!remakeScript || segCount > 1) && shotPlan.length) {
    const shotPlanStoryboard = buildStoryboardFromShotPlan(shotPlan, segCount);
    if (shotPlanStoryboard) remakeScript = shotPlanStoryboard;
  }
  const remakePrompt = _sanitizePromptForUser(String(payload.remakePrompt || payload.remake_prompt || "").trim());
  const enginePrompts = (payload.enginePrompts && typeof payload.enginePrompts === "object") ? payload.enginePrompts : {};
  if (remakeScript) state.lastStoryboard = remakeScript;
  if (remakePrompt) state.lastPrompt = remakePrompt;
  state.hotVideoRemake = {
    ...(state.hotVideoRemake && typeof state.hotVideoRemake === "object" ? state.hotVideoRemake : {}),
    ...payload,
    shotPlan,
    enginePrompts,
    confidenceScore: Number(payload.confidenceScore || 0),
    remakeScript: remakeScript || String(payload.remakeScript || payload.remake_script || "").trim(),
    remakePrompt: remakePrompt || _sanitizePromptForUser(String(payload.remakePrompt || payload.remake_prompt || "").trim()),
  };
  state.workflowHydrated = Boolean(state.lastStoryboard || state.lastPrompt);
  state.canUseEditors = true;
}

export function applyWorkspaceMode() {
  const workspaceEl = document.getElementById("workspace");
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
    const scriptEditorPanel = document.getElementById("scriptEditorPanel");
    const videoEditorPanel = document.getElementById("videoEditorPanel");
    if (scriptEditorPanel) scriptEditorPanel.hidden = true;
    if (videoEditorPanel) videoEditorPanel.hidden = true;
    updateWorkspaceTabs();
    _updateChatTailWindow();
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
  const scriptEditorPanel = document.getElementById("scriptEditorPanel");
  const videoEditorPanel = document.getElementById("videoEditorPanel");
  if (scriptEditorPanel) scriptEditorPanel.hidden = !state.scriptEditorOpen;
  if (videoEditorPanel) videoEditorPanel.hidden = !state.videoEditorOpen;
  updateWorkspaceTabs();
  _updateChatTailWindow();
  _updateActiveVideoCardState();
  _updateEditCmdsBar();
}

export function updateWorkspaceTabs() {
  const toggleScriptTab = document.getElementById("toggleScriptTab");
  const toggleVideoTab = document.getElementById("toggleVideoTab");
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

export function updateWorkspaceToolbarVisibility() {
  const workspaceToolbar = document.querySelector(".workspace-toolbar");
  if (!workspaceToolbar) return;
  hasOpenEditors = Boolean(state.canUseEditors && (state.videoEditorOpen || state.scriptEditorOpen));
  workspaceToolbar.hidden = !hasOpenEditors;
}

export function updateToolbarIndicator() {
  const workspaceToolbar = document.querySelector(".workspace-toolbar");
  const toggleScriptTab = document.getElementById("toggleScriptTab");
  const toggleVideoTab = document.getElementById("toggleVideoTab");
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

export function buildSegmentedStoryboard(segCount = 1) {
  const partName = (idx) => {
    const letter = String.fromCharCode(65 + Math.max(0, Number(idx) || 0));
    return currentLang === "zh" ? `脚本 ${letter}` : `Script ${letter}`;
  };
  const points = _normalizePointsList(state.sellingPoints);
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
    const segLabel = partName(s);
    const lines = chunk.map((p, idx) =>
      currentLang === "zh"
        ? `镜头${idx + 1}：${p}，面向「${state.targetUser || "目标人群"}」。`
        : `Scene ${idx + 1}: ${p}; target "${state.targetUser || "audience"}".`
    );
    segments.push(`[${segLabel}]\n${lines.join("\n")}`);
  }
  return segments;
}

export function buildStoryboardFromPromptSegments(prompts = [], segDuration = 8) {
  void segDuration;
  const list = Array.isArray(prompts)
    ? prompts.map((p) => String(p || "").trim()).filter(Boolean)
    : [];
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return list
    .map((p, i) => {
      const letter = String.fromCharCode(65 + i);
      const label = currentLang === "zh" ? `[脚本 ${letter}]` : `[Script ${letter}]`;
      return `${label}\n${p}`;
    })
    .join("\n\n");
}

function buildStoryboardFromShotPlan(shotPlan = [], segCount = 1) {
  const items = Array.isArray(shotPlan) ? shotPlan : [];
  if (!items.length) return "";
  const targetSegCount = Math.max(1, Number(segCount) || 1);
  const totalDuration = items.reduce((sum, item) => sum + Math.max(1, Number(item?.duration_seconds || 0)), 0) || targetSegCount;
  const segmentTarget = totalDuration / targetSegCount;
  const segments = Array.from({ length: targetSegCount }, () => []);
  let currentSeg = 0;
  let currentDur = 0;
  items.forEach((item, idx) => {
    const shotTitle = String(item?.shot || item?.title || (currentLang === "zh" ? `镜头${idx + 1}` : `Shot ${idx + 1}`)).trim();
    const visual = String(item?.visual || "").trim();
    const voiceover = String(item?.voiceover || "").trim();
    const onscreenText = String(item?.onscreen_text || "").trim();
    const line = [
      `${shotTitle}：${visual || (currentLang === "zh" ? "延续参考视频节奏推进" : "Continue the reference pacing")}`,
      voiceover ? (currentLang === "zh" ? `口播：${voiceover}` : `Voiceover: ${voiceover}`) : "",
      onscreenText ? (currentLang === "zh" ? `字幕：${onscreenText}` : `Caption: ${onscreenText}`) : "",
    ].filter(Boolean).join("；");
    segments[currentSeg].push(line);
    currentDur += Math.max(1, Number(item?.duration_seconds || 0));
    const shouldAdvance = currentSeg < targetSegCount - 1 && currentDur >= segmentTarget;
    const remainingItems = items.length - idx - 1;
    const remainingSegments = targetSegCount - currentSeg - 1;
    if (shouldAdvance && remainingItems >= remainingSegments) {
      currentSeg += 1;
      currentDur = 0;
    }
  });
  return buildStoryboardFromPromptSegments(
    segments.map((seg) => seg.join("\n")).filter(Boolean),
    Math.max(1, Math.round(totalDuration / targetSegCount)),
  );
}

export function parseStoryboardSegments(storyboardText = "") {
  const raw = String(storyboardText || "").trim();
  if (!raw) return [];
  const normalized = raw.replace(
    /\n*\[(?:第\d+段（\d+秒）|Segment \d+ \(\d+s\)|脚本\s*[A-Z]|Script\s*[A-Z]|Part\s*[A-Z])\]\s*/gi,
    "\n@@SPLIT@@\n"
  );
  const parts = normalized
    .split("@@SPLIT@@")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts;
}

export function getBoundScriptSummary(storyboardText = "") {
  const parts = parseStoryboardSegments(storyboardText);
  if (parts.length > 1) return currentLang === "zh" ? "脚本已就绪" : "Script ready";
  const raw = String((parts[0] || storyboardText || "")).trim();
  const firstLine = raw.split("\n").map((s) => s.trim()).find(Boolean) || "";
  if (!firstLine) {
    return currentLang === "zh" ? "脚本已就绪" : "Script ready";
  }
  return firstLine.length > 20 ? `${firstLine.slice(0, 20)}…` : firstLine;
}

export function renderScriptEditor() {
  const scriptEditorPanel = document.getElementById("scriptEditorPanel");
  if (!scriptEditorPanel) return;
  if (!state.scriptEditorOpen) return;

  const dur = Number(state.duration || 8);
  const segCount = dur >= 16 ? Math.floor(dur / 8) : 1;
  const existingSegments = parseStoryboardSegments(state.lastStoryboard);
  const segments = existingSegments.length === segCount
    ? existingSegments
    : buildSegmentedStoryboard(segCount);

  const durationLabel = currentLang === "zh" ? "视频时长" : "Duration";
  const remakeMeta = state.hotVideoRemake && typeof state.hotVideoRemake === "object" ? state.hotVideoRemake : null;
  const remakeSummary = remakeMeta ? String(remakeMeta.summary || "").trim() : "";
  const remakeHook = remakeMeta ? String(remakeMeta.hook || "").trim() : "";
  const remakeSourceUrl = remakeMeta ? String(remakeMeta.sourceUrl || "").trim() : "";
  const remakeResolvedVideoUrl = remakeMeta ? String(remakeMeta.resolvedVideoUrl || "").trim() : "";
  const remakeResolvedPageUrl = remakeMeta ? String(remakeMeta.resolvedPageUrl || "").trim() : "";
  const remakeShareStrategy = remakeMeta ? String(remakeMeta.shareResolution?.strategy || "").trim() : "";
  const shareStrategyLabelMap = {
    direct: currentLang === "zh" ? "直接视频链接" : "Direct video URL",
    redirect_direct: currentLang === "zh" ? "短链跳转后直达视频" : "Redirected share link to direct video",
    html_extract: currentLang === "zh" ? "页面 HTML 提取视频直链" : "Extracted video URL from page HTML",
    rendered_html_extract: currentLang === "zh" ? "渲染页面后提取视频直链" : "Extracted video URL from rendered page",
    unresolved_page: currentLang === "zh" ? "仅拿到页面，未解析出视频直链" : "Only page URL resolved, no direct video URL",
    cache_hit: currentLang === "zh" ? "命中缓存结果" : "Used cached resolution",
    passthrough: currentLang === "zh" ? "原样使用输入链接" : "Used input URL as-is",
  };
  const remakeShareStrategyLabel = remakeShareStrategy ? (shareStrategyLabelMap[remakeShareStrategy] || remakeShareStrategy) : "";
  const remakeMetaHtml = remakeMeta
    ? `
    <div class="summary-card" style="margin-bottom:12px;">
      <div class="info-grid">
        ${remakeHook ? `<div class="info-item"><div class="info-icon">🎣</div><div class="info-main"><div class="info-title">${currentLang === "zh" ? "参考钩子" : "Reference hook"}</div><div class="info-value">${_sanitizeInputValue(remakeHook)}</div></div></div>` : ""}
        ${remakeSummary ? `<div class="info-item"><div class="info-icon">🧠</div><div class="info-main"><div class="info-title">${currentLang === "zh" ? "复刻摘要" : "Remake summary"}</div><div class="info-value">${_sanitizeInputValue(remakeSummary)}</div></div></div>` : ""}
        ${remakeSourceUrl ? `<div class="info-item"><div class="info-icon">🔗</div><div class="info-main"><div class="info-title">${currentLang === "zh" ? "参考链接" : "Reference URL"}</div><div class="info-value">${_sanitizeInputValue(remakeSourceUrl)}</div></div></div>` : ""}
        ${remakeShareStrategyLabel ? `<div class="info-item"><div class="info-icon">🧭</div><div class="info-main"><div class="info-title">${currentLang === "zh" ? "解析策略" : "Resolution strategy"}</div><div class="info-value">${_sanitizeInputValue(remakeShareStrategyLabel)}</div></div></div>` : ""}
        ${remakeResolvedVideoUrl && remakeResolvedVideoUrl !== remakeSourceUrl ? `<div class="info-item"><div class="info-icon">🎬</div><div class="info-main"><div class="info-title">${currentLang === "zh" ? "视频直链" : "Resolved video URL"}</div><div class="info-value">${_sanitizeInputValue(remakeResolvedVideoUrl)}</div></div></div>` : ""}
        ${remakeResolvedPageUrl && remakeResolvedPageUrl !== remakeSourceUrl ? `<div class="info-item"><div class="info-icon">🌐</div><div class="info-main"><div class="info-title">${currentLang === "zh" ? "落地页面" : "Resolved page URL"}</div><div class="info-value">${_sanitizeInputValue(remakeResolvedPageUrl)}</div></div></div>` : ""}
      </div>
    </div>`
    : "";
  let segmentHtml = "";
  for (let i = 0; i < segCount; i++) {
    const letter = String.fromCharCode(65 + i);
    const title = segCount > 1
      ? (currentLang === "zh" ? `脚本 ${letter}` : `Script ${letter}`)
      : (currentLang === "zh" ? "脚本" : "Script");
    segmentHtml += `
      <label class="editor-label">${title}</label>
      <textarea id="storyboardSeg${i}" class="editor-textarea" rows="6">${_sanitizeInputValue(segments[i] || "")}</textarea>
    `;
  }

  scriptEditorPanel.innerHTML = `
    <div class="editor-head">
      <strong>${t("scriptEditTitle")}</strong>
      <button class="editor-close-btn" id="closeScriptPanelBtn">${t("closePanel")}</button>
    </div>
    <p class="editor-hint">${t("scriptEditHint")}</p>
    ${remakeMetaHtml}
    <div class="editor-duration-row" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <label class="editor-label" style="margin:0;">${durationLabel}</label>
      <select id="scriptDurationSelect" style="padding:4px 8px;border-radius:8px;border:1px solid #c0d2ec;">
        <option value="4" ${dur === 4 ? "selected" : ""}>4${currentLang === "zh" ? "秒" : "s"}</option>
        <option value="6" ${dur === 6 ? "selected" : ""}>6${currentLang === "zh" ? "秒" : "s"}</option>
        <option value="8" ${dur === 8 ? "selected" : ""}>8${currentLang === "zh" ? "秒" : "s"}</option>
        <option value="16" ${dur === 16 ? "selected" : ""}>16${currentLang === "zh" ? "秒" : "s"}</option>
      </select>
    </div>
    ${segmentHtml}
    <label class="editor-label">${t("promptLabel")}</label>
    <textarea id="promptTextarea" class="editor-textarea" rows="10">${_sanitizeInputValue(state.lastPrompt || _buildPrompt())}</textarea>
    <div class="editor-actions">
      <button id="regenFromScriptBtn" class="action-chip-btn action-chip-primary">${t("storyboardRegenerate")}</button>
    </div>
  `;

  const durationSelect = document.getElementById("durationSelect");
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
    _setActionButtonState(btn, "progress", t("storyboardRegenerate"));
    const currentSegCount = Number(state.duration || 8) >= 16 ? Math.floor(Number(state.duration) / 8) : 1;
    const segs = [];
    for (let i = 0; i < currentSegCount; i++) {
      const el = scriptEditorPanel.querySelector(`#storyboardSeg${i}`);
      segs.push(el?.value?.trim() || "");
    }
    if (currentSegCount > 1) {
      state.lastStoryboard = segs.map((s, i) => {
        const letter = String.fromCharCode(65 + i);
        const label = currentLang === "zh" ? `[脚本 ${letter}]` : `[Script ${letter}]`;
        return `${label}\n${s}`;
      }).join("\n\n");
    } else {
      state.lastStoryboard = segs[0] || "";
    }
    state.lastPrompt = scriptEditorPanel.querySelector("#promptTextarea")?.value?.trim() || _buildPrompt();
    try {
      await _generateVideo(state.lastPrompt);
      _setActionButtonState(btn, "done", t("storyboardRegenerate"));
      setTimeout(() => _setActionButtonState(btn, "idle"), 1400);
    } catch (_e) {
      _setActionButtonState(btn, "blocked", t("storyboardRegenerate"));
      setTimeout(() => _setActionButtonState(btn, "idle"), 1800);
      throw _e;
    }
  });
}
