"""Pinned local-only Demucs loader. No implicit weight download or GPU use."""
import hashlib
import json
import os
from pathlib import Path


def separate(source, cache, output, max_seconds=600):
    import numpy as np
    import soundfile as sf
    import librosa
    spec = json.loads(Path(__file__).with_name('models.json').read_text())
    weight = Path(cache) / spec['file'] if cache else None
    if not weight or not weight.is_file():
        return None, 'SKIP Demucs: pinned local model missing; mixture activity fallback'
    with weight.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    if digest != spec['sha256']:
        raise ValueError('Demucs SHA-256 mismatch; refusing unverified weights')
    try:
        import torch
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except ImportError:
        return None, 'SKIP Demucs: optional CPU dependencies missing; mixture activity fallback'
    if librosa.get_duration(path=source) > max_seconds:
        raise ValueError('separation duration exceeds budget')
    # Demucs v4 stores a model class in the pinned checkpoint; only this verified artifact is loaded.
    torch.set_num_threads(1)
    previous = os.environ.get('TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD')
    try:
        os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'] = '1'
        model = get_model(spec['signature'], repo=Path(cache)).cpu().eval()
    finally:
        if previous is None:
            os.environ.pop('TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD', None)
        else:
            os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'] = previous
    y, sr = sf.read(source, dtype='float32', always_2d=True)
    if y.shape[1] not in (1, 2):
        raise ValueError('Demucs expects mono or stereo audio')
    y = librosa.resample(y.T, orig_sr=sr, target_sr=model.samplerate)
    if y.shape[0] == 1:
        y = np.repeat(y, 2, axis=0)
    x = torch.from_numpy(y.copy())
    mean, scale = x.mean(), x.mean(0).std().clamp_min(1e-8)
    with torch.inference_mode():
        stems = apply_model(model, ((x-mean)/scale)[None], device='cpu', shifts=0,
                            split=True, overlap=.25, num_workers=0, progress=False)[0]
    vocal = (stems[model.sources.index('vocals')]*scale+mean).T.numpy()
    sf.write(output, vocal, model.samplerate, subtype='FLOAT')
    return output, 'PASS local htdemucs CPU separation; SHA-256 verified'
