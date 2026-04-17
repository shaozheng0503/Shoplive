本文件夹说明
==============

本文件夹存放 ShopLive 作品的全部源代码与代表性素材。

文件清单：
----------
1. shoplive-源码.zip          — 作品团队开发的全部源代码（不含开发工具和公共类库）
   ├── backend/               — Python Flask 后端（约 16,700 行）
   │   ├── api/               — API 路由层（agent/veo/hot_video/video_edit 等）
   │   ├── common/            — 公共工具函数
   │   ├── scraper/           — 网页爬取模块
   │   ├── tests/             — 自动化测试（370 个用例）
   │   ├── web_app.py         — Flask 应用主文件
   │   ├── schemas.py         — Pydantic 数据校验
   │   ├── audit.py           — 全链路审计日志
   │   ├── tool_registry.py   — Agent 工具注册表
   │   └── run.py             — 启动入口
   ├── frontend/              — 前端代码（约 24,900 行 JS/HTML/CSS）
   │   ├── pages/             — HTML 页面（index/agent/studio/image-lab）
   │   ├── scripts/           — JavaScript 模块
   │   └── styles/            — CSS 样式
   ├── requirements.txt       — Python 依赖清单
   └── .env.example           — 环境变量模板

2. 代表性素材/                — 制作过程中使用的代表性素材
   ├── screenshots/           — 界面截图
   └── demo_videos/           — 示例生成视频片段

备注：
- 源代码可通过 GitHub 获取：https://github.com/shaozheng0503/Shoplive
- 根据文档中的安装步骤可完全复现运行环境
