# Shoplive

> 面向电商营销的 AI 视频生成与编辑工作台。  
> 从"商品理解"到"成片导出"，一套系统走完整链路。

![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![Flask](https://img.shields.io/badge/Backend-Flask-black)
![Frontend](https://img.shields.io/badge/Frontend-Vanilla%20JS-orange)
![Tests](https://img.shields.io/badge/Tests-195%20passed-brightgreen)
![Status](https://img.shields.io/badge/Status-Active-success)

[English README](./README.en.md) | 简体中文（当前）

Shoplive 是一个面向电商营销场景的 AI 视频生成与编辑工作台。  
用户可以通过商品图、商品链接或文本提示词，快速完成「商品理解 → 提示词生成 → 视频生成 → 在线二次编辑导出」的完整链路。

---

## 目录

- [为什么是 Shoplive](#为什么是-shoplive)
- [核心能力](#核心能力)
- [功能矩阵](#功能矩阵)
- [端到端流程总览](#端到端流程总览)
- [技术架构](#技术架构)
- [项目结构](#项目结构)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [视频生成模式](#视频生成模式)
- [关键接口速览](#关键接口速览)
- [接口调用示例](#接口调用示例)
- [运行测试](#运行测试)
- [演示流程（推荐）](#演示流程推荐)
- [常见问题](#常见问题)
- [部署与安全建议](#部署与安全建议)
- [Roadmap](#roadmap)
- [许可证](#许可证)

---

## 为什么是 Shoplive

- **端到端闭环**：不是单点"文生视频"，而是"解析商品 → 生成 → 编辑 → 导出"的完整生产链路
- **多模型支持**：同时支持 Google Veo（3.1 Fast / 3.1 Preview / 2.0）和 Grok Video，可在界面随时切换
- **LLM 分镜拆分**：多段视频（12s/16s/18s）使用 LLM 自动拆分不同叙事场景，消除拼接重复
- **工程化可观测**：Pydantic 边界校验、审计追踪（trace_id）、健康检查、OpenAPI 自动同步
- **多入口协作**：Landing / Agent / Studio / Image Lab 分工明确，适合演示与真实运营
- **兼顾体验与稳定性**：流式输出、轮询退避、任务并发、拼接失败明确提示、关键步骤 try/finally 解锁
- **对 Agent 友好**：Tool Registry + Skills + MCP 适配，便于 LLM 发现能力并自动编排
- **自然语言视频编辑**：通过 `/api/agent/run` 用文字指令直接编辑视频，LLM 自动规划工具调用链路，SSE 实时推送进度

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 商品信息解析 | 支持图片与商品链接提取商品名、卖点、风格等，自动填入提示词 |
| 主流电商抓取 | requests + Playwright 双引擎，支持 10+ 平台（Amazon、Shein、淘宝、京东等） |
| 智能提示词 | 自动生成/增强 Veo/Grok 可用的电商视频提示词，支持 LLM 增强 |
| AI 参考图生成 | 三字段表单（模特地区/主营品类/风格）+ LLM prompt 工程，生成高质量商品图 |
| 视频生成 | Veo 8s/16s + Grok 6s/12s/18s，LLM 分镜拆分，ffmpeg 智能音频兼容拼接 |
| 二次编辑 | 调色、变速、文字蒙版、BGM 混音后导出 |
| **Agent 对话编辑视频** | 自然语言指令直接编辑视频（调速/调色/文字蒙版/时间线裁剪），SSE 流式进度 |
| Agent Tools 基础设施 | Pydantic 校验、Tool Registry、Skills 技能编排、MCP 协议、全链路审计 |

---

## 功能矩阵

| 模块 | 能力 | 当前状态 |
|------|------|---------|
| Landing | AI 商品图生成（三字段表单）、上传参考图、「生成视频→」直通 Agent | ✅ 可用 |
| Agent | 商品洞察、提示词增强、多模型视频生成、并发任务跟踪、弹窗选图、**自然语言编辑视频** | ✅ 可用 |
| Studio | 时间线编辑、异步渲染、进度/取消、统计与优化建议 | ✅ 可用（MVP+） |
| Image Lab | 商品相关生图与管线衔接 | ✅ 可用 |
| Backend API | Veo / Grok / Shoplive / Agent / Media / Video Edit 全链路接口 | ✅ 可用 |
| Agent Infra | Tool Registry / Skills / MCP / Audit / OpenAPI | ✅ 可用 |

---

## 端到端流程总览

```mermaid
flowchart LR
    A[商品图 / 商品链接 / 文本 / AI生成图] --> B[商品解析与洞察]
    B --> C[LLM 提示词生成/增强]
    C --> D{选择模型}
    D -->|Veo| E[8s/16s 生成]
    D -->|Grok| F[6s/12s/18s LLM分镜拆分+拼接]
    E --> G[状态轮询与任务管理]
    F --> G
    G --> H[Agent 预览与多任务并发]
    H --> I[Studio 时间线二次编辑]
    I --> J[FFmpeg 渲染导出]
```

---

## 技术架构

```mermaid
flowchart LR
    user["User / LLM Agent"] --> landing["Landing / Agent / Studio / Image Lab"]
    landing --> flask["Flask Web App"]

    flask --> agentApi["/api/agent/*"]
    flask --> shopliveApi["/api/shoplive/*"]
    flask --> veoApi["/api/veo/*\n(Veo + Grok + concat + split)"]
    flask --> mediaApi["/api/media\n(Imagen + AI生图)"]
    flask --> editApi["/api/video/edit/*\n(ffmpeg)"]
    flask --> tabcodeApi["/api/tabcode/*\n(Grok Video SSE)"]

    flask --> infraApi["Agent 基础设施层"]
    infraApi --> toolsApi["/api/tools/manifest"]
    infraApi --> skillsApi["/api/skills"]
    infraApi --> mcpApi["/api/mcp/*"]
    infraApi --> auditApi["/api/audit/*"]
    infraApi --> healthApi["/api/health + /api/openapi.json"]

    agentApi --> validate["validation.py (Pydantic)"]
    veoApi --> validate
    validate --> audit["audit.py (全链路审计)"]

    agentApi --> litellm["LiteLLM (分镜拆分 / 提示词增强)"]
    shopliveApi --> litellm
    veoApi --> vertex["Veo on Vertex AI"]
    tabcodeApi --> grok["Grok Video (tabcode.cc)"]
    mediaApi --> imagen["Google Imagen / AI生图"]
    editApi --> ffmpeg["ffmpeg / ffprobe"]
```

---

## 项目结构

```text
shoplive/
├── README.md
├── 更新.md                      # 开发日志
├── conftest.py                  # pytest sys.path 配置
├── requirements.txt
├── backend/
│   ├── run.py                   # 启动入口
│   ├── app_factory.py           # 应用工厂
│   ├── web_app.py               # Flask 主应用 + 路由注册
│   ├── briefing.py              # 业务规则、脚本与提示词编排
│   ├── infra.py                 # 鉴权、代理、公共参数解析
│   ├── schemas.py               # Pydantic 请求验证模型
│   ├── validation.py            # validate_request 装饰器
│   ├── audit.py                 # 全链路审计（AuditLogger）
│   ├── tool_registry.py         # LLM 友好工具注册表
│   ├── skills.py                # 技能编排层
│   ├── mcp_adapter.py           # MCP JSON-RPC 协议适配器
│   ├── async_executor.py        # ThreadPoolExecutor 并行执行
│   ├── common/
│   │   └── helpers.py           # 通用工具（LLM 调用、分镜拆分、ffmpeg 拼接、GCS）
│   ├── api/
│   │   ├── agent_api.py         # 商品洞察、Agent 对话
│   │   ├── shoplive_api.py      # 视频工作流（脚本/提示词）
│   │   ├── veo_api.py           # Veo/Grok 任务提交、状态查询、拼接、分镜生成
│   │   ├── media_api.py         # 生图与组合管线（含 LLM prompt 工程）
│   │   ├── video_edit_api.py    # ffmpeg 导出接口
│   │   └── tabcode_api.py       # Grok Video SSE 流式接口
│   ├── scraper/                 # 电商链接抓取与解析
│   │   ├── fetchers.py          # requests / Playwright 双引擎
│   │   ├── models.py            # FetchArtifact / ParseResult
│   │   └── adapters/            # 平台适配器（10+ 平台）
│   └── tests/
│       ├── test_schemas.py           # Pydantic schema 测试（45 tests）
│       ├── test_audit.py             # 审计日志测试（23 tests）
│       ├── test_validation.py        # 验证装饰器测试（23 tests）
│       ├── test_helpers_timeline.py  # 时间线片段测试（6 tests）
│       ├── test_optimizations.py     # 系统优化测试（19 tests）
│       ├── test_video_edit_api.py    # 视频编辑 API 测试（含异步任务队列）
│       └── test_agent_run.py         # Agent Run 端到端测试（34 tests）
├── video_edits/                 # 导出视频存储目录（运行时自动创建）
└── frontend/
    ├── pages/                   # 多页面入口（index / agent / studio / image-lab）
    ├── scripts/                 # entry / modules / shared
    ├── styles/                  # 各页面样式（含 ref-modal、AI表单、卡片系统）
    └── assets/                  # 静态素材
```

---

## 环境要求

- Python `3.10+`
- `ffmpeg` 和 `ffprobe`（视频拼接/导出必需）
- Playwright Chromium（商品页面 JS 渲染抓取）
- Google Cloud 凭据（Veo / Imagen）
- LiteLLM API Key（提示词增强、分镜拆分、AI 生图 prompt 工程）

---

## 快速开始

### 1. 安装依赖

```bash
cd shoplive
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt
playwright install chromium
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，关键配置项：

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `LITELLM_API_KEY` | ✅ | 文本模型密钥（分镜拆分、提示词增强等） |
| `LITELLM_API_BASE` | 否 | LiteLLM 服务地址 |
| `LITELLM_MODEL` | 否 | 默认文本模型名（如 `bedrock-claude-4-5-haiku`） |
| `GOOGLE_APPLICATION_CREDENTIALS` | 否 | Google 服务账号 JSON 路径 |
| `TABCODE_API_KEY` | 否 | Grok Video 调用密钥（使用 Grok 模型时需要） |
| `TABCODE_API_BASE` | 否 | Grok Video 服务地址 |
| `HOST` | 否 | Flask 监听地址，默认 `127.0.0.1` |
| `PORT` | 否 | Flask 监听端口，默认 `8000` |
| `DEBUG` | 否 | 调试开关，默认开启 |

### 3. 启动服务

```bash
python3 backend/run.py
```

自定义端口：

```bash
PORT=8010 python3 backend/run.py
```

默认地址：`http://127.0.0.1:8000`

> `backend/run.py` 会自动将项目根目录加入 `sys.path`，无需切换到父级目录运行。

### 4. 打开页面

| 页面 | 地址 | 说明 |
|------|------|------|
| Landing | `/` | 入口页，AI 生图、上传参考图、直通 Agent |
| Agent | `/pages/agent.html` | 主工作台，视频生成全流程 |
| Studio | `/pages/studio.html` | 时间线编辑器 |
| Image Lab | `/pages/image-lab.html` | 生图管线 |

---

## 视频生成模式

### Veo 模型（Google Vertex AI）

| 模式 | 接口 | 时长 | 说明 |
|------|------|------|------|
| 单次生成 | `/api/veo/start` | 4–15s | 支持文生视频、图生视频（首帧/尾帧）、参考图风格 |
| 链式延展 | `/api/veo/chain` | 8/16/24s | 自动链式扩展，种子一致性保证 |
| LLM 分镜并行 | `/api/veo/generate-16s` | 16s | LLM 拆分为两段不同叙事 prompt，并行生成后拼接 |
| 状态查询 | `/api/veo/status` | — | 轮询任务状态，含指数退避 |
| 抽帧 | `/api/veo/extract-frame` | — | 提取视频首/尾帧，用于帧衔接 |
| 拼接 | `/api/veo/concat-segments` | — | ffmpeg 智能音频兼容拼接，返回 HTTP URL |

**支持模型**：`veo-3.1-generate-preview` / `veo-3.1-fast-generate-001` / `veo-2.0-generate-001`

### Grok Video（tabcode.cc）

| 时长选项 | 实现方式 |
|---------|---------|
| 6s（单次） | 直接生成 |
| 12s（2段拼接） | LLM 拆分为 2 个不同分镜 prompt，串行生成后拼接 |
| 18s（3段拼接） | LLM 拆分为 3 个不同分镜 prompt，串行生成后拼接 |

### LLM 分镜拆分策略

所有多段视频均使用统一的三步 Chain-of-Thought 提示词拆分：

1. **STEP 1 – 视觉锚点提取**：锁定商品外观、风格、灯光、色调、镜头语言，所有段落必须继承
2. **STEP 2 – 叙事角色分配**：第1段=英雄开场（产品推进），第2段=使用/情感收尾（不同角度）
3. **STEP 3 – 生成各段 prompt**：以视觉锚点开头 + 当前段专属动作，带时间戳镜头指引

LLM 失败时走智能 fallback（结构化场景模板，各段内容不同，绝不重复）。

---

## 关键接口速览

### Veo 生成

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/veo/start` | POST | 提交生成任务（text/image/reference/frame 模式） |
| `/api/veo/status` | POST | 查询任务状态（含指数退避重试） |
| `/api/veo/chain` | POST | 链式扩展生成（8/16/24s），支持 `async_mode=true` 返回 202 + job_id |
| `/api/veo/chain/status` | GET | 查询异步 chain 任务状态 |
| `/api/veo/extend` | POST | 基于已有视频做单次延展 |
| `/api/veo/generate-16s` | POST | LLM 分镜并行生成 16s |
| `/api/veo/generate-12s` | POST | LLM 分镜并行生成 12s（适用 Grok） |
| `/api/veo/concat-segments` | POST | 拼接两段视频（GCS/data URL/HTTP），返回 video_url |
| `/api/veo/extract-frame` | POST | 提取视频帧（first/last/指定秒数） |
| `/api/veo/play` | GET | GCS 视频流式代理播放 |

### Grok Video

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/tabcode/video/generate` | POST | SSE 流式生成，返回进度 + 视频 URL |
| `/api/tabcode/models` | GET | 可用模型列表 |

### Agent & 商品洞察

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/agent/shop-product-insight` | POST | 商品链接解析（10+ 平台） |
| `/api/agent/image-insight` | POST | 商品图识别与卖点提取 |
| `/api/agent/chat` | POST | LLM 对话（支持 `stream=true` SSE） |
| `/api/agent/run` | POST | **Agent 自然语言执行**：LLM 理解指令 → 自动调用工具 → SSE 流式进度（调速/调色/文字/时间线） |

### 生图

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/shoplive/image/generate` | POST | AI 商品图生成（LLM prompt 工程 + Imagen，自动类别校验重试） |
| `/api/google-image/generate` | POST | 直接调用 Google Imagen |

### 工作流

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/shoplive/video/workflow` | POST | 脚本生成 / 提示词构建（validate/generate_script/build_export_prompt） |
| `/api/shoplive/video/prompt` | POST | 单步提示词生成 |

### 视频编辑

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/video/edit/export` | POST | 调色/变速/文字蒙版/BGM 混音导出 |
| `/api/video/timeline/render` | POST | 时间线片段渲染导出（异步） |
| `/api/video/timeline/render/status` | GET | 查询渲染任务状态 |
| `/api/video/timeline/render/cancel` | POST | 取消渲染任务 |
| `/video-edits/<filename>` | GET | 导出视频访问 |

### Agent 基础设施

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/tools/manifest` | GET | LLM 工具清单（支持 `?skill=` / `?tags=` 筛选） |
| `/api/skills` | GET | 技能摘要列表 |
| `/api/skills/<id>` | GET | 完整技能定义 + 操作说明书 |
| `/api/mcp/tools` | GET | MCP 协议工具列表 |
| `/api/mcp/rpc` | POST | MCP JSON-RPC 调用入口 |
| `/api/audit/stats` | GET | 全链路调用统计 |
| `/api/audit/recent` | GET | 最近 N 条审计记录 |
| `/api/health` | GET | 服务健康检查 + 组件状态 |
| `/api/openapi.json` | GET | 自动生成的 OpenAPI 3.0.3 规范 |

---

## 接口调用示例

### 提交 Veo 任务

```bash
curl -sS -X POST "http://127.0.0.1:8000/api/veo/start" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "your-project-id",
    "model": "veo-3.1-fast-generate-001",
    "prompt": "一条连衣裙的电商展示视频，自然光棚拍，镜头从宽景推至细节特写",
    "veo_mode": "text",
    "duration_seconds": 8,
    "aspect_ratio": "16:9"
  }'
```

### 查询状态

```bash
curl -sS -X POST "http://127.0.0.1:8000/api/veo/status" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "your-project-id",
    "model": "veo-3.1-fast-generate-001",
    "operation_name": "<start 接口返回的 operation_name>"
  }'
```

### LLM 分镜并行生成 16s

```bash
curl -sS -X POST "http://127.0.0.1:8000/api/veo/generate-16s" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "your-project-id",
    "prompt": "黑色运动鞋电商广告，极简风格，突出鞋底科技感与材质细节",
    "aspect_ratio": "16:9",
    "storage_uri": "gs://your-bucket/veo-output/"
  }'
```

响应包含 `video_url`（HTTP 直链）和 `video_data_url`（base64，向后兼容）。

### AI 商品图生成

```bash
curl -sS -X POST "http://127.0.0.1:8000/api/shoplive/image/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "product_name": "黑色真皮运动鞋",
    "main_category": "运动鞋",
    "selling_region": "欧美",
    "brand_philosophy": "街头潮流风格",
    "sample_count": 1
  }'
```

### 拼接两段视频

```bash
curl -sS -X POST "http://127.0.0.1:8000/api/veo/concat-segments" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "your-project-id",
    "gcs_uri_a": "gs://your-bucket/seg_a.mp4",
    "gcs_uri_b": "gs://your-bucket/seg_b.mp4"
  }'
```

响应：`{ "ok": true, "video_url": "http://127.0.0.1:8000/video-edits/concat-xxx.mp4", "video_data_url": "data:video/mp4;base64,..." }`

### Agent 自然语言编辑视频

```bash
# 将视频加速 2 倍
curl -sS -X POST "http://127.0.0.1:8000/api/agent/run" \
  -H "Content-Type: application/json" \
  -d '{
    "instruction": "将这个视频加速2倍，并在底部加上文字「限时特卖 8折优惠」",
    "context": {
      "video_url": "http://127.0.0.1:8000/video-edits/my-video.mp4"
    }
  }'
```

响应为 SSE 流：每条 `data:` 含 `{"event": "tool_call"|"tool_result"|"done"|"error", ...}`。
最终 `done` 事件包含 `result.video_url`（可直接播放的导出链接）。

### 服务健康检查

```bash
curl "http://127.0.0.1:8000/api/health"
```

---

## 运行测试

```bash
pip install pytest
python3 -m pytest backend/tests/ -v
```

| 文件 | 测试数 | 覆盖内容 |
|------|--------|---------|
| `test_schemas.py` | 45 | Pydantic schema 枚举、边界、必填校验 |
| `test_audit.py` | 23 | AuditLogger buffer/stats/trace/线程安全 |
| `test_validation.py` | 23 | validate_request 装饰器 13 种错误路径 |
| `test_helpers_timeline.py` | 6 | 时间线片段归一化、边界过滤 |
| `test_optimizations.py` | 19 | LRU 缓存、共享线程池、初始等待跳过、队列 TTL 清理 |
| `test_video_edit_api.py` | — | ffmpeg 导出、异步时间线渲染、任务队列满载驱逐 |
| `test_agent_run.py` | 34 | Agent Run SSE：单轮/多轮 tool-call、超时、JSON 解析错误、未知工具 |

---

## 演示流程（推荐）

1. 打开 Landing（`/`），在 AI 生成面板填写「欧美 / 连衣裙 / 法式优雅」，生成参考图
2. 点击参考图上的「生成视频 →」按钮，自动跳转 Agent 并导入图片
3. Agent 自动识别商品信息、填充提示词
4. 选择模型（Veo 3.1 Fast / Grok Video）和时长，点击「生成视频」
5. 视频生成完毕后，点击「编辑视频」进行调色/文字蒙版处理
6. 导出并获取可访问链接

---

## 常见问题

**Q: 生成成功但无法播放？**  
A: 检查 `/api/veo/status` 返回中的 `signed_video_urls` 与 `inline_videos`；GCS 403 通常是权限不足。

**Q: ffmpeg 拼接失败？**  
A: 确认已安装 `ffmpeg` 和 `ffprobe`（`ffmpeg -version` 验证）。音频不兼容时系统会自动转码，但若 ffprobe 不在 PATH 则退化到保守重编码模式。

**Q: 文字蒙版未生效？**
A: 系统 ffmpeg 可能编译时未包含 `libfreetype`（`drawtext` 需要）。解决方案：
```bash
brew install ffmpeg-full   # 含 drawtext/libfreetype
```
服务启动时会自动检测并优先使用 `ffmpeg-full`（PATH 自动注入），无需额外配置。

**Q: Grok 视频每段都一样？**  
A: 已在前端加入 LLM 分镜拆分（`_splitPromptForGrok`），每段使用不同叙事场景的 prompt。若 LLM 调用失败会走结构化 fallback（3 种场景模板各不相同）。

**Q: 多段视频拼接后有音频跳跃？**  
A: ffmpeg 拼接前会 ffprobe 检测各段音频参数，不一致时自动统一转码为 AAC 44100Hz 立体声。

**Q: 商品链接解析质量低？**  
A: 查看返回的 `fallback_reason`，`anti_bot` 或 `weak_html` 建议更换代理或稍后重试。

**Q: 提交按钮点击后不能再次使用？**  
A: 已修复（`try/finally` 确保 `primarySubmitLocked` 在任意情况下解锁）。若仍遇到，刷新页面即可。

---

## 部署与安全建议

- 请勿将 `.env`、凭据文件、私钥提交到代码仓库
- 生产环境建议将密钥由密钥管理服务注入，不直接落盘
- 建议在 API 网关层增加鉴权与限流，避免接口滥用
- 对外演示时建议使用最小权限服务账号，并定期轮换密钥

---

## Roadmap

- [x] Agent 自然语言编辑视频（`/api/agent/run` SSE）
- [x] Veo chain 异步模式（`async_mode=true` + `/api/veo/chain/status`）
- [x] ffmpeg-full 自动检测与 drawtext 支持
- [x] 时间线任务队列满载驱逐（TTL + 200 条上限）
- [x] GCS signing 失败显式返回 `sign_error`（不再静默丢失）
- [ ] Veo SSE 链式流式状态推送（`/api/veo/chain/stream?job_id=xxx`）
- [ ] Studio 时间线升级为可插拔渲染后端（ffmpeg / cloud render）
- [ ] 任务中心完善（筛选、重试、失败诊断）
- [ ] Docker/Compose 标准化本地与演示部署
- [ ] 多语言提示词优化（英/日/阿拉伯语市场）

---

## 许可证

本仓库当前用于内部开发与演示，默认 **保留所有权利（All Rights Reserved）**。  
未经作者书面许可，不得复制、分发、修改或用于商业用途。

若后续计划开源，建议新增正式 `LICENSE` 文件并在此处声明开源协议（例如 MIT / Apache-2.0）。
