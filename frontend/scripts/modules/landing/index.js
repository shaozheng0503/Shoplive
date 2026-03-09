const promptInput = document.getElementById("promptInput");
const langToggleBtn = document.getElementById("langToggleBtn");
const topStartBtn = document.getElementById("topStartBtn");
const startFlowBtn = document.getElementById("startFlowBtn");
const aspectRatioSelect = document.getElementById("aspectRatioSelect");
const durationSelect = document.getElementById("durationSelect");
const refPreview = document.getElementById("landingRefPreview");
const openRefPanelBtn = document.getElementById("openRefPanelBtn");
const refModal = document.getElementById("refModal");
const closeRefPanelBtn = document.getElementById("closeRefPanelBtn");
const refUploadBtn = document.getElementById("refUploadBtn");
const refMosaicBtn = document.getElementById("refMosaicBtn");
const refFileInput = document.getElementById("refFileInput");
const refTabUpload = document.getElementById("refTabUpload");
const refTabAi = document.getElementById("refTabAi");
const refUploadPanel = document.getElementById("refUploadPanel");
const refAiPanel = document.getElementById("refAiPanel");
const refUploadGrid = document.getElementById("refUploadGrid");
const refAiResultGrid = document.getElementById("refAiResultGrid");
const refAiPromptInput = document.getElementById("refAiPromptInput");
const refAiGenerateBtn = document.getElementById("refAiGenerateBtn");
const enhancePromptBtn = document.getElementById("enhancePromptBtn");

const i18n = {
  en: {
    navFeatures: "Features",
    navSolutions: "Solutions",
    navResources: "Resources",
    navPricing: "Pricing",
    navCommunity: "Community",
    cardVideoClips: "HD assets",
    cardProductLinks: "Product links",
    cardVideoScript: "Video Script",
    line1: "Create faster, with less friction:",
    desc: "No editing skills needed. Shoplive analyzes product highlights and outputs production-ready videos in minutes.",
    cta: "Start generating",
    uploadRef: "Reference image",
    uploadHint: "Upload product images and describe your product and video style.",
    ratioLabel: "Aspect ratio",
    durationLabel: "Duration",
    enhancePrompt: "Enhance prompt",
    start: "Get started",
    creatorUsage: "10,000+ creators are using Shoplive",
    placeholders: [
      "Describe your product and desired video style",
      "Paste a product URL to parse details automatically",
      "Input key selling points, audience, and visual tone",
    ],
    refPanelTitle: "Select reference image",
    refUploadLocal: "Upload local image",
    refUploadMosaic: "Upload collage",
    refTabUpload: "Upload assets",
    refTabAi: "AI generate",
    refAiPromptPh: "Describe product appearance and style to generate references",
    refAiGenerateBtn: "Generate",
    refEmpty: "No images yet",
    refGenerating: "Generating...",
    refGenerateFail: "Generation failed",
  },
  zh: {
    navFeatures: "功能",
    navSolutions: "解决方案",
    navResources: "资源",
    navPricing: "价格",
    navCommunity: "社区",
    cardVideoClips: "高清素材",
    cardProductLinks: "商品链接",
    cardVideoScript: "视频脚本",
    line1: "让创作回归简单：",
    desc: "无需剪辑技能，Shoplive 自动化分析商品卖点，几分钟内直接产出专业级可用视频。",
    cta: "开始生成",
    uploadRef: "参考图",
    uploadHint: "上传商品图，描述你的商品信息和想要的视频风格…",
    ratioLabel: "比例",
    durationLabel: "视频时长",
    enhancePrompt: "提示词增强",
    start: "开始使用",
    creatorUsage: "超过 10,000+ 创作者正在使用",
    placeholders: ["上传商品图，描述你的商品信息和想要的视频风格…", "告诉 Shoplive 你想生成什么视频，或粘贴商品链接", "输入视频卖点、受众、风格等关键信息"],
    refPanelTitle: "选择参考图",
    refUploadLocal: "从本地上传",
    refUploadMosaic: "从本地上传拼图",
    refTabUpload: "上传资产",
    refTabAi: "AI 生成",
    refAiPromptPh: "输入商品关键词和风格，生成参考图",
    refAiGenerateBtn: "AI 生成",
    refEmpty: "资产库中暂无图片",
    refGenerating: "AI 生图中...",
    refGenerateFail: "生成失败",
  },
};

const REF_IMAGE_STORAGE_KEY = "shoplive.landingRefImage";
let currentLang = localStorage.getItem("shoplive.lang") || "zh";
let idx = 0;
let selectedRefDataUrl = sessionStorage.getItem(REF_IMAGE_STORAGE_KEY) || "";
let uploadAssets = [];
let aiAssets = [];

function applyLanguage(lang) {
  currentLang = lang;
  localStorage.setItem("shoplive.lang", lang);
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.dataset.i18n;
    if (i18n[lang]?.[key]) node.textContent = i18n[lang][key];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    const key = node.getAttribute("data-i18n-placeholder");
    if (key && i18n[lang]?.[key]) node.placeholder = i18n[lang][key];
  });
  const langLabel = langToggleBtn?.querySelector(".lang-label");
  if (langLabel) langLabel.textContent = lang === "zh" ? "EN" : "中文";
  if (promptInput) promptInput.placeholder = i18n[lang].placeholders[idx % i18n[lang].placeholders.length];
}

function gotoAgent(extra = {}) {
  const draft = promptInput ? promptInput.value.trim() : "";
  const params = new URLSearchParams();
  if (extra.from) params.set("from", String(extra.from));
  if (draft) params.set("draft", draft);
  if (extra.product_url) params.set("product_url", String(extra.product_url));
  if (extra.aspect_ratio) params.set("aspect_ratio", String(extra.aspect_ratio));
  if (extra.duration) params.set("duration", String(extra.duration));
  if (extra.enhance) params.set("enhance", "1");
  window.location.href = `/pages/agent.html?${params.toString()}`;
}

function isLikelyUrl(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/^https?:\/\//i.test(raw)) return true;
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/.*)?$/i.test(raw);
}

function normalizeProductUrl(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/.*)?$/i.test(raw)) return `https://${raw}`;
  return "";
}

function setActiveRefTab(tab) {
  const isUpload = tab === "upload";
  refTabUpload?.classList.toggle("is-active", isUpload);
  refTabAi?.classList.toggle("is-active", !isUpload);
  refUploadPanel?.classList.toggle("is-active", isUpload);
  refAiPanel?.classList.toggle("is-active", !isUpload);
}

function renderRefGrid(container, items = []) {
  if (!container) return;
  if (!items.length) {
    container.innerHTML = `
      <div class="ref-empty-state">
        <span class="ref-empty-icon" aria-hidden="true"></span>
        <span class="ref-empty">${i18n[currentLang].refEmpty}</span>
      </div>
    `;
    return;
  }
  container.innerHTML = "";
  items.forEach((src, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `ref-thumb${src === selectedRefDataUrl ? " is-selected" : ""}`;
    item.innerHTML = `<img src="${src}" alt="ref-${index + 1}" />`;
    item.addEventListener("click", () => {
      selectedRefDataUrl = src;
      sessionStorage.setItem(REF_IMAGE_STORAGE_KEY, src);
      if (refPreview) refPreview.src = src;
      renderRefGrid(container, items);
      if (container === refUploadGrid) renderRefGrid(refAiResultGrid, aiAssets);
      if (container === refAiResultGrid) renderRefGrid(refUploadGrid, uploadAssets);
    });
    container.appendChild(item);
  });
}

async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read file failed"));
    reader.readAsDataURL(file);
  });
}

function deriveProductName(text = "") {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return currentLang === "zh" ? "商品" : "Product";
  return clean.slice(0, 48);
}

async function callLandingImageGenerate(promptText) {
  const resp = await fetch(`${window.location.origin}/api/shoplive/image/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_name: deriveProductName(promptText),
      main_category: deriveProductName(promptText),
      target_audience: "",
      brand_philosophy: "Shoplive conversion-oriented product storytelling",
      selling_region: currentLang === "zh" ? "全球" : "global",
      selling_points: promptText,
      template: "clean",
      other_info: promptText,
      sample_count: 2,
      aspect_ratio: aspectRatioSelect?.value || "16:9",
      location: "us-central1",
      language_code: currentLang === "zh" ? "zh-CN" : "en-US",
      currency_code: currentLang === "zh" ? "CNY" : "USD",
      exchange_rate: currentLang === "zh" ? "7.2" : "1.0",
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data?.ok || !Array.isArray(data?.images) || !data.images.length) {
    const err = data?.error || data?.response?.error?.message || `HTTP ${resp.status}`;
    throw new Error(err);
  }
  return data.images.map((x) => String(x?.data_url || "")).filter(Boolean);
}

function openRefModal() {
  if (!refModal) return;
  refModal.classList.add("is-open");
  refModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeRefModal() {
  if (!refModal) return;
  refModal.classList.remove("is-open");
  refModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

[topStartBtn, startFlowBtn].forEach((btn) => {
  if (!btn) return;
  btn.addEventListener("click", () => {
    const draft = promptInput ? promptInput.value.trim() : "";
    const normalizedDraftUrl = normalizeProductUrl(draft);
    const aspectRatio = aspectRatioSelect?.value || "16:9";
    const duration = durationSelect?.value || "8";
    if (normalizedDraftUrl && isLikelyUrl(normalizedDraftUrl)) {
      gotoAgent({
        from: "landing-product-link",
        product_url: normalizedDraftUrl,
        aspect_ratio: aspectRatio,
        duration,
      });
      return;
    }
    gotoAgent({
      from: selectedRefDataUrl ? "landing-ref" : "landing-prompt",
      aspect_ratio: aspectRatio,
      duration,
    });
  });
});

if (promptInput) {
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      startFlowBtn?.click();
    }
  });
  setInterval(() => {
    const list = i18n[currentLang].placeholders;
    idx = (idx + 1) % list.length;
    promptInput.placeholder = list[idx];
  }, 2400);
}

if (langToggleBtn) {
  langToggleBtn.addEventListener("click", () => {
    applyLanguage(currentLang === "zh" ? "en" : "zh");
  });
}

openRefPanelBtn?.addEventListener("click", openRefModal);
closeRefPanelBtn?.addEventListener("click", closeRefModal);
refModal?.addEventListener("click", (e) => {
  if (e.target === refModal) closeRefModal();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeRefModal();
});

refTabUpload?.addEventListener("click", () => setActiveRefTab("upload"));
refTabAi?.addEventListener("click", () => setActiveRefTab("ai"));
refUploadBtn?.addEventListener("click", () => refFileInput?.click());
refMosaicBtn?.addEventListener("click", () => refFileInput?.click());

refFileInput?.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []).slice(0, 8);
  if (!files.length) return;
  const results = await Promise.all(files.map((f) => readFileAsDataUrl(f).catch(() => "")));
  uploadAssets = results.filter(Boolean);
  if (!selectedRefDataUrl && uploadAssets.length) {
    selectedRefDataUrl = uploadAssets[0];
    sessionStorage.setItem(REF_IMAGE_STORAGE_KEY, selectedRefDataUrl);
    if (refPreview) refPreview.src = selectedRefDataUrl;
  }
  renderRefGrid(refUploadGrid, uploadAssets);
});

refAiGenerateBtn?.addEventListener("click", async () => {
  const promptText = String(refAiPromptInput?.value || promptInput?.value || "").trim();
  if (!promptText) return;
  const oldText = refAiGenerateBtn.textContent;
  refAiGenerateBtn.disabled = true;
  refAiGenerateBtn.textContent = i18n[currentLang].refGenerating;
  try {
    aiAssets = await callLandingImageGenerate(promptText);
    if (!selectedRefDataUrl && aiAssets.length) {
      selectedRefDataUrl = aiAssets[0];
      sessionStorage.setItem(REF_IMAGE_STORAGE_KEY, selectedRefDataUrl);
      if (refPreview) refPreview.src = selectedRefDataUrl;
    }
    renderRefGrid(refAiResultGrid, aiAssets);
    setActiveRefTab("ai");
  } catch (err) {
    refAiResultGrid.innerHTML = `<span class="ref-empty">${i18n[currentLang].refGenerateFail}: ${String(err?.message || "")}</span>`;
  } finally {
    refAiGenerateBtn.disabled = false;
    refAiGenerateBtn.textContent = oldText || i18n[currentLang].refAiGenerateBtn;
  }
});

enhancePromptBtn?.addEventListener("click", () => {
  gotoAgent({
    from: "landing-prompt",
    aspect_ratio: aspectRatioSelect?.value || "16:9",
    duration: durationSelect?.value || "8",
    enhance: true,
  });
});

if (selectedRefDataUrl && refPreview) refPreview.src = selectedRefDataUrl;
renderRefGrid(refUploadGrid, uploadAssets);
renderRefGrid(refAiResultGrid, aiAssets);
setActiveRefTab("upload");
applyLanguage(currentLang);
