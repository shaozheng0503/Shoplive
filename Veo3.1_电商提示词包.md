# Veo 3.1 电商提示词包（无字幕版）

## 1) 官方规则速查（已提炼）

基于 Google Cloud Veo/Vertex AI 文档，可直接执行的高价值规则如下：

- 用**清晰、具体、导演化语言**，避免空泛形容词。
- 短视频（4/6/8秒）建议**单场景单动作主线**，不要一条里塞多个剧情转场。
- 需要口播时，台词写法用 `Character says: ...`，**避免双引号**。
- 明确镜头语法：shot size（close-up/medium/wide）+ camera move（dolly/pan/truck）。
- 若是 image-to-video：提示词重点写“运动”，不要重复描述静态画面里已经存在的信息。
- 电商场景建议显式写约束：干净背景、材质细节、反光可控、商业光。
- 无字幕诉求：在 `negative_prompt` 里写元素词，而不是命令句。

推荐参数位：

- `duration_seconds`: `4` / `6` / `8`
- `aspect_ratio`: `16:9`（横版）或 `9:16`（竖版）
- 建议配 `negative_prompt`: `subtitles, captions, on-screen text, watermark, logo overlay, UI elements, distortion, extra fingers`

---

## 2) Prompt Skeleton（两套模板）

### 模板A：纯产品展示（无对白、无字幕）

将 `{}` 中内容替换成你的商品信息后直接用：

```text
A high-end ecommerce commercial of {product_name}. 
Single-scene setup: {scene_context}. 
Hero shot: {shot_type}, camera {camera_move}, focusing on {core_selling_point_1} and {core_selling_point_2}. 
Material realism: {material_texture}, controlled reflections, crisp edges, premium lighting, shallow depth of field. 
The product performs {micro_action} naturally, with realistic physics. 
Mood: {mood_style}, color palette {color_style}. 
Audio: clean ambient sound only, subtle SFX matching product movement, no music overpowering the scene. 
Commercial-ready, photorealistic, clean composition.
```

推荐 `negative_prompt`：

```text
subtitles, captions, on-screen text, watermark, logo overlay, cluttered background, deformed geometry, artifacts
```

---

### 模板B：可口播广告（无字幕，可有人声）

```text
A conversion-focused ecommerce ad for {product_name}. 
Single-scene: {scene_context}. 
Shot design: {shot_type}, camera {camera_move}, highlighting {core_selling_point_1} and {core_selling_point_2}. 
A presenter in {presenter_style} interacts with the product naturally. 
Lighting: {lighting_style}, cinematic but realistic, product-first framing. 
Dialogue: Presenter says: {short_line_under_12_words}. 
Audio bed: low, clean ambient + subtle product SFX; voice is clear and front-focused. 
Photorealistic, premium commercial finish, clean frame.
```

推荐 `negative_prompt`：

```text
subtitles, captions, on-screen text, watermark, logo overlay, noisy crowd, overexposed highlights, blurry product
```

---

## 3) 10条可直接生成的成品提示词

每条都已按“无字幕”思路设计，可直接复制。  
（建议同时传入对应 `negative_prompt`，进一步稳定“无字幕”结果）

### 1. 护肤精华（纯展示）

- 推荐参数：`duration_seconds=6`, `aspect_ratio=9:16`
- 适用：抖音/短视频种草主视觉

```text
A premium skincare serum bottle on a wet black stone surface at dawn. 
Close-up hero shot, slow dolly in, focusing on glass clarity, liquid viscosity, and droplet texture. 
Soft side lighting with controlled highlights reveals the label area and cap details without glare. 
A single drop rolls down the bottle naturally, then settles near the base with realistic fluid motion. 
Mood is calm, clinical-luxury, cool silver-blue palette, photorealistic commercial quality. 
Audio: light water ambience and subtle droplet SFX only.
```

### 2. 口红（可口播）

- 推荐参数：`duration_seconds=8`, `aspect_ratio=9:16`
- 适用：美妆带货口播短广告

```text
A beauty presenter stands in a clean vanity studio holding a matte lipstick. 
Medium close-up, slow truck right, emphasizing true color payoff, smooth glide, and non-drying finish. 
The presenter applies one stroke on lip, then tilts toward camera to show texture under soft key light. 
Lighting is warm and flattering, background minimal and elegant. 
Dialogue: Presenter says: One swipe, bold color, all-day comfort. 
Audio: clear voice, subtle studio room tone, no overpowering music. 
Photorealistic, conversion-focused ecommerce ad look.
```

### 3. 连衣裙（纯展示）

- 推荐参数：`duration_seconds=8`, `aspect_ratio=9:16`
- 适用：女装详情页短视频

```text
A flowing midi dress displayed on a model in a bright minimalist loft. 
Full shot transitioning to medium shot with a gentle arc camera move, highlighting waist tailoring and fabric drape. 
The model performs one natural turn, showing hem movement and seam craftsmanship with realistic cloth physics. 
Soft daylight from window plus subtle rim light for silhouette separation. 
Mood is elegant and confident, warm-neutral palette, premium fashion commercial style. 
Audio: soft room ambience and fabric movement SFX only.
```

### 4. 运动鞋（纯展示）

- 推荐参数：`duration_seconds=6`, `aspect_ratio=16:9`
- 适用：横版商品主图视频

```text
A pair of running shoes on a textured concrete platform in a modern sports studio. 
Low-angle close-up, dynamic dolly around the shoe, focusing on outsole grip pattern, breathable mesh, and heel support. 
One controlled footstep lands next to the shoe to show cushioning response and stability. 
Directional light with crisp shadows, high contrast but clean highlights. 
Energetic, performance-driven mood, photorealistic product-commercial finish. 
Audio: subtle impact thump and soft indoor ambience.
```

### 5. 通勤包（可口播）

- 推荐参数：`duration_seconds=8`, `aspect_ratio=9:16`
- 适用：功能卖点讲解型广告

```text
A smart commuter backpack in a modern office lobby. 
Medium shot with slow pan left, showing multi-compartment organization, laptop slot, and water-resistant surface. 
Presenter opens the bag once and smoothly demonstrates quick-access pockets in one continuous action. 
Lighting is clean corporate daylight with controlled reflections on zippers. 
Dialogue: Presenter says: Organized, lightweight, built for daily commute. 
Audio: clear voice with subtle lobby ambience and zipper SFX. 
Photorealistic ecommerce ad, product-first composition.
```

### 6. 无线耳机（纯展示）

- 推荐参数：`duration_seconds=6`, `aspect_ratio=16:9`
- 适用：3C 性能感广告

```text
Wireless earbuds and charging case on a dark reflective table with neon edge light. 
Macro close-up, slow zoom in then slight rack focus from case to earbud tip, highlighting finish quality and ergonomic shape. 
Case lid opens smoothly with realistic hinge motion, then status light glows softly. 
Lighting is futuristic but controlled, metallic texture and edges remain sharp and clean. 
Mood is premium tech, cool cyan-purple palette, photorealistic commercial realism. 
Generate native synced audio track (not silent). 
Audio design: clear lid open click, magnetic snap, soft UI confirmation chime, low electronic room hum, subtle whoosh synced with camera movement. 
Mixing: SFX in foreground, ambience in background, clean and audible, no music, no silence.
```

### 7. 咖啡机（可口播）

- 推荐参数：`duration_seconds=8`, `aspect_ratio=16:9`
- 适用：厨房小家电讲解视频

```text
A compact espresso machine on a clean kitchen counter during morning light. 
Medium shot with gentle dolly in, focusing on one-touch operation, fast extraction, and crema texture. 
Presenter presses one button, coffee pours into a ceramic cup in a single smooth sequence. 
Warm natural lighting, realistic steam and liquid behavior, premium home-lifestyle atmosphere. 
Dialogue: Presenter says: One touch, rich crema, cafe taste at home. 
Audio: clear voice, coffee pour SFX, low kitchen ambience.
```

### 8. 空气炸锅（纯展示）

- 推荐参数：`duration_seconds=6`, `aspect_ratio=9:16`
- 适用：厨房爆品转化短片

```text
An air fryer on a tidy kitchen island with ingredients nearby. 
Medium close-up, camera truck right, emphasizing rapid heating, crisp texture result, and easy-clean basket design. 
Basket slides out once to reveal golden fries with visible steam and realistic food texture. 
Lighting is bright high-key commercial light, clean shadows, appetizing color rendering. 
Mood is efficient and modern, photorealistic ecommerce style. 
Audio: soft kitchen ambience and crisp food SFX.
```

### 9. 宠物粮（可口播）

- 推荐参数：`duration_seconds=8`, `aspect_ratio=9:16`
- 适用：宠物用品情感带货

```text
A premium pet food pack and bowl in a cozy living room with a healthy dog nearby. 
Medium shot with slight dolly forward, focusing on ingredient freshness cues, kibble texture, and feeding moment. 
The dog approaches naturally and starts eating calmly, showing appetite and trust. 
Lighting is warm and homey, with clean focus on product pack and bowl foreground. 
Dialogue: Presenter says: High protein nutrition your dog will love. 
Audio: clear voice, subtle home ambience, gentle pet movement SFX. 
Photorealistic, trust-building ecommerce ad tone.
```

### 10. 保温杯（纯展示）

- 推荐参数：`duration_seconds=4`, `aspect_ratio=9:16`
- 适用：短时高频素材（可拼接）

```text
A stainless insulated tumbler on an outdoor desk at sunrise. 
Close-up static-to-dolly-in shot, highlighting matte finish, leak-proof lid, and condensation-free body. 
Hand lifts the cup once, twists the lid, and light steam appears naturally from the opening. 
Golden-hour backlight with controlled flare, product edges remain crisp and premium. 
Mood is clean, active, everyday lifestyle, photorealistic commercial quality. 
Audio: soft morning ambience and subtle lid twist SFX only.
```

---

## 4) 快速调参与复用指南

### A. 一键替换词位

- `{product_name}`：商品名（具体到品类+特征）
- `{core_selling_point}`：最多2个核心卖点（短视频不要贪多）
- `{scene_context}`：使用场景（通勤、厨房、梳妆台、健身房）
- `{camera_move}`：每条尽量 1 种主运动（slow dolly in / slow pan left）
- `{mood_style}`：高级感/清新/科技/生活化

### B. 失败重试策略（强烈建议）

- 首轮失败：减少镜头复杂度，删掉多余动作，只保留一个主动作。
- 仍不稳定：把 8 秒拆成两个 4 秒 clip 分开生成再拼接。
- 人物口播不稳：将台词缩短到 6-10 个英文词，避免长句。
- 有字幕残留：在 `negative_prompt` 加强  
  `subtitles, captions, on-screen text, lower third, watermark, logo overlay`

### C. API 请求示例（结构）

```json
{
  "model": "veo-3.1-generate-preview",
  "prompt": "PASTE_PROMPT_HERE",
  "duration_seconds": 6,
  "aspect_ratio": "9:16",
  "negative_prompt": "subtitles, captions, on-screen text, watermark, logo overlay, UI elements"
}
```

---

## 5) 继续补充：服饰类专用 20 条（全中文，可直接生成）

统一建议参数：

- 默认：`duration_seconds=6`，`aspect_ratio=9:16`
- 通用 `negative_prompt`：`subtitles, captions, on-screen text, watermark, logo overlay, UI elements, distortion, extra fingers`

### A. 日韩审美（1-7）

1) 甜美针织开衫（上身特写）  
提示词：明亮日系卧室场景，女生穿浅色针织开衫，镜头中近景缓慢推近，重点展示织纹细节、纽扣工艺和上身垂感，人物自然转身半圈并整理衣领，光线柔和通透，画面干净高级，真实面料质感，电商广告质感，无字幕。

2) 通勤衬衫（抗皱卖点）  
提示词：韩系极简办公室背景，模特穿白色通勤衬衫，镜头由中景平滑横移到近景，突出领口挺括、袖口走线和面料平整度，模特抬手打字后站起，衣身依旧平整，低对比柔光，干净商业画面，无字幕。

3) 百褶半身裙（动态垂坠）  
提示词：城市街角咖啡店外景，模特穿高腰百褶半身裙，低机位全身镜头缓慢环绕，展示裙摆摆动和腰线修饰效果，动作自然轻步前行，色调清新克制，布料运动物理真实，电商短视频风格，无字幕。

4) 学院风卫衣（减龄休闲）  
提示词：日光校园步道场景，模特穿宽松学院风卫衣，中景跟拍向前，重点展示帽型、罗纹袖口与版型轮廓，人物回头微笑并拉起帽绳，画面柔和明快，面料纹理清晰，青春感强，无字幕。

5) 软糯毛衣（亲肤质感）  
提示词：暖色客厅沙发场景，模特穿奶油色毛衣，近景慢速推近，重点表现毛线蓬松度、亲肤触感和肩线落点，人物轻抚袖口并抱臂，暖光氛围，细节锐利，温柔高级感，无字幕。

6) 牛仔阔腿裤（显腿长）  
提示词：韩系白墙影棚，模特穿高腰牛仔阔腿裤，全身镜头从脚部向上微抬，突出高腰比例、裤线和垂感，模特自然走两步并转身，光比简洁，蓝调干净，真实布料质感，无字幕。

7) 防晒外套（轻薄透气）  
提示词：春日公园步道，模特穿轻薄防晒外套，中景跟拍加轻微推近，突出面料轻盈、帽檐结构与拉链细节，风吹衣摆轻微摆动，阳光逆光边缘干净，清爽运动感，无字幕。

### B. 欧美审美（8-14）

8) 西装外套（利落剪裁）  
提示词：城市商务大堂，模特穿修身西装外套，中近景稳定推进，突出肩线、驳领和腰部剪裁，模特扣上纽扣后侧身展示轮廓，冷暖平衡商业布光，高级职业感，无字幕。

9) 紧身运动套装（塑形卖点）  
提示词：现代健身房场景，模特穿运动套装，低机位中景环绕，展示面料弹性、包裹感与高腰支撑，人物做轻量拉伸动作，肌理与褶皱真实，节奏有力但画面干净，无字幕。

10) 真丝吊带裙（光泽质感）  
提示词：傍晚室内落地窗场景，模特穿真丝吊带裙，中景慢速推近，重点展示面料光泽、垂坠和贴合曲线，人物缓步转身，金色边缘光勾勒轮廓，电影级商业感，无字幕。

11) 羊绒大衣（秋冬高级）  
提示词：秋季街景，模特穿长款羊绒大衣，远景到中景缓慢拉近，强调面料厚实细腻、翻领结构与版型挺阔，人物行走中整理衣领，色调克制偏暖，高级时装广告质感，无字幕。

12) 机能冲锋衣（防风防泼水）  
提示词：轻雨城市桥面，模特穿机能冲锋衣，中景跟拍，重点展示帽檐、压胶拉链与面料拒水效果，雨滴从衣面滑落可见，冷色硬朗布光，户外性能感强，无字幕。

13) 高弹打底裤（舒适贴合）  
提示词：简洁居家运动空间，模特穿高弹打底裤，中近景横移，突出腰头包裹、腿部贴合与回弹，人物完成下蹲后站起，面料恢复平整，光线均匀，真实电商展示，无字幕。

14) 皮革短夹克（酷感风格）  
提示词：夜晚都市霓虹街景，模特穿短款皮夹克，中景轻微环绕，展示皮面反光控制、五金细节和肩部廓形，人物转头并拉上拉链，氛围冷调，时尚大片质感，无字幕。

### C. 中东审美（15-20）

15) 长袍连衣裙（优雅线条）  
提示词：高端室内拱门空间，模特穿长袍连衣裙，全身镜头缓慢推近，突出长线条垂坠、袖口细节和面料层次，人物缓慢行走并停步回身，金暖光线，高级典雅，无字幕。

16) 轻奢头巾搭配（面料与配色）  
提示词：简洁米色室内场景，模特佩戴轻奢头巾与同色系服装，中近景稳定镜头，强调面料细腻、边缘包裹与配色协调，人物自然整理头巾，光线柔和，品牌感强，无字幕。

17) 刺绣礼服（工艺细节）  
提示词：高端宴会厅背景，模特穿刺绣礼服，先中景后近景慢推，重点表现刺绣纹样、珠饰反光和结构剪裁，人物轻转一圈，细节清晰且反光可控，奢华电商广告风格，无字幕。

18) 宽松罩袍（舒适与得体）  
提示词：明亮室内走廊，模特穿宽松罩袍，中景平稳跟拍，展示面料透气感、袖摆流动和整体得体轮廓，人物自然步行并轻抬手，柔和高键布光，日常高质感，无字幕。

19) 金属配饰腰带长裙（节庆风）  
提示词：节庆风格室内布景，模特穿长裙配金属腰带，中景环绕镜头，突出腰带细节、裙身层次与动作时的光泽变化，人物轻步旋转，暖金调氛围，精致高级，无字幕。

20) 商务端庄套装（正式场景）  
提示词：现代办公会客区，模特穿端庄套装，中近景推近，展示肩线结构、面料挺括和整体得体比例，人物落座再起身，服装保持平整，中性高端布光，专业可信，无字幕。

---

## 6) 可直接复用的小技巧（服饰专用）

- 想突出“显瘦/显高”：加入 `高腰线明显、纵向线条、全身低机位轻推`。
- 想突出“面料高级”：加入 `近景微距、纤维纹理清晰、反光可控`。
- 想避免“动作怪异”：每条只保留一个主动作（转身、行走、抬手三选一）。
- 想做 A/B 测试：同一条提示词仅替换 `光线风格` 或 `镜头运动`，不要同时改太多变量。

