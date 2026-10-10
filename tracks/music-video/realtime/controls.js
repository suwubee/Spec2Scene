/** DOM controls share the transport clock, including while the engine is warming. */
export function createControls({root, slider, download, time, transport, refresh, isWarming,
  activity = window, idleMs = 2500}) {
  let timer, dragging = false, disposed = false, checking = false, request;
  const listeners = [];
  const on = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };
  const format = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  function show() {
    clearTimeout(timer); root.classList.remove('idle');
    if (disposed) return;
    timer = setTimeout(() => {
      const s = transport.state;
      if (!s.paused && !isWarming() && s.sound === 'playing' && !dragging &&
          !root.contains(document.activeElement)) root.classList.add('idle');
    }, idleMs);
  }
  function present(t = transport.time()) {
    if (!dragging) slider.value = t;
    time.textContent = `${format(Number(slider.value))} / ${format(Number(slider.max))}`;
    slider.setAttribute('aria-valuetext', time.textContent);
  }
  function seek(t) { transport.seek(t); slider.value = transport.time(); refresh(); present(); show(); }
  on(slider, 'input', () => seek(Number(slider.value)));
  on(slider, 'pointerdown', () => { dragging = true; show(); });
  for (const event of ['pointerup', 'pointercancel']) on(activity, event, () => { dragging = false; show(); });
  for (const event of ['pointermove', 'pointerdown', 'keydown']) on(activity, event, show);
  on(root, 'focusin', show); on(root, 'focusout', show);
  // Pointer activation should not pin the controls forever; keyboard focus stays visible.
  on(root, 'click', event => { if (event.detail > 0 && event.target === document.activeElement) event.target.blur(); show(); });
  function unavailable() {
    download.removeAttribute('href'); download.setAttribute('aria-disabled', 'true');
    download.textContent = '成片生成中';
  }
  async function checkDownload() {
    if (checking || disposed) return;
    checking = true; request = new AbortController();
    const timeout = setTimeout(() => request.abort(), 8000);
    try {
      const url = new URL(download.dataset.video, location.href);
      if (url.origin !== location.origin) throw new Error('Download must be same-origin');
      const response = await fetch(url, {method: 'HEAD', cache: 'no-store', signal: request.signal});
      if (!response.ok || !/^video\/mp4(?:;|$)/i.test(response.headers.get('content-type') || '') ||
          response.headers.get('content-length') === '0') throw new Error('Video not ready');
      if (!disposed) {
        download.href = url.href; download.download = url.pathname.split('/').at(-1);
        download.setAttribute('aria-disabled', 'false'); download.textContent = '下载 MP4';
      }
    } catch { if (!disposed) unavailable(); }
    finally { clearTimeout(timeout); checking = false; }
  }
  on(download, 'click', event => { if (download.getAttribute('aria-disabled') === 'true') event.preventDefault(); });
  on(activity, 'focus', checkDownload);
  unavailable(); checkDownload(); present(); show();
  const retry = setInterval(checkDownload, 30000);
  return {present, seek, show, checkDownload, dispose() {
    disposed = true; clearTimeout(timer); clearInterval(retry); request?.abort(); listeners.forEach(remove => remove());
  }};
}
