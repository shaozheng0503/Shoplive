/**
 * LTX-Video UI module — wired to the ltxv-shell section in image-lab.html
 */

const MODEL_MAX_DURATION = {
  'ltx-2-3-fast': { '1920x1080': 20, '1080x1920': 20, default: 10 },
  'ltx-2-3-pro':  { default: 10 },
  'ltx-2-pro':    { default: 10 },
  'ltx-2-fast':   { default: 10 },
};

function getMaxDuration(model, resolution) {
  const map = MODEL_MAX_DURATION[model] || {};
  return map[resolution] ?? map.default ?? 10;
}

// State
let state = {
  model: 'ltx-2-3-pro',
  resolution: '1920x1080',
  ratio: '16:9',
  duration: 5,
  fps: 24,
  imageFile: null,
  lastVideoUrl: null,
};

// Elements
const $prompt       = document.getElementById('ltxvPrompt');
const $imageInput   = document.getElementById('ltxvImageInput');
const $imagePickBtn = document.getElementById('ltxvImagePickBtn');
const $imageName    = document.getElementById('ltxvImageName');
const $imageClearBtn= document.getElementById('ltxvImageClearBtn');
const $durationSlider = document.getElementById('ltxvDuration');
const $durationLabel  = document.getElementById('ltxvDurationLabel');
const $durationMax    = document.getElementById('ltxvDurationMax');
const $cameraSelect   = document.getElementById('ltxvCamera');
const $audioChk       = document.getElementById('ltxvAudio');
const $generateBtn    = document.getElementById('ltxvGenerateBtn');
const $progressWrap   = document.getElementById('ltxvProgressWrap');
const $progressBar    = document.getElementById('ltxvProgressBar');
const $statusText     = document.getElementById('ltxvStatusText');
const $resultArea     = document.getElementById('ltxvResultArea');
const $resultMeta     = document.getElementById('ltxvResultMeta');
const $actions        = document.getElementById('ltxvActions');
const $downloadBtn    = document.getElementById('ltxvDownloadBtn');
const $extendBtn      = document.getElementById('ltxvExtendBtn');

// --- Option button helpers ---
function bindOptButtons(attr, onChange) {
  document.querySelectorAll(`[${attr}]`).forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.ltxv-model-row, .ltxv-ratio-row, .ltxv-fps-row');
      if (group) group.querySelectorAll('.ltxv-opt-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.getAttribute(attr), btn);
    });
  });
}

bindOptButtons('data-ltxv-model', (val) => {
  state.model = val;
  updateDurationLimit();
});

bindOptButtons('data-ltxv-ratio', (val, btn) => {
  state.ratio = val;
  state.resolution = btn.getAttribute('data-ltxv-res');
  updateDurationLimit();
});

bindOptButtons('data-ltxv-fps', (val) => {
  state.fps = parseInt(val, 10);
});

function updateDurationLimit() {
  const max = getMaxDuration(state.model, state.resolution);
  $durationSlider.max = max;
  $durationMax.textContent = `${max}s`;
  if (state.duration > max) {
    state.duration = max;
    $durationSlider.value = max;
    $durationLabel.textContent = `${max}s`;
  }
}

$durationSlider.addEventListener('input', () => {
  state.duration = parseInt($durationSlider.value, 10);
  $durationLabel.textContent = `${state.duration}s`;
});

// --- Image picker ---
$imagePickBtn.addEventListener('click', () => $imageInput.click());
$imageInput.addEventListener('change', () => {
  const file = $imageInput.files[0];
  if (file) {
    state.imageFile = file;
    $imageName.textContent = file.name;
    $imageClearBtn.style.display = '';
  }
});
$imageClearBtn.addEventListener('click', () => {
  state.imageFile = null;
  $imageInput.value = '';
  $imageName.textContent = '未选择';
  $imageClearBtn.style.display = 'none';
});

// --- Progress animation ---
let _progressTimer = null;
function startProgress() {
  $progressWrap.style.display = '';
  $progressBar.style.width = '5%';
  let pct = 5;
  _progressTimer = setInterval(() => {
    // ease toward 90%
    pct = Math.min(90, pct + (90 - pct) * 0.04);
    $progressBar.style.width = `${pct}%`;
  }, 800);
}
function finishProgress() {
  clearInterval(_progressTimer);
  $progressBar.style.width = '100%';
  setTimeout(() => { $progressWrap.style.display = 'none'; $progressBar.style.width = '0%'; }, 600);
}

// --- Generate ---
$generateBtn.addEventListener('click', async () => {
  const prompt = $prompt.value.trim();
  if (!prompt) { alert('请输入视频描述'); return; }

  $generateBtn.disabled = true;
  $generateBtn.textContent = '生成中…';
  $actions.style.display = 'none';
  $statusText.textContent = '正在生成，请稍候…';
  startProgress();

  const body = {
    prompt,
    model: state.model,
    duration: state.duration,
    resolution: state.resolution,
    fps: state.fps,
    generate_audio: $audioChk.checked,
  };

  const camera = $cameraSelect.value;
  if (camera) body.camera_motion = camera;

  if (state.imageFile) {
    const b64 = await fileToBase64(state.imageFile);
    body.image_base64 = b64;
  }

  try {
    const t0 = Date.now();
    const res = await fetch('/api/ltxv/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    finishProgress();

    if (!res.ok || data.error) {
      $statusText.textContent = `错误: ${data.error || data.message || res.statusText}`;
      return;
    }

    state.lastVideoUrl = data.video_url;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    $resultMeta.textContent = `${data.model} · ${data.resolution} · ${data.duration}s · 耗时 ${elapsed}s`;
    $statusText.textContent = '生成完成';
    renderVideo(data.video_url);

    $downloadBtn.href = data.video_url;
    $downloadBtn.download = data.filename || 'ltxv_video.mp4';
    $actions.style.display = '';
  } catch (err) {
    finishProgress();
    $statusText.textContent = `请求失败: ${err.message}`;
  } finally {
    $generateBtn.disabled = false;
    $generateBtn.textContent = '生成视频';
  }
});

// --- Extend ---
$extendBtn?.addEventListener('click', async () => {
  if (!state.lastVideoUrl) return;
  $extendBtn.disabled = true;
  $extendBtn.textContent = '延长中…';
  $statusText.textContent = '正在延长视频…';
  startProgress();

  try {
    const res = await fetch('/api/ltxv/extend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_url: window.location.origin + state.lastVideoUrl,
        duration: 5,
        mode: 'end',
        model: state.model.endsWith('-fast') ? 'ltx-2-3-pro' : state.model,
      }),
    });
    const data = await res.json();
    finishProgress();

    if (!res.ok || data.error) {
      $statusText.textContent = `延长失败: ${data.error || res.statusText}`;
      return;
    }

    state.lastVideoUrl = data.video_url;
    $statusText.textContent = '延长完成';
    renderVideo(data.video_url);
    $downloadBtn.href = data.video_url;
    $downloadBtn.download = data.filename || 'ltxv_extended.mp4';
  } catch (err) {
    finishProgress();
    $statusText.textContent = `请求失败: ${err.message}`;
  } finally {
    $extendBtn.disabled = false;
    $extendBtn.textContent = '延长视频 +5s';
  }
});

// --- Render video player ---
function renderVideo(url) {
  $resultArea.innerHTML = `
    <video controls autoplay muted loop class="ltxv-video-player" src="${url}">
      您的浏览器不支持 video 标签。
    </video>`;
}

// --- File to base64 ---
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // includes data:image/... prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
