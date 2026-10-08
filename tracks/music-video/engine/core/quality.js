// Author: suwubee
export const QUALITY = Object.freeze({
  high:{pipeline:'final',renderScale:1,msaa:4,shadow:2048,particles:1},
  medium:{pipeline:'preview',renderScale:.75,msaa:0,shadow:1024,particles:.5},
  low:{pipeline:'preview',renderScale:.5,msaa:0,shadow:512,particles:.25},
});
export function resolveQuality(request='auto',gl=null) {
  const ext=gl?.getExtension('WEBGL_debug_renderer_info');
  const renderer=gl ? String(gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL || gl.RENDERER)) : '';
  const software=/swiftshader|llvmpipe|softpipe|software|mesa offscreen/i.test(renderer);
  if(!['auto','high','medium','low','final','preview'].includes(request))throw new Error('unknown quality');
  const name=request==='final'?'high':request==='preview'?'medium':request==='auto'?(software?'low':'high'):request;
  return {...QUALITY[name],name,request,requested:request,actual:name,offlineQuality:'high',renderer,software,offline:request==='final',reason:software&&request==='auto'?'software renderer: auto selected low':'explicit requested quality preserved'};
}
