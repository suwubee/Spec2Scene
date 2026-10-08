"""Procedural harmonic syllables only. No recorded music, speech or published lyrics."""
import json
from pathlib import Path
import tempfile


def selftest(output=None):
    import numpy as np
    import soundfile as sf
    from align import pipeline, units, corrections, validate, write_json, lrc
    context = tempfile.TemporaryDirectory(prefix='scene-lyrics-test-') if output is None else None
    root = Path(context.name if context else output); root.mkdir(parents=True, exist_ok=True)
    sr, duration = 16000, 13
    vocal = np.zeros(sr*duration, dtype=np.float32)
    expected = []
    starts = [[.703,1.357,2.124,2.706],[4.604,5.157,6.052,6.806],[9.003,9.647,10.244,11.057]]
    lengths = [[.46,.58,.4,.95],[.4,.66,.55,.85],[.49,.43,.58,1.05]]
    for i,(times,lens) in enumerate(zip(starts,lengths)):
        for j,(a,length) in enumerate(zip(times,lens)):
            n = round(length*sr); t = np.arange(n)/sr
            pitch = [196,247,247,294,220,262,330,262,174,220,277,220][i*4+j]
            phase = 2*np.pi*pitch*t + .018*np.sin(2*np.pi*5*t)
            envelope = np.minimum(1,t/.018)*np.minimum(1,(length-t)/.04)
            tone = sum(np.sin(h*phase)/h**1.3 for h in range(1,7))*.22*envelope
            vocal[round(a*sr):round(a*sr)+n] += tone
            expected.append(a)
    t = np.arange(len(vocal))/sr
    mix = vocal+.012*np.sin(2*np.pi*98*t)+.006*np.sin(2*np.pi*392*t)
    sf.write(root/'mix.wav',mix,sr); sf.write(root/'stem.wav',vocal,sr)
    # Test-only arbitrary labels, deliberately not a work or a lyrical composition.
    write_json(root/'text.json', ['甲乙丙丁','戊己庚辛','la le li lo'])
    result = pipeline(root/'mix.wav',root/'text.json',root/'aligned',vocal_stem=root/'stem.wav')
    actual = [w['start'] for l in result['lines'] for w in l['words']]
    error = np.abs(np.array(actual)-expected)
    assert len(result['lines']) == 3 and len(actual) == 12
    assert error.max() <= .12, (actual, expected, error)
    assert error.mean() <= .065, error
    assert sum(l['locked'] for l in result['lines']) >= 1, result['lines']
    data = {'inputSHA256':result['inputSHA256'],'textSHA256':result['textSHA256'],
            'lines':[{'id':'1','confirmed':False},{'id':'2','confirmed':True,'reviewer':'synthetic-test'}]}
    revised = corrections(result,data)
    assert not revised['lines'][0]['locked'] and revised['lines'][1]['locked']
    assert result['lines'][0]['text'] not in lrc(revised)
    data['lines'] = [{'id':'1','start':-.5}]
    try:
        corrections(result,data)
        raise AssertionError('invalid correction accepted')
    except ValueError:
        pass
    data['lines'] = [{'id':'1','confirmed':True}]
    try:
        corrections(result,data)
        raise AssertionError('confirmation without reviewer accepted')
    except ValueError:
        pass
    write_json(root/'fallback-text.json',[{'text':'la le li lo','start':.7,'end':3.65}])
    fallback = pipeline(root/'mix.wav',root/'fallback-text.json',root/'fallback',model_dir=root/'absent',visualize=False)
    assert not any(l['locked'] for l in fallback['lines'])
    assert all(l['confidence'] <= .49 for l in fallback['lines'])
    assert 'missing' in fallback['separation']
    sf.write(root/'silence.wav',np.zeros(sr),sr)
    silent = pipeline(root/'silence.wav',root/'text.json',root/'silence',separation='off',visualize=False)
    assert silent['status'] == 'SKIP' and silent['lines'] == []
    assert len(units('paper hello')) == 4
    # End-to-end manual confirmation survives rerun; derived outputs may be replaced, corrections may not.
    data['lines'] = [{'id':'1','confirmed':True,'reviewer':'synthetic-test'}]
    write_json(root/'aligned'/'alignment_corrections.json',data)
    rerun = pipeline(root/'mix.wav',root/'text.json',root/'aligned',vocal_stem=root/'stem.wav',visualize=False)
    assert rerun['lines'][0]['lockReason'] == 'reviewer-confirmed'
    # Phrase candidates are never auto-approved, even with clean synthetic vocal activity.
    phrase_result = pipeline(root/'mix.wav',root/'text.json',root/'phrases',vocal_stem=root/'stem.wav',
                             mode='phrase',silence=.5,visualize=False)
    assert len(phrase_result['lines']) == 3 and not any(l['locked'] for l in phrase_result['lines'])
    assert (root/'phrases'/'vocals.wav').read_bytes() == (root/'stem.wav').read_bytes()
    first = phrase_result['lines'][0]
    approved = corrections(phrase_result, {'inputSHA256':phrase_result['inputSHA256'],'textSHA256':phrase_result['textSHA256'],
        'lines':[{'id':'1','confirmed':True,'reviewer':'synthetic-reviewer','onsetReference':expected[0],
                  'approval':{'approved':True,'reviewer':'synthetic-reviewer','reference':'synthetic-only','humanListened':False}}]})
    assert approved['lines'][0]['reviewerApproved'] and not approved['lines'][0]['humanListened']
    report = {'status':'PASS','scope':'procedural harmonic syllables, not real singing or separation quality',
              'syllables':len(actual),'onsetMeanErrorSeconds':float(error.mean()),'onsetMaxErrorSeconds':float(error.max()),
              'autoLockedLines':sum(l['locked'] for l in result['lines']),
              'checks':['DP onset error','same-pitch repeated syllables','variable durations','mixture fallback',
                        'silence SKIP','English approximation','manual lock/unlock','invalid corrections rejected','rerun preserves corrections','phrase pipeline retains stem and requires reviewed onset'],
              'realSong':'SKIP no authorized regression audio','demucsInference':'SKIP optional model inference not part of synthetic alignment test'}
    write_json(root/'report.json',report); print(json.dumps(report))
    if context:
        context.cleanup()
