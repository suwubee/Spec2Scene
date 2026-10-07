#!/usr/bin/env python3
"""Analyze the actual playback file. Automatic sections are candidates for review."""
import argparse
import hashlib
import json
import math
import subprocess
import tempfile
from pathlib import Path


def fit_grid(times, strengths, duration, bpm_hint):
    import numpy as np
    if duration <= 0 or not 30 <= bpm_hint <= 300:
        raise ValueError('positive duration and BPM in 30..300 required')
    times = np.asarray(times)
    strengths = np.asarray(strengths)
    if len(times) != len(strengths) or len(times) < 2 or not np.all(np.isfinite(strengths)):
        raise ValueError('invalid envelope')
    if float(np.max(strengths)) < 1e-10:
        raise ValueError('silent input: a beat grid cannot be inferred')
    strengths = strengths / np.max(strengths)
    best = (-1, bpm_hint, 0)
    for bpm in np.linspace(bpm_hint * .99, bpm_hint * 1.01, 81):
        period = 60 / bpm
        for phase in np.linspace(0, period, 96, endpoint=False):
            grid = np.arange(phase, duration, period)
            if not len(grid):
                continue
            score = float(np.interp(grid, times, strengths).mean())
            if score > best[0]:
                best = (score, float(bpm), float(phase))
    score, bpm, phase = best
    beats = np.arange(phase, duration, 60 / bpm)
    residuals = []
    for start in range(0, len(beats), 16):
        window = beats[start:start + 16]
        if len(window) < 4:
            continue
        offsets = np.linspace(-.12, .12, 121)
        values = [np.interp(window + offset, times, strengths).mean() for offset in offsets]
        residuals.append(float(offsets[int(np.argmax(values))] * 1000))
    return bpm, phase, score, beats, residuals


def analyze(source, bpm_hint, beats_per_bar=4):
    import numpy as np
    import librosa
    audio, rate = librosa.load(source, sr=22050, mono=True)
    duration = len(audio) / rate
    if duration < 1 or np.max(np.abs(audio)) < 1e-8:
        raise ValueError('input must contain at least one second of non-silent audio')
    hop = 128
    percussive = librosa.effects.percussive(audio)
    envelope = librosa.onset.onset_strength(y=percussive, sr=rate, hop_length=hop)
    times = librosa.times_like(envelope, sr=rate, hop_length=hop)
    bpm, phase, score, beats, residuals = fit_grid(times, envelope, duration, bpm_hint)
    rms = librosa.feature.rms(y=audio, hop_length=hop)[0]
    rms_times = librosa.times_like(rms, sr=rate, hop_length=hop)
    # A spectral onset has window latency: expose it, never silently claim exact musical downbeats.
    bars = []
    for i, start in enumerate(beats[::beats_per_bar]):
        end = min(duration, start + beats_per_bar * 60 / bpm)
        samples = rms[(rms_times >= start) & (rms_times < end)]
        bars.append({'index': i, 'start': float(start), 'end': float(end),
                     'energy': float(samples.mean()) if len(samples) else 0})
    sections = []
    begin = 0
    for i in range(1, len(bars) + 1):
        change = i < len(bars) and abs(bars[i]['energy'] - bars[i-1]['energy']) > max(.02, bars[i-1]['energy'] * .6)
        if i == len(bars) or change:
            sections.append({'barStart': begin, 'barEnd': i, 'label': 'candidate',
                             'energy': float(np.mean([b['energy'] for b in bars[begin:i]]))})
            begin = i
    return {'schema': 1, 'sha256': hashlib.sha256(Path(source).read_bytes()).hexdigest(),
            'duration': duration, 'bpm': bpm, 'firstBeat': phase, 'beatsPerBar': beats_per_bar,
            'beats': [float(t) for t in beats], 'bars': bars, 'sections': sections,
            'analysis': {'gridScore': score, 'residualMs': residuals,
                         'medianAbsDriftMs': float(np.median(np.abs(residuals))) if residuals else None,
                         'maxAbsDriftMs': max(map(abs, residuals), default=None),
                         'reviewRequired': True,
                         'method': 'percussive spectral grid; bar phase and semantic sections need human review'}}


def save_plot(result, output):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(2, 1, figsize=(12, 5))
    axes[0].plot([b['start'] for b in result['bars']], [b['energy'] for b in result['bars']])
    axes[0].set(xlabel='Playback time (s)', ylabel='RMS', title=f"Grid {result['bpm']:.3f} BPM; review section candidates")
    axes[1].plot(result['analysis']['residualMs'])
    axes[1].set(xlabel='16-beat window', ylabel='Residual (ms)')
    fig.tight_layout()
    fig.savefig(output)
    plt.close(fig)


def selftest():
    import numpy as np
    import soundfile as sf
    times = np.arange(0, 20, .005)
    envelope = np.exp(-((np.mod(times - .125 + .25, .5) - .25) / .012) ** 2)
    bpm, phase, score, beats, residual = fit_grid(times, envelope, 20, 120)
    assert abs(bpm - 120) < .1 and abs(phase - .125) < .012 and len(beats) == 40
    assert max(map(abs, residual)) < 12 and score > .8
    try:
        fit_grid(times, np.zeros_like(times), 20, 120)
        raise AssertionError('silence accepted')
    except ValueError:
        pass
    with tempfile.TemporaryDirectory(prefix='scene-music-') as folder:
        wave = np.zeros(22050 * 8)
        for position in np.arange(.125, 8, .5):
            start = int(position * 22050)
            length = min(1102, len(wave) - start)
            wave[start:start+length] = np.sin(np.arange(length) * 2 * math.pi * 440 / 22050) * np.exp(-np.arange(length) / 180)
        source = Path(folder) / 'synthetic.wav'
        sf.write(source, wave, 22050)
        result = analyze(source, 120)
        assert 118.8 <= result['bpm'] <= 121.2 and len(result['bars']) >= 3
        save_plot(result, Path(folder) / 'analysis.svg')
    print('PASS analyze_song selftest: grid, drift, silence rejection, synthesized audio analysis, plot')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--out', type=Path, help='JSON output; SVG plot uses same stem')
    parser.add_argument('--bpm-hint', type=float)
    parser.add_argument('--beats-per-bar', type=int, default=4)
    parser.add_argument('--tempo', type=float, default=1, help='Optional rubberband tempo multiplier; reanalyze transformed WAV')
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.input or not args.out or args.bpm_hint is None:
        parser.error('--input, --out and --bpm-hint are required')
    if not 1 <= args.beats_per_bar <= 12 or not .25 <= args.tempo <= 4:
        parser.error('beats-per-bar 1..12; tempo .25..4')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    source = args.input
    if args.tempo != 1:
        source = args.out.with_suffix('.tempo.wav')
        if source.exists():
            parser.error('transformed output already exists')
        subprocess.run(['rubberband', '--tempo', str(args.tempo), str(args.input), str(source)], check=True)
    result = analyze(source, args.bpm_hint * args.tempo, args.beats_per_bar)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    save_plot(result, args.out.with_suffix('.svg'))
    print(json.dumps({'bpm': result['bpm'], 'analysis': result['analysis']}))


if __name__ == '__main__':
    main()
