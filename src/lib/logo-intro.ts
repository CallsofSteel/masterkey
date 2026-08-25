// Masterkey — one-time logo intro (Coinbase "C" turns into the Masterkey keyhole).
//
// Shipped as a single inline <script> from the root layout rather than a React
// component, on purpose:
//   • zero client-bundle weight and no hydration dependency — it starts painting
//     the instant the tag parses, so the intro overlaps hydration instead of
//     waiting on it;
//   • it runs once per document, so App Router client-side navigation can never
//     retrigger it;
//   • the overlay DOM is created by the script only when it actually plays, so
//     repeat visitors pay one localStorage read and nothing else.
//
// Gates (all must pass, else it no-ops immediately):
//   1. homepage only        — keeps it out of /run, /bundles, /dashboard, /oauth,
//                             so agent-driven navigation to the chat or node view
//                             can never surface it
//   2. not seen before      — localStorage, written UP-FRONT so an interrupted
//                             intro still counts as seen
//   3. no reduced-motion    — respects the OS accessibility setting
//
// The mark itself is one parametric shape. Both logos are a white disc minus a
// centre hole minus a slot cut out through the rim; only the slot's angle and
// taper differ (measured off public/first-frame.png and public/last-frame.png).
// So the transition is a rotation plus a parameter swap — no path morphing — and
// it lands pixel-exact on both marks. Source of truth for the full-length version:
// videos/masterkey-logo-turn/index.html
//
// Replay hook — window.__mkIntroPlay() plays it again on demand, used by the
// ASCII-smiley easter egg in the sidebar footer (src/components/intro-replay-egg.tsx).
// It deliberately does NOT touch localStorage, so a replay never re-arms the
// automatic first-visit intro. Defining it costs one closure and touches no DOM
// until called.
//
// To retune: SPIN_TO (how many turns), the T beat sheet, END/FADE_MS.
// To remove: delete this file and the two lines in src/app/layout.tsx.

export const LOGO_INTRO_SCRIPT = `(function(){
"use strict";
var KEY="mk-intro-seen";

var C0={cx:363.29,cy:357.75,Ro:181.07,Ri:90.46,A:15.00,B:0};
var K1={cx:362.79,cy:362.76,Ro:177.10,Ri:69.62,A:17.21,B:0.2563};
var BLUE="#1733ff";

var T={holdEnd:0.12,windEnd:0.26,closeStart:1.42,shutStart:1.50,shutMid:1.52,
       spinEnd:1.55,pupilStart:1.56,pupilPeak:1.72,sliceStart:1.60,
       sliceEnd:1.80,settleEnd:1.94};
var END=2.02, FADE_MS=340;
var SPIN_FROM=-16, SPIN_TO=810;
var G=16, STEP=1.7, ALPHA=0.16, SMEAR_K=0.035, SMEAR_MAX=G*STEP;

function clamp(v,a,b){return v<a?a:v>b?b:v;}
function lerp(a,b,u){return a+(b-a)*u;}
function seg(t,a,b){return clamp((t-a)/(b-a),0,1);}
function outQuad(u){return 1-(1-u)*(1-u);}
function inQuad(u){return u*u;}
function outQuart(u){var m=1-u;return 1-m*m*m*m;}
function inOutSine(u){return 0.5-0.5*Math.cos(Math.PI*u);}
function smoothstep(u){u=clamp(u,0,1);return u*u*(3-2*u);}

var NP=1024, CUM=new Float64Array(NP+1);
(function(){
  function vel(u){
    if(u<0.16)return smoothstep(u/0.16);
    if(u<0.52)return 1;
    return Math.pow(1-(u-0.52)/0.48,1.9);
  }
  for(var i=1;i<=NP;i++)CUM[i]=CUM[i-1]+vel((i-0.5)/NP)/NP;
})();
function spinEase(u){
  u=clamp(u,0,1);var x=u*NP,i=Math.floor(x),f=x-i;
  var a=CUM[Math.min(i,NP)],b=CUM[Math.min(i+1,NP)];
  return (a+(b-a)*f)/CUM[NP];
}

function theta(t){
  if(t<=T.holdEnd)return 0;
  if(t<=T.windEnd)return lerp(0,SPIN_FROM,outQuad(seg(t,T.holdEnd,T.windEnd)));
  if(t>=T.spinEnd)return SPIN_TO;
  return lerp(SPIN_FROM,SPIN_TO,spinEase(seg(t,T.windEnd,T.spinEnd)));
}
function holeR(t){
  if(t<=T.holdEnd)return C0.Ri;
  if(t<=T.windEnd)return lerp(C0.Ri,93.5,outQuad(seg(t,T.holdEnd,T.windEnd)));
  if(t<=T.closeStart)return lerp(93.5,73.0,inOutSine(seg(t,T.windEnd,T.closeStart)));
  if(t<=T.shutStart)return lerp(73.0,0,inQuad(seg(t,T.closeStart,T.shutStart)));
  if(t<=T.pupilStart)return 0;
  if(t<=T.pupilPeak)return lerp(0,74.5,outQuart(seg(t,T.pupilStart,T.pupilPeak)));
  if(t<=T.settleEnd)return lerp(74.5,K1.Ri,inOutSine(seg(t,T.pupilPeak,T.settleEnd)));
  return K1.Ri;
}
function aperture(t){
  if(t<T.closeStart)return 1;
  if(t<T.shutStart)return 1-inQuad(seg(t,T.closeStart,T.shutStart));
  if(t<T.shutMid)return 0;
  return 1;
}
function markScale(t){
  if(t<=T.holdEnd)return 1;
  if(t<=T.windEnd)return lerp(1,0.986,outQuad(seg(t,T.holdEnd,T.windEnd)));
  if(t<=1.10)return lerp(0.986,1.004,inOutSine(seg(t,T.windEnd,1.10)));
  if(t<=T.closeStart)return lerp(1.004,0.996,inOutSine(seg(t,1.10,T.closeStart)));
  if(t<=T.shutStart)return lerp(0.996,0.974,inQuad(seg(t,T.closeStart,T.shutStart)));
  if(t<=T.pupilStart)return 0.974;
  if(t<=T.pupilPeak)return lerp(0.974,1.014,outQuart(seg(t,T.pupilStart,T.pupilPeak)));
  if(t<=T.settleEnd)return lerp(1.014,1.0,inOutSine(seg(t,T.pupilPeak,T.settleEnd)));
  return 1;
}
function discBlend(t){return inOutSine(seg(t,T.windEnd,T.closeStart));}

function slotPoints(cx,cy,thDeg,A,B,ap,s0,sEnd){
  if(sEnd<=s0)return "0,0";
  var th=thDeg*Math.PI/180, ux=Math.cos(th), uy=Math.sin(th), nx=-uy, ny=ux;
  var h0=Math.max(0,ap*(A+B*s0)), h1=Math.max(0,ap*(A+B*sEnd));
  return (cx+ux*s0+nx*h0).toFixed(2)+","+(cy+uy*s0+ny*h0).toFixed(2)+" "+
         (cx+ux*sEnd+nx*h1).toFixed(2)+","+(cy+uy*sEnd+ny*h1).toFixed(2)+" "+
         (cx+ux*sEnd-nx*h1).toFixed(2)+","+(cy+uy*sEnd-ny*h1).toFixed(2)+" "+
         (cx+ux*s0-nx*h0).toFixed(2)+","+(cy+uy*s0-ny*h0).toFixed(2);
}

var SVGNS="http://www.w3.org/2000/svg";
function el(n,attrs){
  var e=document.createElementNS(SVGNS,n);
  for(var k in attrs)e.setAttribute(k,attrs[k]);
  return e;
}

var active=null; // the currently-mounted instance, if any

function play(){
if(active)active.destroy();

var root=document.createElement("div");
root.id="mk-intro";
root.setAttribute("aria-hidden","true");
root.style.cssText="position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;"+
  "background:"+BLUE+";display:flex;align-items:center;justify-content:center;"+
  "opacity:1;transition:opacity "+FADE_MS+"ms ease-out;contain:strict";

var svg=el("svg",{viewBox:"0 0 726.15 726.15"});
// NB: the disc is only ~50% of the viewBox width (the rest is the logo tile's
// padding), so the rendered mark is about half these numbers.
svg.style.cssText="width:min(64vmin,460px);height:auto;display:block;"+
  "transform:scale(1);transition:transform "+FADE_MS+"ms ease-out;will-change:transform";

var disc=el("circle",{fill:"#ffffff"});
var smear=el("g",{});
var slot=el("polygon",{fill:BLUE,points:"0,0"});
var hole=el("circle",{fill:BLUE});
var pulse=el("circle",{fill:"none",stroke:"#ffffff","stroke-width":"3",opacity:"0"});
svg.appendChild(disc);svg.appendChild(smear);svg.appendChild(slot);
svg.appendChild(hole);svg.appendChild(pulse);

var ghosts=[];
for(var gi=0;gi<G;gi++){
  var gh=el("polygon",{fill:BLUE,opacity:"0",points:"0,0"});
  smear.appendChild(gh);ghosts.push(gh);
}
root.appendChild(svg);

function frame(t){
  t=clamp(t,0,END);
  var sc=markScale(t), bl=discBlend(t);
  var cx=lerp(C0.cx,K1.cx,bl), cy=lerp(C0.cy,K1.cy,bl);
  var Ro=lerp(C0.Ro,K1.Ro,bl)*sc, Ri=holeR(t)*sc;
  var kh=t>=T.shutMid;
  var A=(kh?K1.A:C0.A)*sc, B=kh?K1.B:C0.B;
  var ap=aperture(t), th=theta(t);
  var s0=B>1e-6?Math.max(-A/B,-Ri*0.96):-Ri*0.96;
  var sFull=Ro+80;
  var sEnd=kh?lerp(s0,sFull,outQuart(seg(t,T.sliceStart,T.sliceEnd))):sFull;

  disc.setAttribute("cx",cx.toFixed(2));disc.setAttribute("cy",cy.toFixed(2));
  disc.setAttribute("r",Math.max(0,Ro).toFixed(2));
  hole.setAttribute("cx",cx.toFixed(2));hole.setAttribute("cy",cy.toFixed(2));
  hole.setAttribute("r",Math.max(0,Ri).toFixed(2));
  slot.setAttribute("points",slotPoints(cx,cy,th,A,B,ap,s0,sEnd));

  var h=1/480, om=(theta(t+h)-theta(t-h))/(2*h), dir=om>=0?1:-1;
  var span=Math.min(Math.abs(om)*SMEAR_K,SMEAR_MAX);
  for(var i=0;i<G;i++){
    var d=(i+1)*STEP;
    if(span<1.2||d>span){ghosts[i].setAttribute("opacity","0");continue;}
    ghosts[i].setAttribute("points",slotPoints(cx,cy,th-dir*d,A,B,ap,s0,sEnd));
    ghosts[i].setAttribute("opacity",(ALPHA*Math.pow(1-d/span,1.1)).toFixed(3));
  }

  var pu=seg(t,1.58,1.96);
  if(pu>0&&pu<1){
    var e2=outQuart(pu);
    pulse.setAttribute("cx",cx.toFixed(2));pulse.setAttribute("cy",cy.toFixed(2));
    pulse.setAttribute("r",(Ro*lerp(1.0,1.15,e2)).toFixed(2));
    pulse.setAttribute("stroke-width",lerp(3.6,0.6,e2).toFixed(2));
    pulse.setAttribute("opacity",(0.5*(1-e2)).toFixed(3));
  }else pulse.setAttribute("opacity","0");
}

frame(0);
// Mounted on <html>, NOT <body>: React hydrates body's children, and an extra node
// there is a structural mismatch that makes React 19 discard the server HTML and
// re-render the whole app on the client. As an <html> child it is outside the
// hydrated tree, so hydration is untouched.
document.documentElement.appendChild(root);

var done=false, raf=0, t0=-1, hard=0;
function finish(){
  if(done)return; done=true;
  if(raf)cancelAnimationFrame(raf);
  if(hard)clearTimeout(hard);
  root.style.pointerEvents="none";
  root.style.opacity="0";
  svg.style.transform="scale(1.08)";
  off();
  setTimeout(function(){
    if(root.parentNode)root.parentNode.removeChild(root);
    if(active&&active.root===root)active=null;
  },FADE_MS+60);
}
// Immediate teardown, no fade — used when a replay supersedes a running instance.
function destroy(){
  done=true;
  if(raf)cancelAnimationFrame(raf);
  if(hard)clearTimeout(hard);
  off();
  if(root.parentNode)root.parentNode.removeChild(root);
  if(active&&active.root===root)active=null;
}
function onSkip(){finish();}
function off(){
  root.removeEventListener("pointerdown",onSkip);
  window.removeEventListener("keydown",onSkip);
  window.removeEventListener("wheel",onSkip);
  window.removeEventListener("touchmove",onSkip);
}
root.addEventListener("pointerdown",onSkip);
window.addEventListener("keydown",onSkip);
window.addEventListener("wheel",onSkip,{passive:true});
window.addEventListener("touchmove",onSkip,{passive:true});

function tick(now){
  if(done)return;
  if(t0<0)t0=now;
  var t=(now-t0)/1000;
  if(t>=END){frame(END);finish();return;}
  frame(t);
  raf=requestAnimationFrame(tick);
}
raf=requestAnimationFrame(tick);
// Hard stop: if rAF is starved (background tab, heavy hydration) never trap the user.
hard=setTimeout(finish,(END*1000)+1500);

active={root:root,destroy:destroy,close:finish};
return active;
}

window.__mkIntroPlay=play;

// Autoplay, first visit only. Any gate failing leaves __mkIntroPlay defined but
// plays nothing, so the sidebar easter egg still works everywhere.
try{
  if(window.__mkIntroRan)return; window.__mkIntroRan=1;
  if(location.pathname!=="/")return;
  if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  if(localStorage.getItem(KEY))return;
  localStorage.setItem(KEY,"1");
}catch(e){return;}

play();
})();`;
