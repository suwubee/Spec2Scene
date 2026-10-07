export function subtitleAt(lines, t) {
  const line = lines.find(l => l.locked === true && t >= l.start && t < l.end);
  if (!line) return {text: '', active: -1};
  return {text: line.text, active: line.words?.findLastIndex(w => t >= w.start) ?? -1, words: line.words};
}
// Optional DOM overlay. Offline capture must explicitly composite this layer (canvas capture excludes DOM).
export function subtitleLayer(element, lines, {fontFamily='serif',fontSize='1.5rem',direction='horizontal'}={}) {
  if (!['horizontal','vertical'].includes(direction)) throw new Error('unknown subtitle direction');
  Object.assign(element.style,{fontFamily,fontSize,writingMode:direction==='vertical'?'vertical-rl':'horizontal-tb',textOrientation:'mixed'});
  element.classList.add('scene-subtitle'); element.setAttribute('aria-live', 'off');
  return t => { const s = subtitleAt(lines, t); element.replaceChildren();
    if (s.words) s.words.forEach((w, i) => { const span = document.createElement('span'); span.textContent = w.text; span.dataset.active = String(i === s.active); element.append(span); });
    else element.textContent = s.text;
  };
}

/** Preserve display punctuation/spacing and expand approximate syllables to their glyph spans. */
export function alignedSongLines(alignment) {
  return (Array.isArray(alignment)?alignment:alignment?.lines||[]).filter(l=>l.locked===true).map(l=>{
    const words=l.words||[],glyphs=[];
    let offset=0;
    for(const c of l.text){
      const w=words.find(w=>offset>=w.offset&&offset<w.offset+w.length)||words.find(w=>w.offset>=offset)||words.at(-1);
      glyphs.push({c,t0:w?.start??l.start,t1:w?.end??l.end});offset++;
    }
    return {...l,t0:l.start,t1:l.end,chars:glyphs};
  });
}
