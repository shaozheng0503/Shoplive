# Shoplive 系统架构与提示词文档

> 本文档覆盖完整链路架构、所有 LLM 提示词（系统提示 + 用户提示）、所有 Fallback 模板，以及基础设施优化摘要。

---

## 目录

1. [系统概览](#1-系统概览)
2. [完整请求链路](#2-完整请求链路)
3. [模块架构](#3-模块架构)
4. [API 端点清单](#4-api-端点清单)
5. [脚本生成提示词](#5-脚本生成提示词)
6. [视频提示词生成提示词](#6-视频提示词生成提示词)
7. [Agent 增强模板](#7-agent-增强模板)
8. [Fallback 模板](#8-fallback-模板)
9. [输入校验与 Brief 规范化](#9-输入校验与-brief-规范化)
10. [基础设施优化摘要](#10-基础设施优化摘要)
11. [测试覆盖](#11-测试覆盖)

---

## 1. 系统概览

Shoplive 是一个 AI 驱动的电商短视频生成平台，核心链路：

```
商品链接 / 商品图
    ↓
商品信息抓取 & 图片分析 (Playwright + Gemini)
    ↓
Brief 规范化 & 校验
    ↓
脚本生成 (LiteLLM → LLM)
    ↓
视频提示词生成 (LiteLLM → LLM)
    ↓
视频生成 (Google Veo 3.1)
    ↓  链式延展 → 16s / 24s
最终视频导出 (FFmpeg 合并 + GCS 存储)
```

技术栈：
- **后端**: Python 3.9 + Flask（同步模型，ThreadPoolExecutor 并行）
- **LLM**: LiteLLM 代理 → azure-gpt-5 / gemini-pro
- **视频生成**: Google Veo 3.1 (`veo-3.1-generate-preview`)，Vertex AI
- **图片生成**: Google Imagen (`imagen-3.0-generate-001`)
- **存储**: Google Cloud Storage (GCS)
- **浏览器自动化**: Playwright（JS 渲染页面抓取）
- **审计**: 全链路 trace_id + 异步 JSONL 审计日志

---

## 2. 完整请求链路

### 2.1 视频工作流（主链路）

```
POST /api/shoplive/video/workflow
{
  "action": "validate" | "generate_script" | "pre_export_check" | "build_export_prompt",
  "input": { ...brief... },
  "api_key": "...",
  "model": "azure-gpt-5"
}
```

**Step 1 — validate**
```
前端 → POST workflow {action: "validate"}
         ↓
     normalize_shoplive_brief()   # 规范化 brief（时长、画幅、卖点去重）
         ↓
     validate_shoplive_brief()    # 校验图片数量、分辨率、锐度、卖点完整性
         ↓
     返回 {ok, validation, normalized_input, input_diff}
```

**Step 2 — generate_script**
```
前端 → POST workflow {action: "generate_script", user_message: "..."}
         ↓
     检查 LLM response cache (TTL=5min, key=sha256(brief)+api_base+model)
         ↓ cache miss
     _build_shoplive_script_via_llm()
         ↓
     LiteLLM → azure-gpt-5 (temperature=0.6, max_tokens=900)
         ↓ 失败时
     build_shoplive_script()   # Fallback 模板
         ↓
     selfcheck_script()        # 校验镜头1/2/3、BGM、标题、文案字段
         ↓
     返回 {script, script_source: "llm"|"llm_cached"|"template", selfcheck}
```

**Step 3 — pre_export_check**
```
前端 → POST workflow {action: "pre_export_check", script_text: "..."}
         ↓
     selfcheck_script()    # 再次校验脚本完整性
         ↓
     返回 {ready, validation, selfcheck}
```

**Step 4 — build_export_prompt**
```
前端 → POST workflow {action: "build_export_prompt", script_text: "..."}
         ↓
     检查 LLM response cache
         ↓ cache miss
     _build_shoplive_video_prompt_via_llm()
         ↓
     LiteLLM → azure-gpt-5 (temperature=0.5, max_tokens=900)
         ↓ 失败时
     build_shoplive_video_prompt_template()   # Fallback 模板
         ↓
     返回 {prompt, prompt_source: "llm"|"llm_cached"|"template_fallback"}
```

### 2.2 Veo 视频生成链路

```
POST /api/veo/start
    ↓
_call_predict_long_running()        # Vertex AI thread-local Session
    ↓
返回 operation_name

POST /api/veo/status
    ↓
_call_fetch_predict_operation()     # 轮询，initial_wait=20s，每6s一次
    ↓
返回 {done, video_url: "gs://..."}

POST /api/veo/chain  (16s / 24s)
    ↓ async_mode=true → HTTP 202 + job_id
    ↓ sync → 串行执行
Job 1: Veo 生成 8s 片段A
Job 2: 以 A 末帧为参考，Veo 生成 8s 片段B
    ↓
concat_videos_ffmpeg()              # FFmpeg filter_complex concat
sign_gcs_url()                      # 生成 4h 有效期签名 URL
    ↓
返回 {video_url, signed_url, duration_seconds: 16}

GET /api/veo/chain/status?job_id=xxx
    ↓
返回 {status, progress, message, result, error}
```

### 2.3 商品洞察链路

```
POST /api/agent/shop-product-insight
    { "url": "https://..." }
    ↓
Playwright 无头浏览器（_PlaywrightPool）
    ↓
提取页面 HTML → Gemini Vision / LiteLLM 解析
    ↓
返回 {product_name, selling_points, images, ...}
```

### 2.4 图片分析链路

```
POST /api/agent/image-insight
    { "images": ["base64..."] }
    ↓
Vertex AI Gemini Pro Vision
    ↓
返回 {category, quality_reports, description}
```

---

## 3. 模块架构

```
shoplive/
├── backend/
│   ├── web_app.py              # Flask 应用入口、路由注册、SHOPLIVE_VIDEO_SYSTEM_PROMPT
│   ├── briefing.py             # Brief 规范化、校验、所有 Fallback 模板
│   ├── audit.py                # 全链路审计（trace_id, ring buffer, async JSONL writer）
│   ├── infra.py                # Token 缓存、代理检测、Vertex AI 凭证
│   ├── schemas.py              # Pydantic v2 请求 Schema
│   ├── validation.py           # @validate_request 装饰器
│   ├── tool_registry.py        # LLM 友好工具注册表
│   ├── skills.py               # 技能编排层
│   ├── mcp_adapter.py          # MCP JSON-RPC 2.0 协议适配
│   ├── async_executor.py       # 共享 ThreadPoolExecutor + TTLCache
│   ├── common/
│   │   └── helpers.py          # LiteLLM 调用、GCS 签名、FFmpeg、图片工具
│   └── api/
│       ├── shoplive_api.py     # /api/shoplive/* 路由（脚本/视频提示词工作流）
│       ├── agent_api.py        # /api/agent/* 路由（商品洞察、图片分析、对话）
│       ├── veo_api.py          # /api/veo/* 路由（Veo 视频生成）
│       ├── media_api.py        # /api/media/* 路由（图片生成）
│       └── video_edit_api.py   # /api/video-edit/* 路由（FFmpeg 剪辑）
```

---

## 4. API 端点清单

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/shoplive/video/workflow` | POST | 视频工作流（4个 action） |
| `/api/shoplive/video/prompt` | POST | 直接生成视频提示词 |
| `/api/shoplive/image/generate` | POST | 商品图生成（Imagen） |
| `/api/agent/shop-product-insight` | POST | 商品链接解析 |
| `/api/agent/image-insight` | POST | 商品图片分析 |
| `/api/agent/chat` | POST | LLM 对话 |
| `/api/veo/start` | POST | 启动 Veo 视频生成 |
| `/api/veo/status` | POST | 查询生成状态 |
| `/api/veo/chain` | POST | 16s/24s 链式生成 |
| `/api/veo/chain/status` | GET | 异步链式任务状态 |
| `/api/veo/extend` | POST | 视频延展 |
| `/api/tools/manifest` | GET | 工具清单（Agent 发现） |
| `/api/skills` | GET | 技能列表 |
| `/api/skills/<id>` | GET | 技能详情 |
| `/api/mcp/tools` | GET | MCP 工具列表 |
| `/api/mcp/rpc` | POST | MCP JSON-RPC 2.0 |
| `/api/audit/stats` | GET | 审计统计 |
| `/api/audit/recent` | GET | 最近审计记录 |
| `/api/audit/trace` | GET | 按 trace_id 查询 |
| `/api/health` | GET | 健康检查 |
| `/api/openapi.json` | GET | OpenAPI 3.0 规范（缓存） |

---

## 5. 脚本生成提示词

### 5.1 System Prompt（固定）

```
你是电商视频脚本专家。
严格遵循最新规则：只聚焦1-2个核心卖点，必须从4.1~4.6中选择1个主框架+1个辅助框架，
镜头可执行、节奏清晰、真实合规。
只输出脚本正文，不要解释。
```

**LLM 参数**: `temperature=0.6`, `max_tokens=900`

---

### 5.2 User Prompt 模板（`build_shoplive_script_prompt`）

```
你是电商短视频脚本导演。请按"最新规则"输出可直接执行的脚本，不要解释。
必须遵循：优先聚焦1-2个核心卖点；框架4.1~4.6中选择1个主框架+1个辅助框架；镜头连贯、可拍摄、可剪辑。
商品：{product_name}
卖点：{selling_points}（分号分隔，最多6个）
目标用户：{target_user}
销售地区：{sales_region}
模板风格：{template}
单段时长：{duration}秒（4/6/8之一）
目标总时长：{total_duration}秒（可选16/24，按8秒链式延展）
画幅：{aspect_ratio}
模特策略：需要模特展示 | 不需要模特展示
用户补充：{user_message}（无则填"无"）
输出格式必须包含以下字段并按顺序输出：
主框架：...
辅助框架：...
镜头1（含时段）：...
镜头2（含时段）：...
镜头3（含时段）：...
Bgm：...
标题：...
文案：...
合规检查：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。
```

**填充示例**（8s 运动鞋）：
```
商品：Nike Air Max 2024
卖点：超轻缓震；透气网面；街头配色
目标用户：18-30岁城市年轻人
销售地区：中国大陆
模板风格：clean
单段时长：8秒
目标总时长：8秒
画幅：16:9
模特策略：需要模特展示
用户补充：无
```

---

### 5.3 脚本自检规则（`selfcheck_script`）

生成的脚本必须包含以下字段，否则 `ready=false`：

| 检查项 | 匹配规则 |
|--------|----------|
| 三个镜头 | 包含 `镜头1`、`镜头2`、`镜头3`（或 `shot 1/2/3`） |
| BGM | 包含 `bgm`（大小写不敏感） |
| 标题 | 包含 `标题` 或 `title` |
| 文案 | 包含 `文案`、`copy` 或 `caption` |

---

## 6. 视频提示词生成提示词

### 6.1 System Prompt（`SHOPLIVE_VIDEO_SYSTEM_PROMPT`）

```
你是一位电商视频提示词总导演。你的任务是根据用户输入（商品信息、卖点、场景、目标人群、时长、画幅、可能的商品图）输出一条可直接用于视频生成的最终提示词。

你必须遵守以下硬性要求：
1) 只聚焦1-2个核心卖点，单段时长在4/6/8秒内可执行；若目标总时长为16/24秒，按8秒片段链式延展。
2) 强制采用"1个主框架 + 1个辅助框架"，从4.1~4.6中选择，不可全部堆叠。
3) 优先商品一致性与真实感：有商品图时严格一致；无商品图时按品类合理想象，不畸形。
4) 禁止夸大、绝对化、虚构认证数据；禁止他牌标识、水印、乱码、畸形手和结构错误。
5) 最终输出只能是一条提示词正文，不要解释、不要列表、不要Markdown标题。
6) 必须包含合规后缀：
   高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。

你必须按以下模板字段组织最终提示词语义（可自然串联，不必逐行标签化）：
- Style
- Environment
- Tone & Pacing
- Camera / Cinematography
- Lighting (或 Lighting & Color)
- Actions / Scenes（分段动作链）
- Background Sound
- Transition / Editing
- Call to Action

4. 视频prompt框架（严格执行）

4.1 产品口播
- [Style]: 轻微手持抖动模拟第一人称，干净简约，信任感。
- [Environment]: 包含关键背景元素与光线特征，氛围符合生活方式。
- [Tone & Pacing]: 语气自然，节奏可快可慢但须匹配使用场景情绪。
- [Camera]: 随动作自然移动，景深可控，主体突出且保留环境信息。
- [Lighting]: 光线作用于产品表面，强化高光、质感和阴影层次。
- [Actions/Scenes]: 主体动作 -> 产品特写 -> 使用演示 -> 情绪体验 -> 收尾整理。
- [Background Sound]: 背景音乐 + 环境音。
- [Transition/Editing]: 匹配剪辑、平滑切换或跳切，节奏连贯。
- [Call to Action]: 人物动作+收尾强调。

4.2 UGC评测
- 真实UGC手持或POV，快节奏，生活感与代入感强。
- 结构：主体出场 -> 产品展示/特写 -> 使用演示 -> 前后对比(可选) -> 总结推荐。
- 光线以自然光/柔和室内光为主，保持干净明亮与真实肤色/材质。

4.3 痛点与解决
- Shot1 正确示范/解决方案全景
- Shot2 痛点/错误示范
- Shot3 解决方案细节特写
- Shot4 产品性能/功能特写
- Shot5 推荐/收尾镜头
- 以清晰对比推动转化，动作与台词围绕"问题->解决->证据->推荐"。

4.4 产品演示
- 极简电影感写实，强调流程可视化与日常仪式感。
- 结构：产品引入 -> 使用动作展示 -> 特写卖点 -> 体验/情绪展示 -> 收尾CTA。
- 镜头以中景+俯拍/特写平滑切换，光线自然柔和，材质细节清晰。

4.5 前后对比
- 现代都市达人带货风格，高饱和商业滤镜，真实亲测感。
- 结构：展示 -> 痛点/对比 -> 使用质感 -> 效果展示 -> 收尾CTA。
- 镜头中景与特写交替，轻微手持律动，关键对比点可停留1-2秒。

4.6 故事讲述
- 使用 [Style] [Scene] [Cinematography] [Lighting & Color] [Mood & Tone] 模块化构建。
- 强调镜头连贯、人物情绪弧线、产品价值与场景关系，表达真诚可信。

输出前自检：
- 是否已明确主框架+辅助框架且可执行？
- 是否只聚焦1-2个核心卖点？
- 是否已体现时长与画幅约束？
- 是否包含声音、转场与CTA？
- 是否附带必须合规后缀？

最终说明：
确保每次输出都具备商业广告质感、真实可拍可剪、合规可信。单段按4/6/8秒形成有节奏的微故事；16/24秒场景按8秒片段衔接并保持一致性。允许在合规前提下进行跨界创意与节奏创新。
```

**LLM 参数**: `temperature=0.5`, `max_tokens=900`

---

### 6.2 User Prompt 结构（`_build_shoplive_video_prompt_via_llm`）

用户消息由固定指令 + JSON payload 拼接：

**固定指令前缀**：
```
请根据以下结构化输入生成最终视频提示词。
必须严格遵守输入中的时长与画幅，并充分利用 input_storyboard。
必须遵循最新规则：聚焦1-2个核心卖点；从4.1~4.6中选1个主框架+1个辅助框架；
输出应包含可执行镜头、光影、场景、情绪锚点与合规后缀。
只输出最终可直接用于视频生成的一段提示词，不要解释。
```

**JSON payload 结构**：
```json
{
  "product_name": "商品名称",
  "main_category": "商品品类",
  "core_selling_points": ["卖点1", "卖点2"],
  "core_selling_points_text": "卖点1；卖点2",
  "primary_scene": "clean",
  "fallback_scene": "studio still-life background",
  "selling_region": "目标销售地区",
  "target_audience": "目标用户群体",
  "brand_philosophy": "Shoplive conversion-first ecommerce storytelling",
  "duration_seconds": 8,
  "aspect_ratio": "16:9",
  "need_model_showcase": true,
  "input_storyboard": "（脚本全文，最多600字）",
  "constraints": {
    "duration_seconds_must_be": 8,
    "aspect_ratio_must_be": "16:9",
    "output_language": "zh",
    "output_format": "only final usable video prompt text, no explanation"
  }
}
```

---

## 7. Agent 增强模板

### 7.1 `build_shoplive_agent_enhance_template`

此模板用于 `build_enhance_template` action，将用户原始提示词改写为最终可用视频提示词。

**System 角色说明**（内嵌在模板正文中，直接作为 User 消息发送给 Agent）：

```
你是一位电商视频提示词优化专家。请把用户原始提示词改写为一条可直接用于视频生成的最终提示词。
你必须严格遵循如下视频 prompt 框架，并按框架字段组织语义：
4.1 产品口播：
- [Style] [Environment] [Tone & Pacing] [Camera] [Lighting]
- [Actions/Scenes]：主体动作 -> 产品特写 -> 使用演示 -> 情绪展示 -> 收尾
- [Background Sound] [Transition/Editing] [Call to Action]
4.2 UGC评测：
- 真实手持/POV、快节奏、生活化高代入
- 结构：主体出场 -> 产品特写 -> 使用演示 -> 前后对比(可选) -> 总结推荐
4.3 痛点与解决：
- Shot1 正确示范 -> Shot2 痛点示范 -> Shot3 解决细节 -> Shot4 性能特写 -> Shot5 推荐收尾
4.4 产品演示：
- 极简电影感写实，强调流程可视化与日常仪式感
- 结构：产品引入 -> 使用动作 -> 特写卖点 -> 体验展示 -> 收尾CTA
4.5 前后对比：
- 现代达人带货风格，高饱和商业滤镜，真实亲测感
- 结构：展示 -> 痛点/对比 -> 使用质感 -> 效果展示 -> 收尾CTA
4.6 故事讲述：
- [Style] [Scene] [Cinematography] [Lighting & Color] [Mood & Tone]
- 叙事强调镜头连贯、情绪弧线、产品价值与场景关系
根据商品与卖点自动选择最合适的1种主框架 + 1种辅助框架，不要同时铺满所有框架。

约束：单段时长={duration}秒，目标总时长={total_duration}秒，画幅={aspect_ratio}，
       商品={product_name}，目标人群={target_user}，地区={sales_region}，风格模板={template}。
核心卖点：{selling_points}。
参考分镜：{script_text}（前500字，如有）
用户原始提示词：{raw_prompt}（如无则填"无"）

输出要求：
- 只输出最终一条提示词正文，不要解释。
- 优先保证商品一致性、真实感、镜头可执行性。
- 最终提示词中要显式覆盖：Style/Environment/Tone & Pacing/Camera/Lighting/Actions/Background Sound/Transition/CTA。
- 单段时长是4/6/8秒；若总时长是16/24秒，按8秒片段链式延展。卖点只聚焦1-2个，节奏要可拍可剪。
- 必须包含合规后缀：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。
```

---

## 8. Fallback 模板

当 LLM 调用失败或无 api_key 时，自动降级到以下模板。

### 8.1 脚本 Fallback（`build_shoplive_script`）

**输出示例**（商品：Nike Air Max，卖点：超轻缓震；透气网面，时长：8s，目标用户：城市年轻人，地区：中国大陆）：

```
主框架：4.4 产品演示；辅助框架：4.6 故事讲述
镜头1（0-2s）：16:9构图，Nike Air Max开场特写，突出超轻缓震，电影级影棚布光，镜头推近。
镜头2（2-5s）：需要模特展示，在中国大陆偏好场景面向城市年轻人进行使用演示，展示透气网面，镜头跟拍并加入情绪锚点。
镜头3（5-8s）：收束为转化镜头，保留商品关键细节与购买动机，节奏干净利落。
BGM：轻快且有节奏感的电商氛围音乐，避免喧宾夺主。
标题：Nike Air Max｜8s 高转化短视频（clean）
文案：围绕"超轻缓震；透气网面"做真实可执行表达，不夸大、不绝对化。
合规检查：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。
```

**模板规则**：
- 固定使用"4.4 产品演示 + 4.6 故事讲述"框架组合
- 三个镜头时段分别为：0-2s（开场特写）、2-5s（使用演示）、5-{duration}s（收尾转化）
- 16/24s 场景额外追加"链路时长"说明行
- 文案取所有卖点用"；"连接

---

### 8.2 视频提示词 Fallback（`build_shoplive_video_prompt_template`）

**模板结构**：
```
{aspect_ratio} 超高清商业画质，电影级影棚布光。
商品：{product_name}。主卖点仅聚焦1-2个：{selling_points}。
目标人群：{target_user}；销售地区：{sales_region}；风格模板：{template}；模特策略：{need_model}；单段时长：{duration}秒。
[若 total_duration 为 16/24] 目标总时长：{total_duration}秒（通过8秒分段延展）。
镜头组织遵循动态节奏，优先使用 1 个主框架 + 1 个辅助框架（4.1~4.6），
把卖点转化为可执行镜头动作、光影、环境与情绪锚点，不写空话。
[若有脚本] 参考分镜脚本：{script_hint}（最多600字）。
合规后缀：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。
```

---

## 9. 输入校验与 Brief 规范化

### 9.1 规范化规则（`normalize_shoplive_brief`）

| 字段 | 规范化逻辑 |
|------|-----------|
| `selling_points` | 按 `[，,、;；\n]` 分割，去除空字符串，`dict.fromkeys` O(n) 去重，取前6个 |
| `duration` | 只允许 `{4, 6, 8}`，非法值 → 默认 8 |
| `total_duration` | 只允许 `{4, 6, 8, 16, 24}`，非法值 → 默认 8 |
| `aspect_ratio` | 当前只支持 `16:9`，非 16:9 值→自动覆盖并写入 `aspect_ratio_warning` |
| `template` | 空值默认 `clean` |
| `need_model` | bool，默认 `true` |

### 9.2 校验规则（`validate_shoplive_brief`）

| 错误码 | 触发条件 |
|--------|---------|
| `NO_IMAGES` | `image_count <= 0` |
| `TOO_MANY_IMAGES` | `image_count > 3` |
| `LOW_RESOLUTION` | 非生成图且宽或高 < 1024px |
| `LOW_SHARPNESS` | `sharpness < 100` |
| `LOW_SUBJECT` | `subjectRatio < 0.4` |
| `NEED_SELLING_POINTS` | 卖点列表为空 |
| `TOO_MANY_POINTS` | 卖点数量 > 6 |
| `NEED_TARGET_USER` | `target_user` 为空 |
| `NEED_REGION` | `sales_region` 为空 |

---

## 10. 基础设施优化摘要

### 10.1 性能优化

| 优化项 | 位置 | 效果 |
|--------|------|------|
| GCS Client `@lru_cache` | `helpers.py` | 避免每次 `sign_gcs_url` 重建 Storage Client |
| Vertex AI thread-local Session | `veo_api.py` | TLS 连接复用，节省 ~100ms/请求 |
| 共享 ThreadPoolExecutor | `async_executor.py` | 消除每次请求创建/销毁线程池的开销 |
| LiteLLM 代码去重 | `helpers.py` | 提取 `_build_litellm_body` + `_is_retryable_litellm_status`，消除 ~80 行重复代码 |
| LLM 响应缓存 TTL 5min | `shoplive_api.py` | 相同 brief + model + api_base 直接返回缓存，跳过 LLM 调用 |
| OpenAPI spec 缓存 | `web_app.py` | 首次构建后缓存，后续 O(1) 返回 |
| `_poll_video_ready` initial_wait | `veo_api.py` | 前20s 跳过无效轮询（Veo 最快30s完成） |

### 10.2 可靠性优化

| 优化项 | 位置 | 效果 |
|--------|------|------|
| 异步审计日志写入 | `audit.py` | 队列 + daemon 线程，消除每次 record() 的磁盘 I/O 阻塞 |
| Chain job TTL 淘汰 | `veo_api.py` | 完成/失败 job 1小时后自动淘汰，硬上限100条，防内存泄漏 |
| LLM 缓存 key 含 api_base hash | `shoplive_api.py` | 防不同 LiteLLM 实例之间的缓存污染 |
| 卖点 O(n) 去重 | `briefing.py` | `dict.fromkeys()` 替代 O(n²) 循环 |
| Pydantic 请求校验装饰器 | `validation.py` | 统一 400 响应格式，含字段级 validation_errors |
| aspect_ratio 静默覆盖追踪 | `briefing.py` | `aspect_ratio_warning` 字段告知调用方被覆盖 |

### 10.3 审计链路

每个请求自动携带：
- `trace_id`：从 `X-Trace-Id` header 获取，或自动生成 16位 hex
- `call_chain`：记录本次请求中所有工具调用序列
- 响应 header：`X-Trace-Id`, `X-Call-Chain-Length`
- 持久化：`SHOPLIVE_AUDIT_DIR` 环境变量指定目录，异步写入 `audit.jsonl`

---

## 11. 测试覆盖

运行方式：
```bash
cd ai创新挑战赛/
python3 -m pytest shoplive/backend/tests/ -v
```

| 测试文件 | 测试数 | 覆盖范围 |
|----------|--------|---------|
| `test_schemas.py` | 39 | 所有 10 个 Pydantic Schema 的字段校验 |
| `test_audit.py` | 23 | AuditRecord、AuditLogger、trace context、线程安全 |
| `test_validation.py` | 23 | `@validate_request` 装饰器，13 种错误场景 |
| `test_optimizations.py` | 19 | GCS cache、LLM cache、chain job 淘汰、shared executor |
| **合计** | **104** | |

---

*文档生成自源代码，路径：`backend/briefing.py`、`backend/web_app.py`、`backend/api/shoplive_api.py`*
