"""Rasterize Pi's captured ANSI frames for local visual inspection, not desktop screenshots."""
import json
import math
import re
import sys
import unicodedata
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

source = Path(sys.argv[1] if len(sys.argv) > 1 else ".reference/artifacts/ui/frames.json")
data = json.loads(source.read_text(encoding="utf-8"))
fonts = Path("C:/Windows/Fonts")
regular = ImageFont.truetype(str(fonts / "consola.ttf"), 20)
bold = ImageFont.truetype(str(fonts / "consolab.ttf"), 20)
cjk = ImageFont.truetype(str(fonts / "msyh.ttc"), 19)
cjk_bold = ImageFont.truetype(str(fonts / "msyhbd.ttc"), 19)
symbols = ImageFont.truetype(str(fonts / "seguisym.ttf"), 14)
cell = math.ceil(regular.getlength("M"))
row_height, margin, header = 27, 20, 58
esc = re.compile(r"\x1b\[([0-9;]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")
base = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]

def palette(n):
    if n < 16:
        return base[n]
    if n < 232:
        n -= 16
        levels = [0, 95, 135, 175, 215, 255]
        return (levels[n // 36], levels[(n // 6) % 6], levels[n % 6])
    return (8 + (n - 232) * 10,) * 3

for frame in data["frames"]:
    image = Image.new("RGB", (frame["columns"] * cell + margin * 2, frame["rows"] * row_height + header + margin), data["defaultBackground"])
    draw = ImageDraw.Draw(image)
    draw.text((margin, 14), frame["title"], font=cjk, fill="#bac4d5")
    for row, line in enumerate(frame["lines"][:frame["rows"]]):
        fg, bg, heavy = data["defaultForeground"], data["defaultBackground"], False
        col, pos = 0, 0
        while pos < len(line):
            if line[pos] == "\x1b":
                match = esc.match(line, pos)
                if not match:
                    pos += 1
                    continue
                if match.group(1) is not None:
                    values = [int(v or 0) for v in match.group(1).split(";")]
                    i = 0
                    while i < len(values):
                        value = values[i]
                        if value == 0:
                            fg, bg, heavy = data["defaultForeground"], data["defaultBackground"], False
                        elif value == 1:
                            heavy = True
                        elif value == 22:
                            heavy = False
                        elif value == 39:
                            fg = data["defaultForeground"]
                        elif value == 49:
                            bg = data["defaultBackground"]
                        elif 30 <= value <= 37 or 90 <= value <= 97:
                            fg = base[value - 30 if value < 90 else value - 90 + 8]
                        elif 40 <= value <= 47 or 100 <= value <= 107:
                            bg = base[value - 40 if value < 100 else value - 100 + 8]
                        elif value in (38, 48) and i + 2 < len(values):
                            color = None
                            if values[i + 1] == 2 and i + 4 < len(values):
                                color = tuple(values[i + 2:i + 5]); i += 4
                            elif values[i + 1] == 5:
                                color = palette(values[i + 2]); i += 2
                            if color is not None:
                                if value == 38: fg = color
                                else: bg = color
                        i += 1
                pos = match.end()
                continue
            char = line[pos]; pos += 1
            if unicodedata.combining(char) or ord(char) < 32 or char in "\ufe0f\u200d":
                continue
            width = 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
            if col + width > frame["columns"]:
                break
            x, y = margin + col * cell, header + row * row_height
            draw.rectangle((x, y, x + width * cell - 1, y + row_height - 1), fill=bg)
            font = (cjk_bold if heavy else cjk) if width == 2 else (bold if heavy else regular)
            if char in "✓▶○●▸▾↳":
                font = symbols
                draw.text((x + max(0, (cell - font.getlength(char)) / 2), y + 6), char, font=font, fill=fg)
            else:
                draw.text((x, y + 2), char, font=font, fill=fg)
            col += width
    target = source.parent / (frame["name"] + ".png")
    image.save(target)
    print(target)
