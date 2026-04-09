/** 单页可同时进行的视频生成数（多窗口各自独立计数）。演示可调高 window.__SHOPLIVE_MAX_CONCURRENT_JOBS__（1–64，需在加载模块前设置）。 */
export const MAX_CONCURRENT_VIDEO_JOBS = (() => {
  try {
    const w = typeof window !== "undefined" ? window : null;
    const raw = w && w.__SHOPLIVE_MAX_CONCURRENT_JOBS__;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.min(64, Math.floor(n));
  } catch (_e) {}
  return 12;
})();
export const CHAT_TAIL_LIMIT_WHEN_SPLIT = 3;

export const state = {
  stage: "awaitMain",
  images: [],
  productAnchors: {},
  productName: "",
  mainBusiness: "",
  sellingPoints: "",
  targetUser: "",
  salesRegion: "",
  brandInfo: "",
  reviewPositivePoints: [],
  reviewNegativePoints: [],
  productImageUrls: [],
  template: "clean",
  duration: "16",
  /** 视频引擎：ltx | jimeng | veo | grok（与 Agent 页模型切换一致） */
  videoEngine: "veo",
  aspectRatio: "16:9",
  needModel: true,
  summaryShown: false,
  regionBatchIdx: 0,
  targetBatchIdx: 0,
  brandBatchIdx: 0,
  generating: false,
  activeVideoJobs: 0,
  taskSeq: 0,
  taskMap: {},
  enhancing: false,
  firstFrame: null,
  lastFrame: null,
  frameMode: false,
  videoEditorOpen: false,
  scriptEditorOpen: false,
  lastPrompt: "",
  lastStoryboard: "",
  lastVideoUrl: "",
  primarySubmitLocked: false,
  canUseEditors: false,
  workflowHydrating: false,
  workflowHydrated: false,
  skipImageConfirmed: false,
  entryFocusMode: false,
  lastModelAdviceKey: "",
  activeVideoCardId: "",
  videoUrlHistory: [],    // max-10 undo stack — push before each export
  pendingEditExport: null, // stored async fn for preview-confirm flow
  videoEdit: {
    maskText: "",
    maskStyle: "elegant",
    maskFont: "sans",
    maskColor: "#ffffff",
    x: 10,
    y: 0,
    w: 80,
    h: 12,
    opacity: 90,
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
    _renderHash: "",
    timeline: {
      playhead: 0,
      selectedTrack: "mask",
      trackState: {
        mask: { visible: true, locked: false },
        color: { visible: true, locked: false },
        bgm: { visible: true, locked: false },
        motion: { visible: true, locked: false },
      },
      keyframes: {
        mask: [],
        color: [],
        bgm: [],
        motion: [],
      },
    },
  },
};

export const smartOptionCache = {
  signature: "",
  targetPool: [],
  brandPool: [],
  loading: null,
};
