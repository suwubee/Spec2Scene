export function musicAt(data, t) {
  const beats = data.beats || [], index = beats.findLastIndex(x => x <= t);
  const sample = channel => {
    const i = (channel?.times || []).findLastIndex(x => x <= t);
    return i < 0 ? 0 : channel.values[i];
  };
  return {t, beat: index, bar: Math.floor(index / (data.beatsPerBar || 4)),
    section: data.sections?.find(s => t >= s.start && t < s.end) || null,
    energy: sample(data.energy), vocalActivity: sample(data.vocalActivity)};
}
export function createClock({duration = 60, media = null} = {}) {
  let start = 0, offset = 0, playing = false;
  return {get playing() { return playing; }, time(now) { return media ? media.currentTime : Math.min(duration, offset + (playing ? (now - start) / 1000 : 0)); },
    async play(now) { if (media) await media.play(); start = now; playing = true; },
    pause(now) { offset = this.time(now); playing = false; media?.pause(); },
    seek(t, now) { offset = Math.max(0, Math.min(duration, t)); start = now; if (media) media.currentTime = offset; }};
}
