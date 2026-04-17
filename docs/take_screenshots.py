"""Take screenshots of all ShopLive pages for competition documentation."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8000"
OUT = Path(__file__).parent / "screenshots"
OUT.mkdir(exist_ok=True)

PAGES = [
    # (url, filename, description, viewport, wait_ms, actions)
    (f"{BASE}/", "01_landing_page.png", "首页/落地页", (1440, 900), 2000, None),
    (f"{BASE}/pages/agent.html", "02_agent_main.png", "AI Agent 主创作界面", (1440, 900), 3000, None),
    (
        f"{BASE}/pages/agent.html",
        "03_agent_hot_video_input.png",
        "爆款视频复刻 - 输入区展开",
        (1440, 900),
        2000,
        "show_hot_video",
    ),
    (f"{BASE}/pages/studio.html", "04_studio.png", "Studio 工作台", (1440, 900), 2000, None),
    (f"{BASE}/pages/image-lab.html", "05_image_lab.png", "AI 图片实验室", (1440, 900), 2000, None),
    # API docs
    (f"{BASE}/api/health", "06_health_api.png", "健康检查 API", (1200, 800), 1000, None),
    (f"{BASE}/api/openapi.json", "07_openapi_spec.png", "OpenAPI 规范", (1200, 800), 1000, None),
    (f"{BASE}/api/tools/manifest", "08_tools_manifest.png", "工具清单 API", (1200, 800), 1000, None),
]


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)

        for url, filename, desc, (w, h), wait, action in PAGES:
            page = await browser.new_page(viewport={"width": w, "height": h})
            try:
                await page.goto(url, wait_until="networkidle", timeout=15000)
            except Exception:
                await page.goto(url, wait_until="load", timeout=15000)

            if action == "show_hot_video":
                try:
                    btn = page.locator("#toggleHotVideoBtn")
                    if await btn.count() > 0:
                        await btn.click()
                        await page.wait_for_timeout(800)
                except Exception:
                    pass

            await page.wait_for_timeout(wait)
            path = OUT / filename
            await page.screenshot(path=str(path), full_page=False)
            print(f"[OK] {filename} — {desc}")
            await page.close()

        # Agent page with different states - use wider viewport for script editor
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        try:
            await page.goto(f"{BASE}/pages/agent.html", wait_until="networkidle", timeout=15000)
        except Exception:
            await page.goto(f"{BASE}/pages/agent.html", wait_until="load", timeout=15000)
        await page.wait_for_timeout(2000)

        # Try to show script editor panel
        try:
            script_btn = page.locator("#toggleScriptBtn, [data-panel='script']")
            if await script_btn.count() > 0:
                await script_btn.first.click()
                await page.wait_for_timeout(1000)
                await page.screenshot(path=str(OUT / "09_script_editor.png"), full_page=False)
                print("[OK] 09_script_editor.png — 分镜脚本编辑器")
        except Exception as e:
            print(f"[SKIP] script editor: {e}")

        # Try to show video editor panel
        try:
            video_btn = page.locator("#toggleVideoEditorBtn, [data-panel='video']")
            if await video_btn.count() > 0:
                await video_btn.first.click()
                await page.wait_for_timeout(1000)
                await page.screenshot(path=str(OUT / "10_video_editor.png"), full_page=False)
                print("[OK] 10_video_editor.png — 视频编辑器")
        except Exception as e:
            print(f"[SKIP] video editor: {e}")

        await page.close()

        # Mobile viewport for responsive design
        page = await browser.new_page(viewport={"width": 390, "height": 844})
        try:
            await page.goto(f"{BASE}/pages/agent.html", wait_until="networkidle", timeout=15000)
        except Exception:
            await page.goto(f"{BASE}/pages/agent.html", wait_until="load", timeout=15000)
        await page.wait_for_timeout(2000)
        await page.screenshot(path=str(OUT / "11_mobile_view.png"), full_page=False)
        print("[OK] 11_mobile_view.png — 移动端视图")
        await page.close()

        await browser.close()

    print(f"\nAll screenshots saved to: {OUT}")


if __name__ == "__main__":
    asyncio.run(main())
