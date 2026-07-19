import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.request

import yt_dlp

LANG_CANDIDATES = ["en", "en-US", "en-GB", "en-orig"]
NOISE_RE = re.compile(r"^\[[^\]]*\]$")
AUTH_COOKIE_NAMES = {"SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"}


def cookie_status():
    """检查 cookies.txt 是否是 yt-dlp 能识别的有效 YouTube 登录态。

    仅文件存在或未过期并不代表登录仍有效。yt-dlp 需要 LOGIN_INFO 加上
    SAPISID / 1PAPISID / 3PAPISID 中的一个，才能把它当作账号 cookies。
    """
    path = os.environ.get("COOKIES_FILE")
    if not path or not os.path.exists(path):
        return {"usable": False, "reason": "未找到 data/cookies.txt"}

    try:
        jar = http.cookiejar.MozillaCookieJar(path)
        jar.load(ignore_discard=True, ignore_expires=True)
    except Exception as e:
        return {"usable": False, "reason": f"data/cookies.txt 不是可读取的 Netscape 格式：{e}"}

    now = time.time()
    names = {
        cookie.name
        for cookie in jar
        if cookie.domain.lstrip(".").endswith("youtube.com")
        and (not cookie.expires or cookie.expires > now)
    }
    if not names:
        return {"usable": False, "reason": "data/cookies.txt 没有未过期的 youtube.com cookies"}
    if "LOGIN_INFO" not in names:
        return {"usable": False, "reason": "data/cookies.txt 缺少 LOGIN_INFO，yt-dlp 不会将其视为已登录"}
    if not names.intersection(AUTH_COOKIE_NAMES):
        return {"usable": False, "reason": "data/cookies.txt 缺少 SAPISID / __Secure-1PAPISID / __Secure-3PAPISID"}
    return {"usable": True, "reason": ""}


def cookie_opts(status=None):
    """只传递经过完整性校验的登录 cookies，避免半失效状态干扰匿名请求。"""
    status = status or cookie_status()
    path = os.environ.get("COOKIES_FILE")
    return {"cookiefile": path} if status["usable"] else {}


def get_track_url(info):
    subs = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    for source, is_auto in ((subs, False), (auto, True)):
        for lang in LANG_CANDIDATES:
            for fmt in source.get(lang, []):
                if fmt.get("ext") == "json3":
                    return fmt["url"], is_auto
    return None, None


def parse_json3(raw):
    cues = []
    for event in raw.get("events", []):
        segs = event.get("segs")
        if not segs:
            continue
        text = "".join(seg.get("utf8", "") for seg in segs).replace("\n", " ").strip()
        if not text or NOISE_RE.match(text):
            continue
        if event.get("aAppend") and cues:
            cues[-1]["text"] = (cues[-1]["text"] + " " + text).strip()
            continue
        cues.append({
            "text": text,
            "start": event.get("tStartMs", 0) / 1000,
            "duration": event.get("dDurationMs", 0) / 1000,
        })
    return cues


# 不同播放器客户端被 YouTube 风控的程度不一样；逐个换着试，能显著降低
# 「Sign in to confirm you're not a bot」这类间歇性拦截的失败率。
PLAYER_CLIENTS = [
    ["web"],
    ["mweb"],
    ["tv"],
    ["web_safari", "web"],
]


def extract_with_fallback(url, cookies):
    """依次尝试多个播放器客户端，返回 (info, last_error)。"""
    last_err = None
    for clients in PLAYER_CLIENTS:
        ydl_opts = {
            "skip_download": True,
            "quiet": True,
            "no_warnings": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitlesformat": "json3",
            # 只要字幕：视频格式列表为空（SABR/风控降级）时不要让格式选择报
            # "Requested format is not available" 连累字幕抓取
            "ignore_no_formats_error": True,
            "extractor_args": {"youtube": {"player_client": clients}},
            **cookie_opts(cookies),
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            # 拿到字幕轨道就算成功；否则换下一个客户端再试
            if get_track_url(info)[0] or info.get("subtitles") or info.get("automatic_captions"):
                return info, None
            # 被风控时 yt-dlp 仍可能拿到标题，却没有格式和字幕。此前这被误报成
            # “视频没有英文字幕”，令用户无法判断真正的网络/登录态问题。
            last_err = "empty_player" if not info.get("formats") else "no_subs"
        except Exception as e:
            last_err = str(e)
    return None, last_err


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing video id"}))
        return

    video_id = sys.argv[1]
    url = f"https://www.youtube.com/watch?v={video_id}"

    cookies = cookie_status()
    info, err = extract_with_fallback(url, cookies)
    if info is None:
        has_cookies = cookies["usable"]
        if err and "not a bot" in err:
            hint = "被 YouTube 判定为机器人，登录 cookies 已失效。请重新导出 data/cookies.txt（见 README）。"
        elif err and ("LOGIN_REQUIRED" in err or "Sign in" in err):
            hint = "该视频需要登录，cookies 已失效或缺失。请更新 data/cookies.txt。"
        elif err == "empty_player":
            cookie_hint = "当前没有可用登录态" if not has_cookies else "当前登录态也未能通过验证"
            hint = ("YouTube 只返回了视频标题，未返回任何可播放格式或字幕轨道（不是“没有英文字幕”）。"
                    f"这通常表示当前网络出口/IP 被限制，{cookie_hint}。"
                    + (f"{cookies['reason']}。" if not has_cookies else "请稍后重试或重新导出 cookies。"))
        elif not has_cookies:
            hint = f"没有可用的登录 cookies：{cookies['reason']}。请按 README 重新导出完整的 data/cookies.txt。"
        elif err == "no_subs":
            hint = ("尝试了多个播放器客户端仍拿不到字幕：该视频要么确实没有英文字幕，"
                    "要么登录态被 YouTube 拦下。若其它视频也普遍失败，请更新 data/cookies.txt。")
        else:
            hint = f"字幕获取失败: {(err or '')[:120]}"
        print(json.dumps({"ok": False, "error": hint}))
        return

    track_url, is_auto = get_track_url(info)
    if not track_url:
        print(json.dumps({"ok": False, "error": "该视频没有可用的英文字幕"}))
        return

    with urllib.request.urlopen(track_url, timeout=20) as resp:
        raw = json.loads(resp.read().decode("utf-8"))

    cues = parse_json3(raw)
    if not cues:
        print(json.dumps({"ok": False, "error": "该视频字幕内容为空"}))
        return

    print(json.dumps({
        "ok": True,
        "title": info.get("title") or video_id,
        "channel": info.get("uploader") or info.get("channel") or "",
        "duration": info.get("duration"),
        "sourceLang": "en",
        "isGenerated": bool(is_auto),
        "cues": cues,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"字幕获取失败: {e}"}))

