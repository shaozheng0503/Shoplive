# Shoplive 项目构建复盘 & AI 协作方法论

---

## 一、从零到成品——实际走过的路

这个项目不是一次性设计出来的，是**五轮迭代**逐步长出来的：

```
Round 0  骨架搭建
         Flask 入口 + 路由分发 + 最小可用的 Veo/Agent/Shoplive 接口
         此时：能跑通，但代码全挤在 web_app.py 里，没有校验、没有审计、没有缓存

Round 1  Agent Tools 基础设施
         拆出 schemas.py / tool_registry.py / skills.py / mcp_adapter.py / audit.py
         核心动作：把"一坨代码"变成"有命名、有边界的模块"

Round 2  闭环打通
         audit.record() 注入到每个处理器（agent 7处、veo 14处）
         补 /api/health 和 /api/openapi.json
         核心动作：让每个请求都能被追踪、被观测

Round 3  输入防线
         Pydantic @validate_request 装饰器，字段级错误 + recovery_suggestion
         核心动作：不信任前端输入，在系统边界做一次性校验

Round 4  测试覆盖
         104 个测试，0.2s 跑完，覆盖 schema / audit / validation / optimization
         核心动作：给后续重构买保险

Round 5  性能与可靠性
         GCS lru_cache / Vertex Session 复用 / 异步审计 / LLM 缓存 / chain job TTL 淘汰
         核心动作：从"能跑"到"跑得稳、跑得快"
```

**回头看最关键的认知**：不要试图一步到位。每轮只做一件事，做完验证，再做下一件。

---

## 二、Agent 项目架构的设计原则

### 2.1 分层——每层只回答一个问题

```
┌─ 协议层 ──────────── "请求合法吗？"
│   schemas.py          Pydantic 定义请求结构
│   validation.py       @validate_request 统一拦截非法输入
│
├─ 路由层 ──────────── "调哪个处理器？"
│   api/shoplive_api    视频工作流
│   api/veo_api         Veo 视频生成
│   api/agent_api       商品洞察 / 图片分析 / 对话
│   api/media_api       图片生成
│
├─ 业务层 ──────────── "业务规则是什么？"
│   briefing.py         Brief 规范化、校验、提示词模板、脚本自检
│   skills.py           技能编排（多工具组合）
│
├─ 工具层 ──────────── "怎么调外部服务？"
│   helpers.py          LiteLLM / GCS / FFmpeg / Imagen
│   tool_registry.py    工具清单（给 Agent 用的发现协议）
│   mcp_adapter.py      MCP JSON-RPC 2.0
│
└─ 基础设施层 ────────── "横切关注点"
    audit.py            全链路审计 (trace_id + ring buffer + async writer)
    infra.py            凭证缓存、代理检测
    async_executor.py   共享线程池、TTL 缓存
```

### 2.2 四个架构决策，事后证明是对的

| 决策 | 为什么有效 |
|------|-----------|
| **依赖注入注册路由** `register_veo_routes(app, json_error=..., get_access_token=...)` | 每个 api 模块不 import web_app，可以独立测试，替换任何一个依赖不影响其他模块 |
| **LLM 调用必有 Fallback 模板** | LLM 服务不可控（超时、限流、返回垃圾），模板兜底保证用户永远拿到结果，体验不降级 |
| **审计在第一天就埋** | 等出问题再补审计，已经来不及了。trace_id 从 before_request 到 after_request 贯穿全链路 |
| **提示词和代码分离** `briefing.py` 独立管理所有模板 | 改提示词不碰路由代码，改路由不碰提示词，两个关注点完全解耦 |

### 2.3 一个容易踩的坑

> **不要用"框架思维"来设计 Agent 项目。**

Agent 项目的核心不是"选 LangChain 还是自己写"，而是：
- 提示词是业务逻辑，必须版本管理、可测试、可 Fallback
- 外部调用（LLM / 视频生成 / 图片生成）全部不可靠，每个都要有降级策略
- 缓存 key 的设计比缓存本身更重要（漏掉 `api_base` 会导致跨实例污染）

---

## 三、和 AI 协作的实战心得

### 3.1 最核心的一条

> **给 AI "锚点"，不给 AI "方向"。**

```
差："帮我优化一下"
好："backend/veo_api.py 的 _poll_video_ready，目前从第0秒开始每6秒轮询，
     但 Veo 最快需要30秒，前5次轮询全部浪费。加一个 initial_wait_seconds=20 参数。"
```

"锚点"意味着：**文件路径 + 函数名 + 当前行为 + 问题原因 + 期望改法**。AI 拿到这五样东西，一轮就能改对。

### 3.2 对话节奏模式

整个项目最高效的对话模式是三步循环：

```
1. 精确指令   → "给 audit.py 加异步写入，queue + daemon thread，满了 drop"
2. AI 执行    → 改代码 + 跑测试
3. "继续"     → 推进到下一项

重复这个循环，不回头解释、不重复描述。
```

**反模式**：
- 一次给 10 个优化点让 AI 全部做 → 互相冲突，改了又改
- 描述不清楚然后说"不对，我要的是……" → 浪费两轮上下文
- 让 AI 自己决定"还有什么能优化" → 有用但产出不可控，适合探索阶段，不适合收尾阶段

### 3.3 MEMORY.md 是杀手锏

这个项目跨了多次对话，每次新会话 AI 都能立即接上，原因是 `MEMORY.md`：

```markdown
## Key Architecture
- Flask web app (backend/web_app.py)
- Agent APIs: backend/api/agent_api.py, backend/api/veo_api.py
- Audit: backend/audit.py + middleware in web_app.py
...

## Round 4 — 基础测试覆盖
- conftest.py: pytest sys.path 配置
- 总计 85 tests，全部通过
```

**写法原则**：
- 按模块组织，不按时间组织
- 只记确认过的结论，不记猜测
- 有路径、有函数名、有数字（测试数、行数）
- 用户纠正过的错误，立即更新

### 3.4 什么时候该让 AI 探索，什么时候该精确指令

| 阶段 | 对话方式 | 例子 |
|------|---------|------|
| 探索期（不确定做什么） | 开放问题 | "你觉得还有哪些地方可以优化" |
| 建设期（知道做什么） | 精确指令 | "在 shoplive_api.py 加 TTL 缓存，key 含 api_base hash" |
| 收尾期（批量执行） | 列表 + "全部实现" | 列出 6 项优化 → "全部实现" |
| 文档期（需要全局视角） | 描述产出格式 | "梳理成文档，提示词和模板都输出，md 格式" |

---

## 四、浓缩成三句话

1. **架构**：分层清晰 + 到处 Fallback + 全链路 trace_id，这三样比用什么框架重要十倍。
2. **迭代**：每轮只做一件事，做完验证再下一件。不要一步到位。
3. **AI 协作**：给文件路径 + 函数名 + 现状 + 问题 + 期望，一轮解决。用 MEMORY.md 跨会话保持上下文。
