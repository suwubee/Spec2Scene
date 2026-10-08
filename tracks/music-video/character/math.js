// Local scalar helpers keep the character independent of renderer implementation.
export const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
export const mix=(a,b,t)=>a+(b-a)*t;
export const smooth=x=>{const t=clamp(x);return t*t*(3-2*t);};
export const mod=(a,n)=>((a%n)+n)%n;
