import {placeSubtitle} from '../composition.js';
export function subtitleAt(lines, t) {
  const line = lines.find(l => l.locked === true && t >= l.start && t < l.end);
  if (!line) return {text: '', active: -1};
  return {text: line.text, active: line.words?.findLastIndex(w => t >= w.start) ?? -1, words: line.words};
}
// Optional DOM overlay. Offline capture must explicitly composite this layer (canvas capture excludes DOM).
export function subtitleLayer(element, lines, {fontFamily='serif',fontSize='1.5rem',direction='horizontal',composition=null}={}) {
  if (!['horizontal','vertical'].includes(direction)) throw new Error('unknown subtitle direction');
  Object.assign(element.style,{fontFamily,fontSize,writingMode:direction==='vertical'?'vertical-rl':'horizontal-tb',textOrientation:'mixed'});
  element.classList.add('scene-subtitle'); element.setAttribute('aria-live', 'off');
  return t => { const s = subtitleAt(lines, t);
    if(composition){const c=typeof composition==='function'?composition(t):composition,b=placeSubtitle(direction==='vertical'?{x0:.82,y0:.15,x1:.92,y1:.85}:{x0:.2,y0:.85,x1:.8,y1:.94},c.characterBounds||[]);Object.assign(element.style,{position:'absolute',left:`${b.x0*100}%`,top:`${b.y0*100}%`});element.dataset.avoidance=b.resolved?'clear':'review-required';} element.replaceChildren();
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
