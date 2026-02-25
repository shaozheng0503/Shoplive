# Shoplive

Shoplive 是一个面向电商营销场景的 AI 视频生成与编辑工作台。  
用户可以通过商品图、商品链接或文本提示词，快速完成「商品理解 -> 提示词生成 -> Veo 视频生成 -> 在线二次编辑导出」的完整链路。

## 核心能力

- 商品信息解析：支持图片与商品链接提取商品名、卖点、风格等信息
- 智能提示词：自动生成/增强 Veo 3.1 可用的电商视频提示词
- 视频生成：调用 Veo 接口提交任务并轮询获取可播放结果
- 二次编辑：对已生成视频进行调色、变速、文字蒙版、BGM 混音后导出
- 多工作台模式：Landing / Agent / Studio / Image Lab 覆盖从创意到交付全过程

---

## 技术架构

```mermaid
flowchart LR
    user["User"] --> landing["Landing / Agent / Studio / Image Lab"]
    landing --> flask["Flask Web App"]
    flask --> agentApi["/api/agent/*"]
    flask --> shopliveApi["/api/shoplive/*"]
    flask --> veoApi["/api/veo/*"]
    flask --> mediaApi["/api/media and pipeline"]
    flask --> editApi["/api/video/edit/export"]
    agentApi --> litellm["LiteLLM"]
    shopliveApi --> litellm
    veoApi --> vertex["Veo on Vertex AI"]
    mediaApi --> imagen["Google Image / Imagen"]
    editApi --> ffmpeg["ffmpeg / ffprobe"]
    flask --> staticFiles["Frontend Static Files"]
```

---

## 项目结构

```text
shoplive/
  README.md
  backend/
    run.py                   # 启动入口
    app_factory.py           # 应用工厂
    web_app.py               # Flask 主应用 + 路由注册 + 静态托管
    briefing.py              # 业务规则、脚本与提示词编排
    infra.py                 # 鉴权、代理、公共参数解析
    common/helpers.py        # 通用工具（解析、模型调用、媒体处理）
    api/
      agent_api.py           # 商品洞察、Agent 对话
      shoplive_api.py        # 视频工作流（校验/脚本/提示词）
      veo_api.py             # Veo 任务提交与状态查询
      media_api.py           # 生图与组合管线接口
      video_edit_api.py      # ffmpeg 导出接口
  frontend/
    pages/                   # 多页面入口
    scripts/                 # entry/modules/shared
    styles/                  # 各页面样式
    assets/                  # 静态素材
```

---

## 环境要求

- Python `3.10+`
- `ffmpeg` 和 `ffprobe`（视频导出必需）
- 可用的 Google Cloud 凭据（Veo / Image）
- LiteLLM API Key（用于提示词相关能力）

建议在仓库根目录（`shoplive` 上一级）执行。

## 快速开始

### 1. 创建虚拟环境并安装依赖

```bash
cd "/Users/huangshaozheng/Desktop/ai创新挑战赛"
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install flask requests google-cloud-storage google-auth
```

### 2. 配置环境变量

```bash
cp shoplive/.env.example shoplive/.env
```

至少确认：

- `LITELLM_API_KEY` 已配置
- Google 凭据文件可访问（默认读取 `shoplive/credentials/...json`，也可通过 `GOOGLE_APPLICATION_CREDENTIALS` 覆盖）

### 3. 启动服务

```bash
python3 -m shoplive.backend.run
```

自定义端口：

```bash
PORT=8010 python3 -m shoplive.backend.run
```

默认地址：`http://127.0.0.1:8000`

### 4. 打开页面

- Landing：`/`
- Agent：`/pages/agent.html`
- Studio：`/pages/studio.html`
- Image Lab：`/pages/image-lab.html`

---

## 关键接口速览

### Agent & 商品洞察

- `POST /api/agent/shop-product-insight`
- `POST /api/agent/image-insight`
- `POST /api/agent/chat`

### Shoplive 工作流

- `POST /api/shoplive/video/workflow`（`validate / generate_script / build_export_prompt`）
- `POST /api/shoplive/video/prompt`

### Veo 生成

- `POST /api/veo/start`
- `POST /api/veo/status`

### 生图与管线

- `POST /api/google-image/generate`
- `POST /api/shoplive/image/generate`
- `POST /api/pipeline/banana-to-veo`
- `POST /api/pipeline/google-image-to-veo`

### 视频编辑导出

- `POST /api/video/edit/export`
- 导出访问：`GET /video-edits/<filename>`

---

## 演示流程（推荐）

1. 在 Landing 输入商品诉求或上传参考图进入 Agent
2. 在 Agent 自动补齐商品信息并生成视频
3. 调用 Veo 轮询完成后，在对话区预览成片
4. 打开视频编辑面板进行调色/BGM/蒙版编辑
5. 导出并获取可访问链接用于演示

---

## 常见问题

- **生成成功但无可播放链接**：检查 `veo/status` 返回中的 `signed_video_urls` 与 `inline_videos`
- **导出失败**：优先确认本机是否安装 `ffmpeg` / `ffprobe`
- **文字蒙版未生效**：当前 ffmpeg 可能不含 `drawtext` 过滤器，系统会自动降级但仍可导出其它编辑项
- **模型调用超时**：检查代理与凭据设置，或降低任务复杂度重试

---

## 许可证

本项目用于内部开发与演示，若需开源发布请补充正式 LICENSE 文件。

