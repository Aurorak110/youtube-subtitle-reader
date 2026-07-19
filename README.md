# YouTube 双语字幕学习工具

输入一个 YouTube 链接，生成逐句「英文 + 中文」对照、生词高亮的学习网页，支持逐词跟读高亮、单句循环、逐句暂停、挖空自测。附带 Chrome 插件：在 YouTube 观看页直接叠加同款学习面板。

三个组成部分：

| 部分 | 作用 | 在哪运行 |
|---|---|---|
| 本地服务 | 抓字幕、AI 翻译、挑生词、缓存、下载视频 | 你的电脑（Node.js） |
| 网页版 | 学习页 + 视频库；可发布成云端网站手机随时看 | 浏览器 / Cloudflare Pages |
| Chrome 插件 | 看 YouTube 时右侧同步双语字幕面板 | Chrome（调用本地服务） |

## 安装（新电脑 / 新用户）

### 0. 前置软件（都免费）

- [Node.js](https://nodejs.org)（18+，一路下一步）
- [Python 3](https://www.python.org/downloads/)（安装时勾选 "Add to PATH"）
- ffmpeg（只有发布云端视频才需要：`winget install ffmpeg`）

### 1. 下载本项目并安装依赖

```
git clone https://github.com/Aurorak110/youtube-subtitle-reader.git
cd youtube-subtitle-reader
npm install
pip install yt-dlp
```

### 2. 配置翻译 API（必须）

1. 到 https://platform.deepseek.com 注册并充值（10 元用很久），创建 API key
2. 把 `config.json.example` 复制一份改名 `config.json`，填入：

```json
{
  "apiKey": "sk-你的key",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat"
}
```

> 每个使用者需要自己的 key。config.json 已被 .gitignore 排除，不会被上传。

### 3. 启动

双击 `启动.bat`（或 `node server.js`），浏览器打开 http://localhost:4300 。
粘贴 YouTube 链接点「生成学习页」——**生成时需要能访问 YouTube 的网络（梯子）**，生成完看缓存不需要。

### 4. 安装 Chrome 插件（可选）

1. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本项目的 `extension` 文件夹
3. 打开任意 YouTube 视频页，右侧出现学习面板；没生成过的视频点面板里的「生成」按钮

### 5. 发布云端版（可选，手机随时看）

1. 注册免费 [Cloudflare](https://dash.cloudflare.com/sign-up) 账号
2. `npx wrangler login` 授权
3. `npx wrangler pages project create 你的项目名 --production-branch=main`
4. 把 `发布.bat`（见下）里的项目名改成你的，双击运行

发布内容 = 学习页 + 字幕数据 + 视频 HLS 切片（本地下载过的视频，手机无梯子可看画面）。

```bat
node scripts\export_site.js
call npx wrangler pages deploy site --project-name=你的项目名 --commit-dirty=true
```

### 6. 开机自启（可选）

用任务计划程序创建登录时任务，操作填 `wscript.exe "项目路径\silent_start.vbs"`（注意先把 `silent_start.vbs` 里的路径改成你自己的项目路径）。

## 学习页功能

- 播放时当前句自动高亮跟随，**逐词卡拉OK式颜色标记**
- 点击任意句子跳转到视频对应位置
- 顶栏开关：中文翻译 / 生词高亮 / 词表
- 练习工具条：速度 0.5–1.5x、重放本句、单句循环、逐句暂停（影子跟读）、挖空自测
- 生词按严格标准挑选（B2+ 高级词、专业术语、习语、短语动词），带类型标签；旧视频可点「↻ 重新提取」升级
- 首页 = 视频库：按博主分组、搜索、显示时长/句数/词数

## 单词本（词根词缀拆解）

首页「📒 我的单词本」入口 → 汇总**所有视频**里挑出的生词，去重、按出现频次排序（一个词在几个视频出现过一目了然），可搜索、按类型（医学/术语/通用高级/已拆解）筛选。

点「生成词根拆解」，AI 会把医学词拆成 **前缀 / 词根 / 后缀 / 连接元音**，每部分给中文含义 + 字面直译，例如：

- `bradycardia` → brady(慢) + card(心脏) + -ia(病症) = **心跳缓慢**
- `appendicitis` → appendic(阑尾) + -itis(炎症) = **阑尾炎症**

医学术语系统由希腊-拉丁词素构成，拆开记远比死记整词高效。拆解结果缓存在 `data/morphology.json`，只算一次不重复花钱；通用词/习语不做无意义的拆解。云端只读版也能看（拆解按钮只在本地可用）。

## 批量缓存一个博主

首页「批量缓存一个博主」卡片：粘贴博主主页链接（`https://www.youtube.com/@某某`）或该博主**任意一个视频**的链接，选缓存最新几条（1–50），点开始。系统会依次抓字幕、翻译、下载视频，生成好的立刻出现在下方视频库；进度条实时显示，可随时「取消剩余」。适合把一个医学 UP 主的整套课程一次性做成学习库。

> 一次几十条会显得像机器人，YouTube 可能临时限流（见下方 cookies）。建议单个博主一次 10–20 条。

## cookies（被 YouTube 拦截时）

如果生成时报 YouTube 登录验证、或提示“只返回了视频标题，未返回格式或字幕轨道”，多半是短时间抓太多触发的临时限制，**等几小时通常自动恢复**。若持续，用完整的登录态绕过：

1. Chrome 装一个能导出 **HttpOnly cookies** 的扩展（如「Get cookies.txt LOCALLY」）
2. 打开 `youtube.com`，确认右上角显示你的登录头像；不要退出、不要清理站点数据
3. 立即导出该站点的**全部** cookies，格式选 **Netscape cookies.txt**，存成 `data/cookies.txt`
4. 重启本地服务后再试。程序会检查文件中是否同时包含 `LOGIN_INFO` 和 `SAPISID` / `__Secure-1PAPISID` / `__Secure-3PAPISID`；缺任一项都不是 yt-dlp 可用的登录态，需要重新导出。

之后本地服务的抓取会自动带上它。`data/cookies.txt` 是账号凭据，已被 `.gitignore` 排除，**不要上传、发送或提交到 GitHub**。

## 常见问题

- **429 insufficient_quota** — API 账户没余额，去充值
- **"该视频没有可用的英文字幕"** — 换一个有英文字幕的视频
- **"YouTube 要求登录验证 / not a bot"** 或 **"只返回了视频标题"** — 这是 YouTube 对当前出口/IP 的限制，并非字幕不存在；先等一段时间，持续出现则按上方步骤重新导出完整 cookies
- **"cookies 缺少 LOGIN_INFO"** — 文件虽然存在但不是有效登录态，通常是导出时未登录、只导出了部分 cookie，或浏览器已轮换了会话；重新打开 YouTube 确认登录后导出全部 cookies
- **手机（局域网）打不开** — 手机和电脑要同一 WiFi；防火墙弹窗选「允许」。想在外网（不同 WiFi / 4G）看，用云端版（第 5 步发布，得到一个 `*.pages.dev` 网址，随处可开）
- **插件面板显示"本地服务未启动"** — 双击 `启动.bat`
- **生成很慢** — 视频越长翻译越久，1 小时以上可能要几分钟
