// Maximum-cardinality chronological matching, then minimum absolute timing error.
// Identity groups are scored separately; empty truth never claims perfect recall.
export function matchEvents(predictions, truth, tolerance = .15) {
  if (!(tolerance >= 0 && Number.isFinite(tolerance))) throw new Error('Invalid tolerance');
  for (const event of [...predictions, ...truth]) if (!Number.isFinite(event.t)) throw new Error('Finite event time required');
  const p = predictions.map((e, id) => ({...e, id})).sort((a, b) => a.t - b.t);
  const t = truth.map((e, id) => ({...e, id})).sort((a, b) => a.t - b.t);
  const dp = Array.from({length: p.length + 1}, () => Array.from({length: t.length + 1}, () => ({pairs: [], cost: 0})));
  const best = (a, b) => a.pairs.length > b.pairs.length || (a.pairs.length === b.pairs.length && a.cost <= b.cost) ? a : b;
  for (let i = 1; i <= p.length; i++) for (let j = 1; j <= t.length; j++) {
    let chosen = best(dp[i - 1][j], dp[i][j - 1]);
    const delta = p[i - 1].t - t[j - 1].t;
    if (Math.abs(delta) <= tolerance + 1e-9) {
      const previous = dp[i - 1][j - 1];
      chosen = best(chosen, {pairs: [...previous.pairs, {prediction: p[i - 1], truth: t[j - 1], delta}], cost: previous.cost + Math.abs(delta)});
    }
    dp[i][j] = chosen;
  }
  return dp[p.length][t.length].pairs;
}
export function evaluateEvents(predictions, truth, tolerance = .15) {
  const identities = new Set([...predictions, ...truth].map(e => e.hand ?? 'any'));
  const matched = [...identities].flatMap(hand => matchEvents(predictions.filter(e => (e.hand ?? 'any') === hand),
    truth.filter(e => (e.hand ?? 'any') === hand), tolerance));
  const temporal = matchEvents(predictions, truth, tolerance);
  const typed = matched.filter(p => p.truth.type !== undefined);
  const times = matched.map(p => Math.abs(p.delta)).sort((a, b) => a - b);
  const median = times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null;
  return {predictions: predictions.length, truth: truth.length, matched: matched.length,
    precision: predictions.length ? matched.length / predictions.length : null,
    recall: truth.length ? matched.length / truth.length : null,
    handAccuracy: temporal.length ? temporal.filter(p => p.prediction.hand === p.truth.hand).length / temporal.length : null,
    typeAccuracy: typed.length ? typed.filter(p => p.prediction.type === p.truth.type).length / typed.length : null,
    medianAbsTimeError: median, falsePositives: predictions.length - matched.length, matches: matched};
}
