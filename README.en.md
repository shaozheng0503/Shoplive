# Shoplive

> AI video generation and editing workspace for ecommerce marketing.  
> One pipeline from product understanding to export-ready videos.

![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![Flask](https://img.shields.io/badge/Backend-Flask-black)
![Frontend](https://img.shields.io/badge/Frontend-Vanilla%20JS-orange)
![Tests](https://img.shields.io/badge/Tests-97%20passed-brightgreen)
![Status](https://img.shields.io/badge/Status-Active-success)

English (current) | [简体中文 README](./README.md)

---

## Table of Contents

- [Why Shoplive](#why-shoplive)
- [Core Capabilities](#core-capabilities)
- [Feature Matrix](#feature-matrix)
- [UI Preview](#ui-preview)
- [End-to-End Flow](#end-to-end-flow)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [API Quick Reference](#api-quick-reference)
- [Run Tests](#run-tests)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Why Shoplive

- **End-to-end workflow**: product parsing -> prompt generation -> Veo generation -> timeline editing -> export
- **Production-minded**: boundary validation with Pydantic, audit traceability, health checks, OpenAPI sync
- **Multi-workbench design**: Landing / Agent / Studio / Image Lab for creation-to-delivery collaboration
- **UX + reliability**: streaming responses, backoff polling, concurrent jobs, timeout continuation, graceful fallbacks
- **Agent-native infra**: Tool Registry + Skills + MCP adapter for LLM discoverability and orchestration

## Core Capabilities

- Product insight extraction from images and ecommerce links
- Dual crawler engines (`requests` + Playwright) with platform adapters
- Prompt generation and enhancement for Veo 3.1
- 8s/16s generation, polling, inline playback, and segment concat
- Post-editing (speed, color, text mask, BGM mix) and export
- Agent infrastructure: validation middleware, tools manifest, skills, audit chain, OpenAPI

## Feature Matrix

| Module | What it does | Status |
| --- | --- | --- |
| Landing | Fast requirement input and handoff to Agent | ✅ Ready |
| Agent | Insight, prompt enhancement, 8s/16s generation, concurrent tasks | ✅ Ready |
| Studio | Timeline editing, async render, progress/cancel, optimization advice | ✅ Ready (MVP+) |
| Image Lab | Product-related image generation and pipelines | ✅ Ready |
| Backend API | Agent / Shoplive / Veo / Media / Edit APIs | ✅ Ready |
| Agent Infra | Tools / Skills / MCP / Audit / OpenAPI | ✅ Ready |

## UI Preview

Place screenshots under `docs/images/` and keep these names:

- `docs/images/landing.png`
- `docs/images/agent.png`
- `docs/images/studio.png`
- `docs/images/image-lab.png`

## End-to-End Flow

```mermaid
flowchart LR
    A[Input: product image / url / prompt] --> B[Product parsing and insight]
    B --> C[Prompt generation or enhancement]
    C --> D[Veo generation: 8s/16s]
    D --> E[Polling and task management]
    E --> F[Agent preview and concurrent jobs]
    F --> G[Studio timeline post-editing]
    G --> H[FFmpeg render and export]
```

## Architecture

```mermaid
flowchart LR
    user["User / LLM Agent"] --> frontend["Landing / Agent / Studio / Image Lab"]
    frontend --> flask["Flask Web App"]
    flask --> agentApi["/api/agent/*"]
    flask --> shopliveApi["/api/shoplive/*"]
    flask --> veoApi["/api/veo/*"]
    flask --> mediaApi["/api/media and pipeline"]
    flask --> editApi["/api/video/edit/export"]
    flask --> infraApi["Tools / Skills / MCP / Audit / Health / OpenAPI"]
```

## Project Structure

```text
shoplive/
  README.md
  README.en.md
  backend/
    run.py
    web_app.py
    schemas.py
    validation.py
    audit.py
    tool_registry.py
    skills.py
    mcp_adapter.py
    common/helpers.py
    api/
    tests/
  frontend/
    pages/
    scripts/
    styles/
    assets/
```

## Requirements

- Python `3.10+`
- `ffmpeg` and `ffprobe`
- Playwright Chromium
- Google Cloud credentials (for Veo/Image)
- LiteLLM API key

## Quick Start

```bash
cd shoplive
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt
playwright install chromium
cp .env.example .env
python3 -m shoplive.backend.run
```

Default URL: `http://127.0.0.1:8000`

## API Quick Reference

- Agent:
  - `POST /api/agent/shop-product-insight`
  - `POST /api/agent/image-insight`
  - `POST /api/agent/chat` (`stream=true` supported)
- Veo:
  - `POST /api/veo/start`
  - `POST /api/veo/status`
  - `POST /api/veo/extract-frame`
  - `POST /api/veo/concat-segments`
- Edit:
  - `POST /api/video/edit/export`
  - `POST /api/video/timeline/render`
- Infra:
  - `GET /api/tools/manifest`
  - `GET /api/skills`
  - `POST /api/mcp/rpc`
  - `GET /api/audit/stats`
  - `GET /api/health`
  - `GET /api/openapi.json`

## Run Tests

```bash
python3 -m pytest backend/tests/ -v
```

## Roadmap

- [ ] Upgrade timeline rendering backend options (ffmpeg / cloud render)
- [ ] Build a richer task center (filter, retry, diagnostics)
- [ ] Add E2E UI automation for Agent + Studio
- [ ] Add Docker/Compose deployment profiles
- [ ] Publish formal OSS license and contributor templates

## Contributing

1. Fork and create a branch: `feat/<topic>`
2. Ensure tests pass before PR
3. Include context, change list, validation steps, and risk notes in PR description
4. Update docs when API behavior changes

## License

This repository is currently for internal development/demo and is **All Rights Reserved** by default.  
If open-sourcing later, add a formal `LICENSE` file and update this section.

