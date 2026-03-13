import { state } from './state.js';
import { currentLang } from './i18n.js';
import { getApiBase, postSse } from './utils.js';
import { pushVideoUrlToHistory } from './video-edit-ops.js';

// Callbacks injected from index.js
let _pushSystemStateMsg = () => null;
let _pushSystemReplyMsg = () => null;
let _renderVideoEditor = () => {};
let _applyVideoEditsToPreview = () => {};
let _scrollToBottom = () => {};

export function initAgentRunCallbacks(cbs) {
  if (cbs.pushSystemStateMsg) _pushSystemStateMsg = cbs.pushSystemStateMsg;
  if (cbs.pushSystemReplyMsg) _pushSystemReplyMsg = cbs.pushSystemReplyMsg;
  if (cbs.renderVideoEditor) _renderVideoEditor = cbs.renderVideoEditor;
  if (cbs.applyVideoEditsToPreview) _applyVideoEditsToPreview = cbs.applyVideoEditsToPreview;
  if (cbs.scrollToBottom) _scrollToBottom = cbs.scrollToBottom;
}

/**
 * Stream /api/agent/run SSE and render each round (thinking / tool_call /
 * tool_result / delta / done) as live chat bubbles.
 * Used when user types a free-form question or edit while a video is loaded.
 */
export async function callAgentRunAndRender(prompt) {
  const base = getApiBase();
  const zh = currentLang === "zh";
  const context = {};
  if (state.lastVideoUrl) context.video_url = state.lastVideoUrl;
  if (state.productName) context.product_name = state.productName;

  const TOOL_LABELS = {
    export_edited_video:    zh ? "导出编辑视频" : "Export video",
    render_video_timeline:  zh ? "渲染时间轴"   : "Render timeline",
    generate_product_image: zh ? "生成商品图"   : "Generate image",
    parse_product_url:      zh ? "解析商品链接" : "Parse product URL",
    analyze_product_image:  zh ? "分析商品图"   : "Analyze image",
    run_video_workflow:     zh ? "运行视频工作流": "Run workflow",
    chain_video_segments:   zh ? "拼接视频片段" : "Chain segments",
  };
  const tools = state.lastVideoUrl
    ? ["export_edited_video", "render_video_timeline", "generate_product_image"]
    : ["parse_product_url", "analyze_product_image", "run_video_workflow", "generate_product_image"];

  const thinkEl = _pushSystemStateMsg(zh ? "🤔 Agent 思考中…" : "🤔 Agent thinking…", "progress");
  let replyBubble = null;
  let replyText = "";
  let activeToolEl = null;
  const bodyOf = (el) => el?.querySelector("[data-msg-body]");

  try {
    await postSse(
      `${base}/api/agent/run`,
      { prompt, tools, context, max_rounds: 5 },
      (event, payload) => {
        switch (event) {
          case "thinking": {
            const b = bodyOf(thinkEl);
            if (b) b.textContent = zh ? `🤔 第 ${payload.round} 轮思考中…` : `🤔 Round ${payload.round} thinking…`;
            _scrollToBottom();
            break;
          }
          case "tool_call": {
            const label = TOOL_LABELS[payload.tool_name] || payload.tool_name;
            activeToolEl = _pushSystemStateMsg(`🔧 ${zh ? "调用" : "Calling"}: ${label}`, "progress");
            _scrollToBottom();
            break;
          }
          case "tool_result": {
            if (activeToolEl) {
              const b = bodyOf(activeToolEl);
              const icon = payload.ok ? "✅" : "❌";
              const label = TOOL_LABELS[payload.tool_name] || payload.tool_name;
              if (b) b.textContent = `${icon} ${label} ${payload.ok ? (zh ? "完成" : "done") : (zh ? "失败" : "failed")}`;
              activeToolEl.classList.remove("status-tone-progress");
              activeToolEl.classList.add(payload.ok ? "status-tone-done" : "status-tone-blocked");
            }
            if (payload.video_url) {
              pushVideoUrlToHistory();
              state.lastVideoUrl = payload.video_url;
              document.querySelectorAll(".video-edit-surface video").forEach((v) => { v.src = payload.video_url; });
              _renderVideoEditor();
              _applyVideoEditsToPreview();
            }
            break;
          }
          case "delta": {
            if (!replyBubble) {
              thinkEl?.remove();
              replyBubble = _pushSystemReplyMsg("");
            }
            replyText += payload.delta || "";
            const b = bodyOf(replyBubble);
            if (b) b.textContent = replyText;
            _scrollToBottom();
            break;
          }
          case "done": {
            thinkEl?.remove();
            if (!replyBubble && payload.content) _pushSystemReplyMsg(payload.content, { speed: 20 });
            break;
          }
          case "error": {
            thinkEl?.remove();
            _pushSystemStateMsg(payload.error || (zh ? "Agent 执行失败" : "Agent failed"), "blocked");
            break;
          }
        }
      },
      120000
    );
  } catch (e) {
    thinkEl?.remove();
    _pushSystemStateMsg(String(e?.message || (zh ? "Agent 请求失败" : "Agent request failed")), "blocked");
  }
}
