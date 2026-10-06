#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["garmin-fit-sdk", "numpy", "rasterio", "pyproj"]
# ///
"""Build a compact swissALTI3D heightfield for the existing terrain renderer.

uv run tools/swisstopo.py activity.fit --output terrain/schynige-platte.json
Downloads public 2 m GeoTIFF tiles once into --cache; the site uses only the
resampled JSON. Coordinates and margins match tools/profile.py's Terrarium map.
"""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import io
import json
import math
from pathlib import Path
import statistics
import urllib.parse
import urllib.request

import numpy as np
from pyproj import Transformer
import rasterio
from profile import load_series


def get(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fit")
    parser.add_argument("--width", type=int, default=512)
    parser.add_argument("--columns", type=int, default=56)
    parser.add_argument("--cache", type=Path, default=Path("/private/tmp/nle-swisstopo-cache"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.width < 16 or args.columns < 2:
        parser.error("width must be at least 16 and columns at least 2")

    distance, _, _, positions = load_series(args.fit)
    points = [(d, p) for d, p in zip(distance, positions) if p]
    if not points:
        parser.error("activity has no GPS positions")
    lats = [p[0] for _, p in points]
    lons = [p[1] for _, p in points]
    dy = 2.5 / 111.32
    dx = 2.5 / (111.32 * math.cos(math.radians(statistics.mean(lats))))
    west, south, east, north = min(lons) - dx, min(lats) - dy, max(lons) + dx, max(lats) + dy
    bbox = [west, south, east, north]
    width_m = (east - west) * 111320 * math.cos(math.radians((south + north) / 2))
    height_m = (north - south) * 111320
    gw, gh = args.width, round(args.width * height_m / width_m)
    lon, lat = np.meshgrid(np.linspace(west, east, gw), np.linspace(north, south, gh))
    x, y = Transformer.from_crs(4326, 2056, always_xy=True).transform(lon, lat)
    heights = np.full((gh, gw), np.nan)

    url = "https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissalti3d/items?" + urllib.parse.urlencode({
        "bbox": ",".join(map(str, bbox)), "limit": 100,
    })
    latest = {}
    while url:
        page = json.loads(get(url))
        for item in page["features"]:
            tile = item["id"].rsplit("_", 1)[-1]
            for name, asset in item["assets"].items():
                if name.endswith(".tif") and asset.get("gsd") == 2 and asset.get("proj:epsg") == 2056:
                    if tile not in latest or item["id"] > latest[tile]["item"]:
                        latest[tile] = {"item": item["id"], "name": name, "url": asset["href"]}
        url = next((link["href"] for link in page["links"] if link["rel"] == "next"), None)
    if not latest:
        raise RuntimeError("No 2 m swissALTI3D tiles found for this activity")
    print(f"Sampling {len(latest)} tiles into {gw} x {gh}, {width_m / (gw - 1):.1f} m spacing", flush=True)
    args.cache.mkdir(parents=True, exist_ok=True)

    def sample(tile):
        cached = args.cache / tile["name"]
        if not cached.exists():
            cached.write_bytes(get(tile["url"]))
        with rasterio.open(io.BytesIO(cached.read_bytes())) as dataset:
            bounds = dataset.bounds
            mask = (x >= bounds.left) & (x < bounds.right) & (y > bounds.bottom) & (y <= bounds.top)
            if not mask.any():
                return
            data = dataset.read(1)
            col, row = ~dataset.transform * (x[mask], y[mask])
            col = np.clip(col - .5, 0, dataset.width - 1.000001)
            row = np.clip(row - .5, 0, dataset.height - 1.000001)
            ix, iy = col.astype(int), row.astype(int)
            fx, fy = col - ix, row - iy
            corners = np.array([data[iy, ix], data[iy, ix + 1], data[iy + 1, ix], data[iy + 1, ix + 1]])
            if not np.isfinite(corners).all() or (dataset.nodata is not None and (corners == dataset.nodata).any()):
                raise RuntimeError(f"Missing elevation samples in {tile['name']}")
            heights[mask] = ((corners[0] * (1 - fx) + corners[1] * fx) * (1 - fy)
                             + (corners[2] * (1 - fx) + corners[3] * fx) * fy)

    with ThreadPoolExecutor(max_workers=4) as executor:
        for i, _ in enumerate(executor.map(sample, latest.values()), 1):
            if i % 20 == 0:
                print(f"Sampled {i}/{len(latest)} tiles", flush=True)
    if not np.isfinite(heights).all():
        raise RuntimeError(f"Incomplete coverage: {np.isnan(heights).sum()} missing grid cells")
    low, high = math.floor(heights.min()), math.ceil(heights.max())
    encoded = np.rint((heights - low) / (high - low) * 65535).astype("<u2")
    route, j = [], 0
    for c in range(args.columns * 4):
        target = (c + .5) / (args.columns * 4) * points[-1][0]
        while j < len(points) - 1 and points[j][0] < target:
            j += 1
        la, lo = points[j][1]
        route.extend([round((lo - west) / (east - west) * (gw - 1), 2),
                      round((north - la) / (north - south) * (gh - 1), 2)])
    result = {
        "source": "swissALTI3D", "attribution": "©swisstopo",
        "sourceUrl": "https://www.swisstopo.admin.ch/en/height-model-swissalti3d",
        "bbox": bbox, "sourceGridMeters": 2,
        "dem": [gw, gh, low, high, round(width_m / (gw - 1), 4), base64.b64encode(encoded.tobytes()).decode(), "u16"],
        "route": route, "tiles": list(latest.values()),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    print(json.dumps({"output": str(args.output), "bytes": args.output.stat().st_size,
                      "grid": [gw, gh], "cell_m": result["dem"][4], "range_m": [low, high],
                      "vertical_step_m": (high - low) / 65535, "tiles": len(latest)}))


if __name__ == "__main__":
    main()
