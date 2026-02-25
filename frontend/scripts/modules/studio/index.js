const taskName = document.getElementById("taskName");
const uploadBtn = document.getElementById("uploadBtn");
const filePicker = document.getElementById("filePicker");
const uploadBox = document.getElementById("uploadBox");
const exportBtn = document.getElementById("exportBtn");
const newTaskBtn = document.getElementById("newTaskBtn");
const studioLangToggleBtn = document.getElementById("studioLangToggleBtn");
const assetList = document.getElementById("assetList");
const previewStatus = document.getElementById("previewStatus");
const previewHint = document.getElementById("previewHint");
const previewVideo = document.getElementById("previewVideo");
const previewImage = document.getElementById("previewImage");
const playPauseBtn = document.getElementById("playPauseBtn");
const seekStartBtn = document.getElementById("seekStartBtn");
const seekEndBtn = document.getElementById("seekEndBtn");
const timecode = document.getElementById("timecode");
const timelineTracks = document.getElementById("timelineTracks");
const splitSegBtn = document.getElementById("splitSegBtn");
const deleteSegBtn = document.getElementById("deleteSegBtn");
const timelineHint = document.getElementById("timelineHint");
const scriptEditor = document.getElementById("scriptEditor");
const scriptCounter = document.getElementById("scriptCounter");
const scriptSync = document.getElementById("scriptSync");
const prdGateBadge = document.getElementById("prdGateBadge");
const messageList = document.getElementById("messageList");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const quickActionButtons = Array.from(document.querySelectorAll(".quick-actions button"));
const useApiToggle = document.getElementById("useApiToggle");
const llmApiBaseInput = document.getElementById("llmApiBaseInput");
const llmApiKeyInput = document.getElementById("llmApiKeyInput");
const backendUrlInput = document.getElementById("backendUrlInput");
const projectIdInput = document.getElementById("projectIdInput");
const modelInput = document.getElementById("modelInput");
const proxyInput = document.getElementById("proxyInput");
const veoModelInput = document.getElementById("veoModelInput");
const storageUriInput = document.getElementById("storageUriInput");
const veoDurationInput = document.getElementById("veoDurationInput");
const veoAspectRatioInput = document.getElementById("veoAspectRatioInput");
const sellingPointsInput = document.getElementById("sellingPointsInput");
const targetUserInput = document.getElementById("targetUserInput");
const salesRegionInput = document.getElementById("salesRegionInput");
const needModelToggle = document.getElementById("needModelToggle");
const templateButtons = Array.from(document.querySelectorAll(".template-btn"));
const pointSuggestions = document.getElementById("pointSuggestions");
const statusValidate = document.getElementById("statusValidate");
const statusClarify = document.getElementById("statusClarify");
const statusScript = document.getElementById("statusScript");
const statusSelfcheck = document.getElementById("statusSelfcheck");
const statusExport = document.getElementById("statusExport");

let assetCount = 0;
let shotCount = 4;
let activeAssetId = null;
let currentDuration = 20;
let draggingAssetId = null;
let timelineDragState = null;
let selectedSegment = null;
let pollTimer = null;
let selectedTemplate = "clean";
let currentLang = localStorage.getItem("shoplive.lang") || "zh";
let lastCanonicalFingerprintNotified = "";
const workflowState = {
  validate: "pending",
  clarify: "pending",
  script: "pending",
  selfcheck: "pending",
  export: "pending",
};

const assets = [];
const timelineModel = [
  { label: "Video", segments: [{ id: "video-1", title: "Shot 1", left: 2, width: 62, color: "#3f78ff" }] },
  { label: "Voice", segments: [{ id: "voice-1", title: "VO", left: 18, width: 48, color: "#8c59ff" }] },
  { label: "Subtitle", segments: [{ id: "sub-1", title: "Sub", left: 36, width: 40, color: "#ffaf31" }] },
  { label: "BGM", segments: [{ id: "bgm-1", title: "BGM", left: 8, width: 58, color: "#ec4a6c" }] },
];

const defaultScript = `[Creative Framework]: Problem-Solution + Sensory Experience
[Opening Hook] (0-3s): Close-up product reveal with high-contrast lighting.
[Product Reveal] (3-7s): Demonstrate texture and key features.
[Benefits] (7-15s): Show practical usage scenarios for target audience.
[CTA] (15-20s): End with clear action and brand message.`;

const i18n = {
  zh: {
    task: "+ 新任务",
    taskUntitled: "未命名任务",
    accountPlan: "免费版",
    panelFootage: "素材",
    uploadBtn: "上传",
    prdGate: "PRD 质检",
    noAssets: "暂无素材",
    dropHint: "拖拽文件到这里，或点击上传",
    prdInputs: "PRD 输入",
    sellingPointsLabel: "商品卖点（1-6个）",
    targetUserLabel: "目标用户",
    salesRegionLabel: "销售地区",
    styleTemplateLabel: "商品风格模版",
    tplClean: "干净商品",
    tplLifestyle: "生活方式",
    tplPremium: "高级质感",
    tplSocial: "社媒广告",
    videoDurationLabel: "视频时长",
    ratioLabel: "视频尺寸比例",
    needModelLabel: "需要模特展示（默认开启）",
    panelVideo: "视频",
    exportBtn: "生成视频",
    noPreview: "暂无预览",
    assetsLoaded: "素材已加载",
    dragReorderHint: "拖拽可排序；单项支持重命名和删除",
    previewHint: "上传素材并发送指令后可生成时间线。",
    splitSegment: "拆分片段",
    deleteSegment: "删除片段",
    timelineHintDefault: "请选择要编辑的片段",
    syncing: "同步中...",
    storyboardSynced: "分镜已同步",
    scriptUpdated: "脚本已更新",
    syncedViaApi: "API 同步完成",
    exporting: "导出中...",
    exportComplete: "导出完成",
    markdownEditor: "Markdown 编辑器",
    online: "在线",
    useBackendApi: "使用后端 API",
    llmApiBasePh: "LiteLLM 地址（例如 https://litellm.shoplazza.site）",
    llmApiKeyPh: "LiteLLM API Key（Bearer ...）",
    backendUrlPh: "后端地址（例如 http://127.0.0.1:8000）",
    projectIdPh: "项目ID（例如 gemini-sl-20251120）",
    proxyPh: "代理（可选）",
    storageUriPh: "gs://bucket/path（可选）",
    qaGenerateTask: "生成任务脚本",
    qaEditShots: "优化镜头节奏",
    qaUpdateTrack: "更新背景音乐",
    chatToolAssets: "素材",
    chatToolLink: "链接",
    chatPlaceholder: "告诉 Shoplive 你想做什么...",
    assetsCount: "{count} 个素材",
    msgAssetUploaded: "已上传 {count} 个素材，Shoplive 正在解析商品素材。",
    msgReceivedQualityReport: "已接收生图质量报告：{report}",
    msgReceivedGeneratedImage: "已接收实时生图结果，进入视频生成阶段。",
    msgNeedImages: "请先上传商品图片（必须上传，支持 1-3 张高清图）。",
    msgTooManyImages: "当前商品图超过 3 张，请保留 1-3 张核心商品高清图。",
    msgLowRes: "图片分辨率过低，请上传至少1024x1024图片。",
    msgLowSharpness: "图片清晰度不足（Laplacian variance < 100），请补充更清晰商品图。",
    msgLowSubject: "检测到主体占比不足 40%，请上传主体更聚焦的商品图。",
    msgArtifact: "疑似压缩伪影较重，请上传高质量原图后继续。",
    msgNeedPoints: "您产品的核心优势是？可选：{options}",
    msgTooManyPoints: "卖点建议填写 1-6 个关键词，请精简后再生成。",
    msgNeedTarget: "请补充目标用户（例如：学生/白领/健身人群）。",
    msgNeedRegion: "请补充销售地区，用于语言和模特风格适配。",
    msgScriptGenerated: "已根据 PRD 生成脚本，并完成基础质量门槛校验。",
    msgScriptHint: "可先点击 generate task name，或输入 script 生成分镜。",
    msgBackendFallback: "后端不可用：{error}。已回退到本地助手。",
    msgEnableBackendForExport: "请开启 Use backend API 后执行真实导出。",
    msgStartExport: "开始执行视频导出，先提交 Veo 任务...",
    msgTaskSubmitted: "任务已提交：{name}",
    msgExportPolling: "导出中... 第 {rounds} 次轮询",
    msgPollFailed: "轮询失败：{error}",
    msgExportSubmitFailed: "导出提交失败：{error}",
    msgExportDoneLoaded: "导出完成，视频已加载到预览区。",
    msgExportDoneNoPlayable: "任务完成，但未找到可播放视频链接。",
    msgTaskReset: "Shoplive 任务已重置。请先上传 1-3 张商品高清图。",
    msgFlowDirect: "已走“有商品图直接生成视频”路径。请上传商品图后直接开始视频生成。",
    msgFlowDraft: "收到你的需求草稿：\"{draft}\"。请先补全 PRD 输入后再生成。",
    msgFlowWelcome: "欢迎使用 Shoplive。请上传 1-3 张商品高清图并填写卖点。",
    msgInputCanonicalized: "已按后端规则标准化输入：{fields}",
    errBackendUrlRequired: "需要填写后端地址（Backend URL）。",
    errModelRequired: "需要填写模型名（Model）。",
    errProjectIdRequired: "需要填写项目ID（Project ID）。",
    errStartVeoFailed: "Veo 任务提交失败。",
    errFetchVeoFailed: "获取 Veo 状态失败。",
    errNoTextResponse: "后端未返回可用文本内容。",
    syncExportFailed: "导出失败",
    uploadHint: "请先上传商品图片（必须上传，支持 1-3 张高清图）。",
    timelineSelected: "已选中：{track} / {seg}",
    gateNotReady: "未就绪",
    gateNoImages: "缺少图片",
    gateTooMany: "图片过多",
    gateLowRes: "分辨率不足",
    gateLowSharpness: "清晰度不足",
    gateLowSubject: "主体占比不足",
    gateArtifact: "压缩风险",
    gateNeedPoints: "需要卖点",
    gateTooManyPoints: "卖点过多",
    gateNeedTarget: "缺少目标用户",
    gateNeedRegion: "缺少地区",
    gateReady: "已就绪",
    flowValidate: "校验",
    flowClarify: "追问",
    flowScript: "脚本",
    flowSelfcheck: "自评",
    flowExport: "导出",
    msgSelfcheckPass: "脚本自评通过：镜头脚本、BGM、标题、文案完整。",
    msgSelfcheckFail: "脚本自评未通过：缺少 {missing}，请先补全脚本后再导出。",
  },
  en: {
    task: "+ New Task",
    taskUntitled: "Untitled Task",
    accountPlan: "Free",
    panelFootage: "Footage",
    uploadBtn: "Upload",
    prdGate: "PRD Gate",
    noAssets: "No Assets",
    dropHint: "Drop files or click upload",
    prdInputs: "PRD Inputs",
    sellingPointsLabel: "Selling points (1-6)",
    targetUserLabel: "Target users",
    salesRegionLabel: "Sales region",
    styleTemplateLabel: "Style template",
    tplClean: "Clean Product",
    tplLifestyle: "Lifestyle",
    tplPremium: "Premium",
    tplSocial: "Social Ads",
    videoDurationLabel: "Video duration",
    ratioLabel: "Aspect ratio",
    needModelLabel: "Model showcase (enabled by default)",
    panelVideo: "Video",
    exportBtn: "Generate Video",
    noPreview: "No Preview",
    assetsLoaded: "Assets Loaded",
    dragReorderHint: "Drag to reorder; rename/delete per item",
    previewHint: "Upload clips and send command to generate timeline.",
    splitSegment: "Split Segment",
    deleteSegment: "Delete Segment",
    timelineHintDefault: "Select a segment to edit",
    syncing: "Syncing...",
    storyboardSynced: "Storyboard synced",
    scriptUpdated: "Script Updated",
    syncedViaApi: "Synced via API",
    exporting: "Exporting...",
    exportComplete: "Export complete",
    markdownEditor: "Markdown Editor",
    online: "Online",
    useBackendApi: "Use backend API",
    llmApiBasePh: "LiteLLM URL (e.g. https://litellm.shoplazza.site)",
    llmApiKeyPh: "LiteLLM API Key (Bearer ...)",
    backendUrlPh: "Backend URL (e.g. http://127.0.0.1:8000)",
    projectIdPh: "Project ID (e.g. gemini-sl-20251120)",
    proxyPh: "Proxy (optional)",
    storageUriPh: "gs://bucket/path (optional)",
    qaGenerateTask: "generate task name",
    qaEditShots: "edit shots",
    qaUpdateTrack: "update track",
    chatToolAssets: "Assets",
    chatToolLink: "Link",
    chatPlaceholder: "Tell Shoplive what you want to do...",
    assetsCount: "{count} assets",
    msgAssetUploaded: "{count} asset(s) uploaded. Shoplive is analyzing product assets.",
    msgReceivedQualityReport: "Image quality report received: {report}",
    msgReceivedGeneratedImage: "Generated image received. Entering video generation stage.",
    msgNeedImages: "Please upload product images first (required, 1-3 HD images).",
    msgTooManyImages: "More than 3 product images detected. Keep 1-3 core HD images.",
    msgLowRes: "Image resolution is too low. Please upload at least 1024x1024 images.",
    msgLowSharpness: "Image sharpness is insufficient (Laplacian variance < 100). Please upload clearer images.",
    msgLowSubject: "Subject ratio is below 40%. Please upload images with clearer subject focus.",
    msgArtifact: "Compression artifacts detected. Please upload higher-quality source images.",
    msgNeedPoints: "What are your core product advantages? Options: {options}",
    msgTooManyPoints: "Selling points should be 1-6 keywords. Please simplify before generating.",
    msgNeedTarget: "Please provide target users (e.g., students/office workers/fitness users).",
    msgNeedRegion: "Please provide sales region for language and model style adaptation.",
    msgScriptGenerated: "Script generated from PRD and baseline quality checks passed.",
    msgScriptHint: "Click generate task name first, or type script to generate storyboard.",
    msgBackendFallback: "Backend unavailable: {error}. Falling back to local assistant.",
    msgEnableBackendForExport: "Enable Use backend API before real export.",
    msgStartExport: "Starting video export and submitting Veo task...",
    msgTaskSubmitted: "Task submitted: {name}",
    msgExportPolling: "Exporting... polling round {rounds}",
    msgPollFailed: "Polling failed: {error}",
    msgExportSubmitFailed: "Export submission failed: {error}",
    msgExportDoneLoaded: "Export complete. Video is loaded in preview.",
    msgExportDoneNoPlayable: "Task finished, but no playable video URL was found.",
    msgTaskReset: "Shoplive task reset. Please upload 1-3 HD product images first.",
    msgFlowDirect: "Direct-upload flow enabled. Upload product images and start video generation.",
    msgFlowDraft: "Draft received: \"{draft}\". Please complete PRD inputs before generation.",
    msgFlowWelcome: "Welcome to Shoplive. Please upload 1-3 HD product images and fill in selling points.",
    msgInputCanonicalized: "Input normalized by backend rules: {fields}",
    errBackendUrlRequired: "Backend URL is required.",
    errModelRequired: "Model is required.",
    errProjectIdRequired: "Project ID is required.",
    errStartVeoFailed: "Failed to start Veo task.",
    errFetchVeoFailed: "Failed to fetch Veo status.",
    errNoTextResponse: "No text response from backend API.",
    syncExportFailed: "Export failed",
    uploadHint: "Upload 1-3 HD product images first.",
    timelineSelected: "Selected: {track} / {seg}",
    gateNotReady: "Not Ready",
    gateNoImages: "No Images",
    gateTooMany: "Too Many",
    gateLowRes: "Low Resolution",
    gateLowSharpness: "Low Sharpness",
    gateLowSubject: "Low Subject",
    gateArtifact: "Artifact Risk",
    gateNeedPoints: "Need Selling Points",
    gateTooManyPoints: "Points > 6",
    gateNeedTarget: "Need Target User",
    gateNeedRegion: "Need Region",
    gateReady: "Ready",
    flowValidate: "Validate",
    flowClarify: "Clarify",
    flowScript: "Script",
    flowSelfcheck: "Self-check",
    flowExport: "Export",
    msgSelfcheckPass: "Script self-check passed: storyboard, BGM, title, and copy are complete.",
    msgSelfcheckFail: "Script self-check failed: missing {missing}. Please complete script before export.",
  },
};

function t(key, vars = {}) {
  const template = i18n[currentLang]?.[key] ?? i18n.zh[key] ?? key;
  return Object.entries(vars).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), template);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function applyLang(lang) {
  currentLang = lang;
  localStorage.setItem("shoplive.lang", lang);
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.dataset.i18n;
    if (i18n[lang][key]) node.textContent = i18n[lang][key];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    const key = node.dataset.i18nPlaceholder;
    if (i18n[lang][key]) node.setAttribute("placeholder", i18n[lang][key]);
  });
  if (studioLangToggleBtn) studioLangToggleBtn.textContent = lang === "zh" ? "EN" : "中文";
  if (newTaskBtn) newTaskBtn.textContent = t("task");
  if (chatInput) chatInput.placeholder = t("chatPlaceholder");
}

function formatTime(value) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const mins = String(Math.floor(safe / 60)).padStart(2, "0");
  const secs = String(safe % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function updateTimecode(current = 0, total = currentDuration) {
  timecode.textContent = `${formatTime(current)} / ${formatTime(total)}`;
}

function updateCounter() {
  scriptCounter.textContent = `${scriptEditor.value.length} characters`;
}

function pushMessage(role, content) {
  const item = document.createElement("article");
  item.className = `message ${role}`;
  item.textContent = content;
  messageList.appendChild(item);
  messageList.scrollTop = messageList.scrollHeight;
}

function setPrdGate(status, text) {
  if (!prdGateBadge) return;
  prdGateBadge.classList.remove("ok", "warn", "bad");
  prdGateBadge.classList.add(status);
  prdGateBadge.textContent = text;
}

function setStep(step, state) {
  workflowState[step] = state;
  renderWorkflowStatus();
}

function resetFlow() {
  workflowState.validate = "pending";
  workflowState.clarify = "pending";
  workflowState.script = "pending";
  workflowState.selfcheck = "pending";
  workflowState.export = "pending";
  renderWorkflowStatus();
}

function renderWorkflowStatus() {
  const mapping = [
    [statusValidate, workflowState.validate],
    [statusClarify, workflowState.clarify],
    [statusScript, workflowState.script],
    [statusSelfcheck, workflowState.selfcheck],
    [statusExport, workflowState.export],
  ];
  mapping.forEach(([el, state]) => {
    if (!el) return;
    el.classList.remove("done", "active", "failed");
    if (state === "done") el.classList.add("done");
    else if (state === "active") el.classList.add("active");
    else if (state === "failed") el.classList.add("failed");
  });
}

function safeFileType(file) {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  return "unknown";
}

async function measureImageQuality(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || 0;
      const height = img.naturalHeight || 0;
      const canvas = document.createElement("canvas");
      const maxW = 256;
      const scale = width > maxW ? maxW / width : 1;
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

      let lapSum = 0;
      let alphaCount = 0;
      let opaqueCount = 0;
      const getGray = (x, y) => {
        const i = (y * canvas.width + x) * 4;
        return 0.299 * imageData[i] + 0.587 * imageData[i + 1] + 0.114 * imageData[i + 2];
      };

      for (let y = 1; y < canvas.height - 1; y++) {
        for (let x = 1; x < canvas.width - 1; x++) {
          const i = (y * canvas.width + x) * 4;
          const alpha = imageData[i + 3];
          alphaCount += 1;
          if (alpha > 20) opaqueCount += 1;
          const lap =
            4 * getGray(x, y) - getGray(x - 1, y) - getGray(x + 1, y) - getGray(x, y - 1) - getGray(x, y + 1);
          lapSum += lap * lap;
        }
      }

      const sharpness = lapSum / Math.max(1, (canvas.width - 2) * (canvas.height - 2));
      const subjectRatio = opaqueCount / Math.max(1, alphaCount);
      resolve({ width, height, sharpness, subjectRatio });
    };
    img.onerror = () => resolve({ width: 0, height: 0, sharpness: 0, subjectRatio: 0 });
    img.src = url;
  });
}

function resetPreview() {
  previewVideo.pause();
  previewVideo.removeAttribute("src");
  previewImage.removeAttribute("src");
  previewVideo.classList.remove("visible");
  previewImage.classList.remove("visible");
  previewStatus.style.display = "block";
  updateTimecode(0, currentDuration);
  playPauseBtn.textContent = "▶";
}

function setActiveAsset(assetId) {
  activeAssetId = assetId;
  const selected = assets.find((item) => item.id === assetId);
  document.querySelectorAll(".asset-item").forEach((node) => {
    node.classList.toggle("active", node.dataset.assetId === assetId);
  });
  if (!selected) return;

  if (selected.type === "video") {
    previewImage.classList.remove("visible");
    previewVideo.src = selected.url;
    previewVideo.classList.add("visible");
    previewStatus.style.display = "none";
    previewHint.textContent =
      currentLang === "zh" ? "视频已加载，可在下方时间线继续裁剪。" : "Video loaded. You can trim timeline segments below.";
    previewVideo.onloadedmetadata = () => {
      currentDuration = Math.max(1, Math.floor(previewVideo.duration || 20));
      updateTimecode(0, currentDuration);
    };
  } else {
    previewVideo.classList.remove("visible");
    previewVideo.pause();
    previewImage.src = selected.url;
    previewImage.classList.add("visible");
    previewStatus.style.display = "none";
    previewHint.textContent =
      currentLang === "zh"
        ? "图片已加载，Shoplive AI 可继续生成场景与模特行为。"
        : "Image loaded. Shoplive AI can generate scenario + model behavior.";
    currentDuration = 20;
    updateTimecode(0, currentDuration);
  }
}

function moveAssetToIndex(assetId, targetIndex) {
  const fromIndex = assets.findIndex((item) => item.id === assetId);
  if (fromIndex < 0 || targetIndex < 0 || targetIndex >= assets.length) return;
  const [moved] = assets.splice(fromIndex, 1);
  assets.splice(targetIndex, 0, moved);
  renderAssets();
}

function renameAsset(assetId) {
  const target = assets.find((item) => item.id === assetId);
  if (!target) return;
  const nextName = window.prompt(currentLang === "zh" ? "重命名素材" : "Rename asset", target.name);
  if (!nextName) return;
  target.name = nextName.trim() || target.name;
  renderAssets();
}

function deleteAsset(assetId) {
  const index = assets.findIndex((item) => item.id === assetId);
  if (index < 0) return;
  const [removed] = assets.splice(index, 1);
  URL.revokeObjectURL(removed.url);
  if (activeAssetId === assetId) activeAssetId = assets[0]?.id || null;
  renderAssets();
}

function inferPointOptions() {
  const names = assets.map((item) => item.name.toLowerCase()).join(" ");
  const options = new Set();
  if (/mask|skin|cream|serum|护肤|面膜/.test(names)) ["补水", "温和配方", "肤感细腻"].forEach((x) => options.add(x));
  if (/bottle|cup|水杯|杯/.test(names)) ["保温", "便携", "防漏"].forEach((x) => options.add(x));
  if (/shoe|sport|运动|健身/.test(names)) ["轻量", "防滑", "舒适"].forEach((x) => options.add(x));
  if (!options.size) ["高清展示", "核心卖点突出", "购买转化导向"].forEach((x) => options.add(x));
  return Array.from(options).slice(0, 3);
}

function renderPointSuggestions(options) {
  pointSuggestions.innerHTML = "";
  options.forEach((option) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = option;
    btn.addEventListener("click", () => {
      const current = sellingPointsInput.value.trim();
      if (!current) sellingPointsInput.value = option;
      else if (!current.includes(option)) sellingPointsInput.value = `${current}、${option}`;
    });
    pointSuggestions.appendChild(btn);
  });
}

function createAssetRow(item, index) {
  const row = document.createElement("div");
  row.className = "asset-item";
  row.dataset.assetId = item.id;
  row.draggable = true;
  row.innerHTML = `
    <div class="asset-main">
      <img class="asset-thumb" src="${item.thumb}" alt="${item.name}" />
      <div class="asset-meta">
        <span class="asset-name">${item.name}</span>
        <span class="asset-sub">${item.typeLabel}</span>
      </div>
    </div>
    <div class="asset-actions">
      <span class="asset-badge">${currentLang === "zh" ? "已分析" : "Analyzed"}</span>
      <button data-action="rename" title="Rename">✎</button>
      <button data-action="delete" title="Delete">✕</button>
    </div>
  `;

  row.addEventListener("click", (event) => {
    if (event.target.closest("button[data-action]")) return;
    setActiveAsset(item.id);
  });
  row.addEventListener("dragstart", () => {
    draggingAssetId = item.id;
  });
  row.addEventListener("dragover", (event) => event.preventDefault());
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    if (!draggingAssetId || draggingAssetId === item.id) return;
    moveAssetToIndex(draggingAssetId, index);
    draggingAssetId = null;
  });
  row.addEventListener("dragend", () => {
    draggingAssetId = null;
  });
  row.querySelector('[data-action="rename"]').addEventListener("click", (event) => {
    event.stopPropagation();
    renameAsset(item.id);
  });
  row.querySelector('[data-action="delete"]').addEventListener("click", (event) => {
    event.stopPropagation();
    deleteAsset(item.id);
  });
  return row;
}

function renderAssets() {
  assetList.innerHTML = "";
  if (!assets.length) {
    uploadBox.querySelector("p").textContent = t("noAssets");
    uploadBox.querySelector("small").textContent = t("dropHint");
    resetPreview();
    previewStatus.textContent = t("noPreview");
    previewHint.textContent = i18n[currentLang].uploadHint;
    renderPointSuggestions(inferPointOptions());
    return;
  }
  uploadBox.querySelector("p").textContent = t("assetsCount", { count: assets.length });
  uploadBox.querySelector("small").textContent = t("dragReorderHint");
  previewStatus.textContent = t("assetsLoaded");
  assets.forEach((item, index) => assetList.appendChild(createAssetRow(item, index)));
  renderPointSuggestions(inferPointOptions());
  if (!activeAssetId || !assets.some((item) => item.id === activeAssetId)) setActiveAsset(assets[0].id);
  else setActiveAsset(activeAssetId);
}

async function ingestFiles(fileList) {
  const picked = Array.from(fileList || []);
  if (!picked.length) return;
  for (const file of picked) {
    const type = safeFileType(file);
    if (type === "unknown") continue;
    assetCount += 1;
    const url = URL.createObjectURL(file);
    const item = {
      id: `asset-${assetCount}`,
      name: file.name,
      url,
      thumb: url,
      type,
      fileSize: file.size,
      typeLabel: type === "video" ? "Video Clip" : "Image Asset",
      quality: null,
    };
    if (type === "image") item.quality = await measureImageQuality(url);
    assets.unshift(item);
  }
  renderAssets();
  pushMessage("assistant", t("msgAssetUploaded", { count: picked.length }));
}

function ingestGeneratedImageFromSession() {
  const raw = sessionStorage.getItem("shoplive.generatedImage");
  if (!raw) return;
  try {
    const payload = JSON.parse(raw);
    const dataUrl = payload?.imageDataUrl;
    if (!dataUrl) return;
    assetCount += 1;
    const generatedQuality = payload?.generatedImageQuality || null;
    const initialQuality =
      generatedQuality && Number(generatedQuality.width) > 0
        ? {
            width: Number(generatedQuality.width) || 0,
            height: Number(generatedQuality.height) || 0,
            sharpness: Number(generatedQuality.sharpness) || 0,
            subjectRatio: Number(generatedQuality.subjectRatio) || 0,
          }
        : null;
    const generatedAssetName = payload?.productName ? `${payload.productName}.png` : "generated_product_image.png";
    assets.unshift({
      id: `asset-${assetCount}`,
      name: generatedAssetName,
      url: dataUrl,
      thumb: dataUrl,
      type: "image",
      fileSize: 1024 * 512,
      typeLabel: "Generated Image",
      quality: initialQuality,
      isGenerated: true,
    });
    if (payload?.sellingPoints) sellingPointsInput.value = payload.sellingPoints;
    if (payload?.targetUser) targetUserInput.value = payload.targetUser;
    if (payload?.salesRegion) salesRegionInput.value = payload.salesRegion;
    if (typeof payload?.needModel === "boolean") needModelToggle.checked = payload.needModel;
    if (payload?.template) {
      selectedTemplate = payload.template;
      templateButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.template === selectedTemplate));
    }
    if (payload?.duration) {
      const target = document.querySelector(`input[name="duration"][value="${payload.duration}"]`);
      if (target) target.checked = true;
      veoDurationInput.value = String(payload.duration);
    }
    renderAssets();
    if (!initialQuality) {
      const target = assets.find((a) => a.id === `asset-${assetCount}`);
      if (target) {
        measureImageQuality(dataUrl)
          .then((q) => {
            target.quality = q;
            renderAssets();
          })
          .catch(() => {});
      }
    }
    if (payload?.shotPreview) {
      scriptEditor.value = payload.shotPreview;
      updateCounter();
      scriptSync.textContent = t("storyboardSynced");
      setStep("script", "done");
      callBackendWorkflow("pre_export_check", scriptEditor.value)
        .then((res) => {
          if (res?.selfcheck?.ok) setStep("selfcheck", "done");
          else setStep("selfcheck", "failed");
        })
        .catch(() => {
          setStep("selfcheck", "failed");
        });
    }
    if (Array.isArray(payload?.qualityReports) && payload.qualityReports.length) {
      const reportText = payload.qualityReports
        .map((r) => `${r.name}: ${r.width}x${r.height}, Lap ${Number(r.sharpness).toFixed(1)}, Subject ${(
          Number(r.subjectRatio) * 100
        ).toFixed(1)}%`)
        .join(" | ");
      pushMessage("assistant", t("msgReceivedQualityReport", { report: reportText }));
    }
    pushMessage("assistant", t("msgReceivedGeneratedImage"));
  } catch (_error) {
    // ignore parse errors
  } finally {
    sessionStorage.removeItem("shoplive.generatedImage");
  }
}

function getSegByIds(trackIndex, segId) {
  const track = timelineModel[trackIndex];
  if (!track) return null;
  return track.segments.find((seg) => seg.id === segId) || null;
}

function applySegStyle(element, segment) {
  element.style.left = `${segment.left}%`;
  element.style.width = `${segment.width}%`;
}

function setSelectedSegment(trackIndex, segId) {
  selectedSegment = { trackIndex, segId };
  document.querySelectorAll(".track-seg").forEach((el) => {
    const active = Number(el.dataset.trackIndex) === trackIndex && el.dataset.segId === segId;
    el.classList.toggle("active", active);
  });
  timelineHint.textContent = t("timelineSelected", { track: timelineModel[trackIndex].label, seg: segId });
}

function beginTimelineDrag(event, mode, trackIndex, segId, segEl, barEl) {
  event.preventDefault();
  const seg = getSegByIds(trackIndex, segId);
  if (!seg) return;
  setSelectedSegment(trackIndex, segId);
  const rect = barEl.getBoundingClientRect();
  timelineDragState = {
    mode,
    trackIndex,
    segId,
    segEl,
    rect,
    startX: event.clientX,
    startLeft: seg.left,
    startWidth: seg.width,
  };
}

function onTimelineMouseMove(event) {
  if (!timelineDragState) return;
  const state = timelineDragState;
  const seg = getSegByIds(state.trackIndex, state.segId);
  if (!seg) return;
  const deltaPct = ((event.clientX - state.startX) / state.rect.width) * 100;
  if (state.mode === "move") seg.left = Math.max(0, Math.min(100 - seg.width, state.startLeft + deltaPct));
  else seg.width = Math.max(4, Math.min(100 - seg.left, state.startWidth + deltaPct));
  applySegStyle(state.segEl, seg);
}

function onTimelineMouseUp() {
  timelineDragState = null;
}

function splitSelectedSegment() {
  if (!selectedSegment) return;
  const { trackIndex, segId } = selectedSegment;
  const track = timelineModel[trackIndex];
  const index = track.segments.findIndex((seg) => seg.id === segId);
  if (index < 0) return;
  const seg = track.segments[index];
  if (seg.width < 10) return;
  const half = seg.width / 2;
  seg.width = half;
  const newSeg = { id: `${seg.id}-b${Date.now()}`, title: seg.title, left: seg.left + half, width: half, color: seg.color };
  track.segments.splice(index + 1, 0, newSeg);
  renderTimeline();
  setSelectedSegment(trackIndex, newSeg.id);
}

function deleteSelectedSegment() {
  if (!selectedSegment) return;
  const { trackIndex, segId } = selectedSegment;
  const track = timelineModel[trackIndex];
  const index = track.segments.findIndex((seg) => seg.id === segId);
  if (index < 0 || track.segments.length <= 1) return;
  track.segments.splice(index, 1);
  renderTimeline();
  selectedSegment = null;
  timelineHint.textContent = t("timelineHintDefault");
}

function renderTimeline() {
  timelineTracks.innerHTML = "";
  timelineModel.forEach((track, trackIndex) => {
    const row = document.createElement("div");
    row.className = "track";
    const label = document.createElement("span");
    label.className = "track-label";
    label.textContent = track.label;
    const bar = document.createElement("div");
    bar.className = "track-bar";
    track.segments.forEach((seg) => {
      const segEl = document.createElement("div");
      segEl.className = "track-seg";
      segEl.dataset.segId = seg.id;
      segEl.dataset.trackIndex = String(trackIndex);
      segEl.textContent = seg.title;
      segEl.style.background = seg.color;
      applySegStyle(segEl, seg);
      const handle = document.createElement("span");
      handle.className = "seg-resize";
      segEl.appendChild(handle);
      segEl.addEventListener("mousedown", (event) => {
        const mode = event.target.classList.contains("seg-resize") ? "resize" : "move";
        beginTimelineDrag(event, mode, trackIndex, seg.id, segEl, bar);
      });
      segEl.addEventListener("click", (event) => {
        event.stopPropagation();
        setSelectedSegment(trackIndex, seg.id);
      });
      bar.appendChild(segEl);
    });
    bar.addEventListener("click", () => {
      selectedSegment = null;
      timelineHint.textContent = t("timelineHintDefault");
      document.querySelectorAll(".track-seg").forEach((el) => el.classList.remove("active"));
    });
    row.appendChild(label);
    row.appendChild(bar);
    timelineTracks.appendChild(row);
  });
}

function getDurationSelection() {
  const node = document.querySelector('input[name="duration"]:checked');
  return node ? Number(node.value) : 10;
}

async function ensurePrdRequirements() {
  setStep("validate", "active");
  if (workflowState.clarify !== "done") setStep("clarify", "pending");
  setStep("script", "pending");
  setStep("selfcheck", "pending");
  setStep("export", "pending");
  const result = await callBackendWorkflow("validate");
  if (!result?.ready) {
    setStep("validate", "failed");
    setStep("clarify", "active");
    applyValidationIssues(result?.validation?.issues || []);
    return { ok: false, backend: result };
  }
  setPrdGate("ok", t("gateReady"));
  setStep("validate", "done");
  setStep("clarify", "done");
  setStep("script", "active");
  const n = result?.normalized_input || {};
  return {
    ok: true,
    backend: result,
    brief: {
      sellingPoints: n.selling_points || [],
      targetUser: n.target_user || "",
      region: n.sales_region || "",
      template: n.template || "clean",
      duration: n.duration || 10,
      aspectRatio: n.aspect_ratio || "16:9",
      needModel: Boolean(n.need_model),
    },
  };
}

function buildGenerationPrompt(brief) {
  const modelMap = {
    skincare: "干净妆容模特",
    sports: "健身模特",
    tech: "专业感模特",
    daily: "生活感模特",
  };
  let productType = "daily";
  const nameBundle = assets.map((a) => a.name.toLowerCase()).join(" ");
  if (/mask|skin|serum|护肤|面膜/.test(nameBundle)) productType = "skincare";
  else if (/sport|fitness|运动|健身/.test(nameBundle)) productType = "sports";
  else if (/phone|tech|电子|科技/.test(nameBundle)) productType = "tech";

  const modelStyle = brief.needModel ? modelMap[productType] : "无模特展示";
  return `
请按电商商品视频专家模式生成：
- 商品卖点：${brief.sellingPoints.join("、")}
- 目标用户：${brief.targetUser}
- 销售地区：${brief.region}
- 模版风格：${brief.template}
- 视频时长：${brief.duration}s
- 画幅：${brief.aspectRatio}
- 模特策略：${modelStyle}
请输出：
1) 镜头脚本（镜头1/镜头2/镜头3）
2) BGM建议
3) 标题
4) 文案
并先做内部质量评估标准：商品清晰、不变形、展示完整。
`.trim();
}

function buildWorkflowInput() {
  const imageAssets = assets.filter((item) => item.type === "image");
  const qualityReports = imageAssets
    .filter((img) => img?.quality)
    .map((img) => ({
      width: img?.quality?.width || 0,
      height: img?.quality?.height || 0,
      sharpness: img?.quality?.sharpness || 0,
      subjectRatio: img?.quality?.subjectRatio || 0,
      is_generated: Boolean(img?.isGenerated),
    }));
  const firstAssetName = (assets[0]?.name || "").replace(/\.[a-z0-9]+$/i, "").trim();
  const inferredProductName = firstAssetName || "product";
  return {
    product_name: inferredProductName,
    main_category: inferredProductName || "ecommerce product",
    selling_points: sellingPointsInput.value,
    target_user: targetUserInput.value.trim(),
    sales_region: salesRegionInput.value.trim(),
    template: selectedTemplate,
    duration: getDurationSelection(),
    aspect_ratio: "16:9",
    need_model: needModelToggle.checked,
    image_count: imageAssets.length,
    quality_reports: qualityReports,
  };
}

function normalizeVeoDuration(rawValue) {
  const n = Number(rawValue);
  if ([4, 6, 8].includes(n)) return { value: n, adjusted: false };
  return { value: 8, adjusted: true };
}

function sanitizePromptForVeo(rawPrompt) {
  let text = String(rawPrompt || "").trim();
  if (!text) return "";
  const replacements = [
    [/少女/g, "成年女性"],
    [/未成年/g, "成年"],
    [/政治敏感/g, "合规"],
    [/低俗/g, "不当内容"],
    [/暴力/g, "冲突"],
    [/畸形手/g, "异常肢体"],
    [/他牌标识/g, "其他品牌标识"],
    [/二维码/g, "识别码"],
  ];
  replacements.forEach(([from, to]) => {
    text = text.replace(from, to);
  });
  // Remove policy-style checklist lines which may trigger filter but are not needed for generation.
  text = text
    .split(/\n+/)
    .filter((line) => !/(禁用词|合规要求|政治|低俗|暴力|allowlisting|support codes)/i.test(line))
    .join("\n")
    .trim();
  return text.slice(0, 1600);
}

function buildUltraSafeVeoPrompt(brief) {
  const points = (brief?.sellingPoints || []).slice(0, 3).join("、") || "核心卖点";
  return [
    `16:9 ecommerce product video, 8 seconds, cinematic studio lighting.`,
    `Product must stay consistent with the uploaded product image, no category drift.`,
    `Show only this product and relevant usage context.`,
    `Selling points: ${points}.`,
    `Target audience: ${brief?.targetUser || "online shoppers"}. Region: ${brief?.region || "global"}.`,
    `Clean composition, smooth camera movement, clear product details, conversion-oriented ending.`,
  ].join(" ");
}

function isResponsibleAiPolicyError(msg) {
  const txt = String(msg || "");
  return /Responsible AI|sensitive words|allowlisting|support codes/i.test(txt);
}

async function ensureImageDataUrl(url) {
  const src = String(url || "").trim();
  if (!src) return "";
  if (/^data:image\/(?:png|jpeg);base64,/i.test(src)) return src;
  const resp = await fetch(src);
  if (!resp.ok) throw new Error(`Failed to read image asset: ${resp.status}`);
  const blob = await resp.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to convert image asset to data URL"));
    reader.readAsDataURL(blob);
  });
}

async function buildVeoImageInputFromAssets() {
  const imageAsset = assets.find((item) => item.type === "image");
  if (!imageAsset) return null;
  const dataUrl = await ensureImageDataUrl(imageAsset.url);
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  return {
    veo_mode: "image",
    image_mime_type: m[1].toLowerCase(),
    image_base64: m[2],
    image_asset_name: imageAsset.name || "image",
  };
}

function applyValidationIssues(issues = []) {
  if (!Array.isArray(issues) || !issues.length) return;
  const issue = issues[0];
  const mapping = {
    NO_IMAGES: ["bad", t("gateNoImages"), t("msgNeedImages")],
    TOO_MANY_IMAGES: ["warn", t("gateTooMany"), t("msgTooManyImages")],
    LOW_RESOLUTION: ["bad", t("gateLowRes"), t("msgLowRes")],
    LOW_SHARPNESS: ["bad", t("gateLowSharpness"), t("msgLowSharpness")],
    LOW_SUBJECT: ["bad", t("gateLowSubject"), t("msgLowSubject")],
    NEED_SELLING_POINTS: ["warn", t("gateNeedPoints"), t("msgNeedPoints", { options: inferPointOptions().join(" / ") })],
    TOO_MANY_POINTS: ["warn", t("gateTooManyPoints"), t("msgTooManyPoints")],
    NEED_TARGET_USER: ["warn", t("gateNeedTarget"), t("msgNeedTarget")],
    NEED_REGION: ["warn", t("gateNeedRegion"), t("msgNeedRegion")],
  };
  const picked = mapping[issue];
  if (!picked) return;
  setPrdGate(picked[0], picked[1]);
  pushMessage("assistant", picked[2]);
}

async function callBackendVeoExport(prompt) {
  const backendUrl = (backendUrlInput.value || "").trim().replace(/\/+$/, "");
  const projectId = (projectIdInput.value || "").trim();
  const proxy = (proxyInput.value || "").trim();
  const model = (veoModelInput.value || "").trim();
  const storageUri = (storageUriInput.value || "").trim();
  const durationRaw = (veoDurationInput.value || "8").trim();
  const durationNorm = normalizeVeoDuration(durationRaw);
  const duration = durationNorm.value;
  const aspectRatio = (veoAspectRatioInput.value || "16:9").trim();
  if (!backendUrl) throw new Error(t("errBackendUrlRequired"));
  if (!projectId) throw new Error(t("errProjectIdRequired"));
  const imageInput = await buildVeoImageInputFromAssets();
  const veoMode = imageInput?.veo_mode || "text";

  const startResp = await fetchWithTimeout(`${backendUrl}/api/veo/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      proxy,
      model,
      prompt: prompt.slice(0, 1800),
      sample_count: 1,
      veo_mode: veoMode,
      image_base64: imageInput?.image_base64,
      image_mime_type: imageInput?.image_mime_type,
      storage_uri: storageUri || undefined,
      duration_seconds: duration,
      aspect_ratio: aspectRatio,
    }),
  }, 25000);
  const startData = await startResp.json();
  if (!startResp.ok || !startData?.operation_name) {
    throw new Error(startData?.error || t("errStartVeoFailed"));
  }
  return {
    backendUrl,
    projectId,
    proxy,
    model,
    operationName: startData.operation_name,
    durationUsed: duration,
    durationAdjusted: durationNorm.adjusted,
    veoModeUsed: veoMode,
    imageAssetName: imageInput?.image_asset_name || "",
  };
}

async function callBackendWorkflow(action, scriptText = "") {
  const backendUrl = (backendUrlInput.value || "").trim().replace(/\/+$/, "");
  const model = (modelInput.value || "").trim();
  const proxy = (proxyInput.value || "").trim();
  const apiBase = (llmApiBaseInput?.value || "").trim();
  const apiKey = (llmApiKeyInput?.value || "").trim();
  if (!backendUrl) throw new Error(t("errBackendUrlRequired"));
  const resp = await fetchWithTimeout(
    `${backendUrl}/api/shoplive/video/workflow`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        input: buildWorkflowInput(),
        script_text: scriptText || undefined,
        user_message: scriptText || undefined,
        model: model || undefined,
        proxy: proxy || undefined,
        api_base: apiBase || undefined,
        api_key: apiKey || undefined,
      }),
    },
    25000
  );
  const data = await resp.json();
  if (!resp.ok || data?.ok === false) throw new Error(data?.error || `Backend returned ${resp.status}`);
  const changed = Object.keys(data?.input_diff || {});
  if (changed.length && data?.input_fingerprint !== lastCanonicalFingerprintNotified) {
    lastCanonicalFingerprintNotified = data?.input_fingerprint || "";
    pushMessage("assistant", t("msgInputCanonicalized", { fields: changed.join(", ") }));
  }
  return data;
}

async function pollVeoStatus(ctx) {
  const resp = await fetchWithTimeout(`${ctx.backendUrl}/api/veo/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: ctx.projectId,
      proxy: ctx.proxy,
      model: ctx.model,
      operation_name: ctx.operationName,
    }),
  }, 12000);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error || t("errFetchVeoFailed"));
  return data;
}

function bindExportedVideo(statusData) {
  const signedUrl = statusData?.signed_video_urls?.[0]?.url || "";
  const signedAnyUrl = statusData?.signed_all_urls?.[0]?.url || "";
  const inlineUrl = statusData?.inline_videos?.[0]?.data_url || "";
  const finalUrl = signedUrl || signedAnyUrl || inlineUrl;
  if (!finalUrl) return false;
  previewImage.classList.remove("visible");
  previewVideo.src = finalUrl;
  previewVideo.classList.add("visible");
  previewStatus.style.display = "none";
  previewHint.textContent = signedUrl
    ? currentLang === "zh"
      ? "已从签名地址加载导出视频。"
      : "Exported video loaded from signed URL."
    : signedAnyUrl
      ? currentLang === "zh"
        ? "已从签名地址加载导出文件。"
        : "Exported file loaded from signed URL."
      : currentLang === "zh"
        ? "已加载内联导出视频。"
        : "Exported inline video loaded.";
  previewVideo.onloadedmetadata = () => {
    currentDuration = Math.max(1, Math.floor(previewVideo.duration || currentDuration));
    updateTimecode(0, currentDuration);
  };
  setStep("export", "done");
  return true;
}

async function mockAssistantReply(inputText) {
  const text = inputText.toLowerCase();
  if (text.includes("script") || text.includes("文案")) {
    const checked = await ensurePrdRequirements();
    if (!checked.ok) return;
    const wf = await callBackendWorkflow("generate_script");
    if (!wf?.ready) {
      setStep("script", "failed");
      setStep("selfcheck", "failed");
      applyValidationIssues(wf?.validation?.issues || []);
      return;
    }
    scriptEditor.value = wf?.script || "";
    updateCounter();
    scriptSync.textContent = t("scriptUpdated");
    setStep("script", "done");
    const selfcheck = wf?.selfcheck || { ok: false, missing: [] };
    if (selfcheck.ok) {
      setStep("selfcheck", "done");
      setStep("export", "active");
      pushMessage("assistant", t("msgSelfcheckPass"));
    } else {
      setStep("selfcheck", "failed");
      pushMessage("assistant", t("msgSelfcheckFail", { missing: selfcheck.missing.join(", ") }));
    }
    pushMessage("assistant", t("msgScriptGenerated"));
    return;
  }
  pushMessage("assistant", t("msgScriptHint"));
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  pushMessage("user", text);
  chatInput.value = "";
  if (useApiToggle.checked) {
    try {
      const checked = await ensurePrdRequirements();
      if (!checked.ok) return;
      const wf = await callBackendWorkflow("generate_script", text);
      if (!wf?.ready) {
        setStep("script", "failed");
        setStep("selfcheck", "failed");
        applyValidationIssues(wf?.validation?.issues || []);
        return;
      }
      const content = wf?.script || "";
      if (content) {
        scriptEditor.value = content;
        updateCounter();
        setStep("script", "done");
        const selfcheck = wf?.selfcheck || { ok: false, missing: [] };
        if (selfcheck.ok) {
          setStep("selfcheck", "done");
          setStep("export", "active");
          pushMessage("assistant", t("msgSelfcheckPass"));
        } else {
          setStep("selfcheck", "failed");
          pushMessage("assistant", t("msgSelfcheckFail", { missing: selfcheck.missing.join(", ") }));
        }
        pushMessage("assistant", content);
      }
      scriptSync.textContent = t("syncedViaApi");
      return;
    } catch (error) {
      pushMessage("assistant", t("msgBackendFallback", { error: error.message }));
    }
  }
  window.setTimeout(() => {
    mockAssistantReply(text);
  }, 250);
}

async function handleExport() {
  const checked = await ensurePrdRequirements();
  if (!checked.ok) return;
  const precheck = await callBackendWorkflow("pre_export_check", scriptEditor.value);
  const selfcheck = precheck?.selfcheck || { ok: false, missing: [] };
  if (!precheck?.ready || !selfcheck.ok) {
    setStep("selfcheck", "failed");
    applyValidationIssues(precheck?.validation?.issues || []);
    pushMessage("assistant", t("msgSelfcheckFail", { missing: selfcheck.missing.join(", ") }));
    return;
  }
  setStep("selfcheck", "done");

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  try {
    exportBtn.classList.add("loading");
    exportBtn.disabled = true;
    setStep("export", "active");
    pushMessage("assistant", t("msgStartExport"));
    scriptSync.textContent = t("exporting");
    let prompt = "";
    const canonicalBrief = {
      sellingPoints: precheck?.normalized_input?.selling_points || checked.brief.sellingPoints,
      targetUser: precheck?.normalized_input?.target_user || checked.brief.targetUser,
      region: precheck?.normalized_input?.sales_region || checked.brief.region,
      template: precheck?.normalized_input?.template || checked.brief.template,
      duration: precheck?.normalized_input?.duration || checked.brief.duration,
      aspectRatio: precheck?.normalized_input?.aspect_ratio || checked.brief.aspectRatio,
      needModel:
        typeof precheck?.normalized_input?.need_model === "boolean"
          ? precheck.normalized_input.need_model
          : checked.brief.needModel,
    };
    try {
      const promptResult = await callBackendWorkflow("build_export_prompt", scriptEditor.value);
      prompt = (promptResult?.prompt || "").trim();
      if (!promptResult?.ready || !prompt) {
        throw new Error(promptResult?.error || t("errNoTextResponse"));
      }
    } catch (error) {
      pushMessage("assistant", `${t("msgBackendFallback", { error: error.message })}`);
      prompt = buildGenerationPrompt(canonicalBrief);
    }
    if (!prompt) {
      prompt = buildGenerationPrompt(canonicalBrief);
    }
    let promptPrimary = sanitizePromptForVeo(prompt);
    if (!promptPrimary) promptPrimary = sanitizePromptForVeo(buildGenerationPrompt(canonicalBrief));
    const promptSafe = buildUltraSafeVeoPrompt(canonicalBrief);
    let ctx = await callBackendVeoExport(promptPrimary);
    if (ctx.durationAdjusted) {
      pushMessage(
        "assistant",
        currentLang === "zh"
          ? `已将导出时长自动调整为 ${ctx.durationUsed}s（Veo 支持 4/6/8s）。`
          : `Duration auto-adjusted to ${ctx.durationUsed}s (Veo supports 4/6/8s).`
      );
      veoDurationInput.value = String(ctx.durationUsed);
    }
    if (ctx.veoModeUsed === "image") {
      pushMessage(
        "assistant",
        currentLang === "zh"
          ? `已启用图生视频模式，锁定商品一致性：${ctx.imageAssetName || "当前商品图"}。`
          : `Image-to-video mode enabled with product lock: ${ctx.imageAssetName || "current product image"}.`
      );
    }
    pushMessage("assistant", t("msgTaskSubmitted", { name: ctx.operationName }));

    let rounds = 0;
    let doneWithoutVideoRounds = 0;
    let policyRetried = false;
    pollTimer = setInterval(async () => {
      rounds += 1;
      try {
        const data = await pollVeoStatus(ctx);
        const done = Boolean(data?.response?.done);
        const opError =
          data?.response?.error?.message ||
          data?.response?.error?.details?.[0]?.message ||
          "";
        if (done && opError && isResponsibleAiPolicyError(opError) && !policyRetried) {
          policyRetried = true;
          clearInterval(pollTimer);
          pollTimer = null;
          pushMessage(
            "assistant",
            currentLang === "zh"
              ? "检测到 Responsible AI 拦截，已自动切换安全提示词重试一次..."
              : "Responsible AI block detected. Retrying once with safer prompt..."
          );
          ctx = await callBackendVeoExport(promptSafe);
          rounds = 0;
          doneWithoutVideoRounds = 0;
          pushMessage("assistant", t("msgTaskSubmitted", { name: ctx.operationName }));
          pollTimer = setInterval(async () => {
            rounds += 1;
            try {
              const data2 = await pollVeoStatus(ctx);
              const done2 = Boolean(data2?.response?.done);
              const opError2 =
                data2?.response?.error?.message ||
                data2?.response?.error?.details?.[0]?.message ||
                "";
              if (done2 && opError2) {
                clearInterval(pollTimer);
                pollTimer = null;
                scriptSync.textContent = t("syncExportFailed");
                setStep("export", "failed");
                pushMessage("assistant", t("msgPollFailed", { error: opError2 }));
                return;
              }
              const hasVideo2 = bindExportedVideo(data2);
              if (hasVideo2) {
                clearInterval(pollTimer);
                pollTimer = null;
                scriptSync.textContent = t("exportComplete");
                pushMessage("assistant", t("msgExportDoneLoaded"));
                return;
              }
              if (done2) {
                doneWithoutVideoRounds += 1;
                if (doneWithoutVideoRounds >= 5) {
                  clearInterval(pollTimer);
                  pollTimer = null;
                  scriptSync.textContent = t("exportComplete");
                  pushMessage("assistant", t("msgExportDoneNoPlayable"));
                  return;
                }
              }
              if (rounds % 2 === 0) {
                pushMessage("assistant", t("msgExportPolling", { rounds }));
              }
            } catch (error) {
              clearInterval(pollTimer);
              pollTimer = null;
              scriptSync.textContent = t("syncExportFailed");
              setStep("export", "failed");
              pushMessage("assistant", t("msgPollFailed", { error: error.message }));
            }
          }, 3000);
          return;
        }
        if (done && opError) {
          clearInterval(pollTimer);
          pollTimer = null;
          scriptSync.textContent = t("syncExportFailed");
          setStep("export", "failed");
          pushMessage("assistant", t("msgPollFailed", { error: opError }));
          return;
        }
        const hasVideo = bindExportedVideo(data);
        if (hasVideo) {
          clearInterval(pollTimer);
          pollTimer = null;
          scriptSync.textContent = t("exportComplete");
          pushMessage("assistant", t("msgExportDoneLoaded"));
          return;
        }
        if (done) {
          doneWithoutVideoRounds += 1;
          if (doneWithoutVideoRounds >= 5) {
            clearInterval(pollTimer);
            pollTimer = null;
            scriptSync.textContent = t("exportComplete");
            pushMessage("assistant", t("msgExportDoneNoPlayable"));
            return;
          }
        }
        if (rounds % 2 === 0) {
          pushMessage("assistant", t("msgExportPolling", { rounds }));
        }
      } catch (error) {
        clearInterval(pollTimer);
        pollTimer = null;
        scriptSync.textContent = t("syncExportFailed");
        setStep("export", "failed");
        pushMessage("assistant", t("msgPollFailed", { error: error.message }));
      }
    }, 3000);
  } catch (error) {
    scriptSync.textContent = t("syncExportFailed");
    setStep("export", "failed");
    pushMessage("assistant", t("msgExportSubmitFailed", { error: error.message }));
  } finally {
    exportBtn.classList.remove("loading");
    exportBtn.disabled = false;
  }
}

function resetTask() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  assets.forEach((item) => URL.revokeObjectURL(item.url));
  assets.splice(0, assets.length);
  activeAssetId = null;
  assetCount = 0;
  shotCount = 4;
  currentDuration = 20;
  selectedSegment = null;
  timelineHint.textContent = t("timelineHintDefault");
  scriptEditor.value = defaultScript;
  scriptSync.textContent = t("syncing");
  taskName.textContent = t("taskUntitled");
  messageList.innerHTML = "";
  sellingPointsInput.value = "";
  targetUserInput.value = "";
  salesRegionInput.value = "";
  needModelToggle.checked = true;
  selectedTemplate = "clean";
  resetFlow();
  templateButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.template === selectedTemplate));
  renderPointSuggestions(inferPointOptions());
  timelineModel[0].segments = [{ id: "video-1", title: "Shot 1", left: 2, width: 62, color: "#3f78ff" }];
  timelineModel[1].segments = [{ id: "voice-1", title: "VO", left: 18, width: 48, color: "#8c59ff" }];
  timelineModel[2].segments = [{ id: "sub-1", title: "Sub", left: 36, width: 40, color: "#ffaf31" }];
  timelineModel[3].segments = [{ id: "bgm-1", title: "BGM", left: 8, width: 58, color: "#ec4a6c" }];
  renderTimeline();
  renderAssets();
  updateCounter();
  pushMessage("assistant", t("msgTaskReset"));
}

uploadBtn.addEventListener("click", () => filePicker.click());
filePicker.addEventListener("change", (event) => ingestFiles(event.target.files));
uploadBox.addEventListener("dragover", (event) => {
  event.preventDefault();
  uploadBox.classList.add("dragover");
});
uploadBox.addEventListener("dragleave", () => uploadBox.classList.remove("dragover"));
uploadBox.addEventListener("drop", (event) => {
  event.preventDefault();
  uploadBox.classList.remove("dragover");
  ingestFiles(event.dataTransfer.files);
});
uploadBox.addEventListener("click", () => filePicker.click());

templateButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedTemplate = btn.dataset.template;
    templateButtons.forEach((item) => item.classList.toggle("active", item === btn));
  });
});

if (studioLangToggleBtn) {
  studioLangToggleBtn.addEventListener("click", () => applyLang(currentLang === "zh" ? "en" : "zh"));
}

sendBtn.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendMessage();
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    sendMessage();
  }
});
quickActionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    chatInput.value = button.dataset.prompt || "";
    sendMessage();
  });
});

scriptEditor.addEventListener("input", updateCounter);
exportBtn.addEventListener("click", handleExport);
newTaskBtn.addEventListener("click", resetTask);
splitSegBtn.addEventListener("click", splitSelectedSegment);
deleteSegBtn.addEventListener("click", deleteSelectedSegment);

playPauseBtn.addEventListener("click", () => {
  if (!previewVideo.classList.contains("visible")) return;
  if (previewVideo.paused) {
    previewVideo.play();
    playPauseBtn.textContent = "⏸";
  } else {
    previewVideo.pause();
    playPauseBtn.textContent = "▶";
  }
});
seekStartBtn.addEventListener("click", () => {
  if (!previewVideo.classList.contains("visible")) return;
  previewVideo.currentTime = 0;
  updateTimecode(0, currentDuration);
});
seekEndBtn.addEventListener("click", () => {
  if (!previewVideo.classList.contains("visible")) return;
  const target = Math.max(0, currentDuration - 0.1);
  previewVideo.currentTime = target;
  updateTimecode(target, currentDuration);
});
previewVideo.addEventListener("timeupdate", () => {
  updateTimecode(previewVideo.currentTime, currentDuration);
});
previewVideo.addEventListener("pause", () => {
  playPauseBtn.textContent = "▶";
});
previewVideo.addEventListener("play", () => {
  playPauseBtn.textContent = "⏸";
});

document.addEventListener("mousemove", onTimelineMouseMove);
document.addEventListener("mouseup", onTimelineMouseUp);

const params = new URLSearchParams(window.location.search);
const draft = params.get("draft");
const from = params.get("from");
if (from === "direct-upload") {
  taskName.textContent = currentLang === "zh" ? "Shoplive 视频任务" : "Shoplive Video Task";
  pushMessage("assistant", t("msgFlowDirect"));
  if (draft) {
    chatInput.value = draft.slice(0, 120);
  }
} else if (draft) {
  taskName.textContent = currentLang === "zh" ? "Shoplive 商品任务" : "Shoplive Product Task";
  pushMessage("assistant", t("msgFlowDraft", { draft }));
  chatInput.value = "Generate a 20s product script with hook and CTA";
} else {
  pushMessage("assistant", t("msgFlowWelcome"));
}

backendUrlInput.value =
  (window.location?.origin && /^https?:/i.test(window.location.origin))
    ? window.location.origin
    : "http://127.0.0.1:8001";
if (llmApiBaseInput) llmApiBaseInput.value = "https://litellm.shoplazza.site";
projectIdInput.value = "gemini-sl-20251120";
modelInput.value = "azure-gpt-5";
veoDurationInput.value = "8";
applyLang(currentLang);
scriptEditor.value = defaultScript;
updateCounter();
renderTimeline();
renderAssets();
renderPointSuggestions(inferPointOptions());
updateTimecode(0, currentDuration);
ingestGeneratedImageFromSession();
resetFlow();
setPrdGate("bad", t("gateNotReady"));
