export function subtitleAt(lines, t) {
  const line = lines.find(l => t >= l.start && t < l.end);
  if (!line) return {text: '', active: -1};
  return {text: line.text, active: line.words?.findLastIndex(w => t >= w.start) ?? -1, words: line.words};
}
// Optional DOM overlay. Offline capture must explicitly composite this layer (canvas capture excludes DOM).
export function subtitleLayer(element, lines) {
  element.classList.add('scene-subtitle'); element.setAttribute('aria-live', 'off');
  return t => { const s = subtitleAt(lines, t); element.replaceChildren();
    if (s.words) s.words.forEach((w, i) => { const span = document.createElement('span'); span.textContent = w.text; span.dataset.active = String(i === s.active); element.append(span); });
    else element.textContent = s.text;
  };
}
