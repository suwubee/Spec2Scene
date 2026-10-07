export const judgement = Object.freeze({perfect: .18, great: .32, good: .5, maxAdaptiveOffset: .25, maxAdaptiveStep: .02});
export function grade(deltaSeconds) {
  const delta = Math.abs(deltaSeconds);
  return delta <= judgement.perfect ? 'perfect' : delta <= judgement.great ? 'great' : delta <= judgement.good ? 'good' : 'miss';
}
