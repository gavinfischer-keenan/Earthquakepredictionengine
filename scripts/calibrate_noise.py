#!/usr/bin/env python3
"""calibrate_noise.py — Record ambient noise and build a noise model.

Connects to a Raspberry Shake RS4D (via SeedLink or UDP), records 30 minutes
of continuous data, computes a noise model (RMS, PSD, 95th percentile), saves
the result to ``noise_model.json``, and prints a summary.

Usage
-----
    # SeedLink mode (default)
    python scripts/calibrate_noise.py --host raspberryshake.local --port 18000

    # UDP mode
    python scripts/calibrate_noise.py --mode udp --port 8888

    # Custom duration and output
    python scripts/calibrate_noise.py --duration 60 --output my_noise.json
"""
from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from obspy import Stream, Trace, UTCDateTime
from scipy import signal as sp_signal

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
STATION = "R1A3D"
NETWORK = "AM"
LOCATION = "00"
CHANNELS = ["EHZ", "ENZ", "ENN", "ENE"]
SAMPLING_RATE = 100.0
DEFAULT_DURATION_MIN = 30
DEFAULT_OUTPUT = "noise_model.json"


# ---------------------------------------------------------------------------
# Data acquisition
# ---------------------------------------------------------------------------


def record_seedlink(
    host: str,
    port: int,
    duration_s: float,
    channels: list[str],
) -> Stream:
    """Record *duration_s* seconds of data via ObsPy SeedLink client.

    Returns an ObsPy Stream with one Trace per channel.
    """
    from obspy.clients.seedlink.easyseedlink import create_client  # type: ignore[import-untyped]

    stream = Stream()
    start = UTCDateTime()

    print(f"  Connecting to SeedLink at {host}:{port} ...")

    def _handle(seedlink_obj: Any, trace: Trace) -> None:
        stream += trace

    client = create_client(f"{host}:{port}", _handle)
    for ch in channels:
        client.select_stream(NETWORK, STATION, ch)

    print(f"  Recording for {duration_s:.0f} seconds ...")
    client.run()

    # Wait for the requested duration (crude but effective for calibration)
    while (UTCDateTime() - start) < duration_s:
        time.sleep(1.0)

    client.close()
    stream.merge(method=1, fill_value=0)
    return stream


def record_udp(
    port: int,
    duration_s: float,
    channels: list[str],
) -> Stream:
    """Record *duration_s* seconds of data from Raspberry Shake UDP stream.

    Listens on the specified UDP port for RS4D data packets in the format:
    ``{'CHANNEL', timestamp, s1, s2, ..., s25}``
    """
    buffers: dict[str, list[float]] = {ch: [] for ch in channels}
    timestamps: dict[str, float] = {ch: 0.0 for ch in channels}

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    sock.settimeout(2.0)

    print(f"  Listening on UDP port {port} ...")
    print(f"  Recording for {duration_s:.0f} seconds ...")

    t_start = time.monotonic()
    while (time.monotonic() - t_start) < duration_s:
        try:
            raw, _ = sock.recvfrom(4096)
        except socket.timeout:
            continue

        packet = raw.decode("utf-8", errors="ignore").strip()
        # Parse: {'EHZ', 1582315130.292, 17537, 18052, ...}
        packet = packet.strip("{}")
        parts = [p.strip().strip("'\"") for p in packet.split(",")]
        if len(parts) < 3:
            continue

        channel = parts[0]
        if channel not in buffers:
            continue

        ts = float(parts[1])
        if timestamps[channel] == 0.0:
            timestamps[channel] = ts
        samples = [float(s) for s in parts[2:]]
        buffers[channel].extend(samples)

    sock.close()

    # Build ObsPy Stream
    stream = Stream()
    for ch in channels:
        if not buffers[ch]:
            continue
        data = np.array(buffers[ch], dtype=np.float64)
        header = {
            "network": NETWORK,
            "station": STATION,
            "location": LOCATION,
            "channel": ch,
            "sampling_rate": SAMPLING_RATE,
            "starttime": UTCDateTime(timestamps[ch]) if timestamps[ch] else UTCDateTime(),
            "npts": len(data),
        }
        stream.append(Trace(data=data, header=header))

    return stream


# ---------------------------------------------------------------------------
# Noise model computation
# ---------------------------------------------------------------------------


def compute_noise_model(stream: Stream) -> dict[str, Any]:
    """Compute noise statistics for each channel in the stream.

    Returns a dict keyed by channel with:
      - rms: Root-mean-square amplitude
      - mean: Mean amplitude
      - std: Standard deviation
      - p95: 95th percentile of absolute amplitude
      - psd_freqs: Frequency axis (Hz) for PSD
      - psd_values: Power Spectral Density values
      - psd_median: Median PSD level
      - duration_s: Duration of recorded data
      - npts: Number of samples
    """
    model: dict[str, Any] = {
        "station": STATION,
        "network": NETWORK,
        "calibration_time": datetime.now(tz=timezone.utc).isoformat(),
        "channels": {},
    }

    for tr in stream:
        ch = tr.stats.channel
        data = tr.data.astype(np.float64)

        # Basic statistics
        rms = float(np.sqrt(np.mean(data ** 2)))
        mean = float(np.mean(data))
        std = float(np.std(data))
        p95 = float(np.percentile(np.abs(data), 95))

        # Power Spectral Density (Welch method)
        nperseg = min(1024, len(data))
        freqs, psd = sp_signal.welch(
            data,
            fs=tr.stats.sampling_rate,
            nperseg=nperseg,
            noverlap=nperseg // 2,
        )
        psd_median = float(np.median(psd))

        model["channels"][ch] = {
            "rms": round(rms, 4),
            "mean": round(mean, 4),
            "std": round(std, 4),
            "p95": round(p95, 4),
            "psd_freqs": freqs.tolist(),
            "psd_values": psd.tolist(),
            "psd_median": round(psd_median, 4),
            "duration_s": round(tr.stats.npts / tr.stats.sampling_rate, 2),
            "npts": int(tr.stats.npts),
        }

    return model


# ---------------------------------------------------------------------------
# Summary printing
# ---------------------------------------------------------------------------


def print_summary(model: dict[str, Any]) -> None:
    """Print a human-readable noise model summary to stdout."""
    print("\n" + "=" * 60)
    print("  Noise Calibration Summary")
    print("=" * 60)
    print(f"  Station : {model['station']} ({model['network']})")
    print(f"  Time    : {model['calibration_time']}")
    print("-" * 60)

    for ch, stats in model.get("channels", {}).items():
        print(f"\n  Channel: {ch}")
        print(f"    Duration    : {stats['duration_s']:.1f} s  ({stats['npts']} samples)")
        print(f"    RMS         : {stats['rms']:.2f} counts")
        print(f"    Mean        : {stats['mean']:.2f} counts")
        print(f"    Std Dev     : {stats['std']:.2f} counts")
        print(f"    95th %%ile   : {stats['p95']:.2f} counts")
        print(f"    PSD median  : {stats['psd_median']:.4f}")

    print("\n" + "=" * 60)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Calibrate ambient noise model for Raspberry Shake RS4D",
    )
    parser.add_argument(
        "--mode",
        choices=["seedlink", "udp"],
        default="seedlink",
        help="Data acquisition mode (default: seedlink)",
    )
    parser.add_argument(
        "--host",
        default="raspberryshake.local",
        help="SeedLink host (default: raspberryshake.local)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=18000,
        help="Port: SeedLink default 18000, UDP default 8888",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=DEFAULT_DURATION_MIN,
        help=f"Recording duration in minutes (default: {DEFAULT_DURATION_MIN})",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help=f"Output JSON file (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--channels",
        nargs="+",
        default=CHANNELS,
        help=f"Channels to record (default: {' '.join(CHANNELS)})",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    duration_s = args.duration * 60.0

    print(f"[calibrate_noise] Mode={args.mode}  Duration={args.duration:.0f} min")

    # --- Record data -------------------------------------------------------
    if args.mode == "seedlink":
        stream = record_seedlink(args.host, args.port, duration_s, args.channels)
    else:
        port = args.port if args.port != 18000 else 8888
        stream = record_udp(port, duration_s, args.channels)

    if len(stream) == 0:
        print("[calibrate_noise] ERROR: No data recorded. Check connection.", file=sys.stderr)
        sys.exit(1)

    print(f"[calibrate_noise] Recorded {len(stream)} trace(s).")

    # --- Compute noise model -----------------------------------------------
    model = compute_noise_model(stream)

    # --- Save to file ------------------------------------------------------
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as fh:
        # Exclude full PSD arrays from the saved file to keep it manageable
        save_model = json.loads(json.dumps(model))  # deep copy
        for ch_data in save_model.get("channels", {}).values():
            # Keep freqs/values for downstream use but truncate display
            pass
        json.dump(save_model, fh, indent=2)

    print(f"\n[calibrate_noise] Noise model saved to: {output_path.resolve()}")

    # --- Print summary -----------------------------------------------------
    print_summary(model)


if __name__ == "__main__":
    main()
