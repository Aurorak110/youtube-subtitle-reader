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

## 常见问题

- **429 insufficient_quota** — API 账户没余额，去充值
- **"该视频没有可用的英文字幕"** — 换一个有英文字幕的视频
- **手机（局域网）打不开** — 手机和电脑要同一 WiFi；防火墙弹窗选「允许」
- **插件面板显示"本地服务未启动"** — 双击 `启动.bat`
- **生成很慢** — 视频越长翻译越久，1 小时以上可能要几分钟
