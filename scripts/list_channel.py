"""列出一个博主（频道）的最新视频，供批量缓存使用。

用法: python list_channel.py <频道主页/任一视频链接/@handle> [数量上限]
输出: 单行 JSON {"ok": true, "channel": "...", "videos": [{"id","title","duration"}]}

接受的链接形式：
- 频道主页: https://www.youtube.com/@SomeDoctor （自动转到 /videos 标签页）
- 频道视频页: https://www.youtube.com/@SomeDoctor/videos
- 播放列表: https://www.youtube.com/playlist?list=...
- 该博主的任意一个视频链接（自动解析出频道再列视频）
- 裸 handle: @SomeDoctor
"""

import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

import yt_dlp

AUTH_COOKIE_NAMES = {"SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"}


def cookie_opts():
    """只在 cookies.txt 是有效 YouTube 登录态时才传给 yt-dlp。

    与 fetch_transcript.py 同一套校验：半失效的 cookie 文件反而会干扰
    匿名请求，宁可不传。要求 LOGIN_INFO + SAPISID/1PAPISID/3PAPISID 之一。
    """
    path = os.environ.get("COOKIES_FILE")
    if not path or not os.path.exists(path):
        return {}
    try:
        jar = http.cookiejar.MozillaCookieJar(path)
        jar.load(ignore_discard=True, ignore_expires=True)
    except Exception:
        return {}
    now = time.time()
    names = {
        c.name
        for c in jar
        if c.domain.lstrip(".").endswith("youtube.com") and (not c.expires or c.expires > now)
    }
    if "LOGIN_INFO" in names and names.intersection(AUTH_COOKIE_NAMES):
        return {"cookiefile": path}
    return {}

# 频道根页（没有指定 tab）：flat 抽取会返回 Videos/Shorts 等 tab 而不是视频，
# 所以统一改写到 /videos 标签页（只含正常视频，不含 shorts/直播）
CHANNEL_ROOT_RE = re.compile(r"youtube\.com/(@[^/?#]+|channel/[^/?#]+|c/[^/?#]+|user/[^/?#]+)/?$")


def normalize(url):
    u = url.strip()
    if u.startswith("@"):
        u = "https://www.youtube.com/" + u
    if not re.match(r"https?://", u):
        u = "https://" + u
    bare = u.split("?")[0].rstrip("/")
    if CHANNEL_ROOT_RE.search(bare):
        return bare + "/videos"
    return u


WATCH_URL_RE = re.compile(r"(youtube\.com/watch\?|youtu\.be/|youtube\.com/shorts/)")


def resolve_channel_from_video(url):
    """视频链接 → 频道主页。走 oEmbed 公开接口，不触发 YouTube 的 bot 验证。"""
    api = "https://www.youtube.com/oembed?" + urllib.parse.urlencode({"url": url, "format": "json"})
    req = urllib.request.Request(api, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("author_url") or ""


def extract(url, limit):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        # 只要列表条目的基本信息，不逐个抓视频详情（快）
        "extract_flat": "in_playlist",
        "playlistend": limit,
        **cookie_opts(),
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing channel url"}))
        return
    url = normalize(sys.argv[1])
    limit = max(1, min(100, int(sys.argv[2]) if len(sys.argv) > 2 else 10))

    # 用户粘的是单个视频链接：先用 oEmbed 换成频道主页（避开 bot 验证），再列频道
    if WATCH_URL_RE.search(url):
        channel_url = resolve_channel_from_video(url)
        if not channel_url:
            print(json.dumps({"ok": False, "error": "无法从该视频链接解析出博主频道"}))
            return
        url = channel_url.rstrip("/") + "/videos"

    info = extract(url, limit)

    if not info.get("entries"):
        print(json.dumps({"ok": False, "error": "该链接没有解析出视频列表，请粘贴博主主页或视频链接"}))
        return

    videos = []
    for e in info.get("entries") or []:
        if not e:
            continue
        vid = e.get("id") or ""
        # YouTube 视频 ID 固定 11 位；频道根页混进来的 tab/播放列表条目不是
        if len(vid) != 11:
            continue
        videos.append({
            "id": vid,
            "title": e.get("title") or vid,
            "duration": e.get("duration"),
        })

    print(json.dumps({
        "ok": True,
        "channel": info.get("channel") or info.get("uploader") or info.get("title") or "",
        "videos": videos,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"获取频道视频列表失败: {e}"}))
