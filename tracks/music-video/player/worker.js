// One in-flight operation; no frame backlog. Even synchronous driver fallback stays off the UI thread.
let runtime, canvas, working=false;
const progress=warm=>postMessage({type:'progress',warm});
const compile=info=>postMessage({type:'compile',...info});
self.addEventListener('message',async({data})=>{
  if(working) {postMessage({type:'error',message:'Concurrent render command rejected'});return;}
  working=true;
  try {
    if(data.type==='init') {
      canvas=data.canvas;
      const {createRuntime}=await import(data.module);
      runtime=await createRuntime({...data,progress,compile});
      postMessage({type:'ready',capabilities:runtime.capabilities,shots:runtime.shots,diagnostics:runtime.diagnostics || null});
    } else if(data.type==='frame'||data.type==='warm') {
      const result=data.type==='warm'?await runtime.warmStep(data.t,data.quality):await runtime.render(data.t,data.quality);
      const bitmap=canvas.transferToImageBitmap();
      postMessage({type:'frame',...result,bitmap},[bitmap]);
      // Warm frames stay private; transfer only the restored current frame.
    } else if(data.type==='idle') {await runtime.idle(data.t);postMessage({type:'idle'});}
  } catch(error) {postMessage({type:'error',message:error.stack||String(error)});}
  finally {working=false;}
});
