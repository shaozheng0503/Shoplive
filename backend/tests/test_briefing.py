from shoplive.backend.briefing import (
    build_shoplive_video_prompt_template,
    render_compact_product_anchor_text,
    summarize_storyboard,
)
from shoplive.backend.api.shoplive_api import _build_shoplive_video_prompt_via_llm


def _normalized_brief():
    return {
        "product_name": "JAHSO 低帮休闲板鞋",
        "selling_points": ["复古设计", "舒适百搭", "优质材质", "街头风格"],
        "target_user": "追求时尚与舒适的年轻人",
        "sales_region": "全球",
        "template": "clean",
        "brand_direction": "经典、时尚、舒适",
        "duration": 8,
        "total_duration": 16,
        "aspect_ratio": "16:9",
        "need_model": True,
        "product_anchors": {
            "category": "休闲运动鞋",
            "colors": ["深灰色", "红色", "米白色", "浅灰色"],
            "materials": ["合成革", "翻毛皮", "橡胶"],
            "silhouette": "低帮、经典板鞋款",
            "key_details": ["侧边W字母Logo", "撞色条纹", "鞋头透气孔", "JAHSO品牌标志"],
            "keep_elements": ["深灰红米白配色", "侧边W字母及条纹", "低帮廓形", "米白中底"],
            "avoid_elements": ["高帮设计", "网面材质", "荧光配色"],
        },
    }


def _script_text():
    return (
        "主框架：4.4 产品演示；辅助框架：4.6 故事讲述\n"
        "镜头1（0-2s）：16:9构图，JAHSO 低帮休闲板鞋开场特写，突出复古设计，电影级影棚布光，镜头推近。商品锚点：商品子类：休闲运动鞋；核心颜色：深灰色、红色、米白色。\n"
        "镜头2（2-5s）：需要模特展示，在全球偏好场景面向追求时尚与舒适的年轻人进行使用演示，展示舒适百搭。\n"
        "镜头3（5-8s）：收束为转化镜头，保留商品关键细节与购买动机。\n"
        "BGM：轻快且有节奏感的电商氛围音乐。\n"
        "标题：JAHSO 低帮休闲板鞋｜8s 高转化短视频（clean）\n"
        "文案：围绕复古设计；舒适百搭；优质材质；街头风格做真实表达。\n"
        "合规检查：高光边缘干净，反光可控，材质纹理清晰。\n"
    )


def test_summarize_storyboard_keeps_shots_only():
    summary = summarize_storyboard(_script_text())
    assert "镜头1" in summary
    assert "镜头2" in summary
    assert "镜头3" in summary
    assert "BGM：" not in summary
    assert "标题：" not in summary
    assert "文案：" not in summary
    assert "合规检查：" not in summary
    assert "商品锚点：" not in summary


def test_render_compact_product_anchor_text_is_concise():
    text = render_compact_product_anchor_text(_normalized_brief()["product_anchors"], lang="zh")
    assert "品类锁定：休闲运动鞋" in text
    assert "颜色锁定：深灰色、红色、米白色" in text
    assert "禁止偏移：高帮设计、网面材质、荧光配色" in text
    assert "适用场景" not in text


def test_build_shoplive_video_prompt_template_uses_core_points_and_clean_storyboard():
    prompt = build_shoplive_video_prompt_template(_normalized_brief(), _script_text())
    assert "核心卖点聚焦：复古设计；舒适百搭" in prompt
    assert "优质材质" not in prompt
    assert "街头风格" not in prompt
    assert "镜头规划：" in prompt
    assert "BGM：" not in prompt
    assert "标题：" not in prompt
    assert "文案：" not in prompt
    assert "合规检查：" not in prompt


def test_build_shoplive_video_prompt_via_llm_payload_is_sanitized():
    captured = {}

    def _fake_call_litellm_chat(**kwargs):
        captured.update(kwargs)
        return 200, {"ok": True, "response": {"choices": []}}

    status_code, data_wrap = _build_shoplive_video_prompt_via_llm(
        normalized=_normalized_brief(),
        script_text=_script_text(),
        api_base="https://example.com",
        api_key="test-key",
        model="azure-gpt-5",
        proxy="",
        shoplive_video_system_prompt="system",
        call_litellm_chat=_fake_call_litellm_chat,
    )

    assert status_code == 200
    assert data_wrap["ok"] is True
    user_content = captured["messages"][1]["content"]
    assert '"core_selling_points": [' in user_content
    assert "复古设计" in user_content
    assert "舒适百搭" in user_content
    assert "优质材质" not in user_content
    assert "街头风格" not in user_content
    assert "镜头1" in user_content
    assert "BGM：" not in user_content
    assert "标题：" not in user_content
