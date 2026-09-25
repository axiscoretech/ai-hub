#!/usr/bin/env python3
"""Rebuild the install-instruction GIFs.

The pictures in assets/ are schematics, not screen recordings. Apple and
Microsoft change the wording between versions. Edit the text, colors, and
timings below, then run:

    python3 scripts/make_install_gifs.py

That overwrites assets/install-macos.gif and assets/install-windows.gif.
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WIDTH = 880
HEIGHT = 540
CAPTION_H = 64

# Edit these if the warning text or the pace should change.
MAC_CAPTIONS = [
    "macOS blocks the first launch. Click Done.",
    "Open System Settings, then Privacy & Security.",
    "Confirm with Open Anyway.",
    "Enter your Mac password.",
    "Done. You need this once per downloaded version.",
]
WIN_CAPTIONS = [
    "SmartScreen warns about an unsigned installer. Click More info.",
    "Check the file name, then click Run anyway.",
    "The installer runs as usual.",
    "Done. The warning is shown because the installer is not code-signed yet.",
]
HOLD_MS = 1400
MOVE_MS = 420
END_MS = 3900
STEP_MS = 40


def font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def gradient(top, bottom):
    image = Image.new("RGB", (WIDTH, HEIGHT), top)
    draw = ImageDraw.Draw(image)
    for y in range(HEIGHT - CAPTION_H):
        mix = y / max(1, HEIGHT - CAPTION_H - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * mix) for i in range(3))
        draw.line([(0, y), (WIDTH, y)], fill=color)
    return image


def round_rect(draw, box, radius, fill, outline=None):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline)


def center_text(draw, box, text, face, fill):
    left, top, right, bottom = box
    bbox = draw.textbbox((0, 0), text, font=face)
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    x = left + (right - left - width) / 2
    y = top + (bottom - top - height) / 2 - 1
    draw.text((x, y), text, font=face, fill=fill)


def wrap(draw, text, face, width):
    words = text.split()
    lines = []
    current = ""
    for word in words:
        trial = word if not current else current + " " + word
        if draw.textbbox((0, 0), trial, font=face)[2] <= width and word != "\n":
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def caption(draw, number, text):
    draw.rectangle((0, HEIGHT - CAPTION_H, WIDTH, HEIGHT), fill=(18, 20, 24))
    draw.ellipse((22, HEIGHT - 46, 50, HEIGHT - 18), fill=(0, 122, 255))
    center_text(draw, (22, HEIGHT - 46, 50, HEIGHT - 18), str(number), font(16, True), (255, 255, 255))
    draw.text((64, HEIGHT - 42), text, font=font(18), fill=(255, 255, 255))


def cursor(draw, x, y):
    shape = [(x, y), (x, y + 18), (x + 5, y + 14), (x + 8, y + 22), (x + 12, y + 20), (x + 8, y + 13), (x + 14, y + 13)]
    draw.polygon(shape, fill=(255, 255, 255), outline=(20, 20, 20))


def menu_bar(draw):
    draw.rectangle((0, 0, WIDTH, 28), fill=(236, 236, 240))
    draw.text((16, 6), "Finder    File    Edit    View    Go    Window", font=font(13), fill=(30, 30, 30))


def icon(draw, box):
    round_rect(draw, box, 16, (109, 91, 255))
    center_text(draw, box, "AI", font(28, True), (255, 255, 255))


def button(draw, box, label, primary=True):
    fill = (10, 132, 255) if primary else (226, 228, 232)
    ink = (255, 255, 255) if primary else (40, 40, 40)
    round_rect(draw, box, 8, fill)
    center_text(draw, box, label, font(16), ink)


def mac_dialog(image, title, body, primary, secondary=None):
    draw = ImageDraw.Draw(image)
    card = (250, 70, 630, 430)
    round_rect(draw, card, 18, (255, 255, 255))
    icon(draw, (400, 96, 480, 176))
    center_text(draw, (270, 186, 610, 220), title, font(20, True), (20, 20, 20))
    lines = wrap(draw, body, font(15), 320)
    y = 228
    for line in lines:
        center_text(draw, (280, y, 600, y + 22), line, font(15), (70, 70, 74))
        y += 22
    button(draw, (290, 330, 590, 366), primary, True)
    if secondary:
        button(draw, (290, 376, 590, 410), secondary, False)


def mac_settings(image, dialog):
    draw = ImageDraw.Draw(image)
    round_rect(draw, (70, 48, 810, 460), 16, (214, 216, 222))
    draw.rectangle((70, 48, 250, 460), fill=(236, 237, 241))
    draw.ellipse((92, 64, 106, 78), fill=(255, 95, 86))
    draw.ellipse((114, 64, 128, 78), fill=(255, 189, 46))
    draw.ellipse((136, 64, 150, 78), fill=(39, 201, 63))
    draw.text((270, 62), "Privacy & Security", font=font(20, True), fill=(20, 20, 20))
    items = ["Wi-Fi", "Bluetooth", "Network", "General", "Appearance", "Privacy & Security", "Desktop & Dock", "Displays"]
    y = 110
    for item in items:
        if item == "Privacy & Security":
            round_rect(draw, (82, y - 4, 238, y + 22), 6, (10, 132, 255))
            draw.text((96, y), item, font=font(14), fill=(255, 255, 255))
        else:
            draw.text((96, y), item, font=font(14), fill=(40, 40, 40))
        y += 32
    round_rect(draw, (280, 120, 760, 168), 8, (255, 255, 255))
    draw.text((296, 134), "Allow applications from App Store & Known Developers", font=font(13), fill=(60, 60, 60))
    round_rect(draw, (280, 184, 760, 250), 8, (255, 255, 255))
    draw.text((296, 198), "“AI Hub” was blocked.", font=font(14), fill=(30, 30, 30))
    button(draw, (600, 206, 740, 234), "Open Anyway", False)
    if dialog == "confirm":
        round_rect(draw, (300, 150, 620, 400), 16, (255, 255, 255))
        icon(draw, (420, 168, 500, 248))
        center_text(draw, (320, 258, 600, 286), "Open “AI Hub”?", font(18, True), (20, 20, 20))
        lines = wrap(draw, "Apple is not able to verify that it is free from malware. Open it only if you trust its source.", font(13), 260)
        y = 292
        for line in lines:
            center_text(draw, (320, y, 600, y + 18), line, font(13), (70, 70, 74))
            y += 18
        button(draw, (340, 340, 580, 372), "Open Anyway", True)
    elif dialog == "password":
        round_rect(draw, (300, 140, 620, 390), 16, (255, 255, 255))
        center_text(draw, (320, 158, 600, 186), "Privacy & Security", font(18, True), (20, 20, 20))
        center_text(draw, (320, 190, 600, 212), "Enter your password to allow this.", font(13), (80, 80, 84))
        round_rect(draw, (340, 224, 580, 252), 6, (255, 255, 255), (190, 190, 196))
        draw.text((352, 230), "Your Mac user name", font=font(13), fill=(150, 150, 156))
        round_rect(draw, (340, 262, 580, 290), 6, (255, 255, 255), (10, 132, 255))
        draw.text((352, 268), "••••••••", font=font(14), fill=(20, 20, 20))
        button(draw, (340, 312, 580, 348), "OK", True)


def mac_app(image):
    draw = ImageDraw.Draw(image)
    round_rect(draw, (70, 48, 810, 456), 14, (28, 30, 34))
    draw.ellipse((88, 64, 102, 78), fill=(255, 95, 86))
    draw.ellipse((110, 64, 124, 78), fill=(255, 189, 46))
    draw.ellipse((132, 64, 146, 78), fill=(39, 201, 63))
    tabs = ["ChatGPT", "Claude", "Gemini", "DeepSeek", "Grok", "Perplexity"]
    x = 170
    for name in tabs:
        if name == "Claude":
            round_rect(draw, (x - 8, 58, x + 62, 84), 8, (109, 91, 255))
            draw.text((x, 64), name, font=font(13), fill=(255, 255, 255))
            x += 84
        else:
            draw.text((x, 64), name, font=font(13), fill=(210, 210, 214))
            x += 78
    round_rect(draw, (250, 360, 630, 408), 16, (58, 60, 66))
    draw.text((270, 374), "How can I help you today?", font=font(15), fill=(170, 170, 176))


def windows_alert(image, revealed):
    draw = ImageDraw.Draw(image)
    round_rect(draw, (150, 70, 730, 430), 0, (0, 120, 212))
    draw.text((700, 78), "×", font=font(16), fill=(255, 255, 255))
    draw.text((180, 110), "Windows protected your PC", font=font(28), fill=(255, 255, 255))
    lines = wrap(
        draw,
        "Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk.",
        font(15),
        500,
    )
    y = 170
    for line in lines:
        draw.text((180, y), line, font=font(15), fill=(255, 255, 255))
        y += 22
    draw.text((180, y + 16), "More info", font=font(15), fill=(255, 255, 255))
    draw.line((180, y + 36, 246, y + 36), fill=(255, 255, 255))
    if revealed:
        draw.text((180, y + 52), "App:          AI-Hub-Setup-1.4.0.exe", font=font(15), fill=(255, 255, 255))
        draw.text((180, y + 76), "Publisher:   Unknown publisher", font=font(15), fill=(255, 255, 255))
        button(draw, (430, 360, 560, 396), "Run anyway", False)
        button(draw, (572, 360, 700, 396), "Don't run", False)
    else:
        button(draw, (520, 360, 680, 396), "Don't run", False)


def windows_setup(image, done):
    draw = ImageDraw.Draw(image)
    round_rect(draw, (160, 120, 720, 420), 2, (248, 248, 248), (180, 180, 184))
    draw.rectangle((160, 120, 720, 152), fill=(255, 255, 255))
    draw.text((176, 128), "AI Hub Setup", font=font(13), fill=(40, 40, 40))
    icon(draw, (190, 176, 250, 236))
    draw.text((266, 176), "Installing AI Hub", font=font(18, True), fill=(20, 20, 20))
    draw.text((266, 204), "Please wait while AI Hub is being installed.", font=font(13), fill=(80, 80, 84))
    round_rect(draw, (190, 250, 690, 266), 3, (220, 220, 224))
    round_rect(draw, (190, 250, 690 if done else 360, 266), 3, (40, 180, 70))
    if done:
        draw.text((190, 284), "Done. AI Hub will start now.", font=font(14), fill=(40, 40, 40))


def paint(kind, stage):
    if kind == "mac":
        image = gradient((186, 198, 236), (168, 150, 214))
        draw = ImageDraw.Draw(image)
        menu_bar(draw)
        if stage == "blocked":
            mac_dialog(
                image,
                "“AI Hub” Not Opened",
                "Apple could not verify “AI Hub” is free of malware that may harm your Mac or compromise your privacy.",
                "Done",
                "Move to Trash",
            )
        elif stage == "settings":
            mac_settings(image, None)
        elif stage == "confirm":
            mac_settings(image, "confirm")
        elif stage == "password":
            mac_settings(image, "password")
        else:
            mac_app(image)
        return image
    image = gradient((18, 48, 110), (8, 24, 72))
    if stage == "smartscreen":
        windows_alert(image, False)
    elif stage == "more":
        windows_alert(image, True)
    elif stage == "install":
        windows_setup(image, False)
    else:
        windows_setup(image, True)
    return image


def with_chrome(image, number, text, pointer):
    frame = image.copy()
    draw = ImageDraw.Draw(frame)
    caption(draw, number, text)
    if pointer:
        cursor(draw, pointer[0], pointer[1])
    return frame


def move(frames, durations, start, end, number, text, base):
    steps = max(1, MOVE_MS // STEP_MS)
    for step in range(1, steps + 1):
        mix = step / steps
        point = (int(start[0] + (end[0] - start[0]) * mix), int(start[1] + (end[1] - start[1]) * mix))
        frames.append(with_chrome(base, number, text, point))
        durations.append(STEP_MS)


def hold(frames, durations, base, number, text, point, ms):
    frames.append(with_chrome(base, number, text, point))
    durations.append(ms)


def build(kind, scenes):
    frames = []
    durations = []
    samples = []
    for index, scene in enumerate(scenes):
        base = paint(kind, scene["stage"])
        samples.append(base)
        number = index + 1
        text = scene["caption"]
        start = scene["from"]
        end = scene["to"]
        hold(frames, durations, base, number, text, start, 280)
        move(frames, durations, start, end, number, text, base)
        hold(frames, durations, base, number, text, end, HOLD_MS if index < len(scenes) - 1 else END_MS)
    return frames, durations, samples


def save(frames, durations, samples, path):
    sheet = Image.new("RGB", (WIDTH, HEIGHT * len(samples)))
    for index, sample in enumerate(samples):
        sheet.paste(sample, (0, HEIGHT * index))
    palette = sheet.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    converted = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    converted[0].save(
        path,
        save_all=True,
        append_images=converted[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )


def main():
    parser = argparse.ArgumentParser(description="Rebuild the install instruction GIFs.")
    parser.add_argument("--out", default=str(ROOT / "assets"), help="Directory for the GIF files")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    mac_scenes = [
        {"stage": "blocked", "caption": MAC_CAPTIONS[0], "from": (700, 360), "to": (440, 348)},
        {"stage": "settings", "caption": MAC_CAPTIONS[1], "from": (200, 300), "to": (670, 220)},
        {"stage": "confirm", "caption": MAC_CAPTIONS[2], "from": (670, 220), "to": (460, 356)},
        {"stage": "password", "caption": MAC_CAPTIONS[3], "from": (460, 300), "to": (460, 330)},
        {"stage": "open", "caption": MAC_CAPTIONS[4], "from": (460, 330), "to": (440, 280)},
    ]
    win_scenes = [
        {"stage": "smartscreen", "caption": WIN_CAPTIONS[0], "from": (760, 240), "to": (210, 250)},
        {"stage": "more", "caption": WIN_CAPTIONS[1], "from": (210, 250), "to": (490, 378)},
        {"stage": "install", "caption": WIN_CAPTIONS[2], "from": (490, 378), "to": (440, 360)},
        {"stage": "done", "caption": WIN_CAPTIONS[3], "from": (440, 360), "to": (440, 340)},
    ]
    mac, mac_durations, mac_samples = build("mac", mac_scenes)
    win, win_durations, win_samples = build("win", win_scenes)
    save(mac, mac_durations, mac_samples, out / "install-macos.gif")
    save(win, win_durations, win_samples, out / "install-windows.gif")
    print(f"Wrote {out / 'install-macos.gif'} and {out / 'install-windows.gif'}")


if __name__ == "__main__":
    main()
