"""Regenerate icons: uv run --with pillow --with cairosvg python scripts/generate-icons.py"""

from io import BytesIO
from pathlib import Path

import cairosvg
from PIL import Image


public = Path(__file__).resolve().parents[1] / "public"
public.mkdir(exist_ok=True)
artwork = """  <circle cx="7" cy="25" r="2"/>
  <path d="M9 25h11a4.5 4.5 0 0 0 0-9h-8a4.5 4.5 0 0 1 0-9h11"/>
  <circle cx="25" cy="7" r="2"/>"""


def vector(color, viewbox="0 0 32 32", style=""):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" fill="none" stroke="{color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <title>wazex</title>
{style}{artwork}
</svg>
"""


def raster(svg, size, color):
    data = cairosvg.svg2png(
        bytestring=svg.encode(), output_width=size * 3, output_height=size * 3
    )
    rendered = Image.open(BytesIO(data)).convert("RGBA").resize(
        (size, size), Image.Resampling.LANCZOS
    )
    image = Image.new("RGBA", (size, size), (*color, 0))
    image.putalpha(rendered.getchannel("A"))
    return image


for mode, color, rgb in [
    ("light", "#1f1f1f", (31, 31, 31)),
    ("dark", "#f5f5f5", (245, 245, 245)),
]:
    svg = vector(color)
    (public / f"icon-{mode}.svg").write_text(svg)
    suffix = "-dark" if mode == "dark" else ""
    raster(svg, 32, rgb).save(public / f"favicon{suffix}.png")
    raster(svg, 48, rgb).save(
        public / f"favicon{suffix}.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)]
    )

style = """  <style>
    :root { color: #1f1f1f; }
    @media (prefers-color-scheme: dark) { :root { color: #f5f5f5; } }
  </style>
"""
(public / "icon.svg").write_text(vector("currentColor", style=style))
touch = raster(vector("#f5f5f5", "-4 -4 40 40"), 180, (245, 245, 245))
touch.save(public / "apple-touch-icon.png")
touch.save(public / "apple-touch-icon-precomposed.png")
