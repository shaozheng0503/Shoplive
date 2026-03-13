# Shoplive 技术方案概述

## 技术栈

| 层级 | 选型 |
|------|------|
| 后端框架 | Python 3.9 + Flask |
| LLM 路由 | LiteLLM Proxy → GPT / Gemini Pro |
| 视频生成 | Google Veo 3.1 via Vertex AI |
| 图片生成 | Google Imagen 3.0 |
| 图片 / 视频分析 | Gemini Vision API |
| 云存储 | Google Cloud Storage |
| 视频处理 | FFmpeg（filter_complex） |
| 商品抓取 | Playwright 无头浏览器 + 10+ 平台 Adapter |
| 请求校验 | Pydantic v2 |
| 前端 | 原生 ES Module，7 个职责分离模块 |

---

## 系统架构

### 核心链路

```
商品链接 / 商品图
        ↓
  商品信息抓取 & 图片分析
  （Playwright + Gemini Vision）
        ↓
   Brief 规范化与校验
        ↓
      脚本生成（LLM）
        ↓
   视频 Prompt 构建（LLM）
        ↓
    视频生成（Veo 3.1）
    ↓ 链式拼接 → 16s / 24s
  FFmpeg 合并 + GCS 存储
```

### 后端结构

```
backend/
├── web_app.py          Flask 路由注册、中间件
├── briefing.py         Brief 规范化、字段校验、模板回退
├── audit.py            全链路审计（trace_id + 异步写盘）
├── infra.py            Token 缓存、代理探测
├── schemas.py          Pydantic 请求模型（12 个 Schema）
├── validation.py       请求校验装饰器
├── tool_registry.py    LLM 工具注册表（11 个工具 / 4 个技能）
├── skills.py           技能编排层
├── mcp_adapter.py      MCP JSON-RPC 2.0 适配
├── async_executor.py   共享 ThreadPoolExecutor
├── common/helpers.py   LiteLLM / GCS / FFmpeg 工具函数
└── api/
    ├── agent_api.py        商品抓取、图片分析、LLM 对话、Agent Run
    ├── shoplive_api.py     脚本 / Prompt 生成工作流
    ├── veo_api.py          Veo 视频生成、链式拼接、异步任务
    ├── media_api.py        Imagen 图片生成
    ├── video_edit_api.py   FFmpeg 视频编辑
    └── tabcode_api.py      Grok 视频生成适配
```

### 前端结构（Agent 工作台）

前端采用原生 ES Module 架构，7 个模块职责分离，通过回调注入解耦循环依赖：

```
frontend/scripts/modules/agent/
├── index.js            主控制器
├── state.js            状态管理
├── i18n.js             国际化（中 / 英）
├── agent-run.js        Agent 自主循环（SSE）
├── workspace.js        工作区布局
├── video-editor-ui.js  视频预览与编辑控件
└── video-edit-ops.js   编辑操作（速度 / 字幕 / BGM）
```

---

## 关键设计

### Agent 自主循环

`POST /api/agent/run` 实现最多 10 轮 Tool-Calling 闭环，通过 SSE 实时推流每一步状态：

```
thinking → tool_call → tool_result → delta → done
```

Agent 自动拆解复合指令（如「加速并叠加字幕」），串行调用对应工具后汇总结果，无需前端手动编排。

### 视频链式生成

Veo 单次最长生成 8s，16s / 24s 通过分段续接实现：以上一段末帧作为下一段首帧输入保证画面连贯，最终由 FFmpeg concat 合并。

### 请求校验

统一装饰器 `@validate_request(Schema)` 注入所有接口。校验失败返回包含字段级错误与 `recovery_suggestion` 的结构化 400 响应。

### 可观测性

每个请求自动绑定 `trace_id`，审计记录异步写入 JSONL，不阻塞请求链路。通过 `/api/audit/stats` 和 `/api/audit/trace` 查询统计与完整调用链。

---

## 主要接口

| 接口 | 说明 |
|------|------|
| `POST /api/agent/shop-product-insight` | 解析电商商品链接（10+ 平台） |
| `POST /api/agent/image-insight` | Gemini 分析商品图 |
| `POST /api/agent/chat` | LLM 对话（支持流式） |
| `POST /api/agent/run` | Agent 自主工具调用循环（SSE） |
| `POST /api/shoplive/video/workflow` | 脚本 → Prompt 生成工作流 |
| `POST /api/veo/start` | Veo 单段视频生成 |
| `POST /api/veo/chain` | 链式拼接生成 16s / 24s 视频 |
| `POST /api/veo/status` | 轮询生成状态 |
| `POST /api/video/edit/export` | 视频编辑导出（速度 / 色彩 / 字幕 / BGM） |
| `POST /api/video/timeline/render` | 时间线裁剪拼接 |
| `POST /api/shoplive/image/generate` | Imagen 商品图生成 |
| `GET  /api/health` | 服务健康检查 |
| `GET  /api/openapi.json` | OpenAPI 3.0 规范 |
