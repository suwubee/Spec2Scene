#!/usr/bin/env python3
"""Local musical evidence: candidate vocal activity, spectral entries, recurrence, pitch and editable line timing."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def align_lines(times, activity, count, duration):
    import numpy as np
    if count < 1 or count > 500 or duration <= 0:
        raise ValueError('line count 1..500 and positive duration required')
    times, activity = np.asarray(times), np.asarray(activity)
    if len(times) != len(activity) or len(times) < 2 or not np.all(np.isfinite(activity)):
        raise ValueError('invalid activity samples')
    mass = np.maximum(activity, 0) * np.gradient(times)
    if mass.sum() < 1e-8:
        return {'status': 'SKIP', 'reason': 'No vocal activity candidate; manual timing required', 'lines': []}
    cumulative = np.cumsum(mass)
    boundaries = np.interp(np.linspace(0, cumulative[-1], count + 1), cumulative, times)
    boundaries[0], boundaries[-1] = 0, duration
    return {'status': 'CANDIDATE', 'method': 'equal activity mass; no text or phoneme recognition',
            'reviewRequired': True, 'lines': [{'index': i, 'start': float(boundaries[i]), 'end': float(boundaries[i+1]),
                                              'locked': False} for i in range(count)]}


def understand(source, vocal_stem=None, line_count=0, max_seconds=600):
    import numpy as np
    import librosa
    info = librosa.get_duration(path=source)
    if info <= 0 or info > max_seconds:
        raise ValueError('audio duration exceeds bounded analysis budget')
    y, sr = librosa.load(source, sr=16000, mono=True)
    hop, n_fft = 512, 2048
    spectrum = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))
    times = librosa.times_like(spectrum, sr=sr, hop_length=hop)
    frequencies = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    energy = np.sqrt(np.mean(spectrum**2, axis=0))
    bands = {}
    entries = []
    for label, low, high in [('low', 30, 200), ('body', 200, 1000), ('presence', 1000, 4000), ('air', 4000, 8000)]:
        band = spectrum[(frequencies >= low) & (frequencies < high)]
        value = np.sqrt(np.mean(band**2, axis=0))
        flux = np.maximum(0, np.diff(band, axis=1, prepend=band[:, :1])).mean(axis=0)
        threshold = float(np.median(flux) + 2 * np.std(flux))
        indices = np.flatnonzero(flux > max(threshold, 1e-7))
        bands[label] = {'energy': value.tolist(), 'flux': flux.tolist()}
        last = -10
        for index in indices:
            if times[index] - last >= .4:
                entries.append({'time': float(times[index]), 'band': label, 'kind': 'spectral-entry-candidate'})
                last = times[index]
    vy = y
    if vocal_stem:
        vy, _ = librosa.load(vocal_stem, sr=sr, mono=True)
        if abs(len(vy) - len(y)) > sr * .1:
            raise ValueError('vocal stem must match playback duration')
        vy = np.pad(vy[:len(y)], (0, max(0, len(y)-len(vy))))
    vs = np.abs(librosa.stft(vy, n_fft=n_fft, hop_length=hop))
    vocal_band = vs[(frequencies >= 180) & (frequencies < 3800)]
    power = np.mean(vocal_band**2, axis=0)
    flatness = np.exp(np.mean(np.log(vocal_band+1e-8), axis=0)) / (np.mean(vocal_band, axis=0)+1e-8)
    activity = np.clip(power/(np.percentile(power, 85)+1e-8), 0, 1) * np.clip(1-flatness*2, 0, 1)
    pitch, magnitude = librosa.piptrack(S=vs, sr=sr, fmin=65, fmax=1200)
    peak = magnitude.argmax(axis=0)
    f0 = pitch[peak, np.arange(pitch.shape[1])]
    confidence = magnitude.max(axis=0)/(vs.max(axis=0)+1e-8)
    f0[(confidence < .2) | (energy < max(1e-6, energy.max()*.015))] = 0
    # Aggregate before similarity: bounded quadratic memory even for a long recording.
    chroma = librosa.feature.chroma_stft(S=spectrum**2, sr=sr, hop_length=hop)
    stride = max(1, int(np.ceil(chroma.shape[1]/300)))
    blocks = np.stack([chroma[:, i:i+stride].mean(axis=1) for i in range(0, chroma.shape[1], stride)], axis=1)
    norm = blocks/(np.linalg.norm(blocks, axis=0, keepdims=True)+1e-8)
    similarity = norm.T @ norm
    recurrent = []
    separation = max(2, int(4 / (hop/sr*stride)))
    for i in range(similarity.shape[0]):
        if i+separation >= len(similarity):
            continue
        j = i+separation+int(np.argmax(similarity[i, i+separation:]))
        if similarity[i, j] > .92 and (not recurrent or times[min(i*stride,len(times)-1)]-recurrent[-1]['a'] > 2):
            recurrent.append({'a': float(times[min(i*stride,len(times)-1)]), 'b': float(times[min(j*stride,len(times)-1)]), 'similarity': float(similarity[i,j])})
    result = {'schema': 2, 'duration': len(y)/sr, 'times': times.tolist(), 'energy': energy.tolist(),
              'vocalActivity': {'values': activity.tolist(), 'method': 'local-stem harmonic activity' if vocal_stem else 'mixture harmonic/band heuristic',
                                'confidence': 'candidate', 'reviewRequired': True},
              'bands': bands, 'entries': entries, 'pitchHz': f0.tolist(), 'pitchConfidence': confidence.tolist(),
              'repeatCandidates': recurrent, 'selfSimilarity': similarity.tolist(),
              'similarityTimes': times[::stride].tolist(),
              'limitations': ['Band entries are not instrument identities.', 'Harmonic instruments may be mistaken for voice.',
                              'Dominant spectral pitch is not a polyphonic melody transcription.', 'Line timing requires manual correction.']}
    if line_count:
        result['alignment'] = align_lines(times, activity, line_count, len(y)/sr)
    mel = librosa.feature.melspectrogram(S=spectrum**2, sr=sr, n_mels=80)
    return result, librosa.power_to_db(mel, ref=np.max)


def save_visuals(result, mel_db, output):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np
    fig, axes = plt.subplots(4, 1, figsize=(13, 10), constrained_layout=True)
    duration = result['duration']
    axes[0].imshow(mel_db, origin='lower', aspect='auto', extent=[0,duration,0,80], cmap='magma', vmin=-70, vmax=0)
    axes[0].set(ylabel='Mel band', title='Local musical evidence — candidates require listening')
    axes[1].plot(result['times'], result['energy'], label='Energy')
    axes[1].plot(result['times'], result['vocalActivity']['values'], label='Vocal candidate', alpha=.75)
    axes[1].legend(); axes[1].set(ylabel='Energy / activity')
    pitch = np.asarray(result['pitchHz']); pitch[pitch == 0] = np.nan
    axes[2].plot(result['times'], pitch, '.', markersize=2); axes[2].set(ylabel='Dominant pitch (Hz)', xlabel='Playback seconds')
    axes[3].imshow(result['selfSimilarity'], origin='lower', aspect='auto', extent=[0,duration,0,duration], cmap='viridis', vmin=0, vmax=1)
    axes[3].set(xlabel='Playback seconds', ylabel='Repeat evidence (s)')
    fig.savefig(output, dpi=120); plt.close(fig)


def separate_local(source, output, model, command):
    if not model or not model.is_dir() or not any(model.iterdir()):
        raise ValueError('Local model directory must exist and contain user-downloaded weights')
    argv = json.loads(command or '[]')
    if not isinstance(argv, list) or not argv or not all(isinstance(x,str) for x in argv):
        raise ValueError('separator command must be a JSON argv array')
    for placeholder in ['{input}', '{output}', '{model}']:
        if not any(placeholder in arg for arg in argv):
            raise ValueError('separator command requires input, output and model placeholders')
    values = {'{input}':str(source.resolve()), '{output}':str(output.resolve()), '{model}':str(model.resolve())}
    for key, value in values.items():
        argv = [arg.replace(key,value) for arg in argv]
    env = {**os.environ, 'HF_HUB_OFFLINE':'1', 'TRANSFORMERS_OFFLINE':'1', 'OMP_NUM_THREADS':'1', 'OPENBLAS_NUM_THREADS':'1'}
    subprocess.run(argv, check=True, env=env, timeout=600)
    if not output.is_file():
        raise ValueError('separator did not produce the configured vocal stem')


def selftest():
    import numpy as np
    import soundfile as sf
    sr = 16000; t = np.arange(sr*8)/sr
    y = .25*np.sin(2*np.pi*220*t)*((t % 4) < 2)
    with tempfile.TemporaryDirectory(prefix='scene-understand-') as folder:
        file = Path(folder)/'synthetic.wav'; sf.write(file,y,sr)
        result, mel = understand(file, line_count=4)
        pitch = np.asarray(result['pitchHz']); valid=pitch[pitch>0]
        assert abs(np.median(valid)-220) < 8
        assert result['alignment']['status'] == 'CANDIDATE' and len(result['alignment']['lines']) == 4
        assert np.allclose(np.asarray(result['selfSimilarity']), np.asarray(result['selfSimilarity']).T)
        assert len(result['selfSimilarity']) <= 300 and result['repeatCandidates']
        assert len(result['entries']) > 0
        save_visuals(result, mel, Path(folder)/'evidence.png')
        sf.write(file,np.zeros(sr*2),sr)
        silent,_ = understand(file,line_count=2)
        assert silent['alignment']['status'] == 'SKIP' and max(silent['pitchHz']) == 0
        assert align_lines([0,1],[0,0],2,2)['status'] == 'SKIP'
        try:
            separate_local(file,Path(folder)/'vocal.wav',Path(folder)/'missing','[]')
            raise AssertionError('missing local weights accepted')
        except ValueError:
            pass
    print('PASS understand selftest: pitch, entries, recurrence, bounded similarity, alignment, silence SKIP, local model guard, PNG')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input',type=Path); p.add_argument('--out',type=Path)
    p.add_argument('--vocal-stem',type=Path); p.add_argument('--line-count',type=int,default=0)
    p.add_argument('--separation',choices=['off','command'],default='off')
    p.add_argument('--separator-command'); p.add_argument('--model-dir',type=Path)
    p.add_argument('--selftest',action='store_true')
    args=p.parse_args()
    if args.selftest: selftest(); return
    if not args.input or not args.out: p.error('--input and --out required')
    if args.line_count<0 or args.line_count>500: p.error('line-count must be 0..500')
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='scene-stem-') as folder:
        stem=args.vocal_stem
        if args.separation=='command':
            stem=Path(folder)/'vocals.wav';separate_local(args.input,stem,args.model_dir,args.separator_command)
        result,mel=understand(args.input,stem,args.line_count)
        args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        save_visuals(result,mel,args.out.with_suffix('.png'))
    print('CANDIDATE local evidence written; listening and manual line alignment required')


if __name__=='__main__': main()
