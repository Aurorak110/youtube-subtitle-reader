import json
import re
import sys
import urllib.request

import yt_dlp

LANG_CANDIDATES = ["en", "en-US", "en-GB", "en-orig"]
NOISE_RE = re.compile(r"^\[[^\]]*\]$")


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


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing video id"}))
        return

    video_id = sys.argv[1]
    url = f"https://www.youtube.com/watch?v={video_id}"

    ydl_opts = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "json3",
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

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


