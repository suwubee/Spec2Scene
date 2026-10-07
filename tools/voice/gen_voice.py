#!/usr/bin/env python3
"""Build speech files for offline playback; the selected build engine may use a network service."""
import argparse
import asyncio
import hashlib
import json
import math
import re
import subprocess
import tempfile
import wave
from pathlib import Path


def validate(lines):
    if not isinstance(lines, list) or not lines:
        raise ValueError('transcript must be a nonempty array')
    seen = set()
    for line in lines:
        ident = line.get('id', '')
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,79}', ident) or ident in seen:
            raise ValueError('invalid or duplicate transcript id')
        if not isinstance(line.get('text'), str) or not line['text'].strip():
            raise ValueError('nonempty text required')
        seen.add(ident)
    return lines


def normalize(source, output, target=-16):
    command = ['ffmpeg', '-hide_banner', '-nostdin', '-threads', '1', '-i', str(source)]
    result = subprocess.run(command + ['-af', f'loudnorm=I={target}:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
                            capture_output=True, text=True, check=True)
    match = re.search(r'\{[^{}]*"input_i"[^{}]*\}', result.stderr)
    if not match:
        raise ValueError('loudness measurement unavailable')
    measured = json.loads(match.group())
    if not all(math.isfinite(float(measured[k])) for k in ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']):
        raise ValueError('cannot normalize silent or invalid audio')
    params = ':'.join(f'{key}={measured[value]}' for key, value in [
        ('measured_I', 'input_i'), ('measured_TP', 'input_tp'), ('measured_LRA', 'input_lra'),
        ('measured_thresh', 'input_thresh'), ('offset', 'target_offset')])
    subprocess.run(command + ['-af', f'loudnorm=I={target}:TP=-1.5:LRA=11:{params}:linear=true',
                             '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '96k', '-threads', '1', '-n', str(output)],
                   capture_output=True, check=True)
    duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                             '-of', 'default=nw=1:nk=1', str(output)]))
    if duration <= 0:
        raise ValueError('empty encoded speech')
    return duration


async def generate(args):
    lines = validate(json.loads(args.script.read_text()))
    args.out.mkdir(parents=True, exist_ok=True)
    command = json.loads(args.command) if args.command else None
    if args.engine == 'command' and (not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command)):
        raise ValueError('--command must be a JSON argument array')
    for line in lines:
        if (args.out / (line['id'] + '.mp3')).exists():
            raise ValueError('refusing overwrite; choose a new output directory')
    manifest = {'engine': args.engine, 'voice': args.voice, 'targetLUFS': args.lufs,
                'licenseReviewRequired': True, 'lines': []}
    print('许可提醒：离线播放不等于商用授权；请核实所选语音服务、声音和台本的条款。')
    with tempfile.TemporaryDirectory(prefix='scene-voice-') as folder:
        for line in lines:
            raw = Path(folder) / (line['id'] + '.wav')
            if args.engine == 'edge':
                import edge_tts
                raw = raw.with_suffix('.mp3')
                await edge_tts.Communicate(line['text'], args.voice).save(str(raw))
            else:
                replacements = {'{text}': line['text'], '{output}': str(raw), '{voice}': args.voice}
                argv = []
                for item in command:
                    for key, value in replacements.items():
                        item = item.replace(key, value)
                    argv.append(item)
                subprocess.run(argv, check=True)  # No shell interpolation.
            target = args.out / (line['id'] + '.mp3')
            duration = normalize(raw, target, args.lufs)
            manifest['lines'].append({**line, 'file': target.name, 'duration': duration,
                                      'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    (args.out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f"PASS generated lines={len(lines)}")


def selftest():
    import struct
    validate([{'id': 'start', 'text': '开始'}])
    for bad in [[{'id': '../escape', 'text': 'a'}], [{'id': 'x', 'text': 'a'}] * 2, []]:
        try:
            validate(bad)
            raise AssertionError('invalid transcript accepted')
        except ValueError:
            pass
    with tempfile.TemporaryDirectory(prefix='scene-voice-test-') as folder:
        source = Path(folder) / 'synthetic.wav'
        with wave.open(str(source), 'wb') as stream:
            stream.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
            stream.writeframes(b''.join(struct.pack('<h', round(6000 * math.sin(2 * math.pi * 440 * i / 24000))) for i in range(48000)))
        assert 1.9 < normalize(source, Path(folder) / 'normalized.mp3') < 2.2
    print('PASS gen_voice selftest: transcript validation, traversal rejection, duplicate rejection, two-pass loudness, encoded duration')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--script', type=Path, help='JSON [{id,text,category?}]')
    p.add_argument('--out', type=Path)
    p.add_argument('--voice', help='Voice identifier for your licensed engine')
    p.add_argument('--engine', choices=['edge', 'command'], default='edge')
    p.add_argument('--command', help='JSON argv array; placeholders {text}, {output}, {voice}')
    p.add_argument('--lufs', type=float, default=-16)
    p.add_argument('--selftest', action='store_true')
    args = p.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.script or not args.out or not args.voice or not -30 <= args.lufs <= -10:
        p.error('--script, --out, --voice required; lufs must be -30..-10')
    asyncio.run(generate(args))


if __name__ == '__main__':
    main()
