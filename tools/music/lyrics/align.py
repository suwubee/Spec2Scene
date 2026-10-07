#!/usr/bin/env python3
"""Offline syllable alignment from energy, pYIN and spectral changes; no speech recognition."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

# Set before loading numerical libraries; do not inherit unbounded BLAS defaults.
for _key in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMBA_NUM_THREADS'):
    os.environ[_key] = '1'


def write_json(file, data):
    file = Path(file)
    temp = file.with_suffix(file.suffix + '.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    temp.replace(file)


def units(text):
    """CJK characters; approximate English syllables with original character offsets."""
    result = []
    for match in re.finditer(r"[A-Za-z]+(?:'[A-Za-z]+)?|[^\W_]", text, re.UNICODE):
        word = match.group()
        cuts = [0]
        if re.fullmatch(r"[A-Za-z']+", word):
            nuclei = list(re.finditer(r'[aeiouy]+', word.lower()))
            if len(nuclei) > 1 and nuclei[-1].group() == 'e' and nuclei[-1].end() == len(word) and not word.lower().endswith('le'):
                nuclei.pop()
            cuts += [(a.end()+b.start())//2 for a, b in zip(nuclei, nuclei[1:])]
        cuts.append(len(word))
        for a, b in zip(cuts, cuts[1:]):
            result.append({'text': word[a:b], 'offset': match.start()+a, 'length': b-a})
    return result


def read_lines(file):
    raw = Path(file).read_text(encoding='utf-8')
    data = json.loads(raw) if Path(file).suffix.lower() == '.json' else raw.splitlines()
    if isinstance(data, dict):
        data = data['lines']
    if not isinstance(data, list):
        raise ValueError('lyrics must be a list of lines')
    rows = []
    for item in data:
        line = {'text': item} if isinstance(item, str) else dict(item)
        if not isinstance(line.get('text'), str):
            raise ValueError('line text must be a string')
        if not line['text'].strip():
            continue
        line = {k: line[k] for k in ('text', 'start', 'end') if k in line}
        line['units'] = units(line['text'])
        if not 1 <= len(line['units']) <= 128:
            raise ValueError('each line needs 1..128 sung units')
        if ('start' in line) != ('end' in line):
            raise ValueError('line window requires both start and end')
        rows.append(line)
    if not 1 <= len(rows) <= 500 or sum(len(l['units']) for l in rows) > 5000:
        raise ValueError('lyrics budget: 1..500 lines, at most 5000 units')
    return rows


def features(y, sr, fmin=65, fmax=1000):
    import numpy as np
    import librosa
    from scipy.ndimage import uniform_filter1d
    from scipy.signal import find_peaks
    hop = sr//100
    spec = np.abs(librosa.stft(y, n_fft=1024, hop_length=hop))
    rms = librosa.feature.rms(y=y, frame_length=512, hop_length=hop)[0]
    db = 20*np.log10(rms+1e-9)
    # pYIN in bounded overlapping chunks avoids a song-length Viterbi lattice.
    f0, prob = np.full(len(rms), np.nan), np.zeros(len(rms))
    for a in range(0, len(y), sr*20):
        lo, hi = max(0, a-sr), min(len(y), a+sr*21)
        pitch, _, vp = librosa.pyin(y[lo:hi], sr=sr, fmin=fmin, fmax=fmax,
                                  frame_length=1024, hop_length=hop, resolution=.1)
        dst, src = a//hop, (a-lo)//hop
        n = min(sr*20//hop, len(rms)-dst, len(pitch)-src)
        f0[dst:dst+n], prob[dst:dst+n] = pitch[src:src+n], vp[src:src+n]
    freqs = librosa.fft_frequencies(sr=sr, n_fft=1024)
    band = spec[(freqs >= 180) & (freqs < 3800)]
    power = np.mean(band**2, axis=0)
    flatness = np.exp(np.mean(np.log(band+1e-8), axis=0))/(band.mean(axis=0)+1e-8)
    activity = np.clip(power/(np.percentile(power, 85)+1e-8), 0, 1)*np.clip(1-flatness*2, 0, 1)
    gate = (db > max(-65, float(np.percentile(db, 98))-32)) & (activity > .035)
    flux = np.maximum(0, np.diff(np.log1p(spec), axis=1, prepend=np.log1p(spec[:, :1]))).mean(axis=0)
    mf = librosa.feature.mfcc(S=librosa.power_to_db(librosa.feature.melspectrogram(S=spec**2, sr=sr, n_mels=40)), n_mfcc=13)[1:]
    novelty = np.linalg.norm(np.diff(mf, axis=1, prepend=mf[:, :1]), axis=0)
    score = np.zeros(len(rms))
    events = []
    def add(k, strength, kind):
        if 0 <= k < len(score):
            score[k] = min(1., score[k]+strength)
            events.append({'time': round(k*.01, 4), 'strength': round(float(strength), 4), 'kind': kind})
    for k in np.flatnonzero(np.diff(gate.astype(int), prepend=0) == 1):
        add(int(k), 1., 'activity-onset')
    for values, kind, gain in [(flux, 'spectral-flux', .8), (novelty, 'timbre-change', .5)]:
        norm = values/(np.percentile(values, 95)+1e-8)
        peaks, _ = find_peaks(norm, height=.3, prominence=.15, distance=9)
        for k in peaks:
            if gate[k]:
                add(int(k), min(gain, float(norm[k])*gain), kind)
    midi = librosa.hz_to_midi(f0)
    jump = np.zeros(len(rms))
    for k in range(5, len(rms)-5):
        l, r = midi[k-5:k], midi[k:k+5]
        if np.isfinite(l).sum() >= 3 and np.isfinite(r).sum() >= 3:
            jump[k] = abs(np.nanmedian(l)-np.nanmedian(r))
    peaks, _ = find_peaks(jump, height=1.4, distance=10)
    for k in peaks:
        add(int(k), min(.85, float(jump[k])/5), 'pitch-change')
    troughs, props = find_peaks(-uniform_filter1d(db, 3), prominence=3, distance=10)
    for k, prom in zip(troughs, props['prominences']):
        if gate[k]:
            add(int(k), min(.6, float(prom)/20), 'energy-trough')
    return {'times': np.arange(len(rms))*.01, 'db': db, 'pitch': f0, 'prob': prob,
            'activity': activity, 'gate': gate, 'score': score, 'events': events,
            'spec': spec, 'duration': len(y)/sr}


def windows(rows, f):
    """Group activity blocks monotonically with DP; explicit windows are trusted only as anchors."""
    import numpy as np
    gate, duration = f['gate'], f['duration']
    if all('start' in l for l in rows):
        spans = [(l['start'], l['end']) for l in rows]
        last = 0
        for a, b in spans:
            if not (last <= a < b <= duration):
                raise ValueError('line windows must be ordered, non-overlapping and inside audio')
            last = b
        return spans, 1.
    if any('start' in l for l in rows):
        raise ValueError('supply windows for all lines or none')
    ids = np.flatnonzero(gate)
    if not len(ids):
        return [], 0.
    chunks = []
    first = prev = ids[0]
    for k in ids[1:]:
        if k-prev > 30:
            if prev-first >= 8:
                chunks.append((first*.01, min(duration, (prev+1)*.01)))
            first = k
        prev = k
    if prev-first >= 8:
        chunks.append((first*.01, min(duration, (prev+1)*.01)))
    n, m = len(rows), len(chunks)
    if m >= n and m <= 1000:
        mass = np.array([b-a for a, b in chunks]); sums = np.r_[0, mass.cumsum()]
        target = mass.sum()/sum(len(l['units']) for l in rows)
        dp = np.full((n+1, m+1), np.inf); back = np.zeros((n+1, m+1), dtype=int); dp[0, 0] = 0
        for i, line in enumerate(rows, 1):
            for k in range(i, min(m, i+ m-n)+1):
                ps = np.arange(max(i-1, k-32), k)
                cost = dp[i-1, ps] + np.log((sums[k]-sums[ps])/(target*len(line['units'])))**2
                p = int(np.argmin(cost)); dp[i, k], back[i, k] = cost[p], ps[p]
        if np.isfinite(dp[n, m]):
            spans, k = [], m
            for i in range(n, 0, -1):
                p = back[i, k]; spans.append((chunks[p][0], chunks[k-1][1])); k = p
            return list(reversed(spans)), 1. if m == n else .72
    # Ambiguous segmentation remains editable but cannot auto-lock.
    mass = np.cumsum(gate.astype(float)); weights = np.r_[0, np.cumsum([len(l['units']) for l in rows])]
    edges = np.interp(weights/weights[-1]*mass[-1], mass, f['times'])
    edges[0], edges[-1] = ids[0]*.01, min(duration, (ids[-1]+1)*.01)
    return list(zip(edges[:-1], edges[1:])), .55


def split_line(a, b, count, f):
    import numpy as np
    from scipy.signal import find_peaks
    lo, hi = max(0, round(a*100)), min(len(f['score'])-1, round(b*100))
    peaks, _ = find_peaks(f['score'][lo:hi], height=.18, distance=7)
    strong = sorted(peaks, key=lambda k: -f['score'][lo+k])[:384]
    pos = np.unique(np.r_[lo, lo+np.array(strong, dtype=int), np.linspace(lo, hi, min(200, max(count*3, 2))).astype(int), hi])
    pos = pos[(pos >= lo) & (pos <= hi)]
    mass = np.cumsum(f['gate']*.01)
    active = mass[pos]-mass[lo]
    target = max(.04, (mass[hi]-mass[lo])/count)
    dp = np.full((count+1, len(pos)), -np.inf); dp[0, 0] = 0
    back = np.zeros_like(dp, dtype=int)
    for j in range(1, count+1):
        ks = [len(pos)-1] if j == count else range(1, len(pos)-1)
        for k in ks:
            prev = np.arange(k)
            duration = (pos[k]-pos[prev])*.01
            value = dp[j-1, prev] - .28*np.log(np.maximum(.01, active[k]-active[prev])/target)**2
            value += 2.8*f['score'][pos[k]] if j < count else 0
            value[duration < .09] = -np.inf
            if len(value):
                p = int(np.argmax(value)); dp[j, k], back[j, k] = value[p], p
    if not np.isfinite(dp[count, -1]):
        raise ValueError('line too short for unit count; provide corrected line windows')
    k, edges = len(pos)-1, [b]
    for j in range(count, 0, -1):
        k = back[j, k]; edges.append(max(a, pos[k]*.01))
    return list(reversed(edges))


def validate(result):
    import math
    previous = 0
    for line in result['lines']:
        a, b = line['start'], line['end']
        if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in (a, b)) or not (previous <= a < b <= result['duration']):
            raise ValueError('invalid or overlapping line times')
        previous, edge = b, a
        for word in line['words']:
            x, y = word['start'], word['end']
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (x, y)) or not (edge-1e-6 <= x < y <= b+1e-6):
                raise ValueError('invalid or overlapping word times')
            edge = y
        if abs(line['words'][0]['start']-a) > 1e-6 or abs(edge-b) > 1e-6:
            raise ValueError('line boundaries must match first/last word')


def corrections(result, data):
    import copy
    if data.get('inputSHA256') != result['inputSHA256'] or data.get('textSHA256') != result['textSHA256']:
        raise ValueError('corrections refer to different audio or text')
    result = copy.deepcopy(result)
    lookup = {l['id']: l for l in result['lines']}
    seen = set()
    for change in data.get('lines', []):
        id_ = change['id']
        if id_ in seen or id_ not in lookup:
            raise ValueError('unknown or duplicate correction line')
        seen.add(id_); line = lookup[id_]
        modified = False
        for key in ('start', 'end'):
            if key in change:
                line[key] = change[key]; modified = True
        word_seen = set()
        for edit in change.get('words', []):
            index = edit['index']
            if type(index) is not int or not 0 <= index < len(line['words']) or index in word_seen:
                raise ValueError('invalid or duplicate word index')
            word_seen.add(index)
            for key in ('start', 'end'):
                if key in edit:
                    line['words'][index][key] = edit[key]; modified = True
        if 'start' in change:
            line['words'][0]['start'] = change['start']
        if 'end' in change:
            line['words'][-1]['end'] = change['end']
        if modified:
            line['locked'], line['lockReason'] = False, 'edited; review required'
        if change.get('confirmed') is True:
            reviewer = change.get('reviewer', '').strip()
            if not reviewer:
                raise ValueError('confirmed corrections require reviewer')
            line.update(locked=True, lockReason='reviewer-confirmed', reviewer=reviewer)
        elif change.get('confirmed') is False:
            line.update(locked=False, lockReason='reviewer-unlocked')
    validate(result)
    return result


def lrc(result):
    def stamp(t):
        centis = round(t*100)
        return f'[{centis//6000:02d}:{centis%6000/100:05.2f}]'
    return '\n'.join(stamp(l['start'])+l['text']+'\n'+stamp(l['end']) for l in result['lines'] if l['locked'])+'\n'


def plots(result, f, output, font=None):
    import numpy as np
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.font_manager import FontProperties, fontManager
    from PIL import Image, ImageOps, ImageDraw
    from matplotlib.ft2font import FT2Font
    required = {ord(c) for line in result['lines'] for c in line['text'] if not c.isspace()}
    prop = FontProperties(fname=font) if font else None
    if font and not required.issubset(FT2Font(str(font)).get_charmap()):
        raise ValueError('visualization font lacks required glyphs')
    if prop is None:
        candidates=sorted(fontManager.ttflist,key=lambda f:(not any(x in f.name for x in ('Noto Sans CJK','WenQuanYi Zen Hei')),f.name))
        for candidate in candidates:
            if required.issubset(FT2Font(candidate.fname).get_charmap()):
                prop=FontProperties(fname=candidate.fname);break
    if prop is None and required:
        raise ValueError('visualization requires --font with project-authorized glyph coverage')
    images = []
    for line in result['lines']:
        a, b = max(0, line['start']-.25), min(result['duration'], line['end']+.25)
        lo, hi = int(a*100), min(f['spec'].shape[1], int(b*100)+1)
        fig, ax = plt.subplots(3, 1, figsize=(12, 5), sharex=True, layout='constrained')
        ax[0].imshow(20*np.log10(f['spec'][:, lo:hi]+1e-6), extent=[a,b,0,8000], origin='lower', aspect='auto', cmap='magma', vmin=-65, vmax=20)
        ax[0].set(ylim=(0, 4000), ylabel='Hz', title=f"{line['id']} confidence={line['confidence']:.3f} locked={line['locked']}")
        ax[1].plot(f['times'], f['pitch'], '.', ms=2); ax[1].set(ylabel='pYIN Hz', ylim=(50, 1100))
        ax[2].plot(f['times'], f['activity'], label='activity'); ax[2].plot(f['times'], f['score'], alpha=.6, label='onset evidence')
        for word in line['words']:
            for axis in ax:
                axis.axvline(word['start'], color='cyan', alpha=.6, lw=.6)
            ax[2].text(word['start'], 1.05, word['text'], fontproperties=prop, fontsize=10)
        ax[2].set(xlim=(a,b), ylim=(0,1.3), xlabel='Playback seconds'); ax[2].legend(loc='lower right')
        file = output/f"line-{line['id']}.png"; fig.savefig(file, dpi=100); plt.close(fig); images.append(file)
    # Paged contact sheets keep memory bounded for long songs.
    for start in range(0, len(images), 12):
        page = images[start:start+12]; sheet = Image.new('RGB', (1200, 250*((len(page)+1)//2)), '#111111')
        for i, file in enumerate(page):
            with Image.open(file) as im:
                sheet.paste(ImageOps.contain(im.convert('RGB'), (600,250)), ((i%2)*600,(i//2)*250))
        sheet.save(output/f'contact-{start//12+1:03d}.png')


def pipeline(source, lyrics, output, *, vocal_stem=None, model_dir=None, separation='auto', threshold=.8,
             correction_file=None, font=None, max_seconds=600, fmin=65, fmax=1000, visualize=True):
    import numpy as np
    import librosa
    from separate import separate
    if not .5 <= threshold <= 1 or not 0 < max_seconds <= 1800 or not 40 <= fmin < fmax <= 2000:
        raise ValueError('invalid threshold, duration budget or pitch range')
    source, output = Path(source), Path(output)
    rows = read_lines(lyrics)
    duration = librosa.get_duration(path=source)
    if not 0 < duration <= max_seconds:
        raise ValueError('audio exceeds duration budget')
    output.mkdir(parents=True, exist_ok=True)
    y, sr = librosa.load(source, sr=16000, mono=True)
    input_hash = hashlib.file_digest(source.open('rb'), 'sha256').hexdigest()
    text_hash = hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    stem, sep_status = vocal_stem, 'SKIP separation disabled; mixture activity fallback'
    with tempfile.TemporaryDirectory(prefix='scene-lyrics-stem-') as temp:
        if stem:
            sep_status = 'USER supplied vocal stem; separation not verified'
        elif separation != 'off':
            stem, sep_status = separate(source, model_dir, Path(temp)/'vocals.wav', max_seconds)
        voice = y
        if stem:
            if abs(librosa.get_duration(path=stem)-duration) > .05:
                raise ValueError('vocal stem must match mix duration within 50 ms')
            voice, _ = librosa.load(stem, sr=sr, mono=True)
            voice = np.pad(voice[:len(y)], (0, max(0,len(y)-len(voice))))
        f = features(voice, sr, fmin, fmax)
    spans, grouping = windows(rows, f)
    lines = []
    for i, (row, (a, b)) in enumerate(zip(rows, spans)):
        edges = split_line(a,b,len(row['units']),f)
        words = []
        for j, unit in enumerate(row['units']):
            x,y_ = edges[j:j+2]; lo,hi = round(x*100), max(round(x*100)+1,round(y_*100))
            onset = float(max(f['score'][max(0,lo-3):lo+4], default=0))
            confidence = (.3*float(f['gate'][lo:hi].mean())+.3*float(np.nan_to_num(f['prob'][lo:hi]).mean())+.4*onset)*grouping
            confidence = min(.49 if not stem else 1., confidence)
            words.append({**unit, 'start': round(float(x),4), 'end': round(float(y_),4), 'confidence': round(confidence,4)})
        confidence = float(np.percentile([w['confidence'] for w in words],25))
        lines.append({'id':str(i+1),'text':row['text'],'start':words[0]['start'],'end':words[-1]['end'],
                      'words':words,'confidence':round(confidence,4),'locked':confidence>=threshold,
                      'lockReason':'confidence-threshold' if confidence>=threshold else 'review-required'})
    result = {'schema':1,'status':'CANDIDATE' if lines else 'SKIP','reason':None if lines else 'No vocal activity; manual windows or better stem required',
              'duration':len(voice)/sr,'inputSHA256':input_hash,'textSHA256':text_hash,'separation':sep_status,
              'method':'pYIN + activity/flux/timbre/pitch onset candidates + monotonic duration DP',
              'confidenceThreshold':threshold,'confidenceCalibrated':False,'lines':lines,
              'limitations':['Acoustic alignment is not speech recognition.','English syllables are orthographic approximations.',
                             'Mixture confidence is capped at 0.49; auto-lock requires a stem.','Human listening and visual review remain necessary.']}
    validate(result)
    correction_file = Path(correction_file) if correction_file else output/'alignment_corrections.json'
    if correction_file.exists():
        result = corrections(result, json.loads(correction_file.read_text()))
    else:
        write_json(correction_file, {'schema':1,'inputSHA256':input_hash,'textSHA256':text_hash,'lines':[]})
    write_json(output/'lyrics.align.json', result)
    (output/'lyrics.lrc').write_text(lrc(result), encoding='utf-8')
    mix_rms = librosa.feature.rms(y=y if isinstance(y,np.ndarray) else voice, hop_length=160)[0]
    write_json(output/'analysis.json', {'schema':1,'duration':result['duration'],'separation':sep_status,'groupingConfidence':grouping,
               'times':f['times'].tolist(),'mixRMS':mix_rms.tolist(),'vocalActivity':f['activity'].tolist(),
               'pitchHz':np.nan_to_num(f['pitch']).tolist(),'voicedProbability':np.nan_to_num(f['prob']).tolist(),'candidates':f['events']})
    np.savez_compressed(output/'features.npz', times=f['times'], db=f['db'], pitch=f['pitch'], probability=f['prob'], activity=f['activity'], onset=f['score'])
    if visualize:
        plots(result,f,output,font)
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('input','lyrics','out','vocal-stem','model-dir','corrections','font'):
        p.add_argument('--'+key, type=Path)
    p.add_argument('--separation',choices=['auto','off','demucs'],default='auto')
    p.add_argument('--threshold',type=float,default=.8)
    p.add_argument('--max-seconds',type=float,default=600)
    p.add_argument('--fmin',type=float,default=65); p.add_argument('--fmax',type=float,default=1000)
    p.add_argument('--selftest',action='store_true')
    args = p.parse_args()
    if args.selftest:
        from selftest import selftest
        selftest(args.out); return
    if not all((args.input,args.lyrics,args.out)):
        p.error('--input, --lyrics and --out required')
    result = pipeline(args.input,args.lyrics,args.out,vocal_stem=args.vocal_stem,model_dir=args.model_dir,
                      separation=args.separation,threshold=args.threshold,correction_file=args.corrections,font=args.font,
                      max_seconds=args.max_seconds,fmin=args.fmin,fmax=args.fmax)
    print(json.dumps({'status':result['status'],'lines':len(result['lines']),'locked':sum(l['locked'] for l in result['lines']),
                      'separation':result['separation']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
