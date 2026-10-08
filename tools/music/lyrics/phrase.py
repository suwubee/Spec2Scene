"""Silence-delimited phrases with paragraph anchors; standard library logic is independently testable."""
import math


def detect_phrases(db, *, hop=.01, threshold_db=-38, silence=.25, minimum=.15):
    if not all(math.isfinite(v) for v in (hop, threshold_db, silence, minimum)) or hop <= 0 or silence < hop or minimum < hop:
        raise ValueError('invalid phrase thresholds')
    active = [i for i, value in enumerate(db) if value >= threshold_db]
    spans = []
    for i in active:
        if spans and round((i-spans[-1][1])*hop, 9) < silence:
            spans[-1][1] = i+1
        else:
            spans.append([i, i+1])
    return [(round(a*hop,8), round(b*hop,8)) for a, b in spans if (b-a)*hop >= minimum]


def distribute(rows, phrases):
    """Bounded monotonic DP over line counts, never merging a silent interlude."""
    n, m = len(rows), len(phrases)
    if not 1 <= m <= n <= 500:
        raise ValueError('phrase/line count needs paragraph anchors or threshold adjustment')
    weights = [len(r['units']) for r in rows]
    sums = [0]
    for w in weights:
        sums.append(sums[-1]+w)
    rate = sums[-1]/sum(b-a for a, b in phrases)
    costs, paths = {0: 0}, {}
    for j, (a, b) in enumerate(phrases):
        next_cost = {}
        for end in range(j+1, n-(m-j-1)+1):
            choices = [(cost+(b-a)*math.log((sums[end]-sums[start])/((b-a)*rate))**2, start)
                       for start, cost in costs.items() if start < end]
            if choices:
                next_cost[end], paths[j, end] = min(choices)
        costs = next_cost
    groups, end = [], n
    for j in reversed(range(m)):
        start = paths[j, end]; groups.append(list(range(start, end))); end = start
    return list(reversed(groups))


def phrase_windows(rows, phrases):
    """Paragraph markers carry optional inclusive, 1-based phrase ranges.

    Shared boundary phrases are split once across both paragraphs, preserving
    the original acoustic phrase instead of introducing an artificial boundary.
    """
    paragraphs = []
    for i, row in enumerate(rows):
        name = row.get('paragraph', '1')
        if not paragraphs or paragraphs[-1][0] != name:
            if any(p[0] == name for p in paragraphs):
                raise ValueError('paragraphs must remain contiguous')
            paragraphs.append((name, []))
        paragraphs[-1][1].append(i)
    assigned = [[] for _ in phrases]
    anchored = any('phraseStart' in r or 'phraseEnd' in r for r in rows)
    if anchored:
        previous = 1
        for _, indices in paragraphs:
            specs = {(rows[i].get('phraseStart'), rows[i].get('phraseEnd')) for i in indices}
            if len(specs) != 1:
                raise ValueError('one consistent phrase range required per paragraph')
            a, b = specs.pop()
            if type(a) is not int or type(b) is not int or not previous <= a <= b <= len(phrases):
                raise ValueError('ordered paragraph phrase anchors required')
            previous = b
            groups = distribute([rows[i] for i in indices], phrases[a-1:b])
            for j, group in enumerate(groups, a-1):
                assigned[j].extend(indices[k] for k in group)
    else:
        # Allocate whole acoustic phrases to paragraphs first, then lines within each.
        # A paragraph needs at least one phrase. Ambiguous shared phrases require anchors.
        synthetic = [{'units': [None]*sum(len(rows[i]['units']) for i in indices)} for _, indices in paragraphs]
        if len(paragraphs) == 1:
            assigned = distribute(rows, phrases)
        else:
            if len(phrases) < len(paragraphs):
                raise ValueError('shared paragraph phrase requires explicit anchors')
            # Assign phrase counts by a monotonic duration DP (paragraph boundaries cannot cut phrases).
            sums = [0.]
            for a, b in phrases:
                sums.append(sums[-1]+b-a)
            total = sum(len(r['units']) for r in synthetic)
            cost, back = {0: 0.}, {}
            for j, row in enumerate(synthetic):
                new = {}
                for end in range(j+1, len(phrases)-(len(paragraphs)-j-1)+1):
                    choices = [(v+(sums[end]-sums[start]-sums[-1]*len(row['units'])/total)**2, start)
                               for start, v in cost.items() if start < end and end-start <= len(paragraphs[j][1])]
                    if choices:
                        new[end], back[j, end] = min(choices)
                cost = new
            if len(phrases) not in cost:
                raise ValueError('paragraph phrase counts cannot be assigned')
            ranges, end = [], len(phrases)
            for j in reversed(range(len(paragraphs))):
                start = back[j, end]; ranges.append((start, end)); end = start
            for (_, indices), (a, b) in zip(paragraphs, reversed(ranges)):
                for j, group in enumerate(distribute([rows[i] for i in indices], phrases[a:b]), a):
                    assigned[j] = [indices[k] for k in group]
    if [i for group in assigned for i in group] != list(range(len(rows))) or any(not g for g in assigned):
        raise ValueError('phrase assignment must cover every line and phrase in order')
    windows, evidence = [], []
    for j, (group, (a, b)) in enumerate(zip(assigned, phrases), 1):
        total = sum(len(rows[i]['units']) for i in group); used = 0
        for i in group:
            start = a+(b-a)*used/total; used += len(rows[i]['units'])
            windows.append((start, a+(b-a)*used/total))
            evidence.append({'phrase': j, 'phraseStart': a, 'phraseEnd': b,
                             'onsetSource': 'silence' if i == group[0] else 'character-proportion estimate'})
    return windows, evidence


def approve_line(line, change):
    approval = change.get('approval', {})
    ref = change.get('onsetReference')
    if approval.get('approved') is not True or not str(approval.get('reviewer', '')).strip() or not str(approval.get('reference', '')).strip():
        raise ValueError('line lock requires reviewer approval and review reference')
    if change.get('reviewer', approval['reviewer']) != approval['reviewer']:
        raise ValueError('approval reviewer must match correction reviewer')
    if not isinstance(ref, (int, float)) or not math.isfinite(ref) or abs(line['start']-ref) > .3+1e-9:
        raise ValueError('line onset must be within 0.3 seconds of reviewed vocal onset')
    line.update(locked=True, lockReason='reviewer-approved-line', reviewerApproved=True,
                approval=approval, onsetReference=ref, onsetErrorSeconds=abs(line['start']-ref),
                humanListened=approval.get('humanListened') is True)


def selftest():
    mask = [-80]*200
    for a, b in [(10,30),(54,70),(95,125)]:
        mask[a:b] = [-20]*(b-a)
    assert detect_phrases(mask) == [(.1,.7),(.95,1.25)]
    rows = [{'units': [0]*n, 'paragraph': 'a'} for n in (2,4)]
    spans, _ = phrase_windows(rows, [(1,7)])
    assert spans == [(1,3),(3,7)]
    rows[1]['paragraph'] = 'b'
    for r in rows:
        r.update(phraseStart=1, phraseEnd=1)
    assert phrase_windows(rows, [(1,7)])[0] == spans
    line = {'start': 1.3}
    approve_line(line, {'onsetReference':1, 'approval':{'approved':True,'reviewer':'test-reviewer','reference':'synthetic-test'}})
    assert line['reviewerApproved'] and not line['humanListened']
    try:
        approve_line({'start':1.301}, {'onsetReference':1,'approval':line['approval']})
    except ValueError:
        pass
    else:
        raise AssertionError('onset tolerance must reject >0.3 s')
    print('PASS phrase segmentation, shared paragraph boundary, proportional lines and approval tolerance; synthetic only')


if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('--selftest', action='store_true')
    if p.parse_args().selftest:
        selftest()
