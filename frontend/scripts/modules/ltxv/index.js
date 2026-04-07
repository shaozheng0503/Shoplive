/**
 * Video generation UI — supports LTX 2.3 (ComfyUI) and Veo 3.1 Fast dual engine.
 */

// ===== State =====
let state = {
  engine: 'comfyui-ltxv',  // 'comfyui-ltxv' or 'veo'
  // LTX settings
  ltxModel: 'LTX-2 (Pro)',
  ltxOrient: 'landscape',   // 'landscape' or 'portrait'
  ltxBaseRes: '1920x1080',  // base resolution (always WxH landscape form)
  ltxResolution: '1920x1080',
  ltxDuration: 10,
  ltxFps: 25,
  // Veo settings
  veoRatio: '9:16',
  veoDuration: 8,
  // Shared
  imageFile: null,
  lastVideoUrl: null,
};

// ===== Elements =====
const $ = (id) => document.getElementById(id);
const $prompt       = $('ltxvPrompt');
const $imageInput   = $('ltxvImageInput');
const $imagePickBtn = $('ltxvImagePickBtn');
const $imageName    = $('ltxvImageName');
const $imageClearBtn= $('ltxvImageClearBtn');
const $ltxSettings  = $('ltxvSettings');
const $veoSettings  = $('veoSettings');
const $durationSlider = $('ltxvDuration');
const $durationLabel  = $('ltxvDurationLabel');
const $audioChk       = $('ltxvAudio');
const $generateBtn    = $('ltxvGenerateBtn');
const $progressWrap   = $('ltxvProgressWrap');
const $progressBar    = $('ltxvProgressBar');
const $statusText     = $('ltxvStatusText');
const $resultArea     = $('ltxvResultArea');
const $resultMeta     = $('ltxvResultMeta');
const $actions        = $('ltxvActions');
const $downloadBtn    = $('ltxvDownloadBtn');
const $extendBtn      = $('ltxvExtendBtn');

// ===== Generic option button binding =====
function bindOpts(attr, onChange) {
  document.querySelectorAll(`[${attr}]`).forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.parentElement;
      row.querySelectorAll('.ltxv-opt-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.getAttribute(attr), btn);
    });
  });
}

// ===== Engine switcher =====
bindOpts('data-engine', (val) => {
  state.engine = val;
  $ltxSettings.style.display = val === 'comfyui-ltxv' ? '' : 'none';
  $veoSettings.style.display = val === 'veo' ? '' : 'none';
  // Update generate button text
  $generateBtn.textContent = val === 'veo' ? '生成视频 (Veo)' : '生成视频 (LTX)';
});

// ===== LTX settings =====
function updateLtxResolution() {
  // Flip WxH when portrait
  if (state.ltxOrient === 'portrait') {
    const [w, h] = state.ltxBaseRes.split('x');
    state.ltxResolution = `${h}x${w}`;
  } else {
    state.ltxResolution = state.ltxBaseRes;
  }
}
bindOpts('data-ltxv-model', (val) => { state.ltxModel = val; });
bindOpts('data-ltxv-orient', (val) => { state.ltxOrient = val; updateLtxResolution(); });
bindOpts('data-ltxv-res', (val) => { state.ltxBaseRes = val; updateLtxResolution(); });
bindOpts('data-ltxv-fps', (val) => { state.ltxFps = parseInt(val, 10); });

$durationSlider.addEventListener('input', () => {
  state.ltxDuration = parseInt($durationSlider.value, 10);
  $durationLabel.textContent = `${state.ltxDuration}s`;
});

// ===== Veo settings =====
bindOpts('data-veo-ratio', (val) => { state.veoRatio = val; });
bindOpts('data-veo-dur', (val) => { state.veoDuration = parseInt(val, 10); });

// ===== Image picker =====
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

// ===== Progress =====
let _progressTimer = null;
function startProgress() {
  $progressWrap.style.display = '';
  $progressBar.style.width = '5%';
  let pct = 5;
  _progressTimer = setInterval(() => {
    pct = Math.min(92, pct + (92 - pct) * 0.03);
    $progressBar.style.width = `${pct}%`;
  }, 1000);
}
function finishProgress() {
  clearInterval(_progressTimer);
  $progressBar.style.width = '100%';
  setTimeout(() => { $progressWrap.style.display = 'none'; $progressBar.style.width = '0%'; }, 600);
}

// ===== Generate =====
$generateBtn.addEventListener('click', async () => {
  const prompt = $prompt.value.trim();
  if (!prompt) { alert('请输入视频描述'); return; }

  $generateBtn.disabled = true;
  $generateBtn.textContent = '生成中…';
  $actions.style.display = 'none';
  $statusText.textContent = '正在生成，请稍候…';
  startProgress();

  try {
    const t0 = Date.now();
    let result;

    if (state.engine === 'comfyui-ltxv') {
      result = await generateLTX(prompt);
    } else {
      result = await generateVeo(prompt);
    }

    finishProgress();

    if (result.error) {
      $statusText.textContent = `错误: ${result.error}`;
      return;
    }

    state.lastVideoUrl = result.video_url;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    $resultMeta.textContent = `${result.model || state.engine} · ${result.resolution || ''} · ${result.duration || ''}s · 耗时 ${elapsed}s`;
    $statusText.textContent = '生成完成';
    renderVideo(result.video_url);

    $downloadBtn.href = result.video_url;
    $downloadBtn.download = result.filename || 'video.mp4';
    $actions.style.display = '';

    // Show extend button only for Veo 8s
    if ($extendBtn) {
      $extendBtn.style.display = (state.engine === 'veo' && state.veoDuration === 8) ? '' : 'none';
    }
  } catch (err) {
    finishProgress();
    $statusText.textContent = `请求失败: ${err.message}`;
  } finally {
    $generateBtn.disabled = false;
    $generateBtn.textContent = state.engine === 'veo' ? '生成视频 (Veo)' : '生成视频 (LTX)';
  }
});

// ===== LTX via ComfyUI =====
async function generateLTX(prompt) {
  const body = {
    prompt,
    model: state.ltxModel,
    duration: state.ltxDuration,
    resolution: state.ltxResolution,
    fps: state.ltxFps,
    generate_audio: $audioChk?.checked || false,
  };

  if (state.imageFile) {
    body.image_base64 = await fileToBase64(state.imageFile);
  }

  const res = await fetch('/api/comfyui-ltxv/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json();
}

// ===== Veo =====
async function generateVeo(prompt) {
  if (state.veoDuration === 16) {
    // Use local-chain for 16s
    const body = {
      prompt,
      model: 'veo-3.1-fast-generate-001',
      aspect_ratio: state.veoRatio,
      target_total_seconds: 16,
      crossfade_seconds: 0.5,
    };
    const res = await fetch('/api/veo/local-chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return {
      video_url: data.video_url,
      filename: data.filename,
      model: 'Veo 3.1 Fast',
      resolution: '720p',
      duration: 16,
      error: data.error,
    };
  } else {
    // 8s single shot via /api/veo/start + poll
    const startBody = {
      prompt,
      model: 'veo-3.1-fast-generate-001',
      veo_mode: state.imageFile ? 'image' : 'text',
      duration_seconds: 8,
      aspect_ratio: state.veoRatio,
      sample_count: 1,
    };
    if (state.imageFile) {
      startBody.image_base64 = await fileToBase64(state.imageFile);
    }

    const startRes = await fetch('/api/veo/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(startBody),
    });
    const startData = await startRes.json();
    if (!startData.ok) return { error: startData.error || 'Veo submit failed' };

    // Poll until done
    const opName = startData.operation_name;
    for (let i = 0; i < 60; i++) {
      await sleep(10000);
      const pollRes = await fetch('/api/veo/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_name: opName,
          model: 'veo-3.1-fast-generate-001',
        }),
      });
      const pollData = await pollRes.json();

      // Check inline videos
      const inlines = pollData.inline_videos || [];
      if (inlines.length > 0) {
        // Save inline video via a small helper endpoint or use data URL
        const videoDataUrl = `data:video/mp4;base64,${inlines[0].base64 || inlines[0]}`;
        return {
          video_url: videoDataUrl,
          filename: 'veo_video.mp4',
          model: 'Veo 3.1 Fast',
          resolution: state.veoRatio === '9:16' ? '720x1280' : '1280x720',
          duration: 8,
        };
      }
      // Check signed URLs
      if (pollData.signed_video_urls?.length > 0) {
        return {
          video_url: pollData.signed_video_urls[0],
          filename: 'veo_video.mp4',
          model: 'Veo 3.1 Fast',
          resolution: state.veoRatio === '9:16' ? '720x1280' : '1280x720',
          duration: 8,
        };
      }
    }
    return { error: 'Veo polling timeout' };
  }
}

// ===== Helpers =====
function renderVideo(url) {
  $resultArea.innerHTML = `
    <video controls autoplay muted loop class="ltxv-video-player" src="${url}">
      浏览器不支持 video 标签
    </video>`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
