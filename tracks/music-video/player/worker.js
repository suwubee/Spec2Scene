// One in-flight operation; no frame backlog. Even synchronous driver fallback stays off the UI thread.
let runtime, canvas, working=false;
const progress=message=>postMessage({type:'progress',message});
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
    } else if(data.type==='frame') {
      const result=await runtime.render(data.t,data.quality);
      const bitmap=canvas.transferToImageBitmap();
      postMessage({type:'frame',...result,bitmap},[bitmap]);
      // Only prepare one upcoming scene after displaying the requested frame.
      // Main thread sends idle separately, so it never queues a second render.
    } else if(data.type==='idle') {await runtime.idle(data.t);postMessage({type:'idle'});}
  } catch(error) {postMessage({type:'error',message:error.stack||String(error)});}
  finally {working=false;}
});
