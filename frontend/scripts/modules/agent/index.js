import { createTransientBackoffByPreset } from "../../shared/polling.js";

const chatList = document.getElementById("chatList");
const taskQueuePanel = document.getElementById("taskQueuePanel");
const taskQueueTitle = document.getElementById("taskQueueTitle");
const taskQueueList = document.getElementById("taskQueueList");
const taskQueueClearBtn = document.getElementById("taskQueueClearBtn");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const uploadBtn = document.getElementById("uploadBtn");
const imageInput = document.getElementById("imageInput");
const langToggleBtn = document.getElementById("langToggleBtn");
const aspectRatioSelect = document.getElementById("aspectRatioSelect");
const durationSelect = document.getElementById("durationSelect");
const enhancePromptBtn = document.getElementById("enhancePromptBtn");
const uploadHint = document.getElementById("uploadHint");
const productUrlInput = document.getElementById("productUrlInput");
const parseProductUrlBtn = document.getElementById("parseProductUrlBtn");
const toggleProductUrlBtn = document.getElementById("toggleProductUrlBtn");
const workspaceEl = document.getElementById("workspace");
const composerCompact = document.querySelector(".composer.composer-compact");
const workspaceToolbar = document.querySelector(".workspace-toolbar");
const scriptEditorPanel = document.getElementById("scriptEditorPanel");
const videoEditorPanel = document.getElementById("videoEditorPanel");
const toggleScriptTab = document.getElementById("toggleScriptTab");
const toggleVideoTab = document.getElementById("toggleVideoTab");
const queryParams = new URLSearchParams(window.location.search);
const SIMPLE_AGENT_MODE = true;

const i18n = {
  zh: {
    back: "返回首页",
    inputPh: "输入视频提示词...",
    upload: "上传图片",
    send: "生成视频",
    enhancePrompt: "提示词增强",
    uploadHint: "上传商品图后可自动解析关键信息，并用于提示词优化。",
    ratioLabel: "比例",
    durationLabel: "视频时长",
    welcome:
      "Hi — 我是 Shoplive 的 AI 助手 😊 现在你可以直接填写提示词并一键生成；上传参考图后我会自动识别商品信息并辅助优化提示词。",
    uploaded: "已收到 {count} 张商品图，我先帮你识别商品和风格。",
    askUpload: "请先上传 1-6 张商品图片。",
    askUploadOptional: "建议先上传 1-6 张商品图（商品一致性与效果更好），也可以先跳过，后续再补传。",
    uploadNow: "立即上传商品图",
    skipUploadNow: "跳过上传，继续配置",
    skipUploadAck: "好的，先跳过上传。后续你可随时补传商品图。",
    continueChatBtn: "继续对话",
    continueChatDesc: "进入下一步信息采集",
    continueChatPrompt: "点击“继续对话”进入下一步。",
    continueChatAck: "继续对话",
    askPoints: "接下来请补充商品卖点（1-6 个，建议用逗号分隔）。",
    askTarget: "再告诉我目标用户（例如：都市通勤女性 / 学生群体 / 潮流穿搭人群）。",
    askRegion: "明白。请再提供销售地区（例如：中国 / 美国 / 日本）。",
    summaryTitle: "信息收集完成，请确认（可编辑）：",
    hint: "确认后我会直接生成视频，并在对话中展示可播放结果。",
    fImg: "商品图片",
    fProduct: "商品名称",
    fPoints: "商品卖点",
    fTarget: "目标用户",
    fRegion: "销售地区",
    fBrand: "品牌信息方向",
    fTpl: "商品风格模版",
    fDur: "视频时长",
    fRatio: "视频尺寸比例",
    fModel: "是否需要模特展示",
    on: "开启",
    confirm: "确认并生成视频",
    submit: "已开始生成视频，请稍候...",
    chainSubmit: "已开始链式生成 {total} 秒视频：先生成基础8秒片段，再自动延展。",
    chainProgressA: "链式生成进行中（目标 {total} 秒）：正在等待当前片段完成…",
    chainProgressB: "链式生成进行中（目标 {total} 秒）：正在拼接下一段风格一致视频…",
    chainProgressC: "链式生成进行中（目标 {total} 秒）：已应用一致性策略，请稍候…",
    chainDoneDetail: "链式生成完成，共产出 {segments} 段片段。",
    chainSummaryTitle: "链式阶段明细：",
    chainSummaryLineBase: "第{step}段（基础生成）｜seed={seed}｜尝试次数={attempt}｜输出：{uri}",
    chainSummaryLineExtend: "第{step}段（延展）｜尝试次数={attempt}｜输入：{source}｜输出：{uri}",
    op: "视频任务已创建，正在生成。",
    polling: "视频生成中，请稍候...",
    pollTransient: "上游状态查询抖动，已自动重试（重试 {retry} 次），稍后继续轮询…",
    pollContinue: "当前阶段耗时较长（总计 {sec}s），已自动继续轮询，请稍候…",
    pollFail: "当前生成失败，请调整信息后重试。",
    genFail: "当前生成失败，请调整信息后重试。",
    tooManyJobs: "当前已有 3 个视频任务在生成中，请稍候其中一个完成后再提交。",
    taskQueueTitle: "并发任务（最多3个）",
    taskQueued: "排队中",
    taskRunning: "进行中",
    taskDone: "已完成",
    taskFailed: "失败",
    taskView: "查看",
    taskClearDone: "清理已完成",
    enhanceWorking: "正在进行提示词增强，请稍候...",
    enhanceDone: "提示词增强完成，已更新输入框。",
    enhanceFail: "提示词增强失败，已保留原文。",
    enhanceRetry: "重试提示词增强",
    enhanceRetryDesc: "再试一次提示词增强",
    enhanceRetryAck: "重试提示词增强",
    toggleLinkShow: "商品链接",
    toggleLinkHide: "收起链接",
    parseLinkBtn: "解析链接",
    parseLinkPh: "粘贴 Shoplazza 商品链接（可自动解析）",
    parseLinkWorking: "正在解析商品链接，请稍候...",
    parseLinkStep1: "正在访问商品页面，读取 HTML 结构…",
    parseLinkStep2: "正在提取商品名称、价格和卖点信息…",
    parseLinkStep3: "正在下载商品主图并识别风格线索…",
    parseLinkStep4: "正在整理评价数据与关键信息…",
    parseLinkSlow: "解析仍在进行（已用时 {sec}s），页面较复杂，请耐心等待…",
    parseLinkDone: "商品链接解析完成，已回填关键信息并更新提示词草稿。",
    parseLinkFail: "商品链接解析失败，请检查链接或稍后重试。",
    parseLinkWeak: "链接可访问，但未稳定提取到商品主图。请点击“参考图”上传1-4张商品图，我会继续自动优化。",
    parseLinkWeakInfo: "已提取到部分商品信息，但图片不足，建议补传商品图以提升一致性。",
    uploadGuideTitle: "建议上传以下截图（1-4张）：",
    uploadGuideItem1: "商品主图（完整商品主体）",
    uploadGuideItem2: "商品卖点文案区域",
    uploadGuideItem3: "规格/材质/尺寸信息区域",
    uploadGuideItem4: "买家评价区（可选）",
    done: "视频生成完成：",
    parseDone: "已自动解析：商品名称「{product}」，推荐主营方向「{business}」，风格模板「{style}」。你可直接修改后继续。",
    parseFallback: "模型解析暂不可用，已使用本地规则完成预填。你可继续修改。",
    askProduct: "请补充商品名称（必填），例如：法式连衣裙 / 复古女鞋。",
    invalidImg: "商品图片格式无效，请重新上传。",
    invalidType: "请上传 PNG/JPEG 图片（最多 6 张）。",
    gotMore: "已收到，你可以在确认卡中继续编辑后点击“确认并生成视频”。",
    quickGen: "直接生成视频",
    pickRegion: "好的，先确定售卖地区。可直接点选下方选项，也可以点击“换一批”。",
    pickTarget: "接下来确定目标客群。可直接点选下方选项，也可以点击“换一批”。",
    pickBrand: "最后补充品牌方向。可点选下方选项，也可以“换一批”或“跳过”。",
    regionAck: "已选择「{value}」，这会帮助我们优化地区化表达与交付策略。",
    targetAck: "定位为「{value}」很合适，这有助于我们优化文案与转化结构。",
    brandAck: "品牌方向「{value}」已记录，后续会用于风格与语气控制。",
    skipBrand: "已跳过品牌方向选择，我会使用默认品牌表达继续配置。",
    refresh: "换一批",
    refreshDesc: "查看更多推荐选项",
    skip: "跳过，直接继续",
    skipDesc: "先用默认品牌方向继续",
    optCN: "中国：电商生态成熟，适合快速上新与大促",
    optUS: "美国：重视品牌故事与场景化穿搭内容",
    optJP: "日本：偏好细节品质与简洁高级感",
    optSEA: "东南亚：短视频转化活跃，适合潮流款",
    optEU: "欧洲：注重可持续理念与面料质感",
    optME: "中东：偏好高质感视觉与精致搭配",
    tIndustry: "都市通勤女性：关注版型、舒适与质感",
    tInstall: "甜美学生群体：关注颜值、搭配和性价比",
    tDealer: "轻熟职场人群：关注剪裁、面料与场景适配",
    tRetail: "潮流穿搭爱好者：关注风格表达与上新速度",
    bReliable: "轻奢质感型：强调高级面料与精致工艺",
    bValue: "高性价比型：强调百搭与日常高频穿着",
    bCustom: "设计师风格型：强调个性轮廓与风格识别",
    insightWorking: "正在识别商品与风格，请稍候...",
    insightWorkingAlt1: "我在看商品主体和细节特征…",
    insightWorkingAlt2: "我在提取风格线索，马上给你结果…",
    insightWorkingAlt3: "我在整理可编辑字段（商品名/主营方向/风格）…",
    insightSlow: "识别仍在进行（已用时 {sec}s），我正在尽量提高准确性…",
    insightRecapTitle: "识别结果如下（可继续修改）：",
    insightRecapProduct: "商品名称：{value}",
    insightRecapBusiness: "主营方向：{value}",
    insightRecapStyle: "风格模板：{value}",
    insightEditTitle: "你可以直接修改以下信息：",
    insightConfirmBtn: "确认这些信息",
    insightConfirmUser: "确认这些信息，继续",
    insightWait: "识别仍在进行（已用时 {sec}s），正在提高结果准确性，请稍候…",
    searchRegionPh: "搜索售卖国家/地区（例如：中国香港、美国、日本）",
    regionNoMatch: "未找到匹配项，可直接输入国家/地区后发送。",
    showMoreRegions: "查看更多国家",
    editVideo: "编辑视频",
    editScript: "编辑脚本",
    videoEditTitle: "视频编辑",
    videoEditHint: "这里是生成后编辑区，只对当前视频做后处理预览，不会改提示词或再次提交生成任务。",
    textMaskTitle: "视频文字蒙版",
    textMaskText: "文案内容",
    textMaskStyle: "样式预设",
    textMaskElegant: "优雅简洁",
    textMaskBold: "高对比标题",
    textMaskSoft: "柔和叙事",
    positionX: "X 位置",
    positionY: "Y 位置",
    maskWidth: "宽度",
    maskHeight: "高度",
    maskOpacity: "透明度",
    maskRotation: "旋转",
    videoTuneTitle: "视频相关信息编辑",
    clipSpeed: "播放速度",
    colorTemp: "色温",
    colorTint: "色调",
    colorSat: "饱和度",
    colorVibrance: "鲜艳度",
    bgmTitle: "BGM 提取与更换",
    bgmExtract: "启用 BGM 提取",
    bgmMood: "BGM 风格",
    bgmVolume: "BGM 音量",
    bgmReplace: "更换方式",
    bgmLocalFile: "本地 BGM 文件",
    bgmChooseFile: "选择音频文件",
    bgmNoLocalFile: "未选择文件",
    bgmClearFile: "清除文件",
    bgmUseLocal: "使用本地音频替换",
    bgmMoodElegant: "优雅轻奢",
    bgmMoodDaily: "日常清新",
    bgmMoodTrendy: "潮流节奏",
    bgmMoodPiano: "钢琴氛围",
    bgmReplaceAuto: "自动智能匹配",
    bgmReplaceKeep: "保持原视频节奏",
    bgmReplaceStrongBeat: "强调节奏感",
    timelineTitle: "关键帧点位时间轴",
    timelineHint: "选择轨道后可添加/删除关键帧，点击点位可跳转到对应时间。",
    videoModuleTitle: "模块编辑",
    videoModuleHint: "点击下方时间轴轨道切换模块，右侧仅显示当前模块参数。",
    timelineToggleVisible: "切换轨道可见性",
    timelineToggleLock: "切换轨道锁定",
    timelineTrackHidden: "轨道已隐藏，预览中不生效。",
    timelineTrackLocked: "轨道已锁定，暂不可编辑。",
    timelinePlayhead: "播放头",
    timelineSelectTrack: "当前轨道",
    timelineTrackMask: "文字蒙版",
    timelineTrackColor: "调色",
    timelineTrackBgm: "BGM",
    timelineTrackMotion: "运动",
    timelineAddKeyframe: "添加关键帧",
    timelineRemoveKeyframe: "删除最近关键帧",
    timelineNoKeyframe: "暂无关键帧",
    scriptEditTitle: "分镜脚本输出修改（重新生成）",
    scriptEditHint: "可编辑分镜文案与完整提示词，然后重新生成视频。",
    promptLabel: "完整生成视频提示词",
    storyboardLabel: "分镜脚本",
    storyboardRegenerate: "用修改后的脚本重新生成",
    videoRegenerate: "应用视频编辑（不重新生成）",
    videoApplyDone: "视频编辑已导出并应用到预览。",
    videoExporting: "正在导出视频编辑，请稍候...",
    videoExportFail: "视频编辑导出失败，请稍后重试。",
    videoMaskUnsupported: "已完成导出，但当前环境不支持文字蒙版写入（drawtext 不可用）。",
    closePanel: "收起",
    alreadySubmitted: "任务已提交，请等待生成完成；如需再次生成，请使用编辑面板里的“重新生成”。",
    tabScript: "分镜脚本",
    tabVideo: "视频编辑",
    tabShowHint: "点击展开",
    tabHideHint: "点击收起",
  },
  en: {
    back: "Back",
    inputPh: "Type video prompt...",
    upload: "Upload Images",
    send: "Generate",
    enhancePrompt: "Enhance Prompt",
    uploadHint: "Upload reference images to auto-parse product info for prompt optimization.",
    ratioLabel: "Aspect Ratio",
    durationLabel: "Duration",
    welcome:
      "Hi — I’m Shoplive’s AI assistant 😊 You can now generate directly with one prompt. Upload reference images and I’ll auto-parse product signals to improve prompt quality.",
    uploaded: "Received {count} product image(s). I’ll now infer product and style.",
    askUpload: "Please upload 1-6 product images first.",
    askUploadOptional:
      "Recommended: upload 1-6 product images first for better consistency and quality. You can also skip for now.",
    uploadNow: "Upload product images now",
    skipUploadNow: "Skip upload and continue",
    skipUploadAck: "Okay, upload skipped for now. You can upload product images later anytime.",
    continueChatBtn: "Continue chat",
    continueChatDesc: "Proceed to the next guided step",
    continueChatPrompt: "Click \"Continue chat\" to move on.",
    continueChatAck: "Continue chat",
    askPoints: "Next, share selling points (1-6, comma-separated).",
    askTarget: "Great! Now tell me your target audience.",
    askRegion: "Got it. Please provide your sales region.",
    summaryTitle: "All required info is collected. Please confirm (editable):",
    hint: "After confirmation, I will generate video and show a playable result in chat.",
    fImg: "Product images",
    fProduct: "Product name",
    fPoints: "Selling points",
    fTarget: "Target audience",
    fRegion: "Sales region",
    fBrand: "Brand direction",
    fTpl: "Style template",
    fDur: "Video duration",
    fRatio: "Aspect ratio",
    fModel: "Need model showcase",
    on: "Enabled",
    confirm: "Confirm & Generate Video",
    submit: "Video generation started, please wait...",
    chainSubmit: "Chained generation started for {total}s: creating base 8s segment then extending automatically.",
    chainProgressA: "Chained generation in progress ({total}s target): waiting for current segment to finish...",
    chainProgressB: "Chained generation in progress ({total}s target): extending with style continuity...",
    chainProgressC: "Chained generation in progress ({total}s target): consistency constraints applied, please wait...",
    chainDoneDetail: "Chained generation completed with {segments} segments.",
    chainSummaryTitle: "Chained segment details:",
    chainSummaryLineBase: "Segment {step} (base) | seed={seed} | attempts={attempt} | output: {uri}",
    chainSummaryLineExtend: "Segment {step} (extend) | attempts={attempt} | input: {source} | output: {uri}",
    op: "Video task created. Generating now.",
    polling: "Generating video, please wait...",
    pollTransient: "Upstream status jitter detected. Auto retry applied ({retry} retries). Polling will continue shortly…",
    pollContinue: "This stage is taking longer than expected ({sec}s total). Auto-continue polling is active…",
    pollFail: "Generation failed. Please adjust inputs and retry.",
    genFail: "Generation failed. Please adjust inputs and retry.",
    tooManyJobs: "There are already 3 video jobs running. Please wait for one to finish before submitting another.",
    taskQueueTitle: "Concurrent jobs (max 3)",
    taskQueued: "Queued",
    taskRunning: "Running",
    taskDone: "Done",
    taskFailed: "Failed",
    taskView: "View",
    taskClearDone: "Clear done",
    enhanceWorking: "Enhancing prompt, please wait...",
    enhanceDone: "Prompt enhancement completed and applied.",
    enhanceFail: "Prompt enhancement failed. Original prompt kept.",
    enhanceRetry: "Retry prompt enhancement",
    enhanceRetryDesc: "Retry prompt enhancement once more",
    enhanceRetryAck: "Retry prompt enhancement",
    toggleLinkShow: "Product URL",
    toggleLinkHide: "Hide URL",
    parseLinkBtn: "Parse Link",
    parseLinkPh: "Paste a Shoplazza product URL to auto parse",
    parseLinkWorking: "Parsing product URL...",
    parseLinkStep1: "Accessing product page, reading HTML structure…",
    parseLinkStep2: "Extracting product name, price and selling points…",
    parseLinkStep3: "Downloading product images and detecting style cues…",
    parseLinkStep4: "Compiling review data and key attributes…",
    parseLinkSlow: "Still parsing ({sec}s). Complex page, please wait…",
    parseLinkDone: "Product URL parsed and draft prompt updated.",
    parseLinkFail: "Failed to parse product URL. Please verify URL and retry.",
    parseLinkWeak: "URL is reachable, but product images were not reliably extracted. Please upload 1-4 product images via \"Reference\".",
    parseLinkWeakInfo: "Partial product info extracted, but image signals are weak. Upload reference images for better consistency.",
    uploadGuideTitle: "Recommended screenshots to upload (1-4):",
    uploadGuideItem1: "Primary product image (full product body)",
    uploadGuideItem2: "Key selling points text section",
    uploadGuideItem3: "Specs/material/size section",
    uploadGuideItem4: "Customer reviews section (optional)",
    done: "Video generated:",
    parseDone: "Auto parsed: product name \"{product}\", suggested focus \"{business}\", style template \"{style}\". You can edit before continuing.",
    parseFallback: "Model parsing is unavailable. Local fallback prefill has been applied.",
    askProduct: "Please provide product name (required), e.g. French dress / retro heels.",
    invalidImg: "Invalid product image format, please re-upload.",
    invalidType: "Please upload PNG/JPEG images only (max 6).",
    gotMore: "Received. You can edit fields in the confirmation card and continue.",
    quickGen: "Generate video now",
    pickRegion: "Great direction 🔧 Let's lock your sales region first (or refresh options):",
    pickTarget: "Now choose target audience (or refresh options):",
    pickBrand: "Next, pick your brand direction (or refresh / skip):",
    regionAck: "Selected \"{value}\". This helps localize messaging and delivery strategy.",
    targetAck: "Audience \"{value}\" recorded. We'll optimize copy and structure for conversion.",
    brandAck: "Brand direction \"{value}\" recorded.",
    skipBrand: "Brand direction skipped. I’ll continue with default brand tone.",
    refresh: "Refresh options",
    refreshDesc: "Show another recommendation set",
    skip: "Skip and continue",
    skipDesc: "Use default brand direction for now",
    optCN: "China: mature ecommerce ecosystem for fast launches",
    optUS: "US: story-driven branding and lifestyle positioning",
    optJP: "Japan: quality, detail, and clean aesthetics",
    optSEA: "SEA: fast social commerce growth for trend styles",
    optEU: "Europe: quality fabrics and sustainable positioning",
    optME: "Middle East: premium visuals and polished styling",
    tIndustry: "Urban office women: fit, comfort, and texture",
    tInstall: "Student segment: style, affordability, and matching ease",
    tDealer: "Young professionals: tailoring, fabric, occasion fit",
    tRetail: "Trend-driven fashion audience: style expression and novelty",
    bReliable: "Premium texture: refined materials and craftsmanship",
    bValue: "Value-first everyday wear: versatile and affordable",
    bCustom: "Designer-led style: distinctive silhouette and identity",
    insightWorking: "Recognizing product and style, please wait...",
    insightWorkingAlt1: "Checking product subject and fine details…",
    insightWorkingAlt2: "Extracting style cues, almost there…",
    insightWorkingAlt3: "Compiling editable fields (name/focus/style)…",
    insightSlow: "Still analyzing ({sec}s). Improving accuracy…",
    insightRecapTitle: "Recognition result (editable):",
    insightRecapProduct: "Product name: {value}",
    insightRecapBusiness: "Business focus: {value}",
    insightRecapStyle: "Style template: {value}",
    insightEditTitle: "You can edit the parsed fields below:",
    insightConfirmBtn: "Confirm these fields",
    insightConfirmUser: "Confirmed. Continue",
    insightWait: "Still analyzing ({sec}s). Improving accuracy, please wait…",
    searchRegionPh: "Search sales country/region (e.g. Hong Kong, US, Japan)",
    regionNoMatch: "No match found. You can type a country/region and send.",
    showMoreRegions: "Show more countries",
    editVideo: "Edit video",
    editScript: "Edit script",
    videoEditTitle: "Video editor",
    videoEditHint: "Post-generation editor only. Applies local preview edits without changing prompt or submitting new generation jobs.",
    textMaskTitle: "Text mask overlay",
    textMaskText: "Overlay text",
    textMaskStyle: "Style preset",
    textMaskElegant: "Elegant clean",
    textMaskBold: "High-contrast headline",
    textMaskSoft: "Soft storytelling",
    positionX: "X position",
    positionY: "Y position",
    maskWidth: "Width",
    maskHeight: "Height",
    maskOpacity: "Opacity",
    maskRotation: "Rotation",
    videoTuneTitle: "Video tuning",
    clipSpeed: "Playback speed",
    colorTemp: "Temperature",
    colorTint: "Tint",
    colorSat: "Saturation",
    colorVibrance: "Vibrance",
    bgmTitle: "BGM extract & replace",
    bgmExtract: "Enable BGM extraction",
    bgmMood: "BGM mood",
    bgmVolume: "BGM volume",
    bgmReplace: "Replacement mode",
    bgmLocalFile: "Local BGM file",
    bgmChooseFile: "Choose audio file",
    bgmNoLocalFile: "No file selected",
    bgmClearFile: "Clear file",
    bgmUseLocal: "Use local audio replacement",
    bgmMoodElegant: "Elegant premium",
    bgmMoodDaily: "Daily fresh",
    bgmMoodTrendy: "Trendy rhythm",
    bgmMoodPiano: "Piano ambient",
    bgmReplaceAuto: "Auto smart matching",
    bgmReplaceKeep: "Keep original rhythm",
    bgmReplaceStrongBeat: "Stronger beat emphasis",
    timelineTitle: "Keyframe timeline",
    timelineHint: "Select a track to add/remove keyframes. Click points to jump.",
    videoModuleTitle: "Module editor",
    videoModuleHint: "Click timeline tracks to switch modules. Top-right shows only the active module settings.",
    timelineToggleVisible: "Toggle track visibility",
    timelineToggleLock: "Toggle track lock",
    timelineTrackHidden: "This track is hidden and not applied in preview.",
    timelineTrackLocked: "This track is locked and currently not editable.",
    timelinePlayhead: "Playhead",
    timelineSelectTrack: "Selected track",
    timelineTrackMask: "Text mask",
    timelineTrackColor: "Color",
    timelineTrackBgm: "BGM",
    timelineTrackMotion: "Motion",
    timelineAddKeyframe: "Add keyframe",
    timelineRemoveKeyframe: "Remove nearest keyframe",
    timelineNoKeyframe: "No keyframes",
    scriptEditTitle: "Storyboard script editing (regenerate)",
    scriptEditHint: "Edit storyboard text and full prompt, then regenerate.",
    promptLabel: "Full video generation prompt",
    storyboardLabel: "Storyboard script",
    storyboardRegenerate: "Regenerate with edited script",
    videoRegenerate: "Apply video edits (no regeneration)",
    videoApplyDone: "Video edits exported and applied to preview.",
    videoExporting: "Exporting video edits, please wait...",
    videoExportFail: "Video edit export failed. Please try again.",
    videoMaskUnsupported: "Export succeeded, but text mask was skipped (drawtext unavailable).",
    closePanel: "Close",
    alreadySubmitted: "Task already submitted. Wait for completion, then use regenerate in editor panels if needed.",
    tabScript: "Storyboard",
    tabVideo: "Video Editor",
    tabShowHint: "Click to open",
    tabHideHint: "Click to close",
  },
};

const shortFeedback = {
  zh: {
    general: ["太好了～", "明白了👌", "收到啦🙌", "这个方向很棒✨"],
    region: ["好选择👍", "这个地区定位很清晰👏", "很不错，方向明确✨"],
    target: ["这个客群选得很准🎯", "定位很清楚👏", "这个人群很匹配✨"],
    brand: ["品牌调性很到位💡", "这个品牌方向很加分✨", "很好，这个定位很有辨识度🌟"],
  },
  en: {
    general: ["Great!", "Got it 👌", "Nice choice 🙌", "Love this direction ✨"],
    region: ["Great market choice 👍", "Clear region positioning 👏", "Nice, region strategy is solid ✨"],
    target: ["Audience fit looks strong 🎯", "Great audience focus 👏", "Nice segment choice ✨"],
    brand: ["Strong brand direction 💡", "Great brand tone choice ✨", "Nice, this adds identity 🌟"],
  },
};

const feedbackDeck = {};
const insightPulseDeck = {};

const targetBatches = [
  ["tIndustry", "tInstall", "tDealer"],
  ["tRetail", "tDealer", "tIndustry"],
];
const brandBatches = [
  ["bReliable", "bValue", "bCustom"],
  ["bValue", "bCustom", "bReliable"],
];

const REGION_ITEMS = [
  { zh: "中国", en: "China", flag: "🇨🇳", common: true, descZh: "电商生态成熟，适合快速上新与大促", descEn: "Mature ecommerce ecosystem for fast launches" },
  { zh: "中国香港", en: "Hong Kong", flag: "🇭🇰", common: true, descZh: "跨境与本地消费并重，适合精品与潮流款", descEn: "Strong cross-border and local demand for premium/trendy products" },
  { zh: "美国", en: "United States", flag: "🇺🇸", common: true, descZh: "重视品牌故事与场景化穿搭内容", descEn: "Story-driven branding and lifestyle positioning" },
  { zh: "日本", en: "Japan", flag: "🇯🇵", common: true, descZh: "偏好细节品质与简洁高级感", descEn: "Quality, detail, and clean aesthetics" },
  { zh: "新加坡", en: "Singapore", flag: "🇸🇬", common: true, descZh: "高客单市场，注重品质与履约体验", descEn: "Higher AOV market focused on quality and fulfillment" },
  { zh: "英国", en: "United Kingdom", flag: "🇬🇧", common: false, descZh: "注重品牌风格一致性与口碑", descEn: "Strong focus on brand consistency and reviews" },
  { zh: "德国", en: "Germany", flag: "🇩🇪", common: false, descZh: "关注功能与面料说明，理性消费", descEn: "Function-first messaging and rational purchase behavior" },
  { zh: "法国", en: "France", flag: "🇫🇷", common: false, descZh: "偏好设计感与质感表达", descEn: "Design-forward and texture-focused preference" },
  { zh: "阿联酋", en: "UAE", flag: "🇦🇪", common: false, descZh: "偏好高质感视觉与精致搭配", descEn: "Premium visuals and polished styling" },
  { zh: "加拿大", en: "Canada", flag: "🇨🇦", common: false, descZh: "重视性价比与实穿场景", descEn: "Balanced value and practical styling scenarios" },
  { zh: "澳大利亚", en: "Australia", flag: "🇦🇺", common: false, descZh: "偏好轻松自然风格与高频穿搭", descEn: "Relaxed style and high-frequency outfit usage" },
  { zh: "马来西亚", en: "Malaysia", flag: "🇲🇾", common: false, descZh: "社媒转化活跃，适合快节奏上新", descEn: "Strong social-commerce conversion for fast drops" },
];

let currentLang = localStorage.getItem("shoplive.lang") || "zh";
let thinkingNode = null;
const MAX_CONCURRENT_VIDEO_JOBS = 3;

const state = {
  stage: "awaitMain",
  images: [],
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
  duration: "8",
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
  videoEdit: {
    maskText: "ELEGANCE",
    maskStyle: "elegant",
    x: 10,
    y: 0,
    w: 80,
    h: 12,
    opacity: 90,
    rotation: 0,
    speed: "1.0",
    temp: 12,
    tint: 5,
    sat: 8,
    vibrance: 10,
    bgmExtract: true,
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
      trackState: {
        mask: { visible: true, locked: false },
        color: { visible: true, locked: false },
        bgm: { visible: true, locked: false },
        motion: { visible: true, locked: false },
      },
      keyframes: {
        mask: [0, 2.2, 5.4],
        color: [1.2, 4.8],
        bgm: [0, 6.4],
        motion: [3.1],
      },
    },
  },
};

function formatElapsedSec(ms) {
  return Math.max(0, Math.floor((Number(ms) || 0) / 1000));
}

function renderTaskQueue() {
  if (!taskQueuePanel || !taskQueueList) return;
  const items = Object.values(state.taskMap || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const doneCount = items.filter((item) => item.status === "done").length;
  if (!items.length) {
    taskQueuePanel.hidden = true;
    taskQueueList.innerHTML = "";
    if (taskQueueClearBtn) taskQueueClearBtn.disabled = true;
    return;
  }
  taskQueuePanel.hidden = false;
  if (taskQueueTitle) taskQueueTitle.textContent = t("taskQueueTitle");
  if (taskQueueClearBtn) {
    taskQueueClearBtn.textContent = t("taskClearDone");
    taskQueueClearBtn.disabled = doneCount <= 0;
  }
  taskQueueList.innerHTML = items
    .slice(0, 8)
    .map((item) => {
      const elapsed = formatElapsedSec(Date.now() - (item.startedAt || item.createdAt || Date.now()));
      const stateText =
        item.status === "done" ? t("taskDone")
          : item.status === "failed" ? t("taskFailed")
            : item.status === "queued" ? t("taskQueued")
              : t("taskRunning");
      const safeStage = sanitizeInputValue(String(item.stage || "").slice(0, 80));
      const safeTitle = sanitizeInputValue(item.title || "Task");
      const canView = Boolean(item.resultCardId);
      const btn = canView
        ? `<button class="task-view-btn" type="button" data-task-action="view" data-task-id="${item.id}">${t("taskView")}</button>`
        : "";
      return `<div class="task-item ${item.status || "running"}"><strong>${safeTitle}</strong><small>${stateText} · ${elapsed}s${safeStage ? ` · ${safeStage}` : ""}${btn}</small></div>`;
    })
    .join("");
}

function createVideoTask(durationLabel = "8s") {
  state.taskSeq = Number(state.taskSeq || 0) + 1;
  const id = `video-task-${Date.now()}-${state.taskSeq}`;
  state.taskMap[id] = {
    id,
    title: `#${state.taskSeq} · ${durationLabel}`,
    status: "queued",
    stage: "",
    createdAt: Date.now(),
    startedAt: Date.now(),
  };
  renderTaskQueue();
  return id;
}

function updateVideoTask(id, patch = {}) {
  if (!id || !state.taskMap[id]) return;
  state.taskMap[id] = { ...state.taskMap[id], ...patch };
  renderTaskQueue();
}

function finishVideoTask(id, ok = true, stage = "") {
  if (!id || !state.taskMap[id]) return;
  state.taskMap[id] = {
    ...state.taskMap[id],
    status: ok ? "done" : "failed",
    stage: stage || state.taskMap[id].stage || "",
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
  if (!task?.resultCardId) return;
  const card = document.querySelector(`[data-task-card-id="${task.resultCardId}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
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

const smartOptionCache = {
  signature: "",
  targetPool: [],
  brandPool: [],
  loading: null,
};
const CHAT_TAIL_LIMIT_WHEN_SPLIT = 3;

function t(key, vars = {}) {
  const str = i18n[currentLang]?.[key] ?? i18n.zh[key] ?? key;
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), str);
}

function shuffle(arr = []) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function nextLead(bucket = "general") {
  const lang = currentLang in shortFeedback ? currentLang : "zh";
  const source = shortFeedback[lang]?.[bucket] || shortFeedback.zh[bucket] || [];
  if (!source.length) return "";
  const key = `${lang}:${bucket}`;
  const deck = feedbackDeck[key];
  if (!deck || deck.idx >= deck.items.length) {
    feedbackDeck[key] = { items: shuffle(source), idx: 0 };
  }
  const active = feedbackDeck[key];
  const value = active.items[active.idx];
  active.idx += 1;
  return value;
}

function withLead(text, bucket = "general") {
  const lead = nextLead(bucket);
  return lead ? `${lead} ${text}` : text;
}

function nextInsightPulseLine() {
  const source = [t("insightWorking"), t("insightWorkingAlt1"), t("insightWorkingAlt2"), t("insightWorkingAlt3")];
  const key = `${currentLang}:insightPulse`;
  let deck = insightPulseDeck[key];
  if (!deck || deck.idx >= deck.items.length) {
    const items = shuffle(source);
    if (deck?.prev && items.length > 1 && items[0] === deck.prev) {
      [items[0], items[1]] = [items[1], items[0]];
    }
    deck = { items, idx: 0, prev: deck?.prev || "" };
    insightPulseDeck[key] = deck;
  }
  const value = deck.items[deck.idx];
  deck.idx += 1;
  deck.prev = value;
  return value;
}

function startLinkParseProgress() {
  const steps = [
    t("parseLinkWorking"),
    t("parseLinkStep1"),
    t("parseLinkStep2"),
    t("parseLinkStep3"),
    t("parseLinkStep4"),
  ];
  const startedAt = Date.now();
  let stepIdx = 0;
  const bubble = pushMsg("system", steps[0], { typewriter: false });
  const timer = setInterval(() => {
    const sec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    if (sec < 20) {
      stepIdx = Math.min(stepIdx + 1, steps.length - 1);
      bubble.textContent = steps[stepIdx];
    } else {
      bubble.textContent = t("parseLinkSlow", { sec });
    }
    scrollToBottom();
  }, 3000);
  return () => {
    clearInterval(timer);
    if (bubble && bubble.parentNode) bubble.remove();
  };
}

function renderWorkspaceTab(el, label, kind) {
  if (!el) return;
  const safeLabel = label || "";
  const iconSvg =
    kind === "script"
      ? "<svg viewBox='0 0 24 24' aria-hidden='true'><rect x='5' y='3.5' width='14' height='17' rx='3'/><rect x='8' y='8' width='8' height='1.8' fill='white'/><rect x='8' y='12' width='8' height='1.8' fill='white'/><rect x='8' y='16' width='6' height='1.8' fill='white'/></svg>"
      : "<svg viewBox='0 0 24 24' aria-hidden='true'><rect x='3.5' y='5' width='12.5' height='14' rx='3'/><polygon points='10.5,9 10.5,15 14.8,12' fill='white'/><path d='M16 9 L20.5 6.5 V17.5 L16 15 Z'/></svg>";
  el.innerHTML = `<span class="tab-icon">${iconSvg}</span><span class="tab-label">${safeLabel}</span>`;
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
  if (uploadHint) uploadHint.textContent = t("uploadHint");
  if (parseProductUrlBtn) parseProductUrlBtn.textContent = t("parseLinkBtn");
  if (productUrlInput) productUrlInput.placeholder = t("parseLinkPh");
  const ratioLabel = document.querySelector('label[for="aspectRatioSelect"] span');
  const durationLabel = document.querySelector('label[for="durationSelect"] span');
  if (ratioLabel) ratioLabel.textContent = t("ratioLabel");
  if (durationLabel) durationLabel.textContent = t("durationLabel");
  if (langToggleBtn) langToggleBtn.textContent = currentLang === "zh" ? "EN" : "中文";
  if (taskQueueClearBtn) taskQueueClearBtn.textContent = t("taskClearDone");
  const back = document.querySelector(".back-link");
  if (back) back.textContent = t("back");
  if (toggleScriptTab) {
    const scriptLabel = t("tabScript") || (currentLang === "zh" ? "分镜脚本" : "Storyboard");
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
}

function syncSimpleControlsFromState() {
  if (aspectRatioSelect) aspectRatioSelect.value = state.aspectRatio || "16:9";
  if (durationSelect) durationSelect.value = String(state.duration || "8");
}

function syncStateFromSimpleControls() {
  if (aspectRatioSelect?.value) state.aspectRatio = aspectRatioSelect.value;
  if (durationSelect?.value) state.duration = String(durationSelect.value);
}

function scrollToBottom() {
  updateChatTailWindow();
  chatList.scrollTop = chatList.scrollHeight;
}

function updateChatTailWindow() {
  if (!chatList) return;
  const isSplitMode = Boolean(state.canUseEditors && (state.videoEditorOpen || state.scriptEditorOpen));
  const nodes = Array.from(chatList.querySelectorAll(":scope > article.msg"));
  nodes.forEach((el) => el.classList.remove("is-history-collapsed"));
  if (!isSplitMode || nodes.length <= CHAT_TAIL_LIMIT_WHEN_SPLIT) return;
  const hideCount = nodes.length - CHAT_TAIL_LIMIT_WHEN_SPLIT;
  for (let i = 0; i < hideCount; i += 1) {
    nodes[i].classList.add("is-history-collapsed");
  }
}

function focusWorkspaceTop() {
  const page = document.querySelector(".agent-page");
  if (page) page.scrollIntoView({ block: "start", behavior: "smooth" });
  window.scrollTo({ top: 0, behavior: "smooth" });
  scrollToBottom();
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

function buildStoryboardText() {
  const points = normalizePointsList(state.sellingPoints);
  const scenes = points.length ? points : [currentLang === "zh" ? "突出产品核心卖点" : "Highlight core product value"];
  const lines = scenes.map((p, idx) =>
    currentLang === "zh"
      ? `镜头${idx + 1}：${p}，面向「${state.targetUser || "目标人群"}」，突出「${state.salesRegion || "目标地区"}」表达。`
      : `Scene ${idx + 1}: ${p}; target "${state.targetUser || "audience"}"; localized for "${state.salesRegion || "region"}".`
  );
  return lines.join("\n");
}

function buildWorkflowInput() {
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
  };
}

function hasWorkflowRequiredInput() {
  return Boolean(
    state.productName &&
      state.mainBusiness &&
      state.sellingPoints &&
      state.targetUser &&
      state.salesRegion
  );
}

async function callShopliveWorkflow(action, extra = {}) {
  const base = getApiBase();
  return postJson(`${base}/api/shoplive/video/workflow`, {
    action,
    input: buildWorkflowInput(),
    model: "azure-gpt-5",
    ...extra,
  });
}

async function hydrateWorkflowTexts(force = false) {
  if (state.workflowHydrating) return;
  if (!force && state.workflowHydrated && state.lastStoryboard && state.lastPrompt) return;
  if (!hasWorkflowRequiredInput()) {
    if (!state.lastStoryboard) state.lastStoryboard = buildStoryboardText();
    if (!state.lastPrompt) state.lastPrompt = buildPrompt();
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
        prompt = sanitizePromptForUser(String(promptResp.prompt).trim());
      }
    } catch (_e) {}
    if (!prompt) prompt = buildPrompt();

    state.lastStoryboard = script;
    state.lastPrompt = sanitizePromptForUser(prompt);
    state.workflowHydrated = true;
  } finally {
    state.workflowHydrating = false;
  }
}

function applyWorkspaceMode() {
  if (!workspaceEl) return;
  updateWorkspaceToolbarVisibility();
  workspaceEl.classList.toggle("entry-focus", Boolean(state.entryFocusMode && !state.canUseEditors));
  if (!state.canUseEditors) {
    state.videoEditorOpen = false;
    state.scriptEditorOpen = false;
    workspaceEl.classList.remove("mode-chat", "mode-two-video", "mode-two-script", "mode-three");
    workspaceEl.classList.remove("has-editors");
    workspaceEl.classList.add("mode-chat");
    if (scriptEditorPanel) scriptEditorPanel.hidden = true;
    if (videoEditorPanel) videoEditorPanel.hidden = true;
    updateWorkspaceTabs();
    updateChatTailWindow();
    return;
  }
  workspaceEl.classList.add("has-editors");
  const mode = state.videoEditorOpen && state.scriptEditorOpen
    ? "mode-three"
    : state.videoEditorOpen
      ? "mode-two-video"
      : state.scriptEditorOpen
        ? "mode-two-script"
        : "mode-chat";
  workspaceEl.classList.remove("mode-chat", "mode-two-video", "mode-two-script", "mode-three");
  workspaceEl.classList.add(mode);
  if (scriptEditorPanel) scriptEditorPanel.hidden = !state.scriptEditorOpen;
  if (videoEditorPanel) videoEditorPanel.hidden = !state.videoEditorOpen;
  updateWorkspaceTabs();
  updateChatTailWindow();
}

function updateWorkspaceTabs() {
  if (toggleScriptTab) {
    const active = Boolean(state.scriptEditorOpen);
    toggleScriptTab.classList.toggle("is-active", active);
    toggleScriptTab.setAttribute("aria-pressed", active ? "true" : "false");
    toggleScriptTab.title = active ? `${t("tabScript")} · ${t("tabHideHint")}` : `${t("tabScript")} · ${t("tabShowHint")}`;
  }
  if (toggleVideoTab) {
    const active = Boolean(state.videoEditorOpen);
    toggleVideoTab.classList.toggle("is-active", active);
    toggleVideoTab.setAttribute("aria-pressed", active ? "true" : "false");
    toggleVideoTab.title = active ? `${t("tabVideo")} · ${t("tabHideHint")}` : `${t("tabVideo")} · ${t("tabShowHint")}`;
  }
  updateToolbarIndicator();
}

function updateWorkspaceToolbarVisibility() {
  if (!workspaceToolbar) return;
  workspaceToolbar.hidden = !state.canUseEditors;
}

function updateToolbarIndicator() {
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

function buildSegmentedStoryboard(segCount = 1) {
  const points = normalizePointsList(state.sellingPoints);
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
    const segLabel = currentLang === "zh" ? `第${s + 1}段（8秒）` : `Segment ${s + 1} (8s)`;
    const lines = chunk.map((p, idx) =>
      currentLang === "zh"
        ? `镜头${idx + 1}：${p}，面向「${state.targetUser || "目标人群"}」。`
        : `Scene ${idx + 1}: ${p}; target "${state.targetUser || "audience"}".`
    );
    segments.push(`[${segLabel}]\n${lines.join("\n")}`);
  }
  return segments;
}

function renderScriptEditor() {
  if (!scriptEditorPanel) return;
  if (!state.scriptEditorOpen) return;

  const dur = Number(state.duration || 8);
  const segCount = dur >= 16 ? Math.floor(dur / 8) : 1;
  const existingSegments = (state.lastStoryboard || "").split(/\n*\[第\d+段|Segment \d+/).filter(Boolean);
  const segments = existingSegments.length === segCount
    ? existingSegments.map((s) => s.replace(/^\(.*?\)\]\s*/, "").trim())
    : buildSegmentedStoryboard(segCount);

  const durationLabel = currentLang === "zh" ? "视频时长" : "Duration";
  const segmentLabel = currentLang === "zh" ? "分镜段" : "Segment";

  let segmentHtml = "";
  for (let i = 0; i < segCount; i++) {
    const title = segCount > 1
      ? (currentLang === "zh" ? `${segmentLabel} ${i + 1}（8秒）` : `${segmentLabel} ${i + 1} (8s)`)
      : (currentLang === "zh" ? "分镜脚本" : "Storyboard");
    segmentHtml += `
      <label class="editor-label">${title}</label>
      <textarea id="storyboardSeg${i}" class="editor-textarea" rows="6">${sanitizeInputValue(segments[i] || "")}</textarea>
    `;
  }

  scriptEditorPanel.innerHTML = `
    <div class="editor-head">
      <strong>${t("scriptEditTitle")}</strong>
      <button class="editor-close-btn" id="closeScriptPanelBtn">${t("closePanel")}</button>
    </div>
    <p class="editor-hint">${t("scriptEditHint")}</p>
    <div class="editor-duration-row" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <label class="editor-label" style="margin:0;">${durationLabel}</label>
      <select id="scriptDurationSelect" style="padding:4px 8px;border-radius:8px;border:1px solid #c0d2ec;">
        <option value="4" ${dur === 4 ? "selected" : ""}>4${currentLang === "zh" ? "秒" : "s"}</option>
        <option value="6" ${dur === 6 ? "selected" : ""}>6${currentLang === "zh" ? "秒" : "s"}</option>
        <option value="8" ${dur === 8 ? "selected" : ""}>8${currentLang === "zh" ? "秒" : "s"}</option>
        <option value="16" ${dur === 16 ? "selected" : ""}>16${currentLang === "zh" ? "秒（2段拼接）" : "s (2 segments)"}</option>
      </select>
    </div>
    ${segmentHtml}
    <label class="editor-label">${t("promptLabel")}</label>
    <textarea id="promptTextarea" class="editor-textarea" rows="10">${sanitizeInputValue(state.lastPrompt || buildPrompt())}</textarea>
    <div class="editor-actions">
      <button id="regenFromScriptBtn">${t("storyboardRegenerate")}</button>
    </div>
  `;

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
    const currentSegCount = Number(state.duration || 8) >= 16 ? Math.floor(Number(state.duration) / 8) : 1;
    const segs = [];
    for (let i = 0; i < currentSegCount; i++) {
      const el = scriptEditorPanel.querySelector(`#storyboardSeg${i}`);
      segs.push(el?.value?.trim() || "");
    }
    if (currentSegCount > 1) {
      state.lastStoryboard = segs.map((s, i) => {
        const label = currentLang === "zh" ? `[第${i + 1}段（8秒）]` : `[Segment ${i + 1} (8s)]`;
        return `${label}\n${s}`;
      }).join("\n\n");
    } else {
      state.lastStoryboard = segs[0] || "";
    }
    state.lastPrompt = scriptEditorPanel.querySelector("#promptTextarea")?.value?.trim() || buildPrompt();
    await generateVideo(state.lastPrompt);
  });
}

function getVideoDurationSec() {
  const d = Number(state.duration || 8);
  return Number.isFinite(d) && d > 0 ? d : 8;
}

function fmtSec(sec = 0) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `0:${String(s).padStart(2, "0")}`;
}

function getTimelineSnapCandidates(ignoreTrack = "", ignoreIdx = -1) {
  const tl = state.videoEdit?.timeline;
  if (!tl?.keyframes) return [];
  const tracks = ["mask", "color", "bgm", "motion"];
  const out = [];
  tracks.forEach((track) => {
    const list = Array.isArray(tl.keyframes[track]) ? tl.keyframes[track] : [];
    list.forEach((sec, idx) => {
      if (track === ignoreTrack && idx === ignoreIdx) return;
      out.push(Number(sec));
    });
  });
  return out.filter((v) => Number.isFinite(v));
}

function snapTimelineSec(sec, maxDelta = 0.2, ignoreTrack = "", ignoreIdx = -1) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return 0;
  const pool = getTimelineSnapCandidates(ignoreTrack, ignoreIdx);
  if (!pool.length) return n;
  let best = n;
  let bestDelta = Number.POSITIVE_INFINITY;
  pool.forEach((v) => {
    const d = Math.abs(v - n);
    if (d < bestDelta) {
      best = v;
      bestDelta = d;
    }
  });
  return bestDelta <= maxDelta ? best : n;
}

function ensureTimelineState() {
  if (!state.videoEdit.timeline) {
    state.videoEdit.timeline = {
      playhead: 0,
      selectedTrack: "mask",
      trackState: {
        mask: { visible: true, locked: false },
        color: { visible: true, locked: false },
        bgm: { visible: true, locked: false },
        motion: { visible: true, locked: false },
      },
      keyframes: { mask: [], color: [], bgm: [], motion: [] },
    };
  }
  const tl = state.videoEdit.timeline;
  if (!tl.trackState) {
    tl.trackState = {
      mask: { visible: true, locked: false },
      color: { visible: true, locked: false },
      bgm: { visible: true, locked: false },
      motion: { visible: true, locked: false },
    };
  }
  ["mask", "color", "bgm", "motion"].forEach((k) => {
    if (!tl.trackState[k] || typeof tl.trackState[k] !== "object") tl.trackState[k] = { visible: true, locked: false };
    tl.trackState[k].visible = tl.trackState[k].visible !== false;
    tl.trackState[k].locked = tl.trackState[k].locked === true;
  });
  if (!tl.keyframes) tl.keyframes = { mask: [], color: [], bgm: [], motion: [] };
  ["mask", "color", "bgm", "motion"].forEach((k) => {
    if (!Array.isArray(tl.keyframes[k])) tl.keyframes[k] = [];
    tl.keyframes[k] = tl.keyframes[k]
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);
  });
  if (typeof tl.selectedTrack !== "string") tl.selectedTrack = "mask";
  if (!["mask", "color", "bgm", "motion"].includes(tl.selectedTrack)) tl.selectedTrack = "mask";
  if (typeof state.videoEdit.activeModule !== "string") state.videoEdit.activeModule = tl.selectedTrack;
  if (!["mask", "color", "bgm", "motion"].includes(state.videoEdit.activeModule)) state.videoEdit.activeModule = "mask";
  if (!Number.isFinite(Number(tl.playhead))) tl.playhead = 0;
}

function buildTrackSegmentsHtml(trackId, points = [], maxSec = 8, isVisible = true) {
  if (!isVisible) return "";
  if (!points.length) return "";
  const list = points.slice().sort((a, b) => a - b);
  const bars = [];
  for (let i = 0; i < list.length - 1; i += 1) {
    const start = Math.max(0, Math.min(100, (list[i] / maxSec) * 100));
    const end = Math.max(0, Math.min(100, (list[i + 1] / maxSec) * 100));
    const width = Math.max(2, end - start);
    bars.push(
      `<i class="kf-seg kf-seg-${trackId}" data-track="${trackId}" data-start-idx="${i}" data-end-idx="${i + 1}" style="left:${start}%;width:${width}%"></i>`,
    );
  }
  if (list.length === 1) {
    const start = Math.max(0, Math.min(96, (list[0] / maxSec) * 100));
    bars.push(`<i class="kf-seg kf-seg-${trackId} is-single" style="left:${start}%;width:4%"></i>`);
  }
  return bars.join("");
}

function buildTimelineRowsHtml(maxSec) {
  const tl = state.videoEdit.timeline;
  const trackDefs = [
    { id: "mask", label: t("timelineTrackMask") },
    { id: "color", label: t("timelineTrackColor") },
    { id: "bgm", label: t("timelineTrackBgm") },
    { id: "motion", label: t("timelineTrackMotion") },
  ];
  return trackDefs
    .map((track) => {
      const points = tl.keyframes[track.id] || [];
      const trackState = tl.trackState?.[track.id] || { visible: true, locked: false };
      const segments = buildTrackSegmentsHtml(track.id, points, maxSec, trackState.visible);
      const dots = points.length
        ? points
            .map((sec, idx) => {
              const left = Math.max(0, Math.min(100, (sec / maxSec) * 100));
              return `<button class="kf-dot" data-track="${track.id}" data-idx="${idx}" data-sec="${sec.toFixed(2)}" style="left:${left}%"></button>`;
            })
            .join("")
        : `<span class="kf-empty">${t("timelineNoKeyframe")}</span>`;
      return `
        <div class="kf-row ${state.videoEdit.activeModule === track.id ? "is-active" : ""} ${trackState.visible ? "" : "is-hidden"} ${trackState.locked ? "is-locked" : ""}" data-track="${track.id}">
          <div class="kf-label-wrap">
            <div class="kf-label">${track.label}</div>
            <div class="kf-controls">
              <button class="kf-ctrl ${trackState.visible ? "" : "is-off"}" data-action="toggle-visibility" data-track="${track.id}" title="${t("timelineToggleVisible")}">${trackState.visible ? "V" : "H"}</button>
              <button class="kf-ctrl ${trackState.locked ? "is-on" : ""}" data-action="toggle-lock" data-track="${track.id}" title="${t("timelineToggleLock")}">${trackState.locked ? "L" : "U"}</button>
            </div>
          </div>
          <div class="kf-track ${state.videoEdit.activeModule === track.id ? "is-active" : ""} ${trackState.visible ? "" : "is-hidden"} ${trackState.locked ? "is-locked" : ""}" data-track="${track.id}">
            ${segments}
            ${dots}
          </div>
        </div>
      `;
    })
    .join("");
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function revokeLocalObjectUrl(url = "") {
  if (typeof url === "string" && url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch (_e) {}
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read file failed"));
    reader.readAsDataURL(file);
  });
}

function applyVideoEditsToPreview() {
  const fx = state.videoEdit || {};
  const trackState = fx.timeline?.trackState || {};
  const speed = trackState.motion?.visible === false ? 1 : clampNum(fx.speed || 1, 0.5, 2);
  const sat = trackState.color?.visible === false ? 100 : clampNum(100 + Number(fx.sat || 0) * 3, 20, 260);
  const bright = trackState.color?.visible === false ? 100 : clampNum(100 + Number(fx.vibrance || 0) * 2, 40, 220);
  const contrast = trackState.color?.visible === false ? 100 : clampNum(100 + Math.abs(Number(fx.temp || 0)) * 1.2, 60, 180);
  const hue = trackState.color?.visible === false ? 0 : clampNum(Number(fx.tint || 0) * 1.8, -45, 45);
  const bgmVolume = clampNum(Number(fx.bgmVolume || 70), 0, 100) / 100;

  const surfaces = Array.from(document.querySelectorAll(".video-edit-surface"));
  surfaces.forEach((surface) => {
    const video = surface.querySelector("video");
    if (!video) return;
    video.playbackRate = speed;
    video.volume = bgmVolume;
    video.style.filter = `saturate(${sat}%) brightness(${bright}%) contrast(${contrast}%) hue-rotate(${hue}deg)`;

    surface.querySelector(".video-subtitle-overlay")?.remove();
    surface.querySelector(".video-bgm-badge")?.remove();

    let bgmAudio = surface.querySelector(".video-bgm-audio");
    if (!bgmAudio) {
      bgmAudio = document.createElement("audio");
      bgmAudio.className = "video-bgm-audio";
      bgmAudio.preload = "auto";
      bgmAudio.hidden = true;
      surface.appendChild(bgmAudio);
    }
    const shouldUseLocalBgm = Boolean(fx.bgmExtract && fx.localBgmUrl && trackState.bgm?.visible !== false);
    if (!shouldUseLocalBgm) {
      video.muted = false;
      bgmAudio.pause();
      if (bgmAudio.getAttribute("src")) {
        bgmAudio.removeAttribute("src");
        try {
          bgmAudio.load();
        } catch (_e) {}
      }
      return;
    }
    if (bgmAudio.getAttribute("src") !== fx.localBgmUrl) {
      bgmAudio.setAttribute("src", fx.localBgmUrl);
      try {
        bgmAudio.load();
      } catch (_e) {}
    }
    bgmAudio.loop = true;
    bgmAudio.volume = bgmVolume;
    bgmAudio.playbackRate = speed;
    video.muted = true;
    const syncBgm = () => {
      const target = Number(video.currentTime || 0);
      if (!Number.isFinite(target)) return;
      if (Math.abs((bgmAudio.currentTime || 0) - target) > 0.35) {
        try {
          bgmAudio.currentTime = target;
        } catch (_e) {}
      }
      if (!video.paused) {
        const p = bgmAudio.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    };
    if (!surface.dataset.bgmBound) {
      const onPlay = () => syncBgm();
      const onPause = () => bgmAudio.pause();
      const onSeek = () => syncBgm();
      const onRate = () => {
        bgmAudio.playbackRate = clampNum(video.playbackRate || speed, 0.5, 2);
      };
      video.addEventListener("play", onPlay);
      video.addEventListener("pause", onPause);
      video.addEventListener("seeking", onSeek);
      video.addEventListener("seeked", onSeek);
      video.addEventListener("timeupdate", onSeek);
      video.addEventListener("ratechange", onRate);
      surface.dataset.bgmBound = "1";
      surface._bgmListeners = { onPlay, onPause, onSeek, onRate };
    }
    syncBgm();
  });
}

function renderVideoEditor() {
  if (!videoEditorPanel) return;
  if (!state.videoEditorOpen) return;
  const fx = state.videoEdit || {};
  ensureTimelineState();
  const tl = state.videoEdit.timeline;
  const activeModule = state.videoEdit.activeModule || tl.selectedTrack || "mask";
  const trackLabelMap = {
    mask: t("timelineTrackMask"),
    color: t("timelineTrackColor"),
    bgm: t("timelineTrackBgm"),
    motion: t("timelineTrackMotion"),
  };
  const activeTrackLabel = trackLabelMap[activeModule] || trackLabelMap.mask;
  const activeTrackState = tl.trackState?.[activeModule] || { visible: true, locked: false };
  const moduleSwitchHtml = ["mask", "color", "bgm", "motion"]
    .map(
      (id) =>
        `<button class="module-switch-btn ${activeModule === id ? "is-active" : ""}" data-module="${id}">${trackLabelMap[id]}</button>`,
    )
    .join("");
  const moduleEditorHtml =
    activeModule === "mask"
      ? `
        <label>${t("textMaskText")}<input id="maskTextInput" value="${sanitizeInputValue(fx.maskText || "ELEGANCE")}" /></label>
        <label>${t("textMaskStyle")}<select id="maskStyleSelect">
          <option value="elegant">${t("textMaskElegant")}</option>
          <option value="bold">${t("textMaskBold")}</option>
          <option value="soft">${t("textMaskSoft")}</option>
        </select></label>
        <div class="range-grid">
          <label>${t("positionX")} <span id="maskXVal">${Number(fx.x || 0)}%</span><input id="maskXRange" type="range" min="0" max="100" value="${Number(fx.x || 0)}" /></label>
          <label>${t("positionY")} <span id="maskYVal">${Number(fx.y || 0)}%</span><input id="maskYRange" type="range" min="0" max="100" value="${Number(fx.y || 0)}" /></label>
          <label>${t("maskWidth")} <span id="maskWVal">${Number(fx.w || 80)}%</span><input id="maskWRange" type="range" min="20" max="100" value="${Number(fx.w || 80)}" /></label>
          <label>${t("maskHeight")} <span id="maskHVal">${Number(fx.h || 12)}%</span><input id="maskHRange" type="range" min="6" max="60" value="${Number(fx.h || 12)}" /></label>
          <label>${t("maskOpacity")} <span id="maskOVal">${Number(fx.opacity || 90)}%</span><input id="maskORange" type="range" min="0" max="100" value="${Number(fx.opacity || 90)}" /></label>
          <label>${t("maskRotation")} <span id="maskRVal">${Number(fx.rotation || 0)}deg</span><input id="maskRRange" type="range" min="-30" max="30" value="${Number(fx.rotation || 0)}" /></label>
        </div>
      `
      : activeModule === "color"
        ? `
          <div class="range-grid">
            <label>${t("colorTemp")} <span id="tempVal">${Number(fx.temp || 12)}</span><input id="tempRange" type="range" min="-30" max="30" value="${Number(fx.temp || 12)}" /></label>
            <label>${t("colorTint")} <span id="tintVal">${Number(fx.tint || 5)}</span><input id="tintRange" type="range" min="-30" max="30" value="${Number(fx.tint || 5)}" /></label>
            <label>${t("colorSat")} <span id="satVal">${Number(fx.sat || 8)}</span><input id="satRange" type="range" min="-30" max="30" value="${Number(fx.sat || 8)}" /></label>
            <label>${t("colorVibrance")} <span id="vibVal">${Number(fx.vibrance || 10)}</span><input id="vibRange" type="range" min="-30" max="30" value="${Number(fx.vibrance || 10)}" /></label>
          </div>
        `
        : activeModule === "bgm"
          ? `
            <label class="inline-check"><input id="bgmExtractChk" type="checkbox" ${fx.bgmExtract ? "checked" : ""} /> ${t("bgmExtract")}</label>
            <label>${t("bgmMood")}<select id="bgmMoodSelect">
              <option value="elegant">${t("bgmMoodElegant")}</option>
              <option value="daily">${t("bgmMoodDaily")}</option>
              <option value="trendy">${t("bgmMoodTrendy")}</option>
              <option value="piano">${t("bgmMoodPiano")}</option>
            </select></label>
            <label>${t("bgmReplace")}<select id="bgmReplaceModeSelect">
              <option value="auto">${t("bgmReplaceAuto")}</option>
              <option value="keep">${t("bgmReplaceKeep")}</option>
              <option value="beat">${t("bgmReplaceStrongBeat")}</option>
            </select></label>
            <label>${t("bgmVolume")} <span id="bgmVolVal">${Number(fx.bgmVolume || 70)}%</span><input id="bgmVolRange" type="range" min="0" max="100" value="${Number(fx.bgmVolume || 70)}" /></label>
            <label>${t("bgmLocalFile")}
              <input id="bgmFileInput" type="file" accept="audio/*" />
            </label>
            <div class="bgm-file-row">
              <span id="bgmFileName">${sanitizeInputValue(fx.localBgmName || t("bgmNoLocalFile"))}</span>
              <button id="clearBgmFileBtn">${t("bgmClearFile")}</button>
            </div>
          `
          : `
            <label>${t("clipSpeed")}<select id="videoEditSpeed"><option value="0.75">0.75x</option><option value="1.0">1.0x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option></select></label>
            <p class="editor-note">${currentLang === "zh" ? "运动轨道用于控制全片速度与关键帧点位。" : "Motion track controls global speed and keyframe positions."}</p>
          `;
  const maxSec = getVideoDurationSec();
  const videoBlock = state.lastVideoUrl
    ? `<div class="video-edit-surface"><video controls src="${state.lastVideoUrl}"></video></div>`
    : `<div class="empty-video">${currentLang === "zh" ? "暂无视频，请先生成一次视频。" : "No video yet. Generate one first."}</div>`;
  videoEditorPanel.innerHTML = `
    <div class="editor-head">
      <strong>${t("videoEditTitle")}</strong>
      <button class="editor-close-btn" id="closeVideoPanelBtn">${t("closePanel")}</button>
    </div>
    <p class="editor-hint">${t("videoEditHint")}</p>
    <div class="video-editor-shell">
      <div class="video-stage-grid">
        <div class="video-preview-wrap">${videoBlock}</div>
        <section class="editor-section module-panel">
          <h4>${t("videoModuleTitle")}</h4>
          <p class="editor-note">${t("videoModuleHint")}</p>
          ${activeTrackState.visible ? "" : `<p class="editor-note">${t("timelineTrackHidden")}</p>`}
          ${activeTrackState.locked ? `<p class="editor-note">${t("timelineTrackLocked")}</p>` : ""}
          <div class="module-switch">${moduleSwitchHtml}</div>
          <div class="video-editor-grid module-body">${moduleEditorHtml}</div>
        </section>
      </div>
      <section class="editor-section timeline-section">
        <h4>${t("timelineTitle")}</h4>
        <p class="editor-note">${t("timelineHint")}</p>
        <label>${t("timelinePlayhead")} <span id="playheadVal">${fmtSec(tl.playhead)}</span><input id="timelinePlayheadRange" type="range" min="0" max="${maxSec}" step="0.1" value="${Number(tl.playhead || 0)}" /></label>
        <p class="timeline-track-current">${t("timelineSelectTrack")}：<strong>${activeTrackLabel}</strong></p>
        <div class="kf-ruler">
          <span>0:00</span><span>${fmtSec(Math.round(maxSec / 2))}</span><span>${fmtSec(maxSec)}</span>
          <i id="kfPlayheadLine" style="left:${Math.max(0, Math.min(100, (tl.playhead / maxSec) * 100))}%"></i>
        </div>
        <div class="kf-rows">${buildTimelineRowsHtml(maxSec)}</div>
        <div class="timeline-actions">
          <button id="addKeyframeBtn">${t("timelineAddKeyframe")}</button>
          <button id="removeKeyframeBtn">${t("timelineRemoveKeyframe")}</button>
        </div>
      </section>
    </div>
    <div class="editor-actions">
      <button id="regenFromVideoEditorBtn">${t("videoRegenerate")}</button>
      <button id="resetVideoEditorBtn">${currentLang === "zh" ? "重置后处理" : "Reset post-edits"}</button>
    </div>
  `;
  const speedSelect = videoEditorPanel.querySelector("#videoEditSpeed");
  const maskStyleSelect = videoEditorPanel.querySelector("#maskStyleSelect");
  const moodSelect = videoEditorPanel.querySelector("#bgmMoodSelect");
  const replaceSelect = videoEditorPanel.querySelector("#bgmReplaceModeSelect");
  if (speedSelect) speedSelect.value = String(fx.speed || "1.0");
  if (maskStyleSelect) maskStyleSelect.value = String(fx.maskStyle || "elegant");
  if (moodSelect) moodSelect.value = String(fx.bgmMood || "elegant");
  if (replaceSelect) replaceSelect.value = String(fx.bgmReplaceMode || "auto");

  const bindRange = (id, outId, suffix = "") => {
    const input = videoEditorPanel.querySelector(id);
    const out = videoEditorPanel.querySelector(outId);
    if (!input || !out) return;
    const render = () => {
      out.textContent = `${input.value}${suffix}`;
    };
    input.addEventListener("input", render);
    render();
  };
  bindRange("#maskXRange", "#maskXVal", "%");
  bindRange("#maskYRange", "#maskYVal", "%");
  bindRange("#maskWRange", "#maskWVal", "%");
  bindRange("#maskHRange", "#maskHVal", "%");
  bindRange("#maskORange", "#maskOVal", "%");
  bindRange("#maskRRange", "#maskRVal", "deg");
  bindRange("#tempRange", "#tempVal");
  bindRange("#tintRange", "#tintVal");
  bindRange("#satRange", "#satVal");
  bindRange("#vibRange", "#vibVal");
  bindRange("#bgmVolRange", "#bgmVolVal", "%");
  if (activeTrackState.locked) {
    videoEditorPanel.querySelectorAll(".module-body input, .module-body select, .module-body button, #addKeyframeBtn, #removeKeyframeBtn").forEach((el) => {
      el.disabled = true;
    });
  }
  videoEditorPanel.querySelectorAll(".module-switch-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mod = btn.getAttribute("data-module") || "mask";
      state.videoEdit.activeModule = mod;
      state.videoEdit.timeline.selectedTrack = mod;
      renderVideoEditor();
    });
  });

  const bgmFileInput = videoEditorPanel.querySelector("#bgmFileInput");
  const bgmFileName = videoEditorPanel.querySelector("#bgmFileName");
  bgmFileInput?.addEventListener("change", async () => {
    const file = bgmFileInput.files?.[0];
    if (!file) return;
    const oldUrl = state.videoEdit.localBgmUrl || "";
    const url = URL.createObjectURL(file);
    let dataUrl = "";
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch (_e) {}
    state.videoEdit.localBgmUrl = url;
    state.videoEdit.localBgmName = file.name;
    state.videoEdit.localBgmDataUrl = dataUrl;
    revokeLocalObjectUrl(oldUrl);
    if (bgmFileName) bgmFileName.textContent = file.name;
    applyVideoEditsToPreview();
  });
  videoEditorPanel.querySelector("#clearBgmFileBtn")?.addEventListener("click", () => {
    const oldUrl = state.videoEdit.localBgmUrl || "";
    state.videoEdit.localBgmUrl = "";
    state.videoEdit.localBgmName = "";
    state.videoEdit.localBgmDataUrl = "";
    revokeLocalObjectUrl(oldUrl);
    renderVideoEditor();
    applyVideoEditsToPreview();
  });

  const playheadRange = videoEditorPanel.querySelector("#timelinePlayheadRange");
  const playheadVal = videoEditorPanel.querySelector("#playheadVal");
  const playheadLine = videoEditorPanel.querySelector("#kfPlayheadLine");
  const updatePlayheadUI = () => {
    const sec = Number(playheadRange?.value || 0);
    if (playheadVal) playheadVal.textContent = fmtSec(sec);
    if (playheadLine) playheadLine.style.left = `${Math.max(0, Math.min(100, (sec / maxSec) * 100))}%`;
  };
  playheadRange?.addEventListener("input", () => {
    const raw = Number(playheadRange.value || 0);
    const snapped = snapTimelineSec(raw, 0.12);
    state.videoEdit.timeline.playhead = snapped;
    playheadRange.value = String(snapped);
    updatePlayheadUI();
  });
  updatePlayheadUI();
  videoEditorPanel.querySelectorAll(".kf-track, .kf-row .kf-label").forEach((trackNode) => {
    trackNode.addEventListener("click", () => {
      const row = trackNode.closest(".kf-row");
      const track = row?.getAttribute("data-track") || trackNode.getAttribute("data-track") || "mask";
      state.videoEdit.timeline.selectedTrack = track;
      state.videoEdit.activeModule = track;
      renderVideoEditor();
    });
  });
  videoEditorPanel.querySelectorAll(".kf-ctrl").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const track = btn.getAttribute("data-track") || "mask";
      const action = btn.getAttribute("data-action") || "";
      const curr = state.videoEdit.timeline.trackState?.[track] || { visible: true, locked: false };
      if (action === "toggle-visibility") curr.visible = !curr.visible;
      if (action === "toggle-lock") curr.locked = !curr.locked;
      state.videoEdit.timeline.trackState[track] = curr;
      if (state.videoEdit.activeModule === track && curr.locked) {
        state.videoEdit.timeline.selectedTrack = track;
      }
      renderVideoEditor();
      applyVideoEditsToPreview();
    });
  });

  videoEditorPanel.querySelectorAll(".kf-dot").forEach((dot) => {
    dot.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const sec = Number(dot.getAttribute("data-sec") || 0);
      const track = dot.getAttribute("data-track") || "mask";
      state.videoEdit.timeline.selectedTrack = track;
      state.videoEdit.timeline.playhead = sec;
      if (playheadRange) playheadRange.value = String(sec);
      updatePlayheadUI();
    });
    dot.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const track = dot.getAttribute("data-track") || "mask";
      if (state.videoEdit.timeline.trackState?.[track]?.locked) return;
      const trackEl = dot.closest(".kf-track");
      if (!trackEl) return;
      const rawIdx = Number(dot.getAttribute("data-idx") || -1);
      const keyframes = state.videoEdit.timeline.keyframes[track] || [];
      let dragIdx = Number.isInteger(rawIdx) ? rawIdx : -1;
      if (dragIdx < 0 || dragIdx >= keyframes.length) {
        const sec = Number(dot.getAttribute("data-sec") || 0);
        let nearest = 0;
        let best = Number.POSITIVE_INFINITY;
        keyframes.forEach((v, idx) => {
          const d = Math.abs(Number(v) - sec);
          if (d < best) {
            best = d;
            nearest = idx;
          }
        });
        dragIdx = nearest;
      }
      if (dragIdx < 0 || dragIdx >= keyframes.length) return;
      const toSec = (clientX) => {
        const rect = trackEl.getBoundingClientRect();
        const ratio = clampNum((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        return clampNum(ratio * maxSec, 0, maxSec);
      };
      const commitDot = (clientX) => {
        const raw = toSec(clientX);
        const snapped = snapTimelineSec(raw, 0.12, track, dragIdx);
        const sec = Math.round(snapped * 100) / 100;
        state.videoEdit.timeline.playhead = sec;
        if (playheadRange) playheadRange.value = String(sec);
        dot.style.left = `${(sec / maxSec) * 100}%`;
        updatePlayheadUI();
        return sec;
      };
      dot.classList.add("is-dragging");
      const onMove = (moveEv) => {
        commitDot(moveEv.clientX);
      };
      const onUp = (upEv) => {
        const finalSec = commitDot(upEv.clientX);
        const list = (state.videoEdit.timeline.keyframes[track] || []).slice();
        list[dragIdx] = finalSec;
        list.sort((a, b) => a - b);
        state.videoEdit.timeline.keyframes[track] = list;
        state.videoEdit.timeline.selectedTrack = track;
        state.videoEdit.activeModule = track;
        dot.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        renderVideoEditor();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  });
  videoEditorPanel.querySelectorAll(".kf-seg[data-start-idx][data-end-idx]").forEach((seg) => {
    seg.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const track = seg.getAttribute("data-track") || "mask";
      if (state.videoEdit.timeline.trackState?.[track]?.locked) return;
      const trackEl = seg.closest(".kf-track");
      if (!trackEl) return;
      const startIdx = Number(seg.getAttribute("data-start-idx") || -1);
      const endIdx = Number(seg.getAttribute("data-end-idx") || -1);
      if (startIdx < 0 || endIdx <= startIdx) return;
      const keyframes = state.videoEdit.timeline.keyframes[track] || [];
      if (endIdx >= keyframes.length) return;

      const startSec0 = Number(keyframes[startIdx]);
      const endSec0 = Number(keyframes[endIdx]);
      if (!Number.isFinite(startSec0) || !Number.isFinite(endSec0)) return;
      const toSec = (clientX) => {
        const rect = trackEl.getBoundingClientRect();
        const ratio = clampNum((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        return clampNum(ratio * maxSec, 0, maxSec);
      };
      const pointerSec0 = toSec(ev.clientX);
      const prevSec = startIdx > 0 ? Number(keyframes[startIdx - 1]) : null;
      const nextSec = endIdx + 1 < keyframes.length ? Number(keyframes[endIdx + 1]) : null;
      const minDelta = startIdx > 0 ? prevSec - startSec0 + 0.02 : -startSec0;
      const maxDelta = endIdx + 1 < keyframes.length ? nextSec - endSec0 - 0.02 : maxSec - endSec0;
      const startDot = trackEl.querySelector(`.kf-dot[data-track="${track}"][data-idx="${startIdx}"]`);
      const endDot = trackEl.querySelector(`.kf-dot[data-track="${track}"][data-idx="${endIdx}"]`);

      const commitSegment = (clientX) => {
        const pointerSec = toSec(clientX);
        const rawStart = startSec0 + (pointerSec - pointerSec0);
        const snappedStart = snapTimelineSec(rawStart, 0.12, track, startIdx);
        const delta = clampNum(snappedStart - startSec0, minDelta, maxDelta);
        const nextStart = Math.round((startSec0 + delta) * 100) / 100;
        const nextEnd = Math.round((endSec0 + delta) * 100) / 100;
        seg.style.left = `${(nextStart / maxSec) * 100}%`;
        seg.style.width = `${Math.max(2, ((nextEnd - nextStart) / maxSec) * 100)}%`;
        if (startDot) startDot.style.left = `${(nextStart / maxSec) * 100}%`;
        if (endDot) endDot.style.left = `${(nextEnd / maxSec) * 100}%`;
        const playSec = Math.round(((nextStart + nextEnd) / 2) * 100) / 100;
        state.videoEdit.timeline.playhead = playSec;
        if (playheadRange) playheadRange.value = String(playSec);
        updatePlayheadUI();
        return { nextStart, nextEnd };
      };

      seg.classList.add("is-dragging");
      const onMove = (moveEv) => {
        commitSegment(moveEv.clientX);
      };
      const onUp = (upEv) => {
        const { nextStart, nextEnd } = commitSegment(upEv.clientX);
        const list = (state.videoEdit.timeline.keyframes[track] || []).slice();
        list[startIdx] = nextStart;
        list[endIdx] = nextEnd;
        list.sort((a, b) => a - b);
        state.videoEdit.timeline.keyframes[track] = list;
        state.videoEdit.timeline.selectedTrack = track;
        state.videoEdit.activeModule = track;
        seg.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        renderVideoEditor();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  });

  videoEditorPanel.querySelector("#addKeyframeBtn")?.addEventListener("click", () => {
    const sec = Number(state.videoEdit.timeline.playhead || 0);
    const track = state.videoEdit.timeline.selectedTrack || "mask";
    if (state.videoEdit.timeline.trackState?.[track]?.locked) return;
    const list = state.videoEdit.timeline.keyframes[track] || [];
    if (!list.some((v) => Math.abs(v - sec) <= 0.08)) {
      list.push(sec);
      list.sort((a, b) => a - b);
      state.videoEdit.timeline.keyframes[track] = list;
    }
    renderVideoEditor();
  });

  videoEditorPanel.querySelector("#removeKeyframeBtn")?.addEventListener("click", () => {
    const sec = Number(state.videoEdit.timeline.playhead || 0);
    const track = state.videoEdit.timeline.selectedTrack || "mask";
    if (state.videoEdit.timeline.trackState?.[track]?.locked) return;
    const list = (state.videoEdit.timeline.keyframes[track] || []).slice();
    if (!list.length) return;
    let nearestIdx = 0;
    let nearestDist = Math.abs(list[0] - sec);
    for (let i = 1; i < list.length; i += 1) {
      const d = Math.abs(list[i] - sec);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    }
    list.splice(nearestIdx, 1);
    state.videoEdit.timeline.keyframes[track] = list;
    renderVideoEditor();
  });

  videoEditorPanel.querySelector("#closeVideoPanelBtn")?.addEventListener("click", () => {
    state.videoEditorOpen = false;
    applyWorkspaceMode();
  });
  videoEditorPanel.querySelector("#regenFromVideoEditorBtn")?.addEventListener("click", async () => {
    const pickValue = (selector, fallback) => {
      const el = videoEditorPanel.querySelector(selector);
      return el ? el.value : fallback;
    };
    const pickChecked = (selector, fallback) => {
      const el = videoEditorPanel.querySelector(selector);
      return el ? Boolean(el.checked) : Boolean(fallback);
    };
    state.videoEdit = {
      maskText: String(pickValue("#maskTextInput", fx.maskText || "")).trim(),
      maskStyle: pickValue("#maskStyleSelect", fx.maskStyle || "elegant"),
      x: Number(pickValue("#maskXRange", fx.x ?? 0)),
      y: Number(pickValue("#maskYRange", fx.y ?? 0)),
      w: Number(pickValue("#maskWRange", fx.w ?? 80)),
      h: Number(pickValue("#maskHRange", fx.h ?? 12)),
      opacity: Number(pickValue("#maskORange", fx.opacity ?? 90)),
      rotation: Number(pickValue("#maskRRange", fx.rotation ?? 0)),
      speed: pickValue("#videoEditSpeed", fx.speed || "1.0"),
      temp: Number(pickValue("#tempRange", fx.temp ?? 12)),
      tint: Number(pickValue("#tintRange", fx.tint ?? 5)),
      sat: Number(pickValue("#satRange", fx.sat ?? 8)),
      vibrance: Number(pickValue("#vibRange", fx.vibrance ?? 10)),
      bgmExtract: pickChecked("#bgmExtractChk", fx.bgmExtract),
      bgmMood: pickValue("#bgmMoodSelect", fx.bgmMood || "elegant"),
      bgmVolume: Number(pickValue("#bgmVolRange", fx.bgmVolume ?? 70)),
      bgmReplaceMode: pickValue("#bgmReplaceModeSelect", fx.bgmReplaceMode || "auto"),
      localBgmUrl: state.videoEdit.localBgmUrl || "",
      localBgmName: state.videoEdit.localBgmName || "",
      localBgmDataUrl: state.videoEdit.localBgmDataUrl || "",
      activeModule: state.videoEdit.activeModule || "mask",
      timeline: state.videoEdit.timeline,
    };
    if (!state.lastVideoUrl) {
      applyVideoEditsToPreview();
      pushMsg("system", t("videoApplyDone"));
      return;
    }
    pushMsg("system", t("videoExporting"));
    try {
      const base = getApiBase();
      const resp = await postJson(
        `${base}/api/video/edit/export`,
        {
          video_url: state.lastVideoUrl,
          edits: state.videoEdit,
        },
        240000
      );
      const exportedUrl = String(resp?.video_url || "").trim();
      if (!exportedUrl) throw new Error("exported url missing");
      state.lastVideoUrl = exportedUrl;
      document.querySelectorAll(".video-edit-surface video").forEach((v) => {
        v.src = exportedUrl;
      });
      renderVideoEditor();
      applyVideoEditsToPreview();
      pushMsg("system", t("videoApplyDone"));
      if (state.videoEdit.maskText && resp?.mask_applied === false) {
        pushMsg("system", t("videoMaskUnsupported"));
      }
    } catch (_e) {
      applyVideoEditsToPreview();
      pushMsg("system", t("videoExportFail"));
    }
  });
  videoEditorPanel.querySelector("#resetVideoEditorBtn")?.addEventListener("click", () => {
    revokeLocalObjectUrl(state.videoEdit.localBgmUrl || "");
    state.videoEdit = {
      ...state.videoEdit,
      maskText: "",
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
      activeModule: state.videoEdit.activeModule || "mask",
    };
    renderVideoEditor();
    applyVideoEditsToPreview();
  });
  applyVideoEditsToPreview();
}

function openEditorPanel(type) {
  if (!state.canUseEditors) return;
  if (type === "video") state.videoEditorOpen = true;
  if (type === "script") state.scriptEditorOpen = true;
  applyWorkspaceMode();
  renderVideoEditor();
  renderScriptEditor();
  focusWorkspaceTop();
  if (type === "script") {
    hydrateWorkflowTexts(true).then(() => {
      if (state.scriptEditorOpen) renderScriptEditor();
    });
  }
}

function toggleEditorPanel(type) {
  if (!state.canUseEditors) return;
  if (type === "video") state.videoEditorOpen = !state.videoEditorOpen;
  if (type === "script") state.scriptEditorOpen = !state.scriptEditorOpen;
  applyWorkspaceMode();
  renderVideoEditor();
  renderScriptEditor();
  focusWorkspaceTop();
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

function typewriter(el, text, speed = 24) {
  const content = String(text || "");
  let i = 0;
  const tick = () => {
    if (i >= content.length) return;
    el.textContent += content[i];
    const ch = content[i];
    i += 1;
    scrollToBottom();
    setTimeout(tick, /[，。！？,.!?]/.test(ch) ? speed * 2.5 : speed);
  };
  tick();
}

function pushMsg(role, text, opts = {}) {
  if (state.entryFocusMode) {
    state.entryFocusMode = false;
    applyWorkspaceMode();
  }
  const el = document.createElement("article");
  el.className = `msg ${role}`;
  chatList.appendChild(el);
  scrollToBottom();
  if (role === "system" && opts.typewriter !== false) typewriter(el, text, opts.speed || 22);
  else el.textContent = text;
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
  const box = pushMsg("system", "", { typewriter: false });
  renderOptions(box, [
    {
      title: t("uploadNow"),
      desc: "",
      onClick: () => imageInput?.click(),
    },
  ]);
}

function showUploadScreenshotGuide() {
  pushMsg(
    "system",
    [
      t("uploadGuideTitle"),
      `- ${t("uploadGuideItem1")}`,
      `- ${t("uploadGuideItem2")}`,
      `- ${t("uploadGuideItem3")}`,
      `- ${t("uploadGuideItem4")}`,
    ].join("\n"),
    { typewriter: false }
  );
}

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/i.exec(dataUrl || "");
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: m[2] };
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
  };
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
}

function startInsightProgress() {
  const startedAt = Date.now();
  const bubble = pushMsg("system", nextInsightPulseLine(), { typewriter: false });
  let warned = false;
  const timer = setInterval(() => {
    const sec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    if (sec < 8) {
      bubble.textContent = nextInsightPulseLine();
      return;
    }
    if (sec >= 8) {
      warned = true;
      bubble.textContent = t("insightSlow", { sec });
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
      project_id: "gemini-sl-20251120",
      model: "gemini-2.5-flash",
      language: currentLang,
      image_items: normalized.map((x) => ({ base64: x.base64, mime_type: x.mime })),
    },
    50000
  );
}

function askRegion() {
  state.stage = "awaitRegion";
  const box = pushMsg("system", t("pickRegion"), { typewriter: false });
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
        pushMsg("system", withLead(t("regionAck", { value: title }), "region"));
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
  const box = pushMsg("system", t("pickTarget"), { typewriter: false });
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
      pushMsg("system", withLead(t("targetAck", { value: opt.title }), "target"));
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
  const box = pushMsg("system", t("pickBrand"), { typewriter: false });
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
      pushMsg("system", withLead(t("brandAck", { value: opt.title }), "brand"));
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
      pushMsg("system", withLead(t("skipBrand"), "general"));
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
    pushMsg("system", t("askPoints"));
    return;
  }
  showSummaryCard();
}

function showContinueAfterSkipStep() {
  const box = pushMsg("system", t("continueChatPrompt"), { typewriter: false });
  renderOptions(box, [
    {
      title: t("continueChatBtn"),
      desc: t("continueChatDesc"),
      onClick: () => {
        pushMsg("user", t("continueChatAck"), { typewriter: false });
        state.stage = "awaitPoints";
        if (!state.sellingPoints) pushMsg("system", t("askPoints"));
        else if (!state.summaryShown) showSummaryCard();
        else showQuickGenerateButton();
        chatInput?.focus();
      },
    },
  ]);
}

function showUploadOptionalStep() {
  const box = pushMsg("system", t("askUploadOptional"), { typewriter: false });
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
        pushMsg("system", t("skipUploadAck"));
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
        <div class="info-item"><div class="info-icon">📐</div><div class="info-main"><div class="info-title">${t("fRatio")}</div><input id="fAspect" value="16:9" readonly /></div></div>
        <div class="info-item"><div class="info-icon">🧍</div><div class="info-main"><div class="info-title">${t("fModel")}</div><label><input id="fNeedModel" type="checkbox" checked /> ${t("on")}</label></div></div>
      </div>
      <p class="table-hint">${t("hint")}</p>
      <div class="summary-actions"><button id="confirmGenerateBtn">${t("confirm")}</button></div>
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
      pushMsg("system", t("alreadySubmitted"));
      return;
    }
    btn.disabled = true;
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
      pushMsg("system", t("askProduct"));
      btn.disabled = false;
      return;
    }
    state.primarySubmitLocked = true;
    await generateVideo();
    btn.textContent = currentLang === "zh" ? "已提交" : "Submitted";
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
    pushMsg("system", t("askPoints"));
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
    <div>${t("insightEditTitle")}</div>
    <div class="summary-card">
      <div class="info-grid">
        <div class="info-item"><div class="info-icon">📦</div><div class="info-main"><div class="info-title">${t("fProduct")}</div><input id="insightProductName" value="${sanitizeInputValue(state.productName)}" /></div></div>
        <div class="info-item"><div class="info-icon">🧭</div><div class="info-main"><div class="info-title">${currentLang === "zh" ? "主营方向" : "Business focus"}</div><input id="insightBusiness" value="${sanitizeInputValue(state.mainBusiness)}" /></div></div>
        <div class="info-item"><div class="info-icon">🎨</div><div class="info-main"><div class="info-title">${t("fTpl")}</div><select id="insightTemplate"><option value="clean">clean</option><option value="lifestyle">lifestyle</option><option value="premium">premium</option><option value="social">social</option></select></div></div>
      </div>
      <div class="summary-actions"><button id="insightConfirmBtn">${t("insightConfirmBtn")}</button></div>
    </div>
  `;
  chatList.appendChild(wrap);
  scrollToBottom();
  const templateEl = wrap.querySelector("#insightTemplate");
  templateEl.value = state.template || "clean";
  wrap.querySelector("#insightConfirmBtn").addEventListener("click", () => {
    const btn = wrap.querySelector("#insightConfirmBtn");
    if (btn.disabled) return;
    btn.disabled = true;
    state.productName = wrap.querySelector("#insightProductName").value.trim();
    state.mainBusiness = wrap.querySelector("#insightBusiness").value.trim();
    state.template = templateEl.value || "clean";
    pushMsg("user", t("insightConfirmUser"), { typewriter: false });
    if (!state.productName) {
      pushMsg("system", t("askProduct"));
      btn.disabled = false;
      return;
    }
    if (state.stage === "awaitMain") {
      state.stage = "awaitRegion";
      askRegion();
      btn.disabled = false;
      return;
    }
    continueAfterInsightConfirm();
    btn.disabled = false;
  });
}

function showQuickGenerateButton() {
  const wrap = document.createElement("article");
  wrap.className = "msg system";
  wrap.innerHTML = `
    <div class="summary-actions">
      <button id="quickGenerateBtn">${t("quickGen")}</button>
    </div>
  `;
  chatList.appendChild(wrap);
  scrollToBottom();
  wrap.querySelector("#quickGenerateBtn").addEventListener("click", async () => {
    if (state.primarySubmitLocked) {
      pushMsg("system", t("alreadySubmitted"));
      return;
    }
    if (!state.productName) {
      pushMsg("system", t("askProduct"));
      return;
    }
    if (!state.salesRegion || !state.targetUser || !state.sellingPoints) {
      showSummaryCard();
      return;
    }
    state.primarySubmitLocked = true;
    await generateVideo();
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
  if (currentLang === "zh") {
    return [
      `${state.aspectRatio || "16:9"} 超高清商业画质，电影级影棚布光。`,
      "商品主体严格参考上传商品图或已解析信息，保持颜色、材质、结构和细节一致。",
      `商品：${state.productName || "该商品"}；主营方向：${state.mainBusiness || "电商"}。`,
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
    .replace(/(?:^|\n)\s*主框架\s*[：:]\s*[^\n；;]*[；;]?\s*/g, "\n")
    .replace(/(?:^|\n)\s*辅助框架\s*[：:]\s*[^\n；;]*[；;]?\s*/g, "\n")
    .replace(/(?:^|\n)\s*primary\s*framework\s*:\s*[^\n;；]*[;；]?\s*/gi, "\n")
    .replace(/(?:^|\n)\s*(supporting|secondary)\s*framework\s*:\s*[^\n;；]*[;；]?\s*/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
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
  return [
    `[Style] ${style}, commercial ultra-HD quality, cinematic lighting.`,
    `[Subject] ${product} for ${business}, keep identity consistent with uploaded references.`,
    `[Context] For ${region}, aimed at ${target}, ${modelText}.`,
    `[Action] Focus on ${points}.`,
    `[00:00-00:02] Hero intro shot and product silhouette.`,
    `[00:02-00:04] Medium shot of key usage moment.`,
    `[00:04-00:06] Macro close-up for texture and material details.`,
    `[00:06-00:08] Confident closing composition with conversion intent.`,
    `[Technical] Aspect ratio ${ratio}, duration ${duration}s, natural camera movement, realistic texture.`,
  ].join(" ");
}

async function rewritePromptForVeoSingle(base, rawPrompt, taskId = "") {
  const source = String(rawPrompt || "").trim();
  if (!source) return "";
  const needsRewrite = hasCjkChars(source);
  if (!needsRewrite) {
    return sanitizePromptForVeo(source) || source;
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
              + "Output must be plain text only (no markdown), max 220 words.\n"
              + "Must include four timestamp shots: [00:00-00:02], [00:02-00:04], [00:04-00:06], [00:06-00:08].\n"
              + "Must avoid text overlays/subtitles/captions and avoid quotation marks.",
          },
          { role: "user", content: source },
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

function buildAutoPromptDraftFromParsed(source = "image") {
  const duration = state.duration || "8";
  const ratio = state.aspectRatio || "16:9";
  const product = state.productName || (currentLang === "zh" ? "该商品" : "this product");
  const business = state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion and accessories");
  const style = state.template || "clean";
  const pointList = normalizePointsList(state.sellingPoints || "");
  const focusPoints = pointList.slice(0, 2);
  const sellingText =
    focusPoints.join(currentLang === "zh" ? "；" : "; ") ||
    (currentLang === "zh" ? "突出核心卖点与真实质感" : "highlight core selling points with realistic texture");
  const target = state.targetUser || (currentLang === "zh" ? "目标人群" : "target audience");
  const region = state.salesRegion || (currentLang === "zh" ? "目标地区" : "target region");
  const modelText =
    state.needModel === false
      ? currentLang === "zh"
        ? "不需要模特展示"
        : "no model showcase"
      : currentLang === "zh"
        ? "需要模特展示"
        : "need model showcase";
  const sourceHint =
    source === "image"
      ? currentLang === "zh"
        ? "请严格参考我上传的商品图，保持商品主体与细节一致。"
        : "Strictly follow uploaded reference images and keep product details consistent."
      : currentLang === "zh"
        ? "请严格参考已解析商品信息，保持商品特征一致。"
        : "Strictly follow parsed product information and keep product details consistent.";
  if (currentLang === "zh") {
    return [
      `[Style] ${style}，超高清商业画质，电影级影棚布光，真实可拍可剪。`,
      `[Environment] 结合${region}审美与${business}消费场景，背景保持干净、道具适度。`,
      `[Tone & Pacing] ${duration}秒内快慢有序，核心卖点仅聚焦1-2个：${sellingText}。`,
      `[Camera] 轻微手持+稳定推进结合，突出产品主体与关键细节。`,
      `[Lighting] 自然光+柔和补光，强化材质纹理与高光边缘。`,
      `[Actions / Scenes] 商品引入 -> 使用动作 -> 卖点特写 -> 体验展示 -> 收尾CTA。`,
      `[Background Sound] 轻节奏BGM + 合理环境音。`,
      `[Transition / Editing] 节奏匹配剪辑，关键动作点顺滑衔接。`,
      `[Call to Action] 以推荐动作和购买动机收口。`,
      `基础约束：画幅${ratio}，时长${duration}秒，商品${product}，目标人群${target}，模特策略${modelText}。`,
      sourceHint,
      "请从4.1~4.6选择最合适的组合完成上述结构，避免空话。",
      "合规后缀：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。",
    ].join(" ");
  }
  return [
    `[Style] ${style}; commercial ultra-HD quality and cinematic studio lighting.`,
    `[Environment] Built for ${region} aesthetics and ${business} shopping context.`,
    `[Tone & Pacing] ${duration}s rhythm with only 1-2 core selling points: ${sellingText}.`,
    `[Camera] Light handheld + controlled push-ins for executable shots.`,
    `[Lighting] Natural + soft fill, emphasize texture and edge highlights.`,
    `[Actions / Scenes] Product intro -> usage -> selling-point close-up -> experience -> CTA close.`,
    `[Background Sound] Light rhythmic BGM plus contextual SFX.`,
    `[Transition / Editing] Beat-matched transitions with smooth action continuity.`,
    `[Call to Action] End with recommendation intent and conversion hook.`,
    `Base constraints: ratio ${ratio}, duration ${duration}s, product ${product}, audience ${target}, model strategy ${modelText}.`,
    sourceHint,
    "Select the best mix from 4.1~4.6 to complete this structure.",
    "Compliance suffix: clean highlight edges, controlled reflections, clear textures, sharp structure edges, no distorted limbs/structures, no third-party logos or watermarks.",
  ].join(" ");
}

function pickPlayableUrl(data) {
  return data?.inline_videos?.[0]?.data_url || data?.signed_video_urls?.[0]?.url || data?.signed_all_urls?.[0]?.url || "";
}

function getApiBase() {
  const { protocol, hostname, port, origin } = window.location;
  if (protocol === "file:") return "http://127.0.0.1:8000";
  if ((hostname === "127.0.0.1" || hostname === "localhost") && !port) return "http://127.0.0.1:8000";
  return origin;
}

function buildPlayableUrlFromGcs(gcsUri) {
  const uri = String(gcsUri || "").trim();
  if (!uri || !uri.startsWith("gs://")) return "";
  return `${getApiBase()}/api/veo/play?gcs_uri=${encodeURIComponent(uri)}`;
}

function buildVideoSourceCandidates(videoUrl, gcsUri = "") {
  const direct = String(videoUrl || "").trim();
  const proxy = buildPlayableUrlFromGcs(gcsUri);
  const result = [];
  if (proxy) result.push(proxy);
  if (direct && direct !== proxy) result.push(direct);
  return result;
}

async function refreshPlayableUrlByOperation(operationName) {
  const op = String(operationName || "").trim();
  if (!op) return "";
  try {
    const status = await postJson(
      `${getApiBase()}/api/veo/status`,
      {
        project_id: "gemini-sl-20251120",
        model: "veo-3.1-fast-generate-001",
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
  const segments = Array.isArray(chainResp?.segments) ? chainResp.segments : [];
  if (!segments.length) return;
  const seed = String(chainResp?.seed || "");
  const lines = [t("chainSummaryTitle")];
  for (const seg of segments) {
    const step = Number(seg?.step || 0) || 0;
    const attempt = Number(seg?.attempt_count || 1) || 1;
    const uri = String(seg?.video_gcs_uri || "").trim() || "-";
    if (String(seg?.type || "") === "base_generate") {
      lines.push(
        t("chainSummaryLineBase", {
          step,
          seed: seed || "-",
          attempt,
          uri,
        })
      );
    } else {
      lines.push(
        t("chainSummaryLineExtend", {
          step,
          attempt,
          source: String(seg?.source_video_gcs_uri || "-"),
          uri,
        })
      );
    }
  }
  pushMsg("system", lines.join("\n"), { speed: 20 });
}

function renderGeneratedVideoCard(videoUrl, gcsUri = "", operationName = "", taskId = "") {
  const sourceCandidates = buildVideoSourceCandidates(videoUrl, gcsUri);
  const finalPlayableUrl = sourceCandidates[0] || "";
  state.lastVideoUrl = finalPlayableUrl;
  state.canUseEditors = true;
  const card = document.createElement("article");
  card.className = "msg system video-msg";
  const cardId = `task-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  card.dataset.taskCardId = cardId;
  const title = document.createElement("div");
  title.textContent = t("done");

  const surface = document.createElement("div");
  surface.className = "video-edit-surface";

  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.src = finalPlayableUrl;
  let idx = 0;
  let refreshedByOp = false;
  video.addEventListener("error", async () => {
    if (idx + 1 < sourceCandidates.length) {
      idx += 1;
      const nextUrl = sourceCandidates[idx];
      state.lastVideoUrl = nextUrl;
      video.src = nextUrl;
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
      return;
    }
    if (!refreshedByOp) {
      refreshedByOp = true;
      const refreshedUrl = await refreshPlayableUrlByOperation(operationName);
      if (refreshedUrl) {
        state.lastVideoUrl = refreshedUrl;
        video.src = refreshedUrl;
        const p = video.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
        return;
      }
    }
    const hasGcsSource = String(gcsUri || "").startsWith("gs://");
    if (hasGcsSource) {
      pushMsg(
        "system",
        currentLang === "zh"
          ? "视频播放失败：当前账号缺少 GCS 对象读取权限（storage.objects.get）。请联系管理员授权后重试，或重新生成（不指定 storage_uri）。"
          : "Video playback failed: current account lacks GCS object read permission (storage.objects.get). Grant permission and retry, or regenerate without storage_uri."
      );
      return;
    }
    pushMsg("system", currentLang === "zh" ? "视频播放失败：地址无效或已过期，请重新生成。" : "Video playback failed: URL invalid or expired. Please regenerate.");
  });
  surface.appendChild(video);

  const actions = document.createElement("div");
  actions.className = "video-actions";
  actions.innerHTML = `
    <button id="openVideoEditorBtn">${t("editVideo")}</button>
    <button id="openScriptEditorBtn">${t("editScript")}</button>
  `;

  card.appendChild(title);
  card.appendChild(surface);
  card.appendChild(actions);
  chatList.appendChild(card);
  card.querySelector("#openVideoEditorBtn")?.addEventListener("click", () => toggleEditorPanel("video"));
  card.querySelector("#openScriptEditorBtn")?.addEventListener("click", () => toggleEditorPanel("script"));
  if (taskId && state.taskMap?.[taskId]) {
    updateVideoTask(taskId, { resultCardId: cardId });
  }
  applyWorkspaceMode();
  renderVideoEditor();
  renderScriptEditor();
  applyVideoEditsToPreview();
  scrollToBottom();
  return cardId;
}

async function postJson(url, body, timeout = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function postSse(url, body, onEvent, timeout = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let errText = `HTTP ${resp.status}`;
      try {
        const data = await resp.json();
        errText = data?.error || data?.message || errText;
      } catch (_e) {
        try {
          errText = (await resp.text()) || errText;
        } catch (_e2) {}
      }
      throw new Error(errText);
    }
    if (!resp.body) throw new Error("empty stream body");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const blocks = pending.split("\n\n");
      pending = blocks.pop() || "";
      for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        let eventName = "message";
        const dataLines = [];
        for (const line of lines) {
          if (!line) continue;
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim() || "message";
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }
        if (!dataLines.length) continue;
        const rawPayload = dataLines.join("\n");
        let payload = null;
        try {
          payload = JSON.parse(rawPayload);
        } catch (_e) {
          payload = { raw: rawPayload };
        }
        onEvent?.(eventName, payload);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function generate16sWithProgress(base, startBody, finalPrompt, workflowStartedAt = Date.now(), taskId = "") {
  const zh = currentLang === "zh";
  const statusBubble = pushMsg("system", zh ? "⏳ 步骤 1/4：正在用 AI 拆分提示词为前后两段…" : "Step 1/4: Splitting prompt into two segments…", { typewriter: false });
  updateVideoTask(taskId, { status: "running", stage: zh ? "步骤1/5 拆分提示词" : "Step 1/5 split prompt" });

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
            content:
              "You are an expert ecommerce video prompt architect for Google Veo 3.1.\n"
              + "Given a single video generation prompt, split it into exactly TWO 8-second segments "
              + "that together form a cohesive 16-second product video.\n\n"
              + "Each segment MUST follow this 5-part formula:\n"
              + "[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]\n\n"
              + "Each segment MUST use timestamp prompting for precise 2-second shot control:\n"
              + "[00:00-00:02] first shot description.\n"
              + "[00:02-00:04] second shot description.\n"
              + "[00:04-00:06] third shot description.\n"
              + "[00:06-00:08] fourth shot description.\n\n"
              + "Rules:\n"
              + "- Part 1 (8s): Product introduction, first impression, core selling-point showcase.\n"
              + "- Part 2 (8s): Usage experience, emotional appeal, lifestyle context, confident closing.\n"
              + "- Both parts MUST keep identical: product identity, visual style, lighting, camera language, color palette, aspect ratio.\n"
              + "- NO repeated content between parts. Part 2 must narratively follow Part 1.\n"
              + "- Each part must be a complete, self-contained video prompt (not a fragment).\n"
              + "- NEVER use quotation marks (Veo renders them as on-screen text). Use colons for speech.\n"
              + "- NEVER include text overlay, subtitles, captions, or on-screen characters.\n"
              + "- Focus each 8s segment on a single coherent scene (official Veo best practice).\n"
              + "- Write in English only. No Chinese characters.\n\n"
              + 'Output ONLY valid JSON: {"part1": "...", "part2": "..."}'
          },
          { role: "user", content: finalPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1200,
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
  if (!promptA) promptA = sanitizePromptForVeo(finalPrompt) || finalPrompt;
  if (!promptB) promptB = sanitizePromptForVeo(finalPrompt) || finalPrompt;

  const segBody = { ...startBody, duration_seconds: 8 };

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
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const totalElapsed = Math.floor((Date.now() - workflowStartedAt) / 1000);
      statusBubble.textContent = zh
        ? `⏳ 步骤 ${label}：生成中（总计 ${totalElapsed}s）…`
        : `Step ${label}: Generating (${totalElapsed}s total)…`;
      updateVideoTask(taskId, { status: "running", stage: zh ? `步骤 ${label} 生成中（总计${totalElapsed}s）` : `Step ${label} running (${totalElapsed}s total)` });
      const waitMs = elapsed < 40 ? 3000 : 12000;
      await new Promise((r) => setTimeout(r, waitMs));
      if (elapsed < 30) continue;
      try {
        const st = await postJson(`${base}/api/veo/status`, { project_id: "gemini-sl-20251120", model: "veo-3.1-fast-generate-001", operation_name: op }, 15000);
        if (st?.transient) {
          const retryAttempts = Math.max(0, Number(st?.retry_attempts || 0));
          const waitMs = transientBackoff.apply(retryAttempts);
          if (transientBackoff.shouldNotify()) {
            pushMsg("system", t("pollTransient", { retry: retryAttempts }));
          }
          updateVideoTask(taskId, { status: "running", stage: zh ? `步骤 ${label} 退避重试` : `Step ${label} backoff retry` });
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
        pushMsg("system", t("pollContinue", { sec: totalElapsed }));
        nextSoftTimeoutAt += SOFT_TIMEOUT_STEP_MS;
        updateVideoTask(taskId, { status: "running", stage: zh ? `步骤 ${label} 自动续轮询` : `Step ${label} auto-continue polling` });
      }
      if (elapsedMs > HARD_TIMEOUT_MS) {
        throw new Error(
          zh
            ? `第${label}段超时（总计>${Math.floor(HARD_TIMEOUT_MS / 1000)}s）`
            : `Segment ${label} timed out (>${Math.floor(HARD_TIMEOUT_MS / 1000)}s total)`
        );
      }
    }
  }

  // Step 2/5: Generate segment 1
  statusBubble.textContent = zh ? "⏳ 步骤 2/5：正在生成第 1 段（8s）…" : "Step 2/5: Generating segment 1 (8s)…";
  updateVideoTask(taskId, { status: "running", stage: zh ? "步骤2/5 生成第1段" : "Step 2/5 segment A" });
  scrollToBottom();
  const startA = await submitSafe(promptA, "A");
  const opA = startA?.operation_name;
  if (!opA) throw new Error(zh ? "第1段提交失败" : "Segment 1 submit failed");
  const resA = await pollUntilDone(opA, "2/5");

  // Step 3/5: Extract last frame from segment 1 for seamless bridging
  statusBubble.textContent = zh ? "⏳ 步骤 3/5：提取第 1 段尾帧用于衔接…" : "Step 3/5: Extracting last frame for bridging…";
  updateVideoTask(taskId, { status: "running", stage: zh ? "步骤3/5 提取尾帧" : "Step 3/5 extract bridge frame" });
  scrollToBottom();
  let bridgeFrameB64 = "";
  let bridgeFrameMime = "image/png";
  try {
    const frameBody = {
      project_id: "gemini-sl-20251120",
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

  // Step 4/5: Generate segment 2 with bridging frame as first frame
  statusBubble.textContent = zh ? "⏳ 步骤 4/5：正在生成第 2 段（8s，首帧衔接）…" : "Step 4/5: Generating segment 2 (8s, bridged)…";
  updateVideoTask(taskId, { status: "running", stage: zh ? "步骤4/5 生成第2段" : "Step 4/5 segment B" });
  scrollToBottom();
  const seg2Body = { ...segBody, prompt: promptB };
  if (bridgeFrameB64) {
    seg2Body.veo_mode = "image";
    seg2Body.image_base64 = bridgeFrameB64;
    seg2Body.image_mime_type = bridgeFrameMime;
  }
  let startB;
  try {
    startB = await postJson(`${base}/api/veo/start`, seg2Body, 30000);
  } catch (e) {
    if (isVeoSafetyRejection(String(e?.message || ""))) {
      const saferBody = { ...segBody, prompt: `Clean cinematic product video continuation, 8 seconds, natural lighting, smooth camera, usage experience.` };
      if (bridgeFrameB64) { saferBody.veo_mode = "image"; saferBody.image_base64 = bridgeFrameB64; saferBody.image_mime_type = bridgeFrameMime; }
      startB = await postJson(`${base}/api/veo/start`, saferBody, 30000);
    } else { throw e; }
  }
  const opB = startB?.operation_name;
  if (!opB) throw new Error(zh ? "第2段提交失败" : "Segment 2 submit failed");
  const resB = await pollUntilDone(opB, "4/5");

  // Step 5/5: Concatenate
  statusBubble.textContent = zh ? "⏳ 步骤 5/5：正在拼接为 16 秒视频…" : "Step 5/5: Concatenating into 16s video…";
  updateVideoTask(taskId, { status: "running", stage: zh ? "步骤5/5 拼接中" : "Step 5/5 concatenating" });
  scrollToBottom();

  let concatUrl = "";
  try {
    const concatBody = { project_id: "gemini-sl-20251120" };
    if (resA.gcs && resB.gcs) {
      concatBody.gcs_uri_a = resA.gcs;
      concatBody.gcs_uri_b = resB.gcs;
    } else if (
      resA.url && resA.url.startsWith("data:video/")
      && resB.url && resB.url.startsWith("data:video/")
    ) {
      concatBody.video_data_url_a = resA.url;
      concatBody.video_data_url_b = resB.url;
    }
    if (concatBody.gcs_uri_a || concatBody.video_data_url_a) {
      const concatResp = await postJson(`${base}/api/veo/concat-segments`, concatBody, 120000);
      concatUrl = String(concatResp?.video_data_url || "").trim();
    }
  } catch (_e) {}

  if (statusBubble.parentNode) statusBubble.remove();

  const playable = concatUrl || resA.url || resB.url || "";
  if (!playable) throw new Error(zh ? "16s 视频播放地址缺失" : "16s video URL missing");

  pushMsg("system", zh
    ? `16 秒视频生成完成（2 段串行衔接）。${concatUrl ? "" : "⚠️ 拼接未完成，暂展示第一段。"}`
    : `16s video ready (2 segments, frame-bridged).${concatUrl ? "" : " Concat incomplete, showing first segment."}`);
  updateVideoTask(taskId, { status: "done", stage: zh ? "16秒任务完成" : "16s completed" });
  renderGeneratedVideoCard(playable, resA.gcs || resB.gcs || "", opA || "", taskId);
}

async function generateVideo(promptOverride = "") {
  if (!canStartVideoJob()) {
    pushMsg("system", t("tooManyJobs"));
    return;
  }
  acquireVideoJobSlot();
  let slotReleased = false;
  const releaseSlotOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseVideoJobSlot();
  };
  const taskId = createVideoTask(`${state.duration || "8"}s`);
  try {
    if (!promptOverride) {
      await hydrateWorkflowTexts(false);
    }
    const finalPrompt = String(promptOverride || state.lastPrompt || buildPrompt()).trim();
    state.lastPrompt = finalPrompt;
    if (!state.lastStoryboard) state.lastStoryboard = buildStoryboardText();
    pushMsg("system", t("submit"));
    updateVideoTask(taskId, { status: "queued", stage: currentLang === "zh" ? "提交任务中" : "Submitting job" });
    const imageParsed = parseDataUrl(state.images[0]?.dataUrl);
    const fallbackImageUrl = Array.isArray(state.productImageUrls) ? String(state.productImageUrls[0] || "").trim() : "";
    const useImageMode = Boolean((imageParsed?.base64 && imageParsed?.mime) || fallbackImageUrl);
    const useFrameMode = Boolean(state.frameMode && state.firstFrame && state.lastFrame);
    const base = getApiBase();
    const safePrompt = await rewritePromptForVeoSingle(base, finalPrompt, taskId);
    const startBody = {
      project_id: "gemini-sl-20251120",
      model: "veo-3.1-fast-generate-001",
      prompt: safePrompt,
      sample_count: 1,
      veo_mode: useFrameMode ? "frame" : useImageMode ? "image" : "text",
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
    } else if (imageParsed?.base64 && imageParsed?.mime) {
      startBody.image_base64 = imageParsed.base64;
      startBody.image_mime_type = imageParsed.mime;
    } else if (fallbackImageUrl) {
      startBody.image_url = fallbackImageUrl;
    }
    if (isChainDuration(state.duration)) {
      await generate16sWithProgress(base, startBody, finalPrompt, Date.now(), taskId);
      finishVideoTask(taskId, true, currentLang === "zh" ? "完成" : "Done");
      releaseSlotOnce();
      return;
    }

    const start = await postJson(`${base}/api/veo/start`, startBody);
    const operationName = start?.operation_name;
    if (!operationName) throw new Error("operation_name missing");
    updateVideoTask(taskId, {
      status: "running",
      stage: currentLang === "zh" ? "已提交，轮询中" : "Submitted, polling",
      operationName,
    });
    const zh = currentLang === "zh";
    const pollBubble = pushMsg("system", zh ? "视频生成中（Fast 模式），预计 60-90 秒…" : "Generating video (Fast mode), ~60-90s…", { typewriter: false });
    const pollStartedAt = Date.now();
    const POLL_SOFT_TIMEOUT_MS = 300000;
    const POLL_SOFT_STEP_MS = 180000;
    const POLL_HARD_TIMEOUT_MS = 1800000;
    let pollStopped = false;
    let nextSoftTimeoutAt = POLL_SOFT_TIMEOUT_MS;
    let lastContinueNoticeAt = 0;
    const transientBackoff = createTransientBackoffByPreset("agentFastPoll");

    const doPoll = async () => {
      if (pollStopped) return;
      const elapsedMs = Date.now() - pollStartedAt;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      pollBubble.textContent = zh
        ? `视频生成中（${elapsedSec}s）…`
        : `Generating video (${elapsedSec}s)…`;
      updateVideoTask(taskId, { status: "running", stage: zh ? `轮询中（总计${elapsedSec}s）` : `Polling (${elapsedSec}s total)` });

      if (elapsedMs > nextSoftTimeoutAt && Date.now() - lastContinueNoticeAt > 30000) {
        lastContinueNoticeAt = Date.now();
        pushMsg("system", t("pollContinue", { sec: elapsedSec }));
        nextSoftTimeoutAt += POLL_SOFT_STEP_MS;
      }
      if (elapsedMs > POLL_HARD_TIMEOUT_MS) {
        pollStopped = true;
        if (pollBubble.parentNode) pollBubble.remove();
        pushMsg("system", zh
          ? `视频生成超时（总计 ${elapsedSec}s）。请稍后重试或简化提示词。`
          : `Video generation timed out (${elapsedSec}s total). Retry later or simplify the prompt.`);
        finishVideoTask(taskId, false, zh ? "超时" : "Timeout");
        releaseSlotOnce();
        return;
      }

      if (elapsedMs < 30000) {
        scheduleNext(2000);
        return;
      }

      try {
        const status = await postJson(
          `${base}/api/veo/status`,
          {
            project_id: "gemini-sl-20251120",
            model: "veo-3.1-fast-generate-001",
            operation_name: operationName,
          },
          20000
        );
        if (status?.transient) {
          const retryAttempts = Math.max(0, Number(status?.retry_attempts || 0));
          const waitMs = transientBackoff.apply(retryAttempts);
          if (transientBackoff.shouldNotify()) {
            pushMsg("system", t("pollTransient", { retry: retryAttempts }));
          }
          scheduleNext(waitMs);
          return;
        }
        const opError = status?.response?.error?.message || "";
        if (status?.response?.done && opError) {
          pollStopped = true;
          if (pollBubble.parentNode) pollBubble.remove();
          if (isVeoSafetyRejection(opError)) {
            pushMsg("system", zh
              ? `视频生成被安全策略拦截：${opError.slice(0, 120)}。请简化提示词后重试。`
              : `Video blocked by safety policy: ${opError.slice(0, 120)}. Simplify prompt and retry.`);
          } else {
            pushMsg("system", t("genFail"));
          }
          finishVideoTask(taskId, false, zh ? "失败" : "Failed");
          releaseSlotOnce();
          return;
        }
        const videoUrl = pickPlayableUrl(status);
        const gcsUri = String(status?.video_uris?.[0] || "").trim();
        if (videoUrl) {
          pollStopped = true;
          if (pollBubble.parentNode) pollBubble.remove();
          renderGeneratedVideoCard(videoUrl, gcsUri, operationName, taskId);
          finishVideoTask(taskId, true, zh ? "完成" : "Done");
          releaseSlotOnce();
          return;
        }
      } catch (_e) {
        pollStopped = true;
        if (pollBubble.parentNode) pollBubble.remove();
        pushMsg("system", t("pollFail"));
        finishVideoTask(taskId, false, zh ? "轮询异常" : "Polling error");
        releaseSlotOnce();
        return;
      }
      scheduleNext(elapsedMs < 90000 ? 10000 : 15000);
    };
    function scheduleNext(ms) { if (!pollStopped) setTimeout(doPoll, ms); }
    scheduleNext(2000);
  } catch (e) {
    const detailRaw = String(e?.message || "").trim();
    const detail = /aborted|abort/i.test(detailRaw)
      ? currentLang === "zh"
        ? "请求超时，请重试"
        : "request timeout, please retry"
      : detailRaw;
    pushMsg("system", detail ? `${t("genFail")} (${detail})` : t("genFail"));
    finishVideoTask(taskId, false, currentLang === "zh" ? "任务失败" : "Failed");
    releaseSlotOnce();
  }
}

async function onUpload(files) {
  const picked = Array.from(files || [])
    .filter((f) => /^image\/(png|jpeg)$/.test(f.type))
    .slice(0, 6);
  if (!picked.length) {
    pushMsg("system", t("invalidType"));
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
    pushMsg("system", withLead(t("parseFallback"), "general"));
  }
  if (SIMPLE_AGENT_MODE) {
    chatInput.value = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image"));
    state.lastPrompt = chatInput.value.trim();
    state.lastStoryboard = buildStoryboardText();
    try {
      await hydrateWorkflowTexts(true);
    } catch (_e) {}
    if (state.lastPrompt) chatInput.value = sanitizePromptForUser(state.lastPrompt);
    syncSimpleControlsFromState();
    pushMsg(
      "system",
      t("parseDone", {
        product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
        business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
        style: state.template || "clean",
      })
    );
    return;
  }
  pushMsg("system", t("insightRecapTitle"));
  state.lastStoryboard = buildStoryboardText();
  state.lastPrompt = sanitizePromptForUser(buildAutoPromptDraftFromParsed("image"));
  try {
    await hydrateWorkflowTexts(true);
  } catch (_e) {}
  pushMsg(
    "system",
    [
      `- ${t("insightRecapProduct", { value: state.productName || (currentLang === "zh" ? "未识别商品" : "Unknown product") })}`,
      `- ${t("insightRecapBusiness", { value: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "Fashion & accessories") })}`,
      `- ${t("insightRecapStyle", { value: state.template || "clean" })}`,
    ].join("\n"),
    { speed: 24 }
  );
  showInsightEditCard();
  if (state.stage === "awaitMain") {
    pushMsg("system", currentLang === "zh" ? "已预填完成。可直接在上方编辑后点击“确认这些信息”。" : "Prefill complete. Edit above and click \"Confirm these fields\".");
  } else if (!state.sellingPoints) {
    pushMsg("system", t("askPoints"));
  }
}

async function onSend() {
  if (SIMPLE_AGENT_MODE) {
    const linkText = String(productUrlInput?.value || "").trim();
    const promptText = String(chatInput.value || "").trim();
    // Clear immediately after submit to avoid stale text staying in composer.
    if (chatInput) chatInput.value = "";
    const firstUrlMatch = (linkText || promptText).match(/(?:https?:\/\/|www\.)[^\s]+/i);
    const urlCandidate = firstUrlMatch?.[0] ? String(firstUrlMatch[0]).trim() : "";
    const needPrefillFromUrl = Boolean(
      urlCandidate && (!state.productName || !state.mainBusiness || !state.sellingPoints)
    );
    if (needPrefillFromUrl) {
      await parseShopProductByUrl(urlCandidate);
    }
    const finalText = String(chatInput.value || "").trim() || promptText;
    if (!finalText) return;
    if (!canStartVideoJob()) {
      pushMsg("system", t("tooManyJobs"));
      return;
    }
    syncStateFromSimpleControls();
    state.lastPrompt = finalText;
    state.primarySubmitLocked = false;
    state.workflowHydrated = true;
    pushMsg("user", finalText, { typewriter: false });
    generateVideo(finalText);
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
    pushMsg("system", withLead(t("regionAck", { value: text }), "region"));
    askTarget();
    return;
  }
  if (state.stage === "awaitTarget") {
    state.targetUser = text;
    pushMsg("system", withLead(t("targetAck", { value: text }), "target"));
    askBrand();
    return;
  }
  if (state.stage === "awaitBrand") {
    state.brandInfo = text;
    pushMsg("system", withLead(t("brandAck", { value: text }), "brand"));
    askForPointsOrSummary();
    return;
  }

  if (!state.images.length && !state.skipImageConfirmed) {
    if (/^(跳过上传|跳过|skip upload|skip)$/i.test(text)) {
      state.skipImageConfirmed = true;
      pushMsg("system", t("skipUploadAck"));
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
    pushMsg("system", t("gotMore"));
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
    pushMsg("system", t("gotMore"));
    showQuickGenerateButton();
    return;
  }

  if (state.salesRegion && state.targetUser && state.sellingPoints) {
    if (!state.summaryShown) showSummaryCard();
    else {
      pushMsg("system", t("gotMore"));
      showQuickGenerateButton();
    }
  } else if (!state.salesRegion) {
    state.stage = "awaitRegion";
    askRegion();
  } else if (!state.targetUser) {
    state.stage = "awaitTarget";
    askTarget();
  } else if (!state.sellingPoints) {
    pushMsg("system", t("askPoints"));
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
    pushMsg("system", t("enhanceWorking"));
    const fallbackTemplate =
      currentLang === "zh"
        ? [
            "你是一位电商视频提示词优化专家。",
            "请根据用户输入，按以下框架优化为可直接用于生成的一条提示词：",
            "4.1产品口播、4.2UGC评测、4.3痛点与解决、4.4产品演示、4.5前后对比、4.6故事讲述。",
            "必须选择1个主框架+1个辅助框架，不要全部堆叠。",
            "最终语义必须覆盖：Style、Environment、Tone & Pacing、Camera、Lighting、Actions/Scenes、Background Sound、Transition/Editing、CTA。",
            "卖点只聚焦1-2个；单段时长遵守4/6/8秒，若目标总时长是16/24秒请按8秒链式延展，镜头可执行可拍可剪。",
            "必须包含合规后缀：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。",
            "只输出最终提示词，不要解释。",
          ].join("\n")
        : [
            "You are an ecommerce video prompt optimizer.",
            "Rewrite the input as a final, production-ready single prompt using frameworks 4.1~4.6.",
            "Select one primary framework + one supporting framework only.",
            "The final prompt must cover: Style, Environment, Tone & Pacing, Camera, Lighting, Actions/Scenes, Background Sound, Transition/Editing, CTA.",
            "Focus on only 1-2 selling points; keep per-segment duration in 4/6/8s, and for 16/24s use chained 8s extension.",
            "Must append compliance suffix: clean highlight edges, controlled reflections, clear textures, sharp structure edges, no distorted limbs/structures, no third-party logos/watermarks.",
            "Output only the final prompt text without explanations.",
          ].join("\n");
    const composedPrompt = [
      templateText || fallbackTemplate,
      `Aspect ratio: ${state.aspectRatio || "16:9"}. Duration: ${state.duration || "8"} seconds.`,
      `Product: ${state.productName || "unknown"}. Business: ${state.mainBusiness || "ecommerce"}. Template: ${state.template || "clean"}.`,
      reviewHint,
      `User prompt: ${raw}.`,
      "Final output constraint: only one final video prompt text, no markdown, no bullet list, no explanation.",
    ].join("\n");
    let optimized = "";
    try {
      let streamed = "";
      let donePayload = null;
      await postSse(
        `${base}/api/agent/chat`,
        {
          model: "bedrock-claude-4-5-haiku",
          prompt: composedPrompt,
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
          {
          model: "bedrock-claude-4-5-haiku",
          messages: [{ role: "user", content: composedPrompt }],
          },
          20000
        );
        optimized = String(retryResp?.content || "").trim();
      } catch (_secondErr) {
        // Both LLM attempts failed — use local template as immediate fallback.
        optimized = sanitizePromptForUser(buildAutoPromptDraftFromParsed("url"));
      }
    }
    if (!optimized) {
      optimized = sanitizePromptForUser(buildAutoPromptDraftFromParsed("url"));
    }
    const cleaned = sanitizePromptForUser(optimized);
    chatInput.value = cleaned;
    state.lastPrompt = cleaned;
    pushMsg("system", t("enhanceDone"));
  } catch (e) {
    const detailRaw = String(e?.message || "").trim();
    const detail = /aborted|abort/i.test(detailRaw)
      ? currentLang === "zh"
        ? "请求超时，请重试"
        : "request timeout, please retry"
      : detailRaw;
    const box = pushMsg("system", detail ? `${t("enhanceFail")} (${detail})` : t("enhanceFail"), { typewriter: false });
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
  const normalizeProductUrl = (raw = "") => {
    const cleaned = String(raw || "")
      .replace(/[<>"'`]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "";
    const firstUrlMatch = cleaned.match(/https?:\/\/[^\s]+/i);
    const picked = firstUrlMatch?.[0] ? String(firstUrlMatch[0]).trim() : cleaned;
    if (/^www\./i.test(picked)) return `https://${picked}`;
    return picked;
  };
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

  const url = normalizeProductUrl(inputUrl || productUrlInput?.value || "");
  if (!url) return;
  if (productUrlInput) productUrlInput.value = url;
  const base = getApiBase();
  const stopParseProgress = startLinkParseProgress();
  try {
    const data = await postJson(
      `${base}/api/agent/shop-product-insight`,
      {
        product_url: url,
        language: currentLang,
      },
      45000
    );
    stopParseProgress();
    const insight = data?.insight || {};
    const parsedProductName = String(insight.product_name || "").trim();
    const parsedSellingPoints = Array.isArray(insight.selling_points)
      ? insight.selling_points.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6)
      : [];
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
      pushMsg("system", t("parseLinkWeak"));
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
      pushImageMsg(state.images);
    } else if (!state.images.length) {
      pushMsg("system", t("parseLinkWeakInfo"));
      showUploadScreenshotGuide();
      showUploadRefQuickAction();
    }
    const reviewSummary = String(insight.review_summary || "").trim();
    const fetchConfidence = String(insight.fetch_confidence || data?.confidence || "").trim().toLowerCase();
    const positiveText = state.reviewPositivePoints.length ? state.reviewPositivePoints.slice(0, 2).join("；") : "";
    const negativeText = state.reviewNegativePoints.length ? state.reviewNegativePoints.slice(0, 2).join("；") : "";
    const sellingText = state.sellingPoints || (currentLang === "zh" ? "突出核心卖点" : "highlight core selling points");
    if (!state.productName) {
      const urlFallbackName = inferProductNameFromUrl(url);
      if (urlFallbackName) state.productName = urlFallbackName;
    }
    if (!state.mainBusiness) state.mainBusiness = guessBusinessByName(state.productName || "");
    if (!state.template) state.template = guessTemplateByName(state.productName || "");
    const currentText = String(chatInput.value || "").trim();
    const shouldOverwriteDraft = !currentText || isLikelyUrlOnlyText(currentText) || currentText === url;
    if (shouldOverwriteDraft) {
      chatInput.value =
        currentLang === "zh"
          ? `请为商品「${state.productName || "该商品"}」生成一条${state.duration || "8"}秒电商短视频，比例${state.aspectRatio || "16:9"}，重点卖点：${sellingText}。${positiveText ? `好评强调点：${positiveText}。` : ""}${negativeText ? `差评规避点：${negativeText}。` : ""}${reviewSummary ? `补充反馈：${reviewSummary}。` : ""}镜头自然、真实质感、突出转化。`
          : `Create a ${state.duration || "8"}s ecommerce video for "${state.productName || "this product"}" in ${state.aspectRatio || "16:9"}. Key selling points: ${sellingText}. ${positiveText ? `Emphasize positive review signals: ${positiveText}.` : ""}${negativeText ? `Avoid negative feedback triggers: ${negativeText}.` : ""}${reviewSummary ? `Additional review cues: ${reviewSummary}.` : ""} Natural cinematic motion, realistic texture, conversion-focused.`;
      state.lastPrompt = String(chatInput.value || "").trim();
    }
    const refillOk = Boolean(state.productName && state.mainBusiness && state.template);
    if (!refillOk) {
      pushMsg(
        "system",
        currentLang === "zh"
          ? "解析已完成，但关键信息回填不完整。请补充商品名称后重试解析，或上传商品图辅助识别。"
          : "Parsing finished, but key fields are not fully backfilled. Please add product name and retry, or upload product images."
      );
    }
    if (fetchConfidence === "low") {
      pushMsg(
        "system",
        currentLang === "zh"
          ? "链接解析结果可信度较低，建议补充商品截图或手动补充卖点。"
          : "Parsed result confidence is low. Add product screenshots or fill selling points manually.",
      );
    }
    pushMsg("system", t("parseLinkDone"));
    pushMsg(
      "system",
      t("parseDone", {
        product: state.productName || (currentLang === "zh" ? "未识别商品" : "unknown"),
        business: state.mainBusiness || (currentLang === "zh" ? "鞋服配饰" : "fashion"),
        style: state.template || "clean",
      }),
      { typewriter: false }
    );
  } catch (_e) {
    stopParseProgress();
    pushMsg("system", t("parseLinkFail"));
  }
}

function consumeLandingParams() {
  const from = (queryParams.get("from") || "").trim();
  const productUrl = (queryParams.get("product_url") || "").trim();
  const aspect = (queryParams.get("aspect_ratio") || "").trim();
  const duration = (queryParams.get("duration") || "").trim();
  const draft = (queryParams.get("draft") || "").trim();

  if (["landing-prompt", "landing-product-link", "landing-upload", "landing-ref"].includes(from)) {
    state.entryFocusMode = true;
  }

  if (aspect && ["16:9", "9:16", "1:1"].includes(aspect)) {
    state.aspectRatio = aspect;
  }
  if (duration && ["4", "6", "8", "16"].includes(duration)) {
    state.duration = duration;
  }
  if (draft && !chatInput.value.trim()) {
    chatInput.value = draft;
  }
  syncSimpleControlsFromState();
  applyWorkspaceMode();

  if (from && (aspect || duration || draft)) {
    const durLabel = state.duration ? `${state.duration}s` : "";
    const ratioLabel = state.aspectRatio || "";
    const parts = [durLabel, ratioLabel].filter(Boolean);
    state._landingHint = parts.length
      ? (currentLang === "zh"
          ? `已应用首页设置：${parts.join(" · ")}${draft ? "，提示词已预填。" : "。"}`
          : `Landing settings applied: ${parts.join(" · ")}${draft ? ". Prompt pre-filled." : "."}`)
      : "";
  }

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
  const welcomeText = t("welcome");
  const baseDelay = Math.max(1400, Math.min(4200, welcomeText.length * 26));
  setTimeout(() => {
    consumeLandingPrefill();
  }, baseDelay);
}

uploadBtn.addEventListener("click", () => imageInput.click());
if (toggleProductUrlBtn) {
  toggleProductUrlBtn.addEventListener("click", () => {
    if (!composerCompact) return;
    composerCompact.classList.toggle("show-link-row");
    const opened = composerCompact.classList.contains("show-link-row");
    toggleProductUrlBtn.textContent = opened ? t("toggleLinkHide") : t("toggleLinkShow");
    if (opened) productUrlInput?.focus();
  });
}
imageInput.addEventListener("change", (e) => onUpload(e.target.files));
sendBtn.addEventListener("click", onSend);
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
          project_id: "gemini-sl-20251120",
          prompt: firstPrompt,
          sample_count: 1,
          aspect_ratio: "16:9",
        }, 60000),
        postJson(`${base}/api/media/image-generate`, {
          project_id: "gemini-sl-20251120",
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
      pushMsg("system", zh
        ? `AI 已生成首尾帧${state.frameMode ? "，可直接用于视频生成。" : "（部分生成失败，请手动上传）。"}`
        : `AI generated frames${state.frameMode ? ". Ready for video generation." : " (partial failure, please upload manually)."}`);
    } catch (e) {
      pushMsg("system", zh ? `首尾帧生成失败: ${e.message}` : `Frame generation failed: ${e.message}`);
    } finally {
      aiGenerateFramesBtn.disabled = false;
      aiGenerateFramesBtn.textContent = zh ? "AI 自动生成" : "AI Generate";
    }
  });
}
if (durationSelect) {
  durationSelect.addEventListener("change", () => {
    state.duration = String(durationSelect.value || "8");
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
  taskQueueClearBtn.addEventListener("click", () => {
    clearCompletedTasks();
  });
}
if (taskQueueList) {
  taskQueueList.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest("[data-task-action='view']") : null;
    if (!btn) return;
    const taskId = String(btn.getAttribute("data-task-id") || "");
    scrollToTaskResult(taskId);
  });
}
window.addEventListener("resize", () => updateToolbarIndicator());

applyLang();
syncSimpleControlsFromState();
applyWorkspaceMode();
consumeLandingParams();
pushMsg("system", t("welcome"));
if (state._landingHint) pushMsg("system", state._landingHint);
if (!SIMPLE_AGENT_MODE) scheduleLandingPrefillAfterWelcome();
