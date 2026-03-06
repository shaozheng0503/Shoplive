export const TRANSIENT_BACKOFF_PRESETS = {
  studioExport: {
    baseMs: 7000,
    stepMs: 3000,
    maxMs: 25000,
    noticeIntervalMs: 15000,
  },
  agentFastPoll: {
    baseMs: 7000,
    stepMs: 2500,
    maxMs: 22000,
    noticeIntervalMs: 12000,
  },
  agentChainPoll: {
    baseMs: 6000,
    stepMs: 2500,
    maxMs: 22000,
    noticeIntervalMs: 12000,
  },
};

export function createTransientBackoff({
  baseMs = 6000,
  stepMs = 2500,
  maxMs = 22000,
  noticeIntervalMs = 12000,
} = {}) {
  let backoffUntil = 0;
  let lastNoticeAt = 0;

  return {
    active() {
      return Date.now() < backoffUntil;
    },
    remainingMs() {
      return Math.max(0, backoffUntil - Date.now());
    },
    apply(retryAttempts = 0) {
      const retries = Math.max(0, Number(retryAttempts) || 0);
      const waitMs = Math.min(maxMs, baseMs + retries * stepMs);
      backoffUntil = Date.now() + waitMs;
      return waitMs;
    },
    shouldNotify() {
      const now = Date.now();
      if (now - lastNoticeAt > noticeIntervalMs) {
        lastNoticeAt = now;
        return true;
      }
      return false;
    },
    reset() {
      backoffUntil = 0;
      lastNoticeAt = 0;
    },
  };
}

export function createTransientBackoffByPreset(presetName = "") {
  const preset = TRANSIENT_BACKOFF_PRESETS[presetName] || {};
  return createTransientBackoff(preset);
}
