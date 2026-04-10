# Shoplive 视频生成架构与提示词体系

> 文档日期：2026-04-09  
> 工作目录：`/Users/huangshaozheng/Desktop/ai创新挑战赛/shoplive`

---

## 一、端到端生成流程

```
用户操作
  ├── 文字输入 → onSend() → submitSimplePromptGeneration()
  ├── 图片上传 → onUpload() → analyzeImageInsight() → auto draft
  ├── 商品链接 → parseShopProductByUrl() → mergeInsight → auto draft
  └── 首页模板卡 → consumeLandingParams() → draft 填入输入框 → auto submit
              ↓
        generateVideo(promptOverride)          [index.js:4000]
              ↓
    ┌─── hydrateWorkflowTexts()               [workspace.js:100]
    │    (LLM生成脚本+提示词，有缓存，失败 fallback)
    │         ↓
    │    rewritePromptForVeoSingle()          [index.js:3130]
    │    (中→英转换 + Veo 合规清理)
    │         ↓
    └─── finalPrompt (英文，已清洗)
              ↓
    isChainDuration(duration)?
      YES (16s) → generate16sWithProgress()  [index.js:3616]
                   A段 → /api/veo/start
                   末帧提取 → /api/veo/extract-frame
                   B段 → /api/veo/start (frame mode)
                   合并 → /api/veo/concat-segments
      NO  (≤12s) → POST /api/veo/start       [veo_api.py:313]
              ↓
    前端轮询 /api/veo/status (每8s一次，18s后开始)
              ↓
    视频完成 → renderGeneratedVideoCard()
```

---

## 二、提示词三层架构

| 层次 | 函数 | 文件:行号 | 时机 | 是否LLM | 失败处理 |
|------|------|----------|------|---------|---------|
| **基础层** | `buildPrompt()` | index.js:2507 | 运行时兜底 | 否 | 直接输出 |
| **工作流层** | `hydrateWorkflowTexts()` | workspace.js:100 | 发起生成前 | 是 | fallback 模板 |
| **运行时层** | `rewritePromptForVeoSingle()` | index.js:3130 | 发 API 前 | 是（中文时） | `buildSingleVeoFallbackPrompt()` |

---

## 三、各层提示词详解

### 3.1 基础层 — `buildPrompt()` [index.js:2507]

从 `state` 字段本地组装，无网络调用，作为最终兜底。

**结构（中英双语）：**

```
[画幅] {aspectRatio}画幅，超高清商业画质，电影级影棚布光。

[商品一致性] 商品严格参考上传图或已解析信息，
  保持颜色、材质、结构和细节一致。

[基础信息]
  商品：{productName}
  主营：{mainBusiness}
  锚点：{productAnchorSummary}

[核心策略]
  卖点（≤2个）：{sellingPoints}
  目标人群：{targetUser}
  销售地区：{salesRegion}
  风格模板：{template}
  模特策略：{needModel ? "需要模特" : "无需模特"}
  时长：{duration}秒

[镜头框架]
  稳定推进+局部特写，主体始终清晰；
  柔光补光强化材质纹理与高光轮廓；
  动作点顺滑衔接，节奏与卖点同步。

[评论信号]
  正向（≤3）：{reviewPositivePoints}
  规避（≤2）：{reviewNegativePoints}

[合规]
  高光边缘干净，反光可控，材质纹理清晰；
  不出现畸形手或错误结构；
  不出现他牌标识或水印。
```

**关键 state 字段：**
`productName` / `mainBusiness` / `sellingPoints` / `targetUser` / `salesRegion` / `template` / `needModel` / `duration` / `productAnchors` / `reviewPositivePoints` / `reviewNegativePoints`

---

### 3.2 工作流层 — `hydrateWorkflowTexts()` [workspace.js:100]

**触发条件：** 用户已填写 productName + mainBusiness + sellingPoints + targetUser + salesRegion

**两步 LLM 调用：**

#### 步骤 1：生成分镜脚本
- 接口：`POST /api/shoplive/video/workflow?action=generate_script`
- 缓存 key：`script:{input_fingerprint}:{model}:{user_message_hash}:{version}`
- 失败 fallback：`buildShopliveScript()`（本地模板，中文）

#### 步骤 2：从脚本生成 Veo 提示词
- 接口：`POST /api/shoplive/video/workflow?action=build_export_prompt`
- 缓存 key：`prompt:{input_fingerprint}:{model}:{script_hash}:{version}`
- 失败 fallback：`buildShopliveVideoPromptTemplate()`（briefing.py:335，中文结构化模板）

**后端 Fallback 模板结构 [briefing.py:335]：**
```
商品：{product_name}，{main_business}
时长：{total_duration}秒
卖点聚焦：{selling_points_top2}
画幅：{aspect_ratio}，风格：{template}

[Opening 0-4s] 全景引入 + 核心卖点特写
[Mid 4-6s] 使用场景 / 细节展示
[Closing 6-8s] 品牌收口 + 购买 CTA
```

---

### 3.3 运行时层 — `rewritePromptForVeoSingle()` [index.js:3130]

**触发条件：** 引擎为 Veo 时，在发 `/api/veo/start` 前调用

**处理流程：**
```
source prompt
    ↓ hasCjkChars(source)?
   YES → LLM rewrite (claude-haiku, 20s timeout, temp=0.3)
   NO  → 跳过 LLM
    ↓
sanitizePromptForVeo()     // 合规清洗
    ↓
append exposure constraint  // 补曝光稳定约束
    ↓
final Veo prompt (英文，≤1600字符)
```

**LLM Rewrite System Prompt：**
```
Rewrite the user's ecommerce video prompt into ONE Veo-ready English prompt.

Rules:
- Keep original product intent and selling points
- Do NOT change product category, silhouette, color family, materials, or key details
- Output: plain text only (no markdown), max 220 words
- Must include four timestamp shots: [00:00-00:02] [00:02-00:04] [00:04-00:06] [00:06-00:08]
- Timestamp boundaries must be seamless: same lighting and exposure across cuts
- No sudden brightening, flash, or exposure pop (especially near 2s)
- No text overlays / subtitles / captions
- No quotation marks
```

**失败 fallback：** `buildSingleVeoFallbackPrompt()` ↓

---

## 四、提示词模板类型全览

### 模板 1：单段文字生成（Text-to-Video）
**触发：** 纯文字提示词，无图片，时长 ≤ 12s

```
[Style] {style_template}, commercial ultra-HD quality, cinematic studio lighting.
[Subject] {product} for {business}, keep identity consistent with uploaded references.
[Anchors] {product_anchor_summary}.
[Context] For {sales_region}, aimed at {target_user}, {model_strategy}.
[Action] Focus on {core_selling_points}.

[00:00-00:04] Continuous hero build — wide to medium, same lighting and exposure 
  throughout (no flash at 2s).
[00:04-00:06] Detail and texture; maintain identical color grade and exposure as 
  prior beats.
[00:06-00:08] Confident closing composition; single coherent lighting setup, 
  no new light sources.

[Technical] Aspect ratio {16:9}, duration {8}s, smooth camera, realistic texture, 
  constant exposure.
[Compliance] No text overlay, no subtitles, no captions.
  Stable exposure and white balance for the whole clip.
  First 0-4 seconds: hold luminance steady — no flash, fade-to-white, or exposure pop.
```

**文件：** index.js:3106 (`buildSingleVeoFallbackPrompt`)

---

### 模板 2：自动草稿（Auto Draft from Image / URL）
**触发：** 上传图片 or 解析商品链接后自动生成

```
[Style] clean，超高清商业画质，电影级布光，真实可拍可剪。

[Environment] {region}{business}消费场景，背景干净，道具克制。

[Tone & Pacing] {duration}秒，节奏紧凑，聚焦：{sellingText}。

[Camera] 稳定推进+局部特写，主体始终清晰。

[Lighting] 柔光补光强化材质纹理与高光轮廓。

[Actions / Scenes]
  商品全貌引入 → 核心卖点特写 → 使用场景展示
  → {needModel ? "模特展示/穿搭/使用" : "无模特，纯产品展示"}
  → 购买 CTA 收口

[BGM] 轻节奏背景音乐，契合场景情绪。

[Transition] 动作点顺滑衔接，节奏与卖点同步。

[Reference] 严格保持商品外观与{source=image?"上传图片":"解析图片"}一致。

[Compliance]
  No text overlay, no subtitles, no captions.
  No brand logos or watermarks.
  {product_anchor_constraints}
```

**文件：** index.js:3184 (`buildAutoPromptDraftFromParsed`)

---

### 模板 3：16秒双段视频（Chain Generation）
**触发：** `state.duration === "16"`

**LLM 分割 System Prompt [index.js:718]：**

```
Step 1 — EXTRACT VISUAL ANCHORS (internal only)
  • PRODUCT: exact name, color, material, key visual features
  • STYLE: cinematic tone (clean/editorial/lifestyle/etc.)
  • LIGHTING: setup (soft natural/studio/golden hour/etc.)
  • COLOR PALETTE: dominant colors and mood
  • CAMERA LANGUAGE: lens style, movement type

Step 2 — ASSIGN NARRATIVE ROLES
  Segment 1 (8s): PRODUCT HERO OPENING
    Camera pushes in from wide to medium, revealing form and silhouette.
    Focus on the most striking visual feature.
    Set the mood and color palette for the whole video.

  Segment 2 (8s): USAGE / SELLING-POINT DETAIL
    DIFFERENT camera angle and environment from Segment 1.
    Show product in use, key feature up-close, or lifestyle context.

Step 3 — WRITE EACH SEGMENT PROMPT
  • Begin with locked visual anchors
  • Add segment-specific narrative action and camera movement
  • Use timestamp shots: [00:00-00:02] [00:02-00:04] [00:04-00:06] [00:06-00:08]
  • Each segment must be COMPLETE and SELF-CONTAINED
  • End of Segment N should visually "hand off" to Segment N+1

Hard Rules:
  ✗ NEVER repeat same shot composition or angle across segments
  ✗ NEVER use quotation marks
  ✗ NEVER include text overlays / subtitles / captions
  ✗ NEVER change product appearance or brand identity between segments
  ✓ Each segment must feel like the SAME video shoot
  ✓ Timestamp beats must evolve GRADUALLY — constant exposure/white balance
  ✓ Write in English only

Output ONLY valid JSON: {"part1": "...", "part2": "..."}
```

**A 段 Fallback [index.js:3572]：**
```
{basePrompt} SEGMENT 1/2 — PRODUCT HERO OPENING:
[00:00-00:02] Slow push-in from wide; hold consistent key light — no exposure jump.
[00:02-00:04] Ease into medium close-up; same lighting setup and white balance 
  as previous beat.
[00:04-00:06] Detail texture; no new light sources or brightness pop.
[00:06-00:08] Hero framing; single coherent grade end-to-end.
```

**B 段 Fallback [index.js:3578]：**
```
{basePrompt} SEGMENT 2/2 — USAGE & CLOSING:
[00:00-00:02] Lifestyle context — match Segment 1 color temperature; 
  gradual angle change only.
[00:02-00:04] Close-up during use; maintain exposure continuity — 
  avoid flash or sudden brightening.
[00:04-00:06] Emotional moment — satisfaction and connection with the product.
[00:06-00:08] Confident closing hero shot — product alone, perfect lighting, 
  camera holds still for final reveal.
```

**B 段特殊处理：** 自动提取 A 段最后一帧 → `veo_mode: "frame"` → 确保视觉连续性

---

### 模板 4：参考图生成（Reference-to-Video）
**触发：** `state.images` 或 `state.productImageUrls` 有数据，且时长 ≤ 12s

**Veo 模式：** `reference`（非 `image`，避免原始比例绑架输出比例）

**Payload 额外字段：**
```json
{
  "veo_mode": "reference",
  "reference_images_base64": [
    { "base64": "...", "mime_type": "image/jpeg" }
  ]
}
```

**注意事项：**
- 图片在发送前通过 `resizeDataUrlForVeo(url, 512px, 0.82)` 压缩，减小 payload
- `reference` 模式允许 Veo 按 `aspect_ratio` 生成正确比例，同时保持商品外观一致性

---

### 模板 5：首尾帧控制（Frame-to-Frame）
**触发：** `state.frameMode && state.firstFrame && state.lastFrame`

**Veo 模式：** `frame`

**Payload 额外字段：**
```json
{
  "veo_mode": "frame",
  "image_base64": "{firstFrame_base64}",
  "image_mime_type": "image/jpeg",
  "last_frame_base64": "{lastFrame_base64}",
  "last_frame_mime_type": "image/png"
}
```

**应用场景：** 精确控制视频首帧（商品展示角度）和尾帧（CTA 画面），16s 双段中 B 段自动使用此模式

---

## 五、不同入口的提示词路径

### 入口 1：首页模板卡

```
用户点击模板卡（女装/跑鞋/社媒）
    ↓
landing.js 拉取模板缩略图 → 存入 sessionStorage
    ↓
跳转 agent.html?from=landing-ref&draft={preset_text}&duration=8
    ↓
consumeLandingParams()
  draft → chatInput.value = draft
  image → state.images = [{dataUrl, source: "landing-ref"}]
    ↓
sendBtn.click() (400ms 后自动)
    ↓
submitSimplePromptGeneration(draft)
  → generateVideo(draft)
  → rewritePromptForVeoSingle(draft)  // 中文→英文
  → Veo reference 模式（缩略图作为风格参考）
```

**提示词来源：** 模板预设文字（中文），经 LLM 重写为英文 Veo prompt

---

### 入口 2：用户文字输入

```
用户在 chat 输入框输入文字
    ↓
onSend()
  → 检查是否是编辑指令 extractVideoEditIntent()
  → 否则 submitSimplePromptGeneration(finalText)
    ↓
generateVideo(text)
  → hydrateWorkflowTexts()（若 state 有足够商品信息）
  → finalPrompt = promptOverride || state.lastPrompt || buildPrompt()
  → rewritePromptForVeoSingle(finalPrompt)
    ↓
Veo text / reference 模式
```

**提示词来源：** 用户输入 → 工作流 LLM 增强（可选）→ 运行时 LLM 重写

---

### 入口 3：上传商品图

```
用户拖入/点击上传图片
    ↓
onUpload(files)
  → analyzeImageInsight(images)
    POST /api/agent/image-insight (Gemini 2.5 Flash)
    返回 product_name, main_business, selling_points,
         style_template, product_anchors
    ↓
applyInsightToState(insight)
  state.productName = insight.product_name
  state.sellingPoints = insight.selling_points
  state.productAnchors = insight.product_anchors
    ↓
state.lastPrompt = buildAutoPromptDraftFromParsed("image")
chatInput.value = sanitizePromptForUser(state.lastPrompt)
    ↓
用户可直接点生成 or 修改后生成
→ rewritePromptForVeoSingle()
→ Veo reference 模式（原图压缩到512px作为参考）
```

**提示词来源：** Vision 模型识别 → Auto Draft 模板 → 运行时 LLM 重写

---

### 入口 4：商品链接解析

```
用户粘贴商品URL
    ↓
parseShopProductByUrl(url)
  Step 1: POST /api/agent/shop-product-insight
    → 爬取商品页 → 提取 name/selling_points/image_urls
  Step 2: 若有图片 → analyzeImageInsight(imageItems)
    → 视觉分析获取 product_anchors
  Step 3: mergeInsightPayloads(textInsight, visualInsight)
    ↓
state 更新（同图片上传路径）
state.lastPrompt = buildAutoPromptDraftFromParsed("url")
    ↓
用户可编辑或直接生成
→ 同图片上传后续路径
```

**提示词来源：** 爬虫 + Vision 混合分析 → Auto Draft 模板 → 运行时 LLM 重写

---

## 六、提示词合规清洗规则 `sanitizePromptForVeo()` [index.js:3067]

| 步骤 | 规则 | 示例 |
|------|------|------|
| 1 | 移除价格信息 | `$99` `¥199` `USD 50` |
| 2 | 移除促销词 | `50% off` `免费包邮` `限时秒杀` |
| 3 | 移除 CTA 词 | `立即购买` `add to cart` |
| 4 | 替换电商平台名 | `Amazon/Walmart/Shein/Temu` → `brand` |
| 5 | 移除版权符 | `TM` `®` `©` |
| 6 | 移除文字覆盖指令 | `text overlay` `字幕` |
| 7 | 移除引号和引号内文字 | `"限时特惠"` |
| 8 | 移除所有中文字符 | 全部 CJK 字符替换为空格 |
| 9 | 过滤禁用行 | 包含 `禁用词/合规要求` 的整行 |
| 10 | 截断至 1600 字符 | — |
| 11 | 强制附加无字幕约束 | "No text overlay, no subtitles..." |
| 12 | 强制附加曝光稳定约束 | "Stable exposure... First 0-4 seconds..." |

---

## 七、Veo API 调用参数一览

```json
{
  "project_id": "qy-shoplazza-02",
  "model": "veo-3.1-fast-generate-001",
  "prompt": "{英文 Veo prompt，≤1600字符}",
  "sample_count": 1,
  "duration_seconds": 8,
  "aspect_ratio": "16:9 | 9:16 | 1:1",

  // ── 4 种模式之一 ──
  "veo_mode": "text",       // 纯文字生成

  "veo_mode": "reference",  // 参考图（保持商品一致，不锁定比例）
  "reference_images_base64": [
    { "base64": "...", "mime_type": "image/jpeg" }
  ],

  "veo_mode": "image",      // 首帧图生视频（锁定输出比例为图片原始比例）
  "image_base64": "...",
  "image_mime_type": "image/jpeg",

  "veo_mode": "frame",      // 首帧+尾帧控制
  "image_base64": "...",    // 首帧
  "last_frame_base64": "..." // 尾帧
}
```

---

## 八、关键文件速查表

| 功能 | 函数名 | 文件 | 行号 |
|------|--------|------|------|
| 主生成函数 | `generateVideo()` | frontend/agent/index.js | 4000 |
| 基础提示词构建 | `buildPrompt()` | frontend/agent/index.js | 2507 |
| Auto Draft（图/链接） | `buildAutoPromptDraftFromParsed()` | frontend/agent/index.js | 3184 |
| 运行时 LLM 重写 | `rewritePromptForVeoSingle()` | frontend/agent/index.js | 3130 |
| 备用 Veo 模板 | `buildSingleVeoFallbackPrompt()` | frontend/agent/index.js | 3106 |
| 合规清洗 | `sanitizePromptForVeo()` | frontend/agent/index.js | 3067 |
| 16s 分割 System Prompt | `_buildSplitSystemPrompt()` | frontend/agent/index.js | 718 |
| 16s 链式生成 | `generate16sWithProgress()` | frontend/agent/index.js | 3616 |
| 工作流 LLM 增强 | `hydrateWorkflowTexts()` | frontend/agent/workspace.js | 100 |
| 工作流后端 API | `api_shoplive_video_workflow()` | backend/api/shoplive_api.py | 205 |
| 图片视觉分析 | `analyzeImageInsight()` | frontend/agent/index.js | 2087 |
| 商品链接解析 | `parseShopProductByUrl()` | frontend/agent/index.js | 4657 |
| Veo 提交 | `api_veo_start()` | backend/api/veo_api.py | 313 |
| Veo 16s 链式 | `api_veo_chain()` | backend/api/veo_api.py | 626 |
| Veo 状态查询 | `api_veo_status()` | backend/api/veo_api.py | 1187 |
| 脚本 Fallback 模板 | `build_shoplive_script()` | backend/briefing.py | ~270 |
| Prompt Fallback 模板 | `buildShopliveVideoPromptTemplate()` | backend/briefing.py | 335 |

---

## 九、State 核心字段

```javascript
// 商品信息
state.productName          // 商品名称
state.mainBusiness         // 主营方向（鞋服配饰/美妆护肤/…）
state.sellingPoints        // 卖点列表（分号分隔的字符串）
state.targetUser           // 目标人群
state.salesRegion          // 销售地区
state.template             // 风格（clean/lifestyle/premium/social）
state.brandInfo            // 品牌方向
state.needModel            // 是否需要模特
state.productAnchors       // 锚点约束对象
  // { category, colors, materials, silhouette,
  //   key_details, keep_elements, usage_scenarios, avoid_elements }
state.reviewPositivePoints // 正向评论信号（取前3条）
state.reviewNegativePoints // 负向评论痛点（取前2条）

// 生成控制
state.duration             // 时长（"4"|"6"|"8"|"12"|"16" 秒）
state.aspectRatio          // 画幅（锁定 "16:9"）
state.videoEngine          // 引擎（"veo"|"grok"|"ltx"|"jimeng"）
state.lastPrompt           // 最后一次生成的提示词
state.lastStoryboard       // 最后一次生成的分镜脚本

// 媒体资产
state.images               // 本地上传图片 [{dataUrl, name, source}]
state.productImageUrls     // 解析得到的商品图 URL 列表
state.firstFrame           // 首帧 dataURL（frame 模式）
state.lastFrame            // 尾帧 dataURL（frame 模式）
state.frameMode            // 是否启用首尾帧模式
state.lastVideoUrl         // 最后生成的视频 URL（编辑操作的 source）
```

---

## 十、曝光稳定专项约束

Veo 在 2s 附近频繁出现亮度突变（flash），已在三处强制注入约束：

**后端（每次提交前）** [veo_api.py:43]：
```
First 0-4 seconds: lock exposure and white balance — no flash, no fade-to-white,
no sudden brightening or luminance spike; if lighting changes, ramp smoothly.
```

**前端 sanitize（运行时）** [index.js:3093]：
```
Stable exposure and white balance for the whole clip; smooth gradual transitions
between shots; no sudden brightness spikes, flashes, strobing, or harsh lighting
jumps at any timestamp. First 0-4 seconds: hold luminance steady — no flash,
fade-to-white, or exposure pop.
```

**16s 分割 System Prompt** [index.js:757]：
```
Timestamp beats must evolve GRADUALLY — keep constant exposure/white balance
at boundaries; NO flash, brightness spike, or strobing
```
