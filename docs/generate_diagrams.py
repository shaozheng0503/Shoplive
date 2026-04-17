"""Generate all technical architecture diagrams for PPT / documentation."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from pathlib import Path
import numpy as np

OUT = Path(__file__).parent / "diagrams"
OUT.mkdir(exist_ok=True)

# ── Global style ──
plt.rcParams["font.family"] = ["PingFang HK", "Hiragino Sans GB", "STHeiti", "Arial Unicode MS", "sans-serif"]
plt.rcParams["axes.unicode_minus"] = False

# Color palette
C_PRIMARY = "#2B5797"
C_ACCENT = "#4A90D9"
C_LIGHT = "#E8F0FE"
C_GREEN = "#34A853"
C_ORANGE = "#F5A623"
C_RED = "#EA4335"
C_PURPLE = "#8E44AD"
C_DARK = "#2C3E50"
C_WHITE = "#FFFFFF"
C_GRAY = "#95A5A6"
C_BG = "#FAFBFD"


def rounded_box(ax, x, y, w, h, text, color=C_PRIMARY, text_color=C_WHITE,
                fontsize=11, alpha=1.0, lw=0, edgecolor=None, radius=0.15):
    """Draw a rounded rectangle with centered text."""
    box = FancyBboxPatch((x - w/2, y - h/2), w, h,
                          boxstyle=f"round,pad=0,rounding_size={radius}",
                          facecolor=color, edgecolor=edgecolor or color,
                          linewidth=lw, alpha=alpha, zorder=2)
    ax.add_patch(box)
    ax.text(x, y, text, ha="center", va="center", fontsize=fontsize,
            color=text_color, zorder=3, fontweight="bold" if fontsize >= 11 else "normal",
            linespacing=1.4)


def arrow(ax, x1, y1, x2, y2, color=C_GRAY, style="->", lw=1.8):
    ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle=style, color=color, lw=lw, connectionstyle="arc3,rad=0"),
                zorder=1)


def save(fig, name):
    path = OUT / name
    fig.savefig(str(path), dpi=200, bbox_inches="tight", facecolor=C_BG, pad_inches=0.3)
    plt.close(fig)
    print(f"[OK] {name}")


# ══════════════════════════════════════════════════════════════
# Diagram 1: 系统三层架构图
# ══════════════════════════════════════════════════════════════
def diagram_architecture():
    fig, ax = plt.subplots(figsize=(14, 8))
    fig.patch.set_facecolor(C_BG)
    ax.set_xlim(0, 14)
    ax.set_ylim(0, 8)
    ax.axis("off")
    ax.set_title("ShopLive 系统架构图", fontsize=18, fontweight="bold", color=C_DARK, pad=15)

    # Layer 1: Frontend
    rounded_box(ax, 7, 7.0, 12.5, 1.2, "", color=C_LIGHT, text_color=C_DARK, lw=2, edgecolor=C_ACCENT)
    ax.text(1.2, 7.0, "展示层", fontsize=13, color=C_PRIMARY, fontweight="bold", va="center")
    for i, (label, sub) in enumerate([
        ("首页\nindex.html", "落地页入口"),
        ("Agent 创作台\nagent.html", "核心工作界面"),
        ("Studio\nstudio.html", "专业工作流"),
        ("图片实验室\nimage-lab.html", "多模型生成"),
    ]):
        x = 3.5 + i * 2.8
        rounded_box(ax, x, 7.0, 2.3, 0.85, label, color=C_ACCENT, fontsize=9)

    # Arrow
    arrow(ax, 7, 6.3, 7, 5.7, C_PRIMARY, lw=2.5)
    ax.text(7.5, 6.0, "RESTful API\n(60 端点)", fontsize=8, color=C_GRAY, ha="left", va="center")

    # Layer 2: Backend
    rounded_box(ax, 7, 4.5, 12.5, 2.4, "", color="#F0F4FF", text_color=C_DARK, lw=2, edgecolor=C_PRIMARY)
    ax.text(1.2, 5.45, "业务层", fontsize=13, color=C_PRIMARY, fontweight="bold", va="center")

    backend_mods = [
        ("agent_api\nAgent+对话", C_PRIMARY),
        ("veo_api\n视频生成链", C_GREEN),
        ("hot_video_api\n爆款复刻", C_ORANGE),
        ("video_edit_api\nFFmpeg 编辑", C_PURPLE),
        ("shoplive_api\n脚本工作流", C_ACCENT),
    ]
    for i, (label, color) in enumerate(backend_mods):
        x = 2.5 + i * 2.4
        rounded_box(ax, x, 5.15, 2.0, 0.7, label, color=color, fontsize=8)

    infra_mods = [
        "schemas.py\nPydantic 校验",
        "audit.py\n审计日志",
        "tool_registry.py\n工具注册表",
        "infra.py\nToken 缓存",
        "validation.py\n请求验证",
    ]
    for i, label in enumerate(infra_mods):
        x = 2.5 + i * 2.4
        rounded_box(ax, x, 3.95, 2.0, 0.6, label, color="#D5DFF0", text_color=C_DARK, fontsize=7.5)

    # Arrow
    arrow(ax, 7, 3.1, 7, 2.5, C_PRIMARY, lw=2.5)
    ax.text(7.5, 2.8, "Vertex AI / REST API", fontsize=8, color=C_GRAY, ha="left", va="center")

    # Layer 3: AI Services
    rounded_box(ax, 7, 1.3, 12.5, 1.6, "", color="#FFF8E8", text_color=C_DARK, lw=2, edgecolor=C_ORANGE)
    ax.text(1.2, 1.3, "AI 服务层", fontsize=13, color=C_ORANGE, fontweight="bold", va="center")

    ai_services = [
        ("Gemini 2.5\nFlash", "#4285F4", "ASR/图片"),
        ("Vertex AI\nLLM", "#34A853", "结构化分析"),
        ("Veo 3.1", "#FBBC04", "视频生成"),
        ("即梦 3.0", "#EA4335", "视频生成"),
        ("LTX 2.3", "#8E44AD", "视频生成"),
    ]
    for i, (label, color, sub) in enumerate(ai_services):
        x = 2.5 + i * 2.4
        rounded_box(ax, x, 1.5, 2.0, 0.6, label, color=color, fontsize=9)
        ax.text(x, 0.9, sub, fontsize=7, color=C_GRAY, ha="center")

    save(fig, "01_system_architecture.png")


# ══════════════════════════════════════════════════════════════
# Diagram 2: 爆款视频复刻 Pipeline 流程图
# ══════════════════════════════════════════════════════════════
def diagram_hot_video_pipeline():
    fig, ax = plt.subplots(figsize=(16, 6))
    fig.patch.set_facecolor(C_BG)
    ax.set_xlim(0, 16)
    ax.set_ylim(0, 6)
    ax.axis("off")
    ax.set_title("爆款视频复刻 Pipeline（全自动 9 步链路）", fontsize=18, fontweight="bold", color=C_DARK, pad=15)

    steps = [
        ("粘贴\n分享链接", C_GRAY, "用户输入"),
        ("解析\n视频直链", C_ACCENT, "Playwright\n+ 重定向"),
        ("下载\n视频文件", C_ACCENT, "≤20MB\nmp4"),
        ("ASR\n字幕转写", "#4285F4", "Gemini 2.5\nFlash"),
        ("噪声\n过滤", C_GREEN, "去除\n[music]"),
        ("LLM\n结构化分析", "#34A853", "Vertex AI\nJSON 输出"),
        ("多引擎\n提示词", C_ORANGE, "Veo/即梦\nLTX/Grok"),
        ("置信度\n评分", C_PURPLE, "0-1 分数\n综合评估"),
        ("一键\n复刻生成", C_RED, "引擎专属\n提示词+商品图"),
    ]

    for i, (label, color, sub) in enumerate(steps):
        x = 1.0 + i * 1.65
        y = 3.5
        rounded_box(ax, x, y, 1.35, 1.2, label, color=color, fontsize=9.5)
        ax.text(x, y - 1.05, sub, fontsize=7, color=C_GRAY, ha="center", va="center", linespacing=1.3)
        if i < len(steps) - 1:
            arrow(ax, x + 0.72, y, x + 0.93, y, color, lw=2)

    # Fallback path
    ax.annotate("", xy=(5.9, 2.0), xytext=(9.2, 2.0),
                arrowprops=dict(arrowstyle="<-", color=C_RED, lw=1.5,
                               connectionstyle="arc3,rad=-0.3", linestyle="--"))
    ax.text(7.5, 1.4, "ASR/LLM 失败 → 兜底模板", fontsize=8, color=C_RED, ha="center",
            style="italic", bbox=dict(boxstyle="round,pad=0.3", facecolor="#FFF0F0", edgecolor=C_RED, alpha=0.8))

    # Time annotations
    ax.text(3.6, 5.2, "ASR 阶段 ~10-30s", fontsize=8, color=C_ACCENT,
            bbox=dict(boxstyle="round,pad=0.2", facecolor=C_LIGHT, edgecolor=C_ACCENT, alpha=0.8))
    ax.text(9.2, 5.2, "分析 + 生成 ~5-15s", fontsize=8, color=C_GREEN,
            bbox=dict(boxstyle="round,pad=0.2", facecolor="#E8F8E8", edgecolor=C_GREEN, alpha=0.8))
    ax.text(13.8, 5.2, "视频生成 ~30-120s", fontsize=8, color=C_ORANGE,
            bbox=dict(boxstyle="round,pad=0.2", facecolor="#FFF8E8", edgecolor=C_ORANGE, alpha=0.8))

    save(fig, "02_hot_video_pipeline.png")


# ══════════════════════════════════════════════════════════════
# Diagram 3: 多引擎提示词自适应
# ══════════════════════════════════════════════════════════════
def diagram_engine_prompts():
    fig, ax = plt.subplots(figsize=(14, 7))
    fig.patch.set_facecolor(C_BG)
    ax.set_xlim(0, 14)
    ax.set_ylim(0, 7)
    ax.axis("off")
    ax.set_title("多引擎提示词自适应生成", fontsize=18, fontweight="bold", color=C_DARK, pad=15)

    # Center: analysis result
    rounded_box(ax, 7, 5.5, 5, 1.0, "LLM 结构化分析结果\n(remake_prompt + shot_plan + hook)", color=C_PRIMARY, fontsize=11)
    rounded_box(ax, 7, 4.0, 3.5, 0.7, "_build_engine_prompts()", color=C_DARK, fontsize=10)
    arrow(ax, 7, 4.95, 7, 4.4, C_PRIMARY, lw=2.5)

    # Four engines
    engines = [
        ("Veo 3.1", "#4285F4", "电影镜头语言",
         "cinematic close-up,\nsmooth camera push,\nsoft natural lighting,\nproduct detail texture"),
        ("即梦 3.0", "#EA4335", "中文电商美学",
         "高清通透，暖调氛围，\n商品质感细腻，\n电商场景，画面精致"),
        ("LTX 2.3", "#8E44AD", "关键帧描述",
         "keyframe 0s: hero reveal;\nkeyframe 4s: demo;\nkeyframe 8s: lifestyle;\nkeyframe 12s: CTA"),
        ("Grok", "#34A853", "自然叙事风格",
         "someone discovers the\nproduct, amazed, shows\nto camera, demonstrates\nbenefit, buy recommend"),
    ]

    for i, (name, color, style, example) in enumerate(engines):
        x = 2.0 + i * 3.3
        arrow(ax, 5.3 + (i - 1.5) * 1.2, 3.6, x, 2.8, color, lw=1.8)
        rounded_box(ax, x, 2.3, 2.8, 0.8, f"{name}\n{style}", color=color, fontsize=10)
        # Example box
        rounded_box(ax, x, 0.9, 2.8, 1.4, example, color=C_WHITE, text_color=C_DARK,
                    fontsize=7.5, lw=1.5, edgecolor=color, radius=0.1)

    save(fig, "03_engine_prompts.png")


# ══════════════════════════════════════════════════════════════
# Diagram 4: Agent Tool-Calling 循环
# ══════════════════════════════════════════════════════════════
def diagram_agent_loop():
    fig, ax = plt.subplots(figsize=(14, 7.5))
    fig.patch.set_facecolor(C_BG)
    ax.set_xlim(0, 14)
    ax.set_ylim(0, 7.5)
    ax.axis("off")
    ax.set_title("Agent Tool-Calling 循环（SSE 实时推送）", fontsize=18, fontweight="bold", color=C_DARK, pad=15)

    # User
    rounded_box(ax, 2, 6.3, 2.5, 0.8, "用户输入 Prompt", color=C_GRAY, fontsize=11)
    arrow(ax, 2, 5.85, 2, 5.25, C_DARK, lw=2)

    # LLM
    rounded_box(ax, 2, 4.8, 2.5, 0.8, "LLM 推理", color=C_PRIMARY, fontsize=12)

    # Decision
    diamond_x, diamond_y = 2, 3.5
    diamond = plt.Polygon([[diamond_x, diamond_y+0.5], [diamond_x+1, diamond_y],
                           [diamond_x, diamond_y-0.5], [diamond_x-1, diamond_y]],
                          facecolor=C_ORANGE, edgecolor=C_ORANGE, zorder=2)
    ax.add_patch(diamond)
    ax.text(diamond_x, diamond_y, "有 tool_call?", fontsize=9, ha="center", va="center",
            color=C_WHITE, fontweight="bold", zorder=3)
    arrow(ax, 2, 4.35, 2, 4.05, C_DARK, lw=2)

    # No -> done
    rounded_box(ax, 2, 2.0, 2.5, 0.8, "返回最终回复\nSSE: done", color=C_GREEN, fontsize=10)
    arrow(ax, 2, 2.95, 2, 2.45, C_GREEN, lw=2)
    ax.text(1.1, 2.7, "No", fontsize=9, color=C_GREEN, fontweight="bold")

    # Yes -> tool execution
    arrow(ax, 3.05, 3.5, 5.3, 3.5, C_ORANGE, lw=2)
    ax.text(4.0, 3.75, "Yes", fontsize=9, color=C_ORANGE, fontweight="bold")

    rounded_box(ax, 6.5, 3.5, 2.2, 0.8, "解析工具调用\nSSE: tool_call", color=C_PURPLE, fontsize=9.5)
    arrow(ax, 7.65, 3.5, 8.8, 3.5, C_DARK, lw=2)

    # Tool registry
    rounded_box(ax, 10.3, 3.5, 2.6, 0.8, "工具注册表\ntool_registry", color=C_DARK, fontsize=9.5)
    arrow(ax, 11.65, 3.5, 12.5, 3.5, C_DARK, lw=1.5)

    # Tools list
    tools = [
        ("render_video_timeline", C_PURPLE),
        ("apply_video_edits", C_ACCENT),
        ("get_video_info", C_GREEN),
    ]
    for i, (name, color) in enumerate(tools):
        y = 4.5 - i * 0.8
        rounded_box(ax, 13.0, y, 1.8, 0.55, name, color=color, fontsize=6.5)

    # Tool result back to LLM
    ax.annotate("", xy=(3.05, 4.8), xytext=(10.3, 4.8),
                arrowprops=dict(arrowstyle="->", color=C_ACCENT, lw=2,
                               connectionstyle="arc3,rad=-0.15"))
    ax.text(6.5, 5.2, "工具执行结果 → 注入 messages → 下一轮 LLM\nSSE: tool_result",
            fontsize=8.5, color=C_ACCENT, ha="center",
            bbox=dict(boxstyle="round,pad=0.3", facecolor=C_LIGHT, edgecolor=C_ACCENT, alpha=0.8))

    # Round counter
    ax.text(0.5, 1.0, "最多 10 轮\n超时 0.46s/工具", fontsize=9, color=C_RED, ha="center",
            bbox=dict(boxstyle="round,pad=0.3", facecolor="#FFF0F0", edgecolor=C_RED, alpha=0.8))

    # SSE events legend
    sse_events = [
        ("start", C_GRAY),
        ("thinking", C_ACCENT),
        ("tool_call", C_PURPLE),
        ("tool_result", C_GREEN),
        ("delta", C_ORANGE),
        ("done", C_PRIMARY),
        ("error", C_RED),
    ]
    ax.text(8.5, 0.9, "SSE 事件流：", fontsize=9, color=C_DARK, fontweight="bold")
    for i, (evt, color) in enumerate(sse_events):
        x = 10.0 + (i % 4) * 1.2
        y = 0.9 - (i // 4) * 0.4
        rounded_box(ax, x, y, 1.0, 0.3, evt, color=color, fontsize=7)

    save(fig, "04_agent_tool_calling.png")


# ══════════════════════════════════════════════════════════════
# Diagram 5: AI 大模型集成一览
# ══════════════════════════════════════════════════════════════
def diagram_ai_integration():
    fig, ax = plt.subplots(figsize=(14, 7))
    fig.patch.set_facecolor(C_BG)
    ax.set_xlim(0, 14)
    ax.set_ylim(0, 7)
    ax.axis("off")
    ax.set_title("AI 大模型全链路集成", fontsize=18, fontweight="bold", color=C_DARK, pad=15)

    # Left: Input sources
    inputs = [
        ("商品链接", 5.5),
        ("商品图片", 4.5),
        ("爆款视频链接", 3.5),
        ("文本提示词", 2.5),
    ]
    for label, y in inputs:
        rounded_box(ax, 1.5, y, 2.2, 0.7, label, color=C_GRAY, fontsize=10)
        arrow(ax, 2.65, y, 3.8, y if abs(y - 4.0) < 1.5 else 4.0, C_GRAY, lw=1.5)

    # Center: AI Models
    models = [
        ("Gemini 2.5 Flash", 5.5, "#4285F4", "多模态理解\n视频 ASR / 图片分析"),
        ("Vertex AI LLM", 4.0, "#34A853", "结构化分析\n脚本生成 / 提示词增强"),
        ("Veo 3.1 / 即梦 / LTX", 2.5, "#FBBC04", "视频生成\n文本→视频 / 图片→视频"),
        ("Gemini Imagen", 1.3, "#EA4335", "图片生成\n商品图合成"),
    ]
    for label, y, color, sub in models:
        rounded_box(ax, 7, y, 3.5, 0.8, f"{label}", color=color, fontsize=11)
        ax.text(9.2, y, sub, fontsize=7.5, color=C_DARK, ha="left", va="center")

    # Right: Outputs
    outputs = [
        ("时间戳字幕", 5.8),
        ("商品洞察", 5.2),
        ("复刻方案 JSON", 4.3),
        ("增强脚本", 3.7),
        ("短视频 mp4", 2.5),
        ("商品图片", 1.3),
    ]
    for label, y in outputs:
        rounded_box(ax, 12.5, y, 2.0, 0.5, label, color=C_LIGHT, text_color=C_DARK, fontsize=8.5, lw=1, edgecolor=C_ACCENT)
        arrow(ax, 8.8, min(max(y, 1.3), 5.5), 11.45, y, C_ACCENT, lw=1.5)

    # Engineering practices
    practices = [
        "Prompt 工程：引擎风格注入 + schema 描述",
        "缓存策略：ASR 24h + 分析 15min",
        "兜底机制：模板降级保障可用性",
        "置信度：综合评分量化方案质量",
    ]
    for i, text in enumerate(practices):
        ax.text(4.2, 0.7 - i * 0.25, f"  {text}", fontsize=7.5, color=C_DARK)
    ax.text(4.2, 0.95, "工程化实践", fontsize=9, color=C_PRIMARY, fontweight="bold")
    rounded_box(ax, 7, 0.45, 7.5, 1.3, "", color=C_WHITE, lw=1.5, edgecolor=C_PRIMARY, radius=0.1)

    save(fig, "05_ai_integration.png")


# ══════════════════════════════════════════════════════════════
# Diagram 6: 功能模块总览
# ══════════════════════════════════════════════════════════════
def diagram_feature_overview():
    fig, ax = plt.subplots(figsize=(14, 6))
    fig.patch.set_facecolor(C_BG)
    ax.set_xlim(0, 14)
    ax.set_ylim(0, 6)
    ax.axis("off")
    ax.set_title("ShopLive 六大核心功能模块", fontsize=18, fontweight="bold", color=C_DARK, pad=15)

    modules = [
        ("AI 视频生成", "多引擎调度\nVeo/即梦/LTX/Grok\n4-24 秒", "#4285F4", "video"),
        ("商品链接解析", "URL 爬取\n结构化信息提取\nPlaywright 渲染", "#34A853", "link"),
        ("爆款视频复刻", "ASR + LLM 分析\n多引擎提示词\n置信度评分", "#EA4335", "hot"),
        ("Agent 对话", "10 轮 Tool-Calling\nSSE 实时推送\n工具注册表", "#FBBC04", "agent"),
        ("视频编辑器", "FFmpeg Timeline\n加速/裁剪/文字\n多源合成", "#8E44AD", "edit"),
        ("AI 图片生成", "Gemini Imagen\n质量检测\n电商场景图", "#F5A623", "image"),
    ]

    for i, (title, desc, color, icon) in enumerate(modules):
        col = i % 3
        row = i // 3
        x = 2.5 + col * 4.0
        y = 4.0 - row * 2.5
        # Card
        rounded_box(ax, x, y, 3.3, 1.8, "", color=C_WHITE, lw=2, edgecolor=color, radius=0.15)
        # Title bar
        rounded_box(ax, x, y + 0.55, 3.1, 0.5, title, color=color, fontsize=11)
        # Description
        ax.text(x, y - 0.25, desc, fontsize=8.5, color=C_DARK, ha="center", va="center", linespacing=1.4)

    # Stats bar
    stats = [
        ("后端代码", "16,700 行"),
        ("前端代码", "14,100 行"),
        ("API 端点", "60 个"),
        ("自动化测试", "370 用例"),
        ("视频引擎", "4 种"),
    ]
    for i, (label, value) in enumerate(stats):
        x = 1.5 + i * 2.5
        ax.text(x, 0.25, value, fontsize=10, color=C_PRIMARY, ha="center", fontweight="bold")
        ax.text(x, 0.0, label, fontsize=8, color=C_GRAY, ha="center")

    save(fig, "06_feature_overview.png")


# ══════════════════════════════════════════════════════════════
# Diagram 7: 竞品对比雷达图
# ══════════════════════════════════════════════════════════════
def diagram_competitor_radar():
    fig, ax = plt.subplots(figsize=(8, 8), subplot_kw=dict(projection="polar"))
    fig.patch.set_facecolor(C_BG)

    categories = ["AI 视频生成", "电商定制", "爆款复刻", "Agent 智能", "多引擎", "视频编辑", "中文适配"]
    N = len(categories)
    angles = [n / float(N) * 2 * np.pi for n in range(N)]
    angles += angles[:1]

    products = {
        "ShopLive":   ([5, 5, 5, 5, 5, 4, 5], C_PRIMARY, 2.5),
        "剪映":       ([3, 2, 0, 0, 1, 5, 5], C_GREEN, 1.5),
        "Runway Gen-3": ([4, 0, 0, 0, 1, 2, 1], C_ORANGE, 1.5),
        "Pika Labs":  ([4, 0, 0, 0, 1, 1, 1], C_PURPLE, 1.5),
    }

    ax.set_theta_offset(np.pi / 2)
    ax.set_theta_direction(-1)
    ax.set_rlabel_position(0)
    plt.yticks([1, 2, 3, 4, 5], ["1", "2", "3", "4", "5"], color=C_GRAY, size=7)
    plt.ylim(0, 5.5)
    plt.xticks(angles[:-1], categories, size=10, color=C_DARK)

    for name, (values, color, lw) in products.items():
        values_plot = values + values[:1]
        ax.plot(angles, values_plot, "o-", linewidth=lw, label=name, color=color, markersize=4)
        ax.fill(angles, values_plot, alpha=0.08, color=color)

    plt.legend(loc="upper right", bbox_to_anchor=(1.35, 1.15), fontsize=10)
    plt.title("ShopLive 竞品对比", size=16, color=C_DARK, fontweight="bold", y=1.1)

    save(fig, "07_competitor_radar.png")


# ══════════════════════════════════════════════════════════════
# Diagram 8: 测试覆盖分布
# ══════════════════════════════════════════════════════════════
def diagram_test_coverage():
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))
    fig.patch.set_facecolor(C_BG)
    fig.suptitle("测试覆盖与质量保障", fontsize=18, fontweight="bold", color=C_DARK, y=1.02)

    # Left: test distribution pie
    labels = ["视频编辑 API", "Agent 运行时", "爆款复刻", "Schema 校验",
              "审计日志", "请求验证", "系统优化", "其他"]
    sizes = [47, 35, 28, 39, 23, 23, 19, 156]
    colors = [C_PURPLE, C_PRIMARY, C_ORANGE, C_ACCENT, C_GREEN, "#F5A623", C_RED, C_GRAY]
    explode = [0.05] * len(labels)

    ax1.pie(sizes, explode=explode, labels=labels, colors=colors, autopct="%1.0f%%",
            shadow=False, startangle=140, textprops={"fontsize": 8.5})
    ax1.set_title("370 个测试用例分布", fontsize=13, color=C_DARK, fontweight="bold")

    # Right: quality metrics bar
    metrics = ["Pydantic\n校验", "审计\n日志", "兜底\n机制", "缓存\n策略", "噪声\n过滤", "置信度\n评分"]
    values = [100, 100, 95, 90, 100, 100]
    bars_colors = [C_ACCENT, C_GREEN, C_ORANGE, C_PURPLE, "#4285F4", C_PRIMARY]

    bars = ax2.barh(metrics, values, color=bars_colors, height=0.6, edgecolor=C_WHITE, linewidth=1.5)
    ax2.set_xlim(0, 115)
    ax2.set_title("质量保障机制覆盖率 (%)", fontsize=13, color=C_DARK, fontweight="bold")
    for bar, val in zip(bars, values):
        ax2.text(bar.get_width() + 1, bar.get_y() + bar.get_height()/2,
                f"{val}%", va="center", fontsize=9, color=C_DARK, fontweight="bold")
    ax2.spines["top"].set_visible(False)
    ax2.spines["right"].set_visible(False)

    plt.tight_layout()
    save(fig, "08_test_coverage.png")


# ── Generate all ──
if __name__ == "__main__":
    diagram_architecture()
    diagram_hot_video_pipeline()
    diagram_engine_prompts()
    diagram_agent_loop()
    diagram_ai_integration()
    diagram_feature_overview()
    diagram_competitor_radar()
    diagram_test_coverage()
    print(f"\nAll diagrams saved to: {OUT}")
