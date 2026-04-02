const langToggleBtn = document.getElementById("langToggleBtn");
const toStudioBtn = document.getElementById("toStudioBtn");
const gotoStudioBtn = document.getElementById("gotoStudioBtn");
const generateBtn = document.getElementById("generateBtn");
const productImageInput = document.getElementById("productImageInput");
const productNameInput = document.getElementById("productNameInput");
const sellingPointsInput = document.getElementById("sellingPointsInput");
const targetUserInput = document.getElementById("targetUserInput");
const salesRegionInput = document.getElementById("salesRegionInput");
const templateButtons = Array.from(document.querySelectorAll(".template-btn"));
const pointSuggestions = document.getElementById("pointSuggestions");
const qualityList = document.getElementById("qualityList");
const progressBar = document.getElementById("progressBar");
const statusText = document.getElementById("statusText");
const etaText = document.getElementById("etaText");
const resultGrid = document.getElementById("resultGrid");
const autoJumpText = document.getElementById("autoJumpText");

let selectedTemplate = "clean";
let currentLang = localStorage.getItem("shoplive.lang") || "zh";
let fakeProgressTimer = null;
let autoJumpTimer = null;
let progressStartedAt = 0;
let generatedImages = [];
let latestQualityReports = [];
const DEFAULT_PROJECT_ID = "qy-shoplazza-02";
const BACKEND_BASE_CANDIDATES = (() => {
  const list = [];
  if (window.location?.origin && /^https?:/i.test(window.location.origin)) list.push(window.location.origin);
  list.push("http://127.0.0.1:8001");
  list.push("http://127.0.0.1:8000");
  return Array.from(new Set(list));
})();

const i18n = {
  zh: {
    skipBtn: "跳过，直接去视频工作台",
    step1: "1. 生成商品图",
    step2: "2. 生成营销视频",
    title: "实时生成商品图",
    desc: "先完成生图，再自动跳转到视频生成工作台。",
    uploadLabel: "上传商品图片（可选，0-3张）",
    productNameLabel: "商品名称",
    pointLabel: "商品卖点（1-6个）",
    targetUserLabel: "目标用户",
    salesRegionLabel: "销售地区",
    templateLabel: "商品风格模版",
    generateBtn: "实时生成商品图",
    qualityTitle: "图片质量检测",
    progressTitle: "生成进度",
    resultTitle: "生成结果",
    gotoBtn: "进入视频生成",
    idleText: "待开始",
    sellingPointsPh: "补水、便携",
    productNamePh: "如：法式复古收腰连衣裙",
    targetUserPh: "如：18-30岁女性",
    salesRegionPh: "如：东南亚",
    statusPreparing: "准备中...",
    statusGenerating: "生成中...",
    statusNeedImages: "请先上传商品图片（1-3张）",
    statusTooManyImages: "商品图片最多上传3张",
    statusNeedPoints: "卖点不足：请确认核心卖点，或点击建议标签补全",
    statusNeedProductName: "请补充商品名称（例如：法式复古收腰连衣裙）。",
    statusTooManyPoints: "卖点超过6个，请精简",
    statusNeedTarget: "请补充目标用户",
    statusNeedRegion: "请补充销售地区",
    statusLowRes: "图片分辨率过低，请上传至少1024x1024图片",
    statusLowSharpness: "图片清晰度不足，请补充高清图片",
    statusLowSubject: "主体占比不足40%，请上传主体更清晰的商品图",
    statusArtifact: "疑似压缩伪影较重，请上传更高质量原图",
    statusCallingApi: "调用服务：{url} /api/google-image/generate",
    statusDone: "生成完成，准备进入视频阶段",
    statusFallback: "接口不可用：{error}",
    statusNoFallback: "接口不可用：{error}",
    qualitySkipped: "未上传参考图，已跳过参考图质量检测，将按文本提示直接生图。",
    statusTryBackend: "正在尝试服务：{url}",
    jumpCountdown: "自动跳转倒计时 {seconds}s",
    etaIdle: "预计剩余耗时 -- s",
    etaLeft: "预计剩余耗时 {seconds} s",
  },
  en: {
    skipBtn: "Skip to Video Studio",
    step1: "1. Generate Product Images",
    step2: "2. Generate Marketing Video",
    title: "Realtime Product Image Generation",
    desc: "Generate product visuals first, then jump to video studio automatically.",
    uploadLabel: "Upload product images (optional, 0-3)",
    productNameLabel: "Product name",
    pointLabel: "Selling points (1-6)",
    targetUserLabel: "Target users",
    salesRegionLabel: "Sales region",
    templateLabel: "Style template",
    generateBtn: "Generate Product Images",
    qualityTitle: "Image quality checks",
    progressTitle: "Progress",
    resultTitle: "Generated Results",
    gotoBtn: "Go to Video Studio",
    idleText: "Idle",
    sellingPointsPh: "hydration, portable",
    productNamePh: "e.g. French retro waist dress",
    targetUserPh: "e.g. women aged 18-30",
    salesRegionPh: "e.g. Southeast Asia",
    statusPreparing: "Preparing...",
    statusGenerating: "Generating...",
    statusNeedImages: "Please upload product images first (1-3).",
    statusTooManyImages: "At most 3 product images are allowed.",
    statusNeedPoints: "Selling points are missing. Please add keywords or click suggestions.",
    statusNeedProductName: "Please provide product name (e.g., French retro waist dress).",
    statusTooManyPoints: "Too many selling points. Keep 1-6 only.",
    statusNeedTarget: "Please provide target users.",
    statusNeedRegion: "Please provide sales region.",
    statusLowRes: "Image resolution is too low. Upload at least 1024x1024.",
    statusLowSharpness: "Image sharpness is too low. Please upload clearer images.",
    statusLowSubject: "Subject ratio is under 40%. Please upload images with a clearer subject.",
    statusArtifact: "Compression artifact risk detected. Please upload higher quality source images.",
    statusCallingApi: "Calling service: {url} /api/google-image/generate",
    statusDone: "Generation completed. Preparing to enter video stage.",
    statusFallback: "API unavailable: {error}",
    statusNoFallback: "API unavailable: {error}",
    qualitySkipped: "No reference images uploaded. Skipped reference quality checks and generating from text prompt directly.",
    statusTryBackend: "Trying backend: {url}",
    jumpCountdown: "Auto jump in {seconds}s",
    etaIdle: "Estimated remaining -- s",
    etaLeft: "Estimated remaining {seconds} s",
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
  langToggleBtn.textContent = lang === "zh" ? "EN" : "中文";
}

function gotoStudio() {
  window.location.href = "/pages/studio.html?from=image-lab";
}

function setStatus(text, percent) {
  statusText.textContent = text;
  progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function setEta(seconds) {
  if (!etaText) return;
  if (!Number.isFinite(seconds) || seconds < 0) {
    etaText.textContent = t("etaIdle");
    return;
  }
  etaText.textContent = t("etaLeft", { seconds: Math.max(0, Math.ceil(seconds)) });
}

function startFakeProgress() {
  let percent = 3;
  progressStartedAt = Date.now();
  setStatus(t("statusPreparing"), percent);
  setEta(35);
  if (fakeProgressTimer) clearInterval(fakeProgressTimer);
  fakeProgressTimer = setInterval(() => {
    percent = Math.min(92, percent + Math.random() * 8);
    setStatus(`${t("statusGenerating")} ${Math.floor(percent)}%`, percent);
    const elapsed = (Date.now() - progressStartedAt) / 1000;
    const remaining = Math.max(1, 35 - elapsed);
    setEta(remaining);
  }, 350);
}

function stopFakeProgress() {
  if (fakeProgressTimer) clearInterval(fakeProgressTimer);
  fakeProgressTimer = null;
  progressStartedAt = 0;
}

function inferPointOptions(names = []) {
  const text = names.join(" ").toLowerCase();
  const options = new Set();
  if (/mask|skin|cream|serum|护肤|面膜/.test(text)) ["补水", "温和配方", "肤感细腻"].forEach((x) => options.add(x));
  if (/bottle|cup|水杯|杯/.test(text)) ["保温", "便携", "防漏"].forEach((x) => options.add(x));
  if (/shoe|sport|运动|健身/.test(text)) ["轻量", "防滑", "舒适"].forEach((x) => options.add(x));
  if (!options.size) ["高清展示", "核心卖点突出", "购买转化导向"].forEach((x) => options.add(x));
  return Array.from(options).slice(0, 3);
}

function renderPointSuggestions(options) {
  pointSuggestions.innerHTML = "";
  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opt;
    btn.addEventListener("click", () => {
      const current = sellingPointsInput.value.trim();
      if (!current) sellingPointsInput.value = opt;
      else if (!current.includes(opt)) sellingPointsInput.value = `${current}、${opt}`;
    });
    pointSuggestions.appendChild(btn);
  });
}

async function measureImageQuality(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || 0;
      const height = img.naturalHeight || 0;
      const canvas = document.createElement("canvas");
      const scale = width > 256 ? 256 / width : 1;
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const grayAt = (x, y) => {
        const i = (y * canvas.width + x) * 4;
        return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      };

      let lapSum = 0;
      let opaque = 0;
      let total = 0;
      for (let y = 1; y < canvas.height - 1; y++) {
        for (let x = 1; x < canvas.width - 1; x++) {
          const i = (y * canvas.width + x) * 4;
          total += 1;
          if (d[i + 3] > 20) opaque += 1;
          const lap = 4 * grayAt(x, y) - grayAt(x - 1, y) - grayAt(x + 1, y) - grayAt(x, y - 1) - grayAt(x, y + 1);
          lapSum += lap * lap;
        }
      }
      const sharpness = lapSum / Math.max(1, (canvas.width - 2) * (canvas.height - 2));
      const subjectRatio = opaque / Math.max(1, total);
      resolve({ dataUrl, width, height, sharpness, subjectRatio });
    };
    img.onerror = () => resolve({ dataUrl, width: 0, height: 0, sharpness: 0, subjectRatio: 0 });
    img.src = dataUrl;
  });
}

async function measureDataUrlQuality(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || 0;
      const height = img.naturalHeight || 0;
      const canvas = document.createElement("canvas");
      const scale = width > 256 ? 256 / width : 1;
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const grayAt = (x, y) => {
        const i = (y * canvas.width + x) * 4;
        return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      };
      let lapSum = 0;
      let opaque = 0;
      let total = 0;
      for (let y = 1; y < canvas.height - 1; y++) {
        for (let x = 1; x < canvas.width - 1; x++) {
          const i = (y * canvas.width + x) * 4;
          total += 1;
          if (d[i + 3] > 20) opaque += 1;
          const lap = 4 * grayAt(x, y) - grayAt(x - 1, y) - grayAt(x + 1, y) - grayAt(x, y - 1) - grayAt(x, y + 1);
          lapSum += lap * lap;
        }
      }
      const sharpness = lapSum / Math.max(1, (canvas.width - 2) * (canvas.height - 2));
      const subjectRatio = opaque / Math.max(1, total);
      resolve({ width, height, sharpness, subjectRatio });
    };
    img.onerror = () => resolve({ width: 0, height: 0, sharpness: 0, subjectRatio: 0 });
    img.src = dataUrl;
  });
}

function renderQualityList(reports) {
  qualityList.innerHTML = "";
  reports.forEach((r) => {
    const ok =
      r.width >= 1024 &&
      r.height >= 1024 &&
      r.sharpness >= 100 &&
      r.subjectRatio >= 0.4 &&
      r.fileSize >= 120 * 1024;
    const item = document.createElement("div");
    item.className = "quality-item";
    item.innerHTML = `
      <strong>${r.name}</strong><br />
      <span class="${ok ? "quality-ok" : "quality-bad"}">
        ${ok ? "PASS" : "NOT PASS"} · ${r.width}x${r.height} · Lap ${r.sharpness.toFixed(1)} · Subject ${(r.subjectRatio * 100).toFixed(1)}%
      </span>
    `;
    qualityList.appendChild(item);
  });
}

function validateBusinessInputs() {
  const files = Array.from(productImageInput.files || []);
  if (files.length > 3) {
    setStatus(t("statusTooManyImages"), 0);
    return false;
  }
  const points = sellingPointsInput.value
    .split(/[，,、]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!points.length) {
    renderPointSuggestions(inferPointOptions(files.map((f) => f.name)));
    setStatus(t("statusNeedPoints"), 0);
    return false;
  }
  if (points.length > 6) {
    setStatus(t("statusTooManyPoints"), 0);
    return false;
  }
  if (!productNameInput.value.trim()) {
    setStatus(t("statusNeedProductName"), 0);
    return false;
  }
  if (!targetUserInput.value.trim()) {
    setStatus(t("statusNeedTarget"), 0);
    return false;
  }
  if (!salesRegionInput.value.trim()) {
    setStatus(t("statusNeedRegion"), 0);
    return false;
  }
  return true;
}

async function validateImageQuality() {
  const files = Array.from(productImageInput.files || []);
  if (!files.length) {
    latestQualityReports = [];
    qualityList.innerHTML = `<div class="quality-item"><span class="quality-ok">${t("qualitySkipped")}</span></div>`;
    return true;
  }
  const reports = [];
  for (const f of files) {
    const q = await measureImageQuality(f);
    reports.push({ ...q, name: f.name, fileSize: f.size });
  }
  latestQualityReports = reports;
  renderQualityList(reports);
  for (const q of reports) {
    if (q.width < 1024 || q.height < 1024) {
      setStatus(t("statusLowRes"), 0);
      return false;
    }
    if (q.sharpness < 100) {
      setStatus(t("statusLowSharpness"), 0);
      return false;
    }
    if (q.subjectRatio < 0.4) {
      setStatus(t("statusLowSubject"), 0);
      return false;
    }
    if (q.fileSize < 120 * 1024) {
      setStatus(t("statusArtifact"), 0);
      return false;
    }
  }
  return true;
}

async function callImageGenerateApi(prompt) {
  let lastError = "unknown error";
  const IMAGE_API_TIMEOUT_MS = 120000;
  const pickError = (data, status) =>
    data?.error ||
    data?.response?.error?.message ||
    data?.first_attempt?.response?.error?.message ||
    data?.response?.raw ||
    (status >= 400 ? `HTTP ${status}` : "接口返回空结果（未生成图片）");
  for (const base of BACKEND_BASE_CANDIDATES) {
    const backendUrl = String(base).replace(/\/+$/, "");
    try {
      setStatus(t("statusTryBackend", { url: backendUrl }), 2);
      const resp = await fetchWithTimeout(`${backendUrl}/api/shoplive/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: DEFAULT_PROJECT_ID,
          model: "imagen-3.0-generate-002",
          product_name: productNameInput.value.trim(),
          main_category: productNameInput.value.trim() || "General ecommerce product",
          target_audience: targetUserInput.value.trim(),
          brand_philosophy: "Shoplive conversion-oriented product storytelling",
          selling_region: salesRegionInput.value.trim(),
          selling_points: sellingPointsInput.value.trim(),
          template: selectedTemplate,
          other_info: prompt,
          sample_count: 2,
          aspect_ratio: "3:4",
          location: "us-central1",
          language_code: currentLang === "zh" ? "zh-CN" : "en-US",
          currency_code: currentLang === "zh" ? "CNY" : "USD",
          exchange_rate: currentLang === "zh" ? "7.2" : "1.0",
        }),
      }, IMAGE_API_TIMEOUT_MS);
      const data = await resp.json();
      if (!resp.ok || !data?.ok) {
        lastError = pickError(data, resp.status);
        continue;
      }
      if (!Array.isArray(data.images) || !data.images.length) {
        lastError = pickError(data, resp.status);
        continue;
      }
      return { images: data.images || [], backendUrl };
    } catch (error) {
      if (error?.name === "AbortError") {
        lastError = currentLang === "zh" ? "请求超时（120s），请稍后重试" : "Request timed out (120s), please retry";
      } else {
        lastError = error?.message || String(error);
      }
    }
  }
  throw new Error(lastError);
}

function renderResults(images) {
  resultGrid.innerHTML = "";
  images.forEach((img, idx) => {
    const card = document.createElement("article");
    card.className = "result-card";
    const src = img.data_url || "";
    card.innerHTML = `
      <img src="${src}" alt="Generated ${idx + 1}" />
      <button data-idx="${idx}">Use this</button>
    `;
    card.querySelector("button").addEventListener("click", () => saveAndGo(images[idx]));
    resultGrid.appendChild(card);
  });
}

async function saveAndGo(item) {
  const generatedQuality = item?.data_url ? await measureDataUrlQuality(item.data_url) : null;
  const payload = {
    imageDataUrl: item.data_url,
    productName: productNameInput.value.trim(),
    sellingPoints: sellingPointsInput.value,
    targetUser: targetUserInput.value.trim(),
    salesRegion: salesRegionInput.value.trim(),
    template: selectedTemplate,
    qualityReports: latestQualityReports,
    generatedImageQuality: generatedQuality,
  };
  sessionStorage.setItem("shoplive.generatedImage", JSON.stringify(payload));
  gotoStudio();
}

function startAutoJump() {
  let seconds = 4;
  gotoStudioBtn.disabled = false;
  autoJumpText.textContent = t("jumpCountdown", { seconds });
  if (autoJumpTimer) clearInterval(autoJumpTimer);
  autoJumpTimer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(autoJumpTimer);
      autoJumpTimer = null;
      if (generatedImages[0]) {
        saveAndGo(generatedImages[0]);
      }
      return;
    }
    autoJumpText.textContent = t("jumpCountdown", { seconds });
  }, 1000);
}

async function handleGenerate() {
  if (!validateBusinessInputs()) return;
  const qualityOk = await validateImageQuality();
  if (!qualityOk) return;

  const points = sellingPointsInput.value.trim();
  const prompt = `生成电商商品图，商品名称:${productNameInput.value.trim()}，模板:${selectedTemplate}，卖点:${points}，目标用户:${targetUserInput.value.trim()}，地区:${salesRegionInput.value.trim()}，画幅3:4，真实商品风格。`;
  setStatus(t("statusCallingApi", { url: BACKEND_BASE_CANDIDATES[0] || "N/A" }), 1);
  generateBtn.classList.add("loading");
  generateBtn.disabled = true;
  gotoStudioBtn.disabled = true;
  autoJumpText.textContent = "";
  startFakeProgress();
  generatedImages = [];
  resultGrid.innerHTML = "";
  try {
    const { images, backendUrl } = await callImageGenerateApi(prompt);
    generatedImages = images || [];
    if (!generatedImages.length) {
      throw new Error("No generated images returned.");
    }
    stopFakeProgress();
    setStatus(t("statusCallingApi", { url: backendUrl }), 98);
    setStatus(t("statusDone"), 100);
    setEta(0);
    renderResults(generatedImages);
    startAutoJump();
  } catch (error) {
    stopFakeProgress();
    setEta(-1);
    generatedImages = [];
    gotoStudioBtn.disabled = true;
    autoJumpText.textContent = "";
    setStatus(t("statusNoFallback", { error: error.message }), 0);
  } finally {
    generateBtn.classList.remove("loading");
    generateBtn.disabled = false;
  }
}

templateButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedTemplate = btn.dataset.template;
    templateButtons.forEach((node) => node.classList.toggle("active", node === btn));
  });
});

productImageInput.addEventListener("change", () => {
  const files = Array.from(productImageInput.files || []);
  renderPointSuggestions(inferPointOptions(files.map((f) => f.name)));
});

langToggleBtn.addEventListener("click", () => applyLang(currentLang === "zh" ? "en" : "zh"));
toStudioBtn.addEventListener("click", gotoStudio);
gotoStudioBtn.addEventListener("click", () => {
  if (generatedImages[0]) {
    saveAndGo(generatedImages[0]);
  }
});
generateBtn.addEventListener("click", handleGenerate);

const params = new URLSearchParams(window.location.search);
const draft = params.get("draft");
if (draft) {
  if (!sellingPointsInput.value) sellingPointsInput.value = draft.slice(0, 80);
  if (!productNameInput.value) productNameInput.value = draft.slice(0, 80);
}

renderPointSuggestions(inferPointOptions([]));
applyLang(currentLang);
setEta(-1);
