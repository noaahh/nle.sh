#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["garmin-fit-sdk", "pillow"]
# ///
"""Render a FIT activity as the ASCII elevation profile used on nle.sh.

Reads distance, altitude, and heart rate from a FIT file and prints:
  - the ASCII art (elevation curve, heart-rate dither fill, summit cross,
    km axis) to paste into the <pre> block
  - the data attributes to paste onto the .profile div (read by profile.js)
  - summary stats for the figcaption

Usage:
  uv run tools/profile.py activity.fit
  uv run tools/profile.py activity.fit --width 56 --height 11
  uv run tools/profile.py activity.fit --hr-zones 143,130,115
  uv run tools/profile.py activity.fit --terrain   # also emit data-dem/data-route
"""

import argparse
import base64
import io
import json
import math
import statistics
import sys
import urllib.request

from garmin_fit_sdk import Decoder, Stream


def load_series(path):
    messages, errors = Decoder(Stream.from_file(path)).read(convert_datetimes_to_dates=False)
    if errors:
        print(f"warning: decoder reported {len(errors)} error(s)", file=sys.stderr)
    dist, alt, hr, pos = [], [], [], []
    k = 180 / 2**31
    for r in messages.get("record_mesgs", []):
        d = r.get("distance")
        a = r.get("enhanced_altitude", r.get("altitude"))
        if d is None or a is None:
            continue
        dist.append(d)
        alt.append(a)
        hr.append(r.get("heart_rate"))
        la, lo = r.get("position_lat"), r.get("position_long")
        pos.append((la * k, lo * k) if la is not None and lo is not None else None)
    if not dist:
        sys.exit("no usable records in FIT file")
    return dist, alt, hr, pos


def terrain(dist, pos, n_route, gw=160, margin_km=2.5, zoom=14):
    """Heightmap around the track from AWS Terrarium tiles, plus the track in grid coords.

    Returns (dem bytes gw*gh quantized to 0..255, lo_m, hi_m, gh, cell_m, route [(gx, gy), ...]).
    """
    from PIL import Image

    pts = [(d, p) for d, p in zip(dist, pos) if p]
    lats = [p[0] for _, p in pts]
    lons = [p[1] for _, p in pts]
    dlat = margin_km / 111.32
    dlon = margin_km / (111.32 * math.cos(math.radians(statistics.mean(lats))))
    s, n = min(lats) - dlat, max(lats) + dlat
    w, e = min(lons) - dlon, max(lons) + dlon
    km_x = (e - w) * 111.32 * math.cos(math.radians((s + n) / 2))
    km_y = (n - s) * 111.32
    gh = round(gw * km_y / km_x)

    def px(lat, lon):  # global web-mercator pixel at `zoom`
        z = 256 * 2**zoom
        y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
        return (lon + 180) / 360 * z, (1 - y / math.pi) / 2 * z

    tiles = {}

    def elev(lat, lon):
        x, y = px(lat, lon)
        tx, ty = int(x // 256), int(y // 256)
        if (tx, ty) not in tiles:
            url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{zoom}/{tx}/{ty}.png"
            with urllib.request.urlopen(url) as r:
                tiles[tx, ty] = Image.open(io.BytesIO(r.read())).convert("RGB")
        rr, g, b = tiles[tx, ty].getpixel((int(x) % 256, int(y) % 256))
        return rr * 256 + g + b / 256 - 32768

    hs = [elev(n - (n - s) * j / (gh - 1), w + (e - w) * i / (gw - 1)) for j in range(gh) for i in range(gw)]
    lo, hi = min(hs), max(hs)
    dem = bytes(round((h - lo) / (hi - lo) * 255) for h in hs)

    total = pts[-1][0]
    route, j = [], 0
    for c in range(n_route):
        target = (c + 0.5) / n_route * total
        while j < len(pts) - 1 and pts[j][0] < target:
            j += 1
        la, lon = pts[j][1]
        route.append((round((lon - w) / (e - w) * (gw - 1), 1), round((n - la) / (n - s) * (gh - 1), 1)))
    return dem, lo, hi, gh, km_x * 1000 / (gw - 1), route


def resample(dist, values, width):
    """Mean of `values` per equal-distance column; None values are skipped."""
    total = dist[-1]
    cols = [[] for _ in range(width)]
    for d, v in zip(dist, values):
        if v is not None:
            cols[min(width - 1, int(d / total * width))].append(v)
    return [statistics.mean(c) if c else None for c in cols]


def smooth(xs, w):
    return [statistics.mean(xs[max(0, i - w):i + w + 1]) for i in range(len(xs))]


def hr_zones(shr):
    """Density thresholds from quantiles so any activity shows contrast."""
    qs = statistics.quantiles(shr, n=4)
    return qs[2], qs[1], qs[0]  # q75, q50, q25


def density(h, zones):
    solid, checker, sparse = zones
    if h >= solid:
        return 1
    if h >= checker:
        return 2
    if h >= sparse:
        return 4
    return 0


def render(rows, shr, zones, width, height):
    top = 1  # extra row for the summit cross
    grid = [[" "] * width for _ in range(height + top)]

    def put(r, x, ch):
        grid[height + top - 1 - r][x] = ch

    for x in range(width):
        r = rows[x]
        nxt = rows[x + 1] if x + 1 < width else r
        if shr:
            k = density(shr[x], zones)
            if k:
                for rr in range(0, r):
                    if (x + rr * 2) % k == 0:
                        put(rr, x, ".")
        if nxt == r:
            put(r, x, "_")
        elif nxt > r:
            for rr in range(r, nxt):
                put(rr, x, "/")
        else:
            for rr in range(nxt, r):
                put(rr, x, "\\")
    return grid, put


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("fit", help="path to the FIT file")
    ap.add_argument("--width", type=int, default=56, help="columns (default 56)")
    ap.add_argument("--height", type=int, default=11, help="rows for the curve (default 11)")
    ap.add_argument("--hr-zones", help="override dither thresholds as solid,checker,sparse bpm")
    ap.add_argument("--terrain", action="store_true", help="also emit the 3D terrain heightmap and route (fetches DEM tiles)")
    args = ap.parse_args()
    W, H = args.width, args.height

    dist, alt, hr, pos = load_series(args.fit)
    total_km = dist[-1] / 1000

    prof = smooth(resample(dist, alt, W), 1)
    lo, hi = min(prof), max(prof)
    rows = [round((p - lo) / (hi - lo) * (H - 1)) for p in prof]

    bpm = resample(dist, hr, W)
    have_hr = all(b is not None for b in bpm)
    shr = smooth(bpm, 2) if have_hr else None
    if args.hr_zones:
        zones = tuple(float(z) for z in args.hr_zones.split(","))
    elif have_hr:
        zones = hr_zones(shr)
    else:
        zones = None

    grid, put = render(rows, shr, zones, W, H)

    # summit cross and altitude label
    px = rows.index(max(rows))
    put(rows[px] + 1, px, "+")
    for j, c in enumerate(f"{round(max(alt))} m"):
        if px + 2 + j < W:
            put(rows[px] + 1, px + 2 + j, c)

    art = ["".join(row).rstrip() for row in grid]

    # km axis, tick step scaled to the activity's length
    step = 5 if total_km <= 25 else 10 if total_km <= 60 else 20 if total_km <= 160 else 50
    axis = ["-"] * W
    lab = [" "] * (W + 4)
    for km in range(0, int(total_km) + 1, step):
        x = round(km / total_km * (W - 1))
        axis[x] = "'"
        for j, c in enumerate(str(km)):
            lab[x + j] = c
    art.append("".join(axis))
    art.append("".join(lab).rstrip() + " km")

    print("\n".join(art))

    sa = smooth(alt, 15)
    ascent = round(sum(max(0, b - a) for a, b in zip(sa, sa[1:])))
    print()
    print(f"stats: {total_km:.1f} km, {ascent} m ascent, alt {round(min(alt))}-{round(max(alt))} m", end="")
    if have_hr:
        print(f", avg hr {round(statistics.mean(b for b in bpm))} bpm", end="")
        print(f", dither zones {tuple(round(z) for z in zones)} bpm", end="")
    print()
    print()
    print("paste onto the .profile div:")
    print(f'data-km="{total_km:.3f}"')
    print(f'data-prof="{json.dumps([round(p) for p in prof], separators=(",", ":"))}"')
    if have_hr:
        print(f'data-bpm="{json.dumps([round(b) for b in bpm], separators=(",", ":"))}"')
    if args.terrain:
        # four route points per art column, so column c sits at route[4c + 2]
        dem, lo, hi, gh, cell_m, route = terrain(dist, pos, W * 4)
        print(f'data-dem="{len(dem) // gh},{gh},{round(lo)},{round(hi)},{round(cell_m)},{base64.b64encode(dem).decode()}"')
        print(f'data-route="{json.dumps([v for p in route for v in p], separators=(",", ":"))}"')


if __name__ == "__main__":
    main()
