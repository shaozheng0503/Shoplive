import { normalizeProductUrlForApi } from "../agent/utils.js";

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
const refAiGenerateBtn = document.getElementById("refAiGenerateBtn");
const aiFieldRegion   = document.getElementById("aiFieldRegion");
const aiFieldCategory = document.getElementById("aiFieldCategory");
const aiFieldStyle    = document.getElementById("aiFieldStyle");
const enhancePromptBtn = document.getElementById("enhancePromptBtn");

const i18n = {
  en: {
    brandBadge: "AI video workspace",
    navFeatures: "Features",
    navSolutions: "Solutions",
    navResources: "Resources",
    navPricing: "Pricing",
    navCommunity: "Community",
    navStatus: "Product experience",
    cardVideoClips: "HD assets",
    cardProductLinks: "Product links",
    cardVideoScript: "Video Script",
    heroKicker: "AI video workspace for ecommerce teams",
    heroLine1: "Upload product images or links,",
    heroLine2: "turn ideas into videos in minutes.",
    desc: "No editing skills needed. Shoplive extracts product highlights, plans the story, and outputs production-ready videos with a workflow your team can operate directly.",
    heroPoint1: "Reference-image driven",
    heroPoint2: "Product link parsing",
    heroPoint3: "Prompt enhancement",
    cta: "Start generating",
    uploadRef: "Reference image",
    uploadHint: "Upload product images and describe your product and video style.",
    ratioLabel: "Aspect ratio",
    durationLabel: "Duration",
    enhancePrompt: "Enhance prompt",
    start: "Get started",
    creatorUsage: "10,000+ creators are using Shoplive",
    creatorNum: "10,000+",
    creatorLabel: "creators are using Shoplive",
    quote1: "\"One prompt, results that rival a photo shoot\" — Li ×, fashion buyer",
    quote2: "\"Freed up our entire content team\" — Wang ×, brand ops",
    quote3: "\"From product URL to finished video in 3 minutes\" — Chen ×, indie seller",
    commandBarKicker: "Start with a reference image, a product link, or a single prompt",
    commandStatus1: "Auto-detect product",
    commandStatus2: "Auto-route model",
    commandTemplateTag1: "Template 01",
    commandTemplateTitle1: "Women's launch",
    commandTemplateDesc1: "For new arrivals, commuter styling, and fabric mood direction",
    commandTemplateTag2: "Template 02",
    commandTemplateTitle2: "Black running shoe details",
    commandTemplateDesc2: "For material close-ups, sole tech, and progressive camera moves",
    commandTemplateTag3: "Template 03",
    commandTemplateTitle3: "Social campaign short video",
    commandTemplateDesc3: "For fast conversion pacing, selling-point recall, and paid social",
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
    aiFieldRegionLabel: "Model region",
    aiFieldRegionPh: "e.g. US, Japan, Southeast Asia…",
    aiFieldCategoryLabel: "Product category",
    aiFieldCategoryPh: "e.g. Dress, Sneakers, Handbag…",
    aiFieldStyleLabel: "Style",
    aiFieldStylePh: "e.g. Minimalist luxury, streetwear, French elegance…",
    aiFormHint: "Fill in 1–3 fields · AI will craft the optimal image prompt automatically",
    aiChipsRegion: ["US/Europe", "Japan", "SE Asia", "Middle East"],
    aiChipsCategory: ["Dress", "Sneakers", "Handbag", "T-Shirt"],
    aiChipsStyle: ["Luxury minimal", "Streetwear", "French elegance", "Japanese fresh"],
  },
  zh: {
    brandBadge: "AI 视频工作台",
    navFeatures: "功能",
    navSolutions: "解决方案",
    navResources: "资源",
    navPricing: "价格",
    navCommunity: "社区",
    navStatus: "产品体验",
    cardVideoClips: "高清素材",
    cardProductLinks: "商品链接",
    cardVideoScript: "视频脚本",
    heroKicker: "面向电商团队的 AI 视频工作台",
    heroLine1: "上传商品图或链接，",
    heroLine2: "把想法直接变成视频。",
    desc: "无需剪辑技能，Shoplive 会自动识别商品卖点、组织镜头表达，并以团队可直接使用的工作流，在几分钟内产出可投放的视频内容。",
    heroPoint1: "商品图驱动",
    heroPoint2: "商品链接解析",
    heroPoint3: "提示词增强生成",
    cta: "开始生成",
    uploadRef: "参考图",
    uploadHint: "上传商品图，描述你的商品信息和想要的视频风格…",
    ratioLabel: "比例",
    durationLabel: "视频时长",
    enhancePrompt: "提示词增强",
    start: "开始使用",
    creatorUsage: "超过 10,000+ 创作者正在使用",
    creatorNum: "10,000+",
    creatorLabel: "创作者正在使用",
    quote1: "\"一句提示词，生成质感不输拍摄的商品视频\" — 李 ×，女装买手",
    quote2: "\"解放了我们整个内容团队\" — 王 ×，品牌运营",
    quote3: "\"从链接到成片只需 3 分钟\" — 陈 ×，独立卖家",
    commandBarKicker: "从参考图、商品链接或一句提示词开始",
    commandStatus1: "自动识别商品",
    commandStatus2: "自动路由模型",
    commandTemplateTag1: "模板 01",
    commandTemplateTitle1: "女装上新",
    commandTemplateDesc1: "适合新品发布、通勤穿搭和面料氛围表达",
    commandTemplateTag2: "模板 02",
    commandTemplateTitle2: "黑色跑鞋细节",
    commandTemplateDesc2: "适合材质展示、鞋底科技感和镜头推进",
    commandTemplateTag3: "模板 03",
    commandTemplateTitle3: "社媒投放短视频",
    commandTemplateDesc3: "适合快节奏转化、卖点记忆和广告投放",
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
    aiFieldRegionLabel: "模特地区",
    aiFieldRegionPh: "如：欧美、日本、东南亚、中东…",
    aiFieldCategoryLabel: "主营品类",
    aiFieldCategoryPh: "如：连衣裙、运动鞋、手提包…",
    aiFieldStyleLabel: "风格",
    aiFieldStylePh: "如：简约高级感、街头潮流、法式优雅…",
    aiFormHint: "填写 1–3 项 · AI 自动优化提示词并生成图片",
    aiChipsRegion: ["欧美", "日本", "东南亚", "中东"],
    aiChipsCategory: ["连衣裙", "运动鞋", "手提包", "T恤"],
    aiChipsStyle: ["简约高级感", "街头潮流", "法式优雅", "日系清新"],
  },
};

const REF_IMAGE_STORAGE_KEY = "shoplive.landingRefImage";
const AI_IMAGES_STORAGE_KEY = "shoplive.landingAiImages";
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

  // Update AI form chip labels
  const chipMaps = [
    { field: "region",   key: "aiChipsRegion"   },
    { field: "category", key: "aiChipsCategory" },
    { field: "style",    key: "aiChipsStyle"    },
  ];
  chipMaps.forEach(({ field, key }) => {
    const chips = document.querySelectorAll(`.ai-form-chips[data-field="${field}"] .ai-chip`);
    const labels = i18n[lang]?.[key] || [];
    chips.forEach((chip, i) => {
      if (labels[i]) { chip.textContent = labels[i]; chip.dataset.value = labels[i]; }
    });
  });

  // Update form hint
  const hint = document.querySelector(".ai-form-hint");
  if (hint) hint.textContent = i18n[lang]?.aiFormHint || "";
}

function gotoAgent(extra = {}) {
  const draft = promptInput ? promptInput.value.trim() : "";
  const params = new URLSearchParams();
  if (extra.from) params.set("from", String(extra.from));
  if (draft) params.set("draft", draft);
  if (extra.product_url) params.set("product_url", String(extra.product_url));
  if (extra.duration) params.set("duration", String(extra.duration));
  if (extra.enhance) params.set("enhance", "1");
  window.location.href = `/pages/agent.html?${params.toString()}`;
}

function gotoAgentWithAiImage(singleDataUrl, allDataUrls = []) {
  // Store the selected image as primary ref
  sessionStorage.setItem(REF_IMAGE_STORAGE_KEY, singleDataUrl);
  // Store all AI images so agent can show them as a gallery
  try {
    sessionStorage.setItem(AI_IMAGES_STORAGE_KEY, JSON.stringify(allDataUrls.slice(0, 8)));
  } catch (_e) {}
  const draft = promptInput ? promptInput.value.trim() : "";
  const params = new URLSearchParams();
  params.set("from", "landing-ai-image");
  if (draft) params.set("draft", draft);
  params.set("duration", durationSelect?.value || "8");
  window.location.href = `/pages/agent.html?${params.toString()}`;
}

function setActiveRefTab(tab) {
  const isUpload = tab === "upload";
  refTabUpload?.classList.toggle("is-active", isUpload);
  refTabAi?.classList.toggle("is-active", !isUpload);
  refUploadPanel?.classList.toggle("is-active", isUpload);
  refAiPanel?.classList.toggle("is-active", !isUpload);
}

function updateRefTriggerPreview() {
  const icon = openRefPanelBtn?.querySelector(".ref-icon");
  const label = openRefPanelBtn?.querySelector("[data-i18n]");
  if (!openRefPanelBtn) return;
  if (selectedRefDataUrl) {
    openRefPanelBtn.style.backgroundImage = `url("${selectedRefDataUrl}")`;
    openRefPanelBtn.style.backgroundSize = "cover";
    openRefPanelBtn.style.backgroundPosition = "center";
    openRefPanelBtn.classList.add("has-ref");
    if (icon) icon.style.display = "none";
    if (label) label.style.display = "none";
  } else {
    openRefPanelBtn.style.backgroundImage = "";
    openRefPanelBtn.classList.remove("has-ref");
    if (icon) icon.style.display = "";
    if (label) label.style.display = "";
  }
}

function renderRefGrid(container, items = [], { showVideoBtn = false } = {}) {
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
    const card = document.createElement("div");
    card.className = `ref-card${src === selectedRefDataUrl ? " is-selected" : ""}`;

    // Image button (select as reference)
    const imgBtn = document.createElement("button");
    imgBtn.type = "button";
    imgBtn.className = "ref-card-img-btn";
    imgBtn.innerHTML = `<img src="${src}" alt="ref-${index + 1}" />`;
    if (src === selectedRefDataUrl) {
      imgBtn.innerHTML += `<span class="ref-card-check">✓</span>`;
    }
    imgBtn.addEventListener("click", () => {
      selectedRefDataUrl = src;
      sessionStorage.setItem(REF_IMAGE_STORAGE_KEY, src);
      if (refPreview) refPreview.src = src;
      renderRefGrid(container, items, { showVideoBtn });
      if (container === refUploadGrid) renderRefGrid(refAiResultGrid, aiAssets, { showVideoBtn: true });
      if (container === refAiResultGrid) renderRefGrid(refUploadGrid, uploadAssets);
      updateRefTriggerPreview();
      if (!showVideoBtn) setTimeout(closeRefModal, 180);
    });
    card.appendChild(imgBtn);

    // Action bar (only for AI generated images)
    if (showVideoBtn) {
      const actions = document.createElement("div");
      actions.className = "ref-card-actions";

      // "Use as reference" button
      const useRefBtn = document.createElement("button");
      useRefBtn.type = "button";
      useRefBtn.className = "ref-card-use-ref";
      useRefBtn.title = currentLang === "zh" ? "设为参考图" : "Set as reference";
      useRefBtn.textContent = currentLang === "zh" ? "参考图" : "Use ref";
      useRefBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedRefDataUrl = src;
        sessionStorage.setItem(REF_IMAGE_STORAGE_KEY, src);
        if (refPreview) refPreview.src = src;
        renderRefGrid(container, items, { showVideoBtn: true });
        updateRefTriggerPreview();
        setTimeout(closeRefModal, 180);
      });

      // "Generate video with this image →" button
      const videoBtn = document.createElement("button");
      videoBtn.type = "button";
      videoBtn.className = "ref-card-video-btn";
      videoBtn.title = currentLang === "zh" ? "用此图生成视频" : "Generate video";
      videoBtn.innerHTML = currentLang === "zh" ? "生成视频 →" : "Make video →";
      videoBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        gotoAgentWithAiImage(src, items);
      });

      actions.appendChild(useRefBtn);
      actions.appendChild(videoBtn);
      card.appendChild(actions);
    }

    container.appendChild(card);
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

async function callLandingImageGenerate(promptText, _maxRetries = 2) {
  const region   = (aiFieldRegion?.value   || "").trim();
  const category = (aiFieldCategory?.value || "").trim() || promptText;
  const style    = (aiFieldStyle?.value    || "").trim();

  const selling_region  = region   || (currentLang === "zh" ? "全球" : "global");
  const main_category   = category;
  const brand_philosophy = style
    ? `${style} product storytelling`
    : "Shoplive conversion-oriented product storytelling";
  const product_name = category || promptText;

  const payload = {
    product_name,
    main_category,
    target_audience: "",
    brand_philosophy,
    selling_region,
    selling_points: [category, style].filter(Boolean).join(", ") || promptText,
    template: "clean",
    other_info: [region, category, style].filter(Boolean).join(", ") || promptText,
    sample_count: 1,
    aspect_ratio: aspectRatioSelect?.value || "16:9",
    location: "us-central1",
    person_generation: "dont_allow",
    skip_category_check: true,
    language_code: currentLang === "zh" ? "zh-CN" : "en-US",
    currency_code: currentLang === "zh" ? "CNY" : "USD",
    exchange_rate: currentLang === "zh" ? "7.2" : "1.0",
  };

  let lastErr;
  for (let attempt = 0; attempt <= _maxRetries; attempt++) {
    try {
      const resp = await fetch(`${window.location.origin}/api/shoplive/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok || !Array.isArray(data?.images) || !data.images.length) {
        throw new Error(data?.error || data?.response?.error?.message || `HTTP ${resp.status}`);
      }
      return data.images.map((x) => String(x?.data_url || "")).filter(Boolean);
    } catch (err) {
      lastErr = err;
      if (attempt < _maxRetries) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }
  throw lastErr;
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
  btn.addEventListener("click", async () => {
    // Wait for any in-progress template thumbnail fetch (max 2s) before navigating
    if (_templateRefFetch) {
      await Promise.race([_templateRefFetch, new Promise((r) => setTimeout(r, 2000))]);
    }
    const draft = promptInput ? promptInput.value.trim() : "";
    const normalizedDraftUrl = normalizeProductUrlForApi(draft);
    const duration = durationSelect?.value || "8";
    if (normalizedDraftUrl) {
      gotoAgent({
        from: "landing-product-link",
        product_url: normalizedDraftUrl,
        duration,
      });
      return;
    }
    gotoAgent({
      from: selectedRefDataUrl ? "landing-ref" : "landing-prompt",
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
  // Rotate placeholder text; store handle so it can be cleaned up
  window._placeholderTimer = window._placeholderTimer || null;
  if (window._placeholderTimer) clearInterval(window._placeholderTimer);
  window._placeholderTimer = setInterval(() => {
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
refUploadBtn?.addEventListener("click", () => {
  setActiveRefTab("upload");
  refFileInput?.click();
});
refMosaicBtn?.addEventListener("click", () => {
  setActiveRefTab("upload");
  refFileInput?.click();
});

refFileInput?.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []).slice(0, 8);
  if (!files.length) return;
  const settled = await Promise.allSettled(files.map((f) => readFileAsDataUrl(f)));
  const newAssets = settled
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);
  if (!newAssets.length) return;
  // Merge with existing assets, deduplicate by data-url prefix
  uploadAssets = [...uploadAssets, ...newAssets].slice(0, 16);
  // Auto-select first uploaded image if none selected yet
  if (!selectedRefDataUrl) {
    selectedRefDataUrl = uploadAssets[0];
    sessionStorage.setItem(REF_IMAGE_STORAGE_KEY, selectedRefDataUrl);
    if (refPreview) refPreview.src = selectedRefDataUrl;
  }
  setActiveRefTab("upload");
  renderRefGrid(refUploadGrid, uploadAssets);
  // Reset input so same file can be re-selected
  e.target.value = "";
});

let _aiProgressTimer = null;

function showAiProgress(container) {
  if (!container) return;
  if (_aiProgressTimer) clearInterval(_aiProgressTimer);
  let pct = 0;
  container.innerHTML = `
    <div class="ai-loading-wrap">
      <div class="ai-loading-cards">
        <div class="ai-skeleton-card"></div>
        <div class="ai-skeleton-card"></div>
      </div>
      <div class="ai-progress-bar-wrap">
        <div class="ai-progress-bar-track">
          <div class="ai-progress-bar-fill" id="aiProgressFill" style="width:0%"></div>
        </div>
        <span class="ai-progress-label" id="aiProgressLabel">0%</span>
      </div>
    </div>
  `;
  const fill = container.querySelector("#aiProgressFill");
  const label = container.querySelector("#aiProgressLabel");
  // Ease progress toward 90% over ~18s (image gen typically 8-20s)
  _aiProgressTimer = setInterval(() => {
    const gap = 90 - pct;
    pct += Math.max(0.4, gap * 0.045);
    pct = Math.min(pct, 90);
    if (fill) fill.style.width = `${pct.toFixed(1)}%`;
    if (label) label.textContent = `${Math.round(pct)}%`;
  }, 400);
}

function finishAiProgress(container, success = true) {
  if (_aiProgressTimer) { clearInterval(_aiProgressTimer); _aiProgressTimer = null; }
  const fill = container?.querySelector("#aiProgressFill");
  const label = container?.querySelector("#aiProgressLabel");
  if (fill) fill.style.width = "100%";
  if (fill) fill.style.background = success
    ? "linear-gradient(90deg, #5e85d8, #79a8ff)"
    : "linear-gradient(90deg, #c0392b, #e74c3c)";
  if (label) label.textContent = success ? "100%" : "failed";
}

// Chip click → fill the associated input field (debounced)
document.querySelectorAll(".ai-form-chips .ai-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (chip.dataset._busy) return;
    chip.dataset._busy = "1";
    requestAnimationFrame(() => { delete chip.dataset._busy; });
    const fieldMap = { region: aiFieldRegion, category: aiFieldCategory, style: aiFieldStyle };
    const fieldName = chip.closest(".ai-form-chips")?.dataset.field;
    const input = fieldMap[fieldName];
    if (input) {
      input.value = chip.dataset.value || chip.textContent;
      input.focus();
    }
    // Highlight active chip within the group
    const group = chip.closest(".ai-form-chips");
    if (group) group.querySelectorAll(".ai-chip").forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
  });
});

// Enter key on any field triggers generate
[aiFieldRegion, aiFieldCategory, aiFieldStyle].forEach((input) => {
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); refAiGenerateBtn?.click(); }
  });
});

refAiGenerateBtn?.addEventListener("click", async () => {
  const category = (aiFieldCategory?.value || "").trim();
  const region   = (aiFieldRegion?.value   || "").trim();
  const style    = (aiFieldStyle?.value    || "").trim();
  // Need at least one field
  if (!category && !region && !style) {
    if (aiFieldCategory) { aiFieldCategory.focus(); aiFieldCategory.classList.add("ai-form-input--error"); }
    return;
  }
  [aiFieldRegion, aiFieldCategory, aiFieldStyle].forEach((f) => f?.classList.remove("ai-form-input--error"));
  const promptText = [category, style, region].filter(Boolean).join(", ");
  const oldHtml = refAiGenerateBtn.innerHTML;
  refAiGenerateBtn.disabled = true;
  refAiGenerateBtn.setAttribute("aria-busy", "true");
  refAiGenerateBtn.innerHTML = `<span class="ai-gen-submit-icon spin">◌</span><span>${i18n[currentLang].refGenerating}</span>`;
  setActiveRefTab("ai");
  showAiProgress(refAiResultGrid);
  try {
    aiAssets = await callLandingImageGenerate(promptText);
    finishAiProgress(refAiResultGrid, true);
    await new Promise((r) => setTimeout(r, 300));
    if (!selectedRefDataUrl && aiAssets.length) {
      selectedRefDataUrl = aiAssets[0];
      sessionStorage.setItem(REF_IMAGE_STORAGE_KEY, selectedRefDataUrl);
      if (refPreview) refPreview.src = selectedRefDataUrl;
    }
    renderRefGrid(refAiResultGrid, aiAssets, { showVideoBtn: true });
  } catch (err) {
    finishAiProgress(refAiResultGrid, false);
    await new Promise((r) => setTimeout(r, 400));
    refAiResultGrid.innerHTML = `
      <div class="ref-empty-state">
        <span class="ref-empty">⚠️ ${i18n[currentLang].refGenerateFail}: ${String(err?.message || "")}</span>
      </div>`;
  } finally {
    refAiGenerateBtn.disabled = false;
    refAiGenerateBtn.removeAttribute("aria-busy");
    refAiGenerateBtn.innerHTML = oldHtml;
  }
});

enhancePromptBtn?.addEventListener("click", () => {
  gotoAgent({
    from: "landing-prompt",
    duration: durationSelect?.value || "8",
    enhance: true,
  });
});

if (selectedRefDataUrl && refPreview) refPreview.src = selectedRefDataUrl;
renderRefGrid(refUploadGrid, uploadAssets);
renderRefGrid(refAiResultGrid, aiAssets, { showVideoBtn: true });
setActiveRefTab("upload");
applyLanguage(currentLang);
updateRefTriggerPreview();

let _templateRefFetch = null;

const _templateCards = document.querySelectorAll(".command-template-card");
_templateCards.forEach((card) => {
  card.addEventListener("click", () => {
    _templateCards.forEach((el) => el.classList.remove("is-active"));
    card.classList.add("is-active");
    if (promptInput) {
      const fill = currentLang === "zh"
        ? (card.getAttribute("data-fill-zh") || "")
        : (card.getAttribute("data-fill-en") || "");
      if (fill) promptInput.value = fill;
      promptInput.focus();
    }
    const ratio = card.getAttribute("data-ratio") || "";
    const duration = card.getAttribute("data-duration") || "";
    if (ratio && aspectRatioSelect) aspectRatioSelect.value = ratio;
    if (duration && durationSelect) durationSelect.value = duration;

    // Clear stale ref immediately, then fetch this card's thumbnail as the new ref.
    // This lets Veo do image-to-video using the template's cover image.
    selectedRefDataUrl = "";
    sessionStorage.removeItem(REF_IMAGE_STORAGE_KEY);
    sessionStorage.removeItem(AI_IMAGES_STORAGE_KEY);
    updateRefTriggerPreview();

    const thumbSrc = card.querySelector(".template-thumb img")?.src || "";
    if (thumbSrc) {
      const smallUrl = thumbSrc.replace(/w=\d+/, "w=480").replace(/q=\d+/, "q=75");
      _templateRefFetch = fetch(smallUrl)
        .then((r) => r.blob())
        .then((blob) => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        }))
        .then((dataUrl) => {
          selectedRefDataUrl = dataUrl;
          try { sessionStorage.setItem(REF_IMAGE_STORAGE_KEY, dataUrl); } catch (_e) {}
          updateRefTriggerPreview();
          _templateRefFetch = null;
        })
        .catch(() => { _templateRefFetch = null; });
    } else {
      _templateRefFetch = null;
    }
  });
});
