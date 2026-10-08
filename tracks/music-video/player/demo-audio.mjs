// Generated only into project assets. Original procedural chords, not a recording or voice.
export function demoWave(seconds=60,sampleRate=16000) {
  if(!Number.isFinite(seconds)||seconds<=0||seconds>120)throw new Error('Demo duration out of bounds');
  const count=Math.round(seconds*sampleRate),data=Buffer.alloc(44+count*2);
  data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);
  data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(sampleRate,24);data.writeUInt32LE(sampleRate*2,28);
  data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(count*2,40);
  const notes=[220,261.6256,329.6276,293.6648,246.9417,196,220,293.6648];
  for(let i=0;i<count;i++) {
    const t=i/sampleRate,n=notes[Math.floor(t/3.75)%notes.length],phase=t%3.75;
    const envelope=(.45+.55*Math.exp(-phase*1.6))*Math.min(1,t/.008,(seconds-t)/.2);
    const value=(Math.sin(2*Math.PI*n*t)+.3*Math.sin(2*Math.PI*n*1.5*t)+.18*Math.sin(2*Math.PI*n*2*t))*.16*envelope;
    data.writeInt16LE(Math.round(value*32767),44+i*2);
  }
  return data;
}
