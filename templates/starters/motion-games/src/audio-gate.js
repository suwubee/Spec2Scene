export function createAudioGate() {
  const Context = window.AudioContext || window.webkitAudioContext;
  const ctx = Context ? new Context() : null;
  const status = document.querySelector('#audio-status'), button = document.querySelector('#sound');
  let lastTone = -Infinity;
  const gate = {
    get state() { return ctx?.state || 'unsupported'; },
    played: 0,
    tone() {
      if (ctx?.state !== 'running' || ctx.currentTime - lastTone < .25) return;
      lastTone = ctx.currentTime;
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      oscillator.frequency.value = 440;
      gain.gain.setValueAtTime(.035, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .15);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(); oscillator.stop(ctx.currentTime + .16); gate.played++;
    },
    async unlock() { if (ctx) { await ctx.resume(); refresh(); gate.tone(); } },
    close() { return ctx?.close(); },
  };
  function refresh() {
    const ready = gate.state === 'running';
    status.textContent = ready ? '声音已开启' : '声音待开启：请点一下屏幕或按键，手势无法开启声音';
    button.hidden = ready;
  }
  const activate = event => { if (event.isTrusted) gate.unlock().catch(() => refresh()); };
  document.addEventListener('pointerdown', activate);
  document.addEventListener('keydown', activate);
  if (ctx) ctx.onstatechange = refresh;
  refresh();
  return gate;
}
