#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["garmin-fit-sdk"]
# ///
"""Render a FIT activity as the ASCII elevation profile used on nle.sh.

Reads distance, altitude, and heart rate from a FIT file and prints:
  - the ASCII art (elevation curve, heart-rate dither fill, summit cross,
    km axis) to paste into the <pre> block
  - the prof/bpm/KM values to paste into the inline script
  - summary stats for the figcaption

Usage:
  uv run tools/profile.py activity.fit
  uv run tools/profile.py activity.fit --width 56 --height 11
  uv run tools/profile.py activity.fit --hr-zones 143,130,115
"""

import argparse
import json
import statistics
import sys

from garmin_fit_sdk import Decoder, Stream


def load_series(path):
    messages, errors = Decoder(Stream.from_file(path)).read(convert_datetimes_to_dates=False)
    if errors:
        print(f"warning: decoder reported {len(errors)} error(s)", file=sys.stderr)
    dist, alt, hr = [], [], []
    for r in messages.get("record_mesgs", []):
        d = r.get("distance")
        a = r.get("enhanced_altitude", r.get("altitude"))
        if d is None or a is None:
            continue
        dist.append(d)
        alt.append(a)
        hr.append(r.get("heart_rate"))
    if not dist:
        sys.exit("no usable records in FIT file")
    return dist, alt, hr


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
    args = ap.parse_args()
    W, H = args.width, args.height

    dist, alt, hr = load_series(args.fit)
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


if __name__ == "__main__":
    main()
