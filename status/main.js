"use strict";(()=>{var _="openchamber.sdk";var ke="data-oc-scrolling",Ke=`
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${ke}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${ke}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${ke}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${ke}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;function qt(e){let o=e.documentElement;if(o.hasAttribute("data-oc-scrollbar-activity"))return;o.setAttribute("data-oc-scrollbar-activity","");let n=new WeakMap;e.addEventListener("scroll",d=>{let s=d.target===e?o:d.target;if(!(s instanceof Element))return;s.hasAttribute("data-oc-scrolling")||s.setAttribute("data-oc-scrolling","");let f=n.get(s);f!==void 0&&clearTimeout(f),n.set(s,setTimeout(()=>{n.delete(s),s.removeAttribute("data-oc-scrolling")},1e3))},{capture:!0,passive:!0})}var Yo=`(${qt.toString()})(document);`;var ro=/^[a-z][a-z0-9-]{0,39}$/;var eo=e=>Object(e)===e&&!Array.isArray(e),We=(e,o)=>Object.keys(e).every(n=>o.includes(n)),to=e=>String(e)===e&&e.length>=1&&e.length<=60,oo=e=>String(e)===e&&e.length>=1&&e.length<=80,no=e=>{if(!Array.isArray(e)||e.length>4)return!1;let o=new Set;for(let n of e){if(!eo(n)||!ro.test(n.id)||!to(n.label)||n.disabled!==void 0&&n.disabled!==!0&&n.disabled!==!1||o.has(n.id))return!1;if(o.add(n.id),n.kind==="button"){if(!We(n,["kind","id","label","disabled"]))return!1;continue}if(n.kind!=="select"||!We(n,["kind","id","label","value","options","disabled"])||!oo(n.value)||!Array.isArray(n.options)||n.options.length<1||n.options.length>16)return!1;let d=new Set;for(let s of n.options){if(!eo(s)||!We(s,["value","label"])||!oo(s.value)||!to(s.label)||d.has(s.value))return!1;d.add(s.value)}if(!d.has(n.value))return!1}return!0};var Je=e=>"bytes"in e?e.bytes.byteLength:e.content.length,so=(e,o)=>{if(e.path!==o.path||e.readOnly!==o.readOnly)return!1;if(e.encoding==="text"||o.encoding==="text")return e.encoding==="text"&&o.encoding==="text"&&e.content===o.content;if(e.bytes.byteLength!==o.bytes.byteLength)return!1;for(let n=0;n<e.bytes.byteLength;n+=1)if(e.bytes[n]!==o.bytes[n])return!1;return!0};var io=/^[A-Za-z0-9_-]{1,80}$/;var ao=["left","right","top","bottom"];var co=(e,o=0,n={remaining:16e3})=>{if(--n.remaining<0||o>=32)return!1;if(e===null)return!0;let d=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let s of d)if(!co(s,o+1,n))return!1;return!0},Ye=e=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every(o=>/^(0|[1-9]\d*)$/.test(o)&&Number(o)<e.length)&&e.every(Ye);if(Object(e)===e){let o=Object.getPrototypeOf(e);return(o===null||o===Object.prototype)&&Object.values(e).every(Ye)}return String(e)===e||Number.isFinite(e)},Qe=e=>{try{return String(e.id)!==e.id||!io.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!ao.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!co(e.data)||!Ye(e.data)?!1:JSON.stringify(e.data).length<=16e3}catch{return!1}};var po=["file","directory","other","missing"],qe=e=>!!(e&&"sessionId"in e),et=e=>!!(e&&"sent"in e&&!("sessionId"in e));var uo=/^[0-9a-f]{7,64}$/i,tt=e=>uo.test(e),ye=500,Oe=32e3,fo=16e3,Eo=128,_o=200,So=2e3,To=16e3,mo=80,ho=200,xo=16e3;var bo=2e3;var ot=2e4,ve=1024,Re=2e6;var we=64e3,Ue=8e3,rt=4e3;var nt=96e4,Qo=60*6e4;var go=999,Ao=1e4,Se=500,ko=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],yo=["stopped","starting","ready","failed"],Zo=new Set(ko),Oo=e=>Zo.has(e),vo=e=>e&&Oo(e)?e:"HOST_REJECTED",ne=e=>e===void 0?!1:e===null||e===!0||e===!1||String(e)===e?!0:Number(e)===e?Number.isFinite(e):Array.isArray(e)?e.every(ne):Object(e)===e?Object.values(e).every(ne):!1,Ro=e=>ne(e)&&JSON.stringify(e).length<=xo,lo=e=>e?.trim().slice(0,ho)??"",se=e=>{let o=e.id.trim().slice(0,Eo),n=e.title.trim().slice(0,_o),d=e.url.trim().slice(0,So),s=e.text?.trim().slice(0,To),f=e.author?.trim().slice(0,mo),R=e.kind==="pull"?"pull":"issue",O={providerId:e.providerId.trim(),id:o,title:n||o,url:d,kind:R};if(s&&(O.text=s),f&&(O.author=f),R==="pull"){let v=lo(e.branches?.head),N=lo(e.branches?.base);v&&N&&(O.branches={head:v,base:N})}return Ro(e.data)&&(O.data=e.data),O},st=e=>{let o=se(e);return e.projectId&&(o.projectId=e.projectId),e.navigation&&(o.navigation=e.navigation),e.worktree&&(o.worktree=e.worktree),o},it=e=>{let o={text:e.text.trim().slice(0,fo)};return e.send&&(o.send=!0),o},at=e=>e===null||!Number.isFinite(e)?null:Math.min(go,Math.max(0,Math.round(e))),ct=e=>Number.isFinite(e)?Math.min(Ao,Math.max(0,Math.ceil(e))):0;var ie=e=>e.length>0&&e.length<=ve&&!e.includes("\0")&&!e.includes("\\");var Ie=e=>!e.startsWith("/")||e.includes("\0")||e.includes("\\")||e.includes("://")||e.length>bo?!1:!e.split("/").some(n=>n==="."||n===".."),qo=new Set(yo),dt=e=>!!(e&&"status"in e&&qo.has(String(e.status))&&!("body"in e)),Ce=e=>!!(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),lt=e=>!!(e&&"content"in e&&String(e.content)===e.content),pt=e=>!!(e&&"written"in e&&e.written===!0),ut=e=>!!(e&&"entries"in e&&Array.isArray(e.entries)),er=new Set(po),ft=e=>!!(e&&"kind"in e&&"size"in e&&er.has(String(e.kind))&&Number.isFinite(e.size)),Et=e=>!!(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),tr=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),or=e=>Object(e)===e?e:null,Ze=e=>String(e)===e&&e.length>0,rr=e=>{if(!Ze(e.id))return null;if(e.ok===!0){let o={channel:_,v:1,type:"result",id:e.id,ok:!0};return Object(e.payload)===e.payload&&(o.payload=e.payload),o}return e.ok===!1&&Ze(e.error)?{channel:_,v:1,type:"result",id:e.id,ok:!1,error:e.error,code:vo(Ze(e.code)?e.code:void 0)}:null},_t=e=>{let o=or(e);return!o||o.channel!==_||o.v!==1?null:o.type==="result"?rr(o):!tr.has(String(o.type))||Object(o.payload)!==o.payload?null:o};var wo=e=>"key"in e&&"metaKey"in e&&"ctrlKey"in e,nr=e=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s",c=class extends Error{code;constructor(o,n){super(n),this.name="HostRequestError",this.code=o}},Uo=()=>Promise.reject(new c("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Me=()=>Promise.reject(new c("BAD_PATH",`File path must be 1 to ${ve} characters without NUL or backslash.`)),Le=e=>{if(e!==void 0){if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new c("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0}},u=e=>(e.value+=1,`oc-${e.value}`),xt=(e={})=>{let o=e.target??("window"in globalThis?window:null);if(!o)throw new c("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let n=e.acceptSource??(t=>t===o.parent),d=e.requestTimeoutMs??ot,s=new Set,f=new Set,R=new Set,O=new Set,v=new Set,N=new Set,P=new Set,ee=new Set,Y=new Set,z=new Set,j=[],le=null,pe=null,he=new Set,xe=new Set,ue=null,fe=null,Be=!1,te=new Map,oe=new Map,re=new Map,D=!1,p={value:0},l=null,F=null,Ee=!1,_e=!1,Ft=null,Xt=t=>t?{sessionId:t.id,phase:t.busy?"started":"completed"}:null,L=t=>{o.parent.postMessage(t,"*")},Bt=()=>{D||o.parent===o||z.size===0||l?.features?.lateGenerateResults!==!0||L({channel:_,v:1,type:"generate-late-listen"})},b=(t,r)=>{for(let i of t)try{i(r)}catch(a){console.error(a)}},Vt=t=>{if(!(t instanceof MessageEvent)||!n(t.source))return;let r=_t(t.data);if(!r)return;if(r.type==="workspace"){let a=oe.get(r.payload.subscriptionId);a&&b([a],r.payload.snapshot);return}if(r.type==="shells"){let a=re.get(r.payload.subscriptionId);a&&b([a],r.payload.snapshot);return}if(r.type==="ready"){l=r.payload,F=Xt(r.payload.session),b(s,r.payload),b(f,r.payload.directory),b(R,r.payload.session),F&&b(O,F),b(v,r.payload.connection),b(N,r.payload.settings),b(P,r.payload.item),Bt();return}if(r.type==="generate-late"){z.size===0?j.push(r.payload):b(z,r.payload);return}if(r.type==="directory"){l&&(l={...l,directory:r.payload.directory}),b(f,r.payload.directory);return}if(r.type==="session"){l&&(l={...l,session:r.payload.session}),r.payload.session?F?.sessionId!==r.payload.session.id&&(F=Xt(r.payload.session)):F=null,b(R,r.payload.session);return}if(r.type==="session-lifecycle"){F=r.payload,b(O,r.payload);return}if(r.type==="connection"){l&&(l={...l,connection:r.payload.connection}),b(v,r.payload.connection);return}if(r.type==="settings"){l&&(l={...l,settings:r.payload.settings}),b(N,r.payload.settings);return}if(r.type==="item"){l&&(l={...l,item:r.payload.item}),b(P,r.payload.item);return}if(r.type==="status-control-event"){b(ee,r.payload);return}if(r.type==="popover-closed"){b(Y,r.payload);return}if(r.type==="action"){let a=T=>{D||L({channel:_,v:1,type:"action-result",id:r.id,payload:T})},m=pe;if(!m){a({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>m(r.payload)).then(()=>a({ok:!0}),T=>{let y=(T instanceof Error?T.message:String(T)).trim();a({ok:!1,error:(y||"Action failed.").slice(0,Se)})});return}if(r.type==="file-open"){let a=r.payload;if(fe&&so(fe,a))return;fe=a,b(he,r.payload);return}if(r.type==="file-saved"){b(xe,r.payload.version);return}if(r.type==="file-snapshot"){let a=y=>{D||L({channel:_,v:1,type:"file-snapshot-result",id:r.id,payload:y})},m=y=>a({error:(y.trim()||"Could not read the edited file.").slice(0,Se)}),T=ue;if(!T){m("This extension does not edit files.");return}Promise.resolve().then(()=>T(r.payload.purpose)).then(y=>{if(Je(y)>2e7){m(`The file is over ${2e7} ${"bytes"in y?"bytes":"characters"}.`);return}if(y.version.length>256){m(`The snapshot version is over ${256} characters.`);return}a({snapshot:"bytes"in y?{bytes:y.bytes,version:y.version}:{content:y.content,version:y.version}})},y=>m(y instanceof Error?y.message:String(y)));return}if(r.type==="resolve"){let a=T=>{L({channel:_,v:1,type:"resolve-result",id:r.id,payload:T})},m=le;if(!m){a({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>m(r.payload)).then(T=>a({item:T?se(T):null}),T=>{let y=(T instanceof Error?T.message:String(T)).trim();a({error:(y||"Command failed.").slice(0,Se)})});return}let i=te.get(r.id);if(i){if(clearTimeout(i.timer),te.delete(r.id),r.ok){i.resolve(r.payload);return}i.reject(new c(r.code,r.error))}};o.addEventListener("message",Vt),L({channel:_,v:1,type:"hello"});let w=(t,r=d)=>D||o.parent===o?Promise.reject(new c("HOST_UNAVAILABLE","No host frame. This page is not in an iframe.")):new Promise((i,a)=>{let m=setTimeout(()=>{te.delete(t.id),a(new c("HOST_TIMEOUT","Host did not answer in time."))},r);te.set(t.id,{resolve:i,reject:a,timer:m}),L(t)}),A=t=>w(t).then(()=>{}),k={channel:_,v:1},Ve=t=>{!D&&o.parent!==o&&L(t)},zt=()=>Ve({...k,type:"file-save"}),jt=t=>{!wo(t)||!nr(t)||(t.preventDefault(),zt())},Kt=t=>{!wo(t)||t.key!=="Escape"||l?.surface!=="popover"||!l.popover||(t.preventDefault(),Qt(l.popover.id,"escape").catch(()=>{}))},be=()=>{let t=l?.surface==="popover"?l.popover:void 0;if(!t)return;let r=Ee||_e;Ft!==r&&(Ft=r,Zt(t.id,r).catch(()=>{}))},ge=()=>{l?.surface!=="popover"||Ee||(Ee=!0,be())},Wt=t=>{l?.surface!=="popover"||t.relatedTarget!==null||!Ee||(Ee=!1,be())},Jt=()=>{l?.surface!=="popover"||_e||(_e=!0,be())},Yt=()=>{l?.surface!=="popover"||!_e||(_e=!1,be())},H=(t,r=1024)=>{if(!t.trim()||t.length>r)throw new c("HOST_REJECTED",`Identity must contain 1 to ${r} characters.`)},ze=async t=>{t.kind!=="projects"&&H(t.projectId);let r=await w({...k,type:"workspace-read",id:u(p),payload:t});if(!r||!("kind"in r)||!("state"in r)||r.kind!==t.kind)throw new c("HOST_REJECTED","Host did not return workspace data.");return r},je=async(t,r)=>{t.kind!=="projects"&&H(t.projectId);let i=u(p);oe.set(i,r);try{await A({...k,type:"workspace-subscribe",id:u(p),payload:{subscriptionId:i,query:t}})}catch(a){throw oe.delete(i),D||L({...k,type:"workspace-unsubscribe",id:u(p),payload:{subscriptionId:i}}),a}return()=>{!oe.delete(i)||D||L({...k,type:"workspace-unsubscribe",id:u(p),payload:{subscriptionId:i}})}},Jo=async(t,r)=>{t.kind==="session"&&H(t.sessionId),t.kind==="project"&&H(t.projectId);let i=u(p);re.set(i,r);try{await A({...k,type:"shells-subscribe",id:u(p),payload:{subscriptionId:i,scope:t}})}catch(a){throw re.delete(i),D||L({...k,type:"shells-unsubscribe",id:u(p),payload:{subscriptionId:i}}),a}return()=>{!re.delete(i)||D||L({...k,type:"shells-unsubscribe",id:u(p),payload:{subscriptionId:i}})}},Ae=async t=>{if("key"in t&&(t.key.length===0||t.key.length>128))throw new c("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!ne(t.value))throw new c("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>65536)throw new c("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&l?.features?.deviceStorage!==!0)throw new c("UNSUPPORTED","This host does not support device storage.");let r=await w({...k,type:"storage",id:u(p),payload:t});if(!r||!("storage"in r)||r.op!==t.op)throw new c("HOST_REJECTED","Host did not return storage data.");return r},Qt=(t,r)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new c("UNSUPPORTED","This host does not support popovers.")):A({...k,type:"popover-close",id:u(p),payload:r?{id:t,reason:r}:{id:t}}),Zt=(t,r)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new c("UNSUPPORTED","This host does not support popovers.")):A({...k,type:"popover-anchor",id:u(p),payload:{id:t,active:r}});return o.addEventListener("keydown",Kt,!0),o.addEventListener("pointerover",ge),o.addEventListener("pointermove",ge),o.addEventListener("pointerout",Wt),o.addEventListener("focus",Jt),o.addEventListener("blur",Yt),{onAction:t=>(pe=t,()=>{pe===t&&(pe=null)}),listProjects:async()=>{let t=await ze({kind:"projects"});if(t.kind!=="projects")throw new c("HOST_REJECTED","Expected projects.");return t},listWorktrees:async t=>{let r=await ze({kind:"worktrees",projectId:t});if(r.kind!=="worktrees")throw new c("HOST_REJECTED","Expected worktrees.");return r},listSessions:async t=>{let r=await ze({kind:"sessions",projectId:t});if(r.kind!=="sessions")throw new c("HOST_REJECTED","Expected sessions.");return r},onProjects:t=>je({kind:"projects"},r=>{r.kind==="projects"&&t(r)}),onWorktrees:(t,r)=>je({kind:"worktrees",projectId:t},i=>{i.kind==="worktrees"&&r(i)}),onSessions:(t,r)=>je({kind:"sessions",projectId:t},i=>{i.kind==="sessions"&&r(i)}),onRunningShells:(t,r)=>Jo(t,r),readShellOutput:async(t,r)=>{H(t,128);let i=r?.cursor;if(i!==void 0&&(!Number.isInteger(i)||i<0))throw new c("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let a=r?.tailBytes;if(a!==void 0&&(!Number.isInteger(a)||a<1||a>65536))throw new c("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${65536}.`);let T=await w({...k,type:"shell-output",id:u(p),payload:{shellId:t,cursor:i,tailBytes:a}});if(!T||typeof T.output!="string"||!Number.isFinite(T.cursor))throw new c("HOST_REJECTED","Host did not return shell output.");return T},stopShell:async t=>{if(H(t,128),(await w({...k,type:"shell-stop",id:u(p),payload:{shellId:t}}))?.stopped!==!0)throw new c("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async t=>{H(t),await A({...k,type:"open-session",id:u(p),payload:{sessionId:t}})},storage:{get:async(t,r)=>{let i=Le(r),a={op:"get",key:t};i&&(a.scope=i);let m=await Ae(a);return m.op==="get"&&m.found?m.value:void 0},set:async(t,r,i)=>{let a=Le(i),m={op:"set",key:t,value:r};a&&(m.scope=a),await Ae(m)},delete:async(t,r)=>{let i=Le(r),a={op:"delete",key:t};i&&(a.scope=i),await Ae(a)},keys:async t=>{let r=Le(t),i={op:"keys"};r&&(i.scope=r);let a=await Ae(i);if(a.op!=="keys")throw new c("HOST_REJECTED","Expected storage keys.");return a.keys}},onReady:t=>(s.add(t),l&&t(l),()=>{s.delete(t)}),onDirectory:t=>(f.add(t),l&&t(l.directory),()=>{f.delete(t)}),onSession:t=>(R.add(t),l&&t(l.session),()=>{R.delete(t)}),onSessionLifecycle:t=>(O.add(t),F&&t(F),()=>{O.delete(t)}),onConnection:t=>(v.add(t),l&&t(l.connection),()=>{v.delete(t)}),onSettings:t=>(N.add(t),l&&t(l.settings),()=>{N.delete(t)}),onItem:t=>(P.add(t),l&&t(l.item),()=>{P.delete(t)}),onStatusControl:t=>(ee.add(t),()=>{ee.delete(t)}),onPopoverClosed:t=>(Y.add(t),()=>{Y.delete(t)}),setStatusControls:t=>l?.features?.statusControls!==!0?Promise.reject(new c("UNSUPPORTED","This host does not support status controls.")):no(t)?A({...k,type:"status-controls",id:u(p),payload:{controls:t}}):Promise.reject(new c("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options.")),openPopover:t=>l?.features?.popovers!==!0?Promise.reject(new c("UNSUPPORTED","This host does not support popovers.")):Qe(t)?A({...k,type:"popover-open",id:u(p),payload:t}):Promise.reject(new c("HOST_REJECTED","Popover requests need bounded geometry and JSON data.")),closePopover:Qt,setPopoverAnchorActive:Zt,onResolve:t=>(le=t,()=>{le===t&&(le=null)}),toast:t=>{let r=t.message.trim();return!r||r.length>ye?Promise.reject(new c("HOST_REJECTED",`Toast message must contain 1 to ${ye} characters.`)):t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Oe)?Promise.reject(new c("HOST_REJECTED",`Toast copy text must contain 1 to ${Oe} characters.`)):A({channel:_,v:1,type:"toast",id:u(p),payload:{...t,message:r}})},openUrl:t=>A({channel:_,v:1,type:"open-url",id:u(p),payload:{url:t}}),openCommit:t=>tt(t)?A({channel:_,v:1,type:"open-commit",id:u(p),payload:{sha:t}}):Promise.reject(new c("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:t=>A({channel:_,v:1,type:"open-surface",id:u(p),payload:{surfaceId:t}}),writeClipboard:t=>A({channel:_,v:1,type:"clipboard-write",id:u(p),payload:{text:t}}),compose:t=>A({channel:_,v:1,type:"compose",id:u(p),payload:t}),attach:t=>A({channel:_,v:1,type:"attach",id:u(p),payload:se(t)}),startSession:async t=>{t.projectId!==void 0&&H(t.projectId);let r=t.worktree;r&&r!==!0&&(r.kind==="existing"?H(r.directory):(r.name!==void 0&&H(r.name,200),r.baseBranch!==void 0&&H(r.baseBranch,200)));let i=await w({channel:_,v:1,type:"start-session",id:u(p),payload:st(t)},e.requestTimeoutMs??18e4);if(!qe(i))throw new c("HOST_REJECTED","Host did not return a session.");return i},prompt:t=>w({channel:_,v:1,type:"prompt",id:u(p),payload:it(t)}).then(r=>{if(!et(r))throw new c("HOST_REJECTED","Host did not return a prompt result.");return r}),sessionLink:t=>A({channel:_,v:1,type:"session-link",id:u(p),payload:se(t)}),close:()=>A({channel:_,v:1,type:"close",id:u(p)}),oauthStart:()=>A({channel:_,v:1,type:"oauth-start",id:u(p)}),oauthDisconnect:()=>A({channel:_,v:1,type:"oauth-disconnect",id:u(p)}),request:t=>(Ie(t.path)?w({channel:_,v:1,type:"request",id:u(p),payload:t}):Uo()).then(r=>{if(!Ce(r))throw new c("HOST_REJECTED","Host request result was empty.");return r}),serviceRequest:t=>(Ie(t.path)?w({channel:_,v:1,type:"service-request",id:u(p),payload:t}):Uo()).then(r=>{if(!Ce(r))throw new c("HOST_REJECTED","Host service request result was empty.");return r}),serviceStatus:()=>w({channel:_,v:1,type:"service-status",id:u(p)}).then(t=>{if(!dt(t))throw new c("HOST_REJECTED","Host did not return service status.");return t}),readFile:t=>(ie(t)?w({channel:_,v:1,type:"file-read",id:u(p),payload:{path:t}}):Me()).then(r=>{if(!lt(r))throw new c("HOST_REJECTED","Host did not return file content.");return r}),writeFile:(t,r)=>ie(t)?r.length>Re?Promise.reject(new c("FILE_TOO_LARGE",`Content is over ${Re} characters.`)):w({channel:_,v:1,type:"file-write",id:u(p),payload:{path:t,content:r}}).then(i=>{if(!pt(i))throw new c("HOST_REJECTED","Host did not confirm the write.");return i}):Me(),listDir:t=>(ie(t)?w({channel:_,v:1,type:"file-list",id:u(p),payload:{path:t}}):Me()).then(r=>{if(!ut(r))throw new c("HOST_REJECTED","Host did not return directory entries.");return r}),stat:t=>(ie(t)?w({channel:_,v:1,type:"file-stat",id:u(p),payload:{path:t}}):Me()).then(r=>{if(!ft(r))throw new c("HOST_REJECTED","Host did not return file status.");return r}),generate:t=>{let r=t.prompt.trim(),i=t.system?.trim();if(r.length===0||r.length>we)return Promise.reject(new c("HOST_REJECTED",`Prompt must be 1 to ${we} characters.`));if(i!==void 0&&(i.length===0||i.length>Ue))return Promise.reject(new c("HOST_REJECTED",`System prompt must be 1 to ${Ue} characters.`));let a=t.maxOutputTokens===void 0?void 0:Math.min(rt,Math.max(1,Math.floor(t.maxOutputTokens)));if(a!==void 0&&!Number.isFinite(a))return Promise.reject(new c("HOST_REJECTED","maxOutputTokens must be a number."));let m={prompt:r};return i!==void 0&&(m.system=i),a!==void 0&&(m.maxOutputTokens=a),w({channel:_,v:1,type:"generate",id:u(p),payload:m},e.requestTimeoutMs??nt).then(T=>{if(!Et(T))throw new c("HOST_REJECTED","Host did not return generated text.");return T})},onLateGenerateResult:t=>{z.add(t);for(let r of j.splice(0))b([t],r);return Bt(),()=>{z.delete(t)}},setBadge:t=>A({channel:_,v:1,type:"badge",id:u(p),payload:{count:at(t)}}),setHeight:t=>A({channel:_,v:1,type:"resize",id:u(p),payload:{height:ct(t)}}),onFileOpen:t=>(he.add(t),Be||(Be=!0,o.addEventListener("keydown",jt,!0)),fe&&t(fe),()=>{he.delete(t)}),onFileSnapshot:t=>(ue=t,()=>{ue===t&&(ue=null)}),onFileSaved:t=>(xe.add(t),()=>{xe.delete(t)}),reportFileChange:t=>Ve({...k,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:zt,reportFileUnsupported:()=>Ve({...k,type:"file-unsupported"}),dispose:()=>{for(let t of oe.keys())L({...k,type:"workspace-unsubscribe",id:u(p),payload:{subscriptionId:t}});oe.clear();for(let t of re.keys())L({...k,type:"shells-unsubscribe",id:u(p),payload:{subscriptionId:t}});re.clear(),D=!0,le=null,pe=null,ue=null,he.clear(),xe.clear(),Be&&o.removeEventListener("keydown",jt,!0),o.removeEventListener("message",Vt),o.removeEventListener("keydown",Kt,!0),o.removeEventListener("pointerover",ge),o.removeEventListener("pointermove",ge),o.removeEventListener("pointerout",Wt),o.removeEventListener("focus",Jt),o.removeEventListener("blur",Yt);for(let t of te.values())clearTimeout(t.timer),t.reject(new c("HOST_UNAVAILABLE","Host client was disposed."));te.clear(),s.clear(),f.clear(),R.clear(),O.clear(),v.clear(),N.clear(),P.clear(),ee.clear(),Y.clear(),z.clear(),j.length=0}}};var Mo=["browser.open","browser.snapshot","browser.click","browser.type","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Kr=new Set(Mo);var Lo=["none","agent","user"];var Jr=new Set(Lo);var sr=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],ir=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Go=(e,o)=>{o.style.colorScheme=e.mode;for(let[n,d]of sr)o.style.setProperty(n,e.tokens[d]);for(let[n,d,s]of ir){let f=e.tokens[s]??"";o.style.setProperty(n,f),o.style.setProperty(d,f)}o.style.setProperty("font-family",e.tokens.font),o.style.setProperty("font-size","0.875rem"),o.style.setProperty("line-height","1.45"),o.style.setProperty("color",e.tokens.foreground)},bt=(e,o)=>{Go(e.theme,o),o.dataset&&(o.dataset.ocSurface=e.surface,o.dataset.ocTheme=e.theme.mode)};var ar={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},x=(e,o)=>`var(--${e}, var(--oc-${ar[e]}, ${o}))`,B=x("surface-background","transparent"),Ne=x("surface-elevated","transparent"),ae=x("surface-elevated-foreground","inherit"),G=x("surface-foreground","inherit"),h=x("surface-muted-foreground","gray"),cr=x("surface-muted","transparent"),K=x("interactive-border","currentColor"),U=x("interactive-hover","transparent"),Q=x("interactive-active","transparent"),gt=x("interactive-selection","transparent"),At=x("interactive-selection-foreground","inherit"),X=x("primary","currentColor"),kt=x("primary-text","inherit"),yt=x("error-text","inherit"),dr=x("font-sans","inherit"),Ot=x("font-mono","monospace"),$o=x("radius","9px"),vt=`calc(${$o} - 2px)`,No=`calc(${$o} - 4px)`,g=(e,o,n="transparent")=>`color-mix(in srgb, ${e} ${o}%, ${n})`,Po=`background-image: linear-gradient(${U}, ${U});`,Rt=e=>`box-shadow: inset 0 0 0 1px ${e}, var(--oc-sdk-field-lift);`,wt="box-shadow: inset 0 0 0 1px var(--oc-sdk-edge), var(--oc-sdk-raised-lift);",Ho="box-shadow: var(--oc-sdk-lit);",Do=`inset 0 1px 0 0 ${g(G,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2)`,lr=`
:root {
  --oc-sdk-edge: ${g(G,10)};
  --oc-sdk-field-bg: ${Ne};
  --oc-sdk-raised-bg: ${B};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 2px 0 rgb(0 0 0 / 0.06);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.45), 0 1px 2px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.8), inset 0 0 0 1px rgb(0 0 0 / 0.04), 0 0 0 1px rgb(0 0 0 / 0.1), 0 1px 2px -0.5px rgb(0 0 0 / 0.08), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.08);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${g(G,6)};
  --oc-sdk-field-bg: ${g(B,50,Ne)};
  --oc-sdk-raised-bg: ${Ne};
  --oc-sdk-field-lift: ${Do};
  --oc-sdk-raised-lift: ${Do};
  --oc-sdk-lit: inset 0 1px 0 0 ${g(G,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.06), inset 0 0 0 1px rgb(255 255 255 / 0.08), 0 0 0 1px rgb(0 0 0 / 0.36), 0 1px 1px -0.5px rgb(0 0 0 / 0.22), 0 3px 3px -1.5px rgb(0 0 0 / 0.2), 0 6px 6px -3px rgb(0 0 0 / 0.16);
}`,Ge=e=>{let o=x(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${o}; --oc-sdk-tone-text: ${x(`${e}-text`,"inherit")}; }`},pr=`
.oc-sdk { box-sizing: border-box; font-size: 0.875rem; line-height: 1.45; }
.oc-sdk *, .oc-sdk *::before, .oc-sdk *::after { box-sizing: border-box; }
/* :where() keeps the reset at zero specificity so every primitive class below overrides it. */
:where(.oc-sdk) :where(button, input, textarea), :where(button.oc-sdk, input.oc-sdk, textarea.oc-sdk) { font: inherit; color: inherit; margin: 0; }
:where(.oc-sdk) :where(button), :where(button.oc-sdk) { cursor: pointer; background: none; border: 0; padding: 0; }
.oc-sdk button:disabled, button.oc-sdk:disabled, .oc-sdk[aria-disabled="true"], .oc-sdk [aria-disabled="true"] { opacity: .5; pointer-events: none; }

.oc-sdk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 32px; padding: 0 12px; border: 1px solid transparent; font-size: 0.875rem; font-weight: 500; line-height: 1; white-space: nowrap; }
.oc-sdk-btn[data-size="sm"] { gap: 6px; height: 28px; padding: 0 10px; font-size: 0.8125rem; }
.oc-sdk-btn[data-size="xs"] { gap: 4px; height: 24px; padding: 0 8px; font-size: 0.75rem; }
.oc-sdk-btn[data-loading="true"] { opacity: .5; pointer-events: none; }
.oc-sdk-btn > .oc-sdk-spinner-ring { width: 14px; height: 14px; }

.oc-sdk-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-field-label { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-field-note { font-size: 0.75rem; }
.oc-sdk-input { display: block; width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: 0; font-size: 0.875rem; line-height: 1.45; appearance: none; }
textarea.oc-sdk-input { height: auto; padding: 8px 10px; resize: vertical; }

.oc-sdk-search { position: relative; min-width: 0; }
.oc-sdk-search .oc-sdk-input { padding-left: 34px; padding-right: 34px; }
.oc-sdk-search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); pointer-events: none; }
.oc-sdk-search-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: none; align-items: center; justify-content: center; width: 24px; height: 24px; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-clear { display: inline-flex; }

.oc-sdk-select { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; width: auto; max-width: 100%; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; text-align: left; }
.oc-sdk-trigger-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-trigger-chevron { flex: 0 0 auto; }
.oc-sdk-popup { position: fixed; z-index: 50; display: flex; flex-direction: column; gap: 2px; min-width: 160px; max-width: calc(100vw - 16px); max-height: min(320px, calc(100vh - 16px)); overflow: auto; padding: 4px; border: 1px solid transparent; }
.oc-sdk-popup-search { flex: 0 0 auto; padding: 2px 2px 4px; }
.oc-sdk-popup-search .oc-sdk-input { height: 28px; font-size: 0.8125rem; }
.oc-sdk-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; font-size: 0.8125rem; text-align: left; }
.oc-sdk-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-option-hint { flex: 0 0 auto; font-size: 0.75rem; }
.oc-sdk-option-check { flex: 0 0 auto; display: inline-flex; width: 14px; visibility: hidden; }
.oc-sdk-option[aria-selected="true"] > .oc-sdk-option-check { visibility: visible; }
.oc-sdk-popup-empty { padding: 8px; font-size: 0.8125rem; }

.oc-sdk-check { display: inline-flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; }
.oc-sdk-check-box { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-top: 3px; border: 1px solid transparent; }
.oc-sdk-check-box > svg { display: none; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box > svg { display: block; }
.oc-sdk-check-thumb { flex: 0 0 auto; position: relative; width: 36px; height: 20px; }
.oc-sdk-check-thumb::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; }
.oc-sdk-check-text { display: flex; flex-direction: column; min-width: 0; }
.oc-sdk-check-label { font-size: 0.875rem; }
.oc-sdk-check-desc { font-size: 0.75rem; }

.oc-sdk-tabs { display: inline-flex; gap: 2px; padding: 2px; max-width: 100%; overflow: auto; }
.oc-sdk-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; font-weight: 500; white-space: nowrap; }
.oc-sdk-tab-count { font-size: 0.75rem; font-variant-numeric: tabular-nums; }

.oc-sdk-badge { display: inline-flex; align-items: center; padding: 1px 6px; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; }

.oc-sdk-list { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.oc-sdk-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; text-align: left; }
.oc-sdk-row-lead { flex: 0 0 auto; width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.oc-sdk-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-meta { flex: 0 0 auto; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-list-empty { padding: 16px 8px; text-align: center; font-size: 0.8125rem; }

.oc-sdk-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 40px 16px; text-align: center; }
.oc-sdk-empty-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
.oc-sdk-empty-body { margin: 0; max-width: 32rem; font-size: 0.8125rem; }
.oc-sdk-empty-action { margin-top: 12px; }

@keyframes oc-sdk-spin { to { transform: rotate(360deg); } }
.oc-sdk-spinner { display: inline-flex; align-items: center; gap: 8px; font-size: 0.8125rem; }
.oc-sdk-spinner-ring { width: 16px; height: 16px; border: 2px solid transparent; animation: oc-sdk-spin .8s linear infinite; }
.oc-sdk-spinner[data-size="sm"] .oc-sdk-spinner-ring { width: 12px; height: 12px; }

.oc-sdk-banner { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; border: 1px solid transparent; }
.oc-sdk-banner-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.oc-sdk-banner-title { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-banner-body { font-size: 0.8125rem; }
.oc-sdk-banner-action { flex: 0 0 auto; }

.oc-sdk-separator { display: flex; align-items: center; gap: 8px; width: 100%; margin: 8px 0; font-size: 0.75rem; }
.oc-sdk-separator::before, .oc-sdk-separator::after { content: ""; flex: 1 1 auto; height: 1px; }
.oc-sdk-separator[data-labeled="false"]::after { display: none; }
.oc-sdk-popup > .oc-sdk-separator { margin: 4px 0; }

.oc-sdk-progress { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-progress-label { display: flex; justify-content: space-between; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-progress-track { height: 6px; overflow: hidden; }
.oc-sdk-progress-fill { height: 100%; transform-origin: left; transition: transform 200ms ease-out; }

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: 8px 0; }
`,Fo=`${lr}
.oc-sdk { color: ${G}; font-family: ${dr}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${Po} }
.oc-sdk-mono { font-family: ${Ot}; }
.oc-sdk-muted { color: ${h}; }
${Ge("success")}${Ge("warning")}${Ge("error")}${Ge("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${X}; --oc-sdk-tone-text: ${kt}; }

.oc-sdk-btn { border-radius: ${vt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${No}; }
.oc-sdk-btn[data-variant="default"] { color: ${kt}; background: ${g(X,10,B)}; border-color: ${g(X,12)}; ${Ho} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${g(X,16,B)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${g(X,22,B)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${cr}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${Q}, ${Q}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${ae}; border-color: transparent; ${wt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${Q}, ${Q}); box-shadow: inset 0 0 0 1px var(--oc-sdk-edge); }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${U}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${Q}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${x("status-error","red")}; color: ${yt}; background: ${g("var(--oc-sdk-tone)",7,B)}; border-color: ${g("var(--oc-sdk-tone)",12)}; ${Ho} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${g("var(--oc-sdk-tone)",9,B)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${g("var(--oc-sdk-tone)",11,B)}; box-shadow: none; }

.oc-sdk-field-note { color: ${h}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${yt}; }
.oc-sdk-input { border-radius: ${vt}; background: var(--oc-sdk-field-bg); color: ${ae}; ${Rt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${h}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Rt(g(G,26))} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Rt(x("status-error","red"))} }
.oc-sdk-input[data-mono="true"] { font-family: ${Ot}; }

.oc-sdk-search-icon { color: ${h}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${X}; }
.oc-sdk-search-clear { border-radius: ${No}; color: ${h}; }
.oc-sdk-search-clear:hover { background: ${U}; color: ${G}; }

.oc-sdk-trigger { border-color: transparent; border-radius: ${vt}; background: var(--oc-sdk-raised-bg); color: ${ae}; ${wt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${Q}, ${Q}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${h}; }
.oc-sdk-trigger-chevron { color: ${h}; }
/* The app's dropdown light: lit top, hairline rings and a layered shadow, no border. */
.oc-sdk-popup { --surface-foreground: ${ae}; border-color: transparent; border-radius: 12px; background: ${Ne}; color: ${ae}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${U}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${gt}; color: ${At}; }
.oc-sdk-option-check { color: ${G}; }
.oc-sdk-option[data-destructive="true"] { color: ${yt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${g(x("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${h}; }
.oc-sdk-popup-empty { color: ${h}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${K}; border-radius: 4px; color: ${G}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${g(G,60,K)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${K}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${B}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${X}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Po} }
.oc-sdk-check-desc { color: ${h}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${g(G,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${h}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${G}; }
.oc-sdk-tab[aria-selected="true"] { color: ${At}; background: ${gt}; border-color: ${K}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${ae}; background: var(--oc-sdk-raised-bg); border-color: transparent; ${wt} }
.oc-sdk-tab-count { color: ${h}; }

.oc-sdk-badge { border-radius: 9999px; background: ${U}; color: ${h}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${g("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${U}; }
.oc-sdk-row[aria-selected="true"] { background: ${gt}; color: ${At}; }
.oc-sdk-row-lead { font-family: ${Ot}; color: ${h}; }
.oc-sdk-row-sub { color: ${h}; }
.oc-sdk-row-meta { color: ${h}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${h}; }

.oc-sdk-empty-body { color: ${h}; }

.oc-sdk-spinner { color: ${h}; }
.oc-sdk-spinner-ring { border-color: ${K}; border-top-color: ${X}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${g("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${h}; }

.oc-sdk-separator { color: ${h}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${g(K,40)}; }

.oc-sdk-progress-label { color: ${h}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${K}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${X}); }

.oc-sdk-text a { color: ${kt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${g(K,60)}; }
`,I=`
${Ke}
${pr}
${Fo}`;var Sr=e=>e!==null&&typeof e=="object"&&!Array.isArray(e);function Xo(e){let o=JSON.parse(e);if(!Sr(o)||o.version!==1||typeof o.sessionID!="string"||typeof o.live!="boolean"||!["todo","monitors","evalCells","background","wakeSources"].every(n=>Array.isArray(o[n])))throw new Error("antechamber answered with an unexpected work-status shape");return o}function Bo(e){return e.goal?.armed===!0||e.wakeSources.length>0||e.todo.some(o=>o.tasks.some(n=>n.status==="in_progress"))}function Vo(e){let o=Math.max(0,Math.floor(e/1e3));if(o<60)return`${o}s`;let n=Math.floor(o/60);if(n<60)return`${n}m ${String(o%60).padStart(2,"0")}s`;let d=Math.floor(n/60);return d<24?`${d}h ${String(n%60).padStart(2,"0")}m`:`${Math.floor(d/24)}d ${d%24}h`}function Ct(e){let o=e.tasks.filter(f=>f.status!=="cancelled"),n=o.filter(f=>f.status==="completed").length,d=e.tasks.find(f=>f.status==="in_progress")?.content,s=e.tasks.every(f=>f.status==="completed"||f.status==="cancelled");return{name:e.name,done:n,total:o.length,finished:s,...d!==void 0?{current:d}:{},tone:d!==void 0?"run":s?"ok":"idle"}}function zo(e){let o=e.findIndex(n=>n.tasks.some(d=>d.status==="in_progress"));return o>=0?o:e.findIndex(n=>!Ct(n).finished)}function Mt(e){switch(e){case"senpi-codemode":return"eval cells";case"terminal-monitors":return"monitors";case"terminal-background-sessions":return"background sessions";case"loop-guard":return"loop guard";default:return e}}function jo(e){return e.todo.length===0&&e.goal===null&&e.wakeSources.length===0}var Tr=1500,Ko=5e3,mr=1e4,hr={completed:"\u2713",in_progress:"\u25CF",pending:"\u25CB",cancelled:"\u2013"},$=xt(),Gt=document.getElementById("root"),me=null,Z="",W=null,J=null,Fe=0,Nt,Xe=!1,Pt=new Map,Te=new Set,Ht=[];function E(e,o={},...n){let d=document.createElement(e);for(let[s,f]of Object.entries(o))typeof f=="function"?d.addEventListener(s,f):s==="class"?d.className=String(f):f===!0?d.setAttribute(s,""):f!==!1&&d.setAttribute(s,f);for(let s of n)s&&d.append(s);return d}function xr(e,o="meta"){let n=E("span",{class:o}),d=s=>{n.textContent=e(s),n.title=n.textContent};return d(Date.now()),Ht.push(d),n}function br(e={}){return{session:me??"",...Z?{stateDir:Z}:{},...e}}async function Wo(e,o,n={}){let d=await $.serviceRequest({method:e,path:o,query:br(n)});if(d.status>=400){let s=`HTTP ${d.status}`;try{let f=JSON.parse(d.body);s=String(f.data?.message??f.detail??f.error??s)}catch{}throw new Error(s)}return d.body}function Lt(e){clearTimeout(Nt),Nt=setTimeout(()=>{de()},e)}async function de(){if(clearTimeout(Nt),me===null){W=null,J=null,q();return}if(document.hidden)return Lt(Ko);let e=++Fe;try{let o=Xo(await Wo("GET","/status"));if(e!==Fe)return;W=o,J=null,q(),Lt(Bo(o)?Tr:Ko)}catch(o){if(e!==Fe)return;J=o instanceof Error?o.message:String(o),q(),Lt(mr)}}async function gr(e,o,n,d,s){if(!Te.has(e)){Te.add(e),q();try{await Wo(o,n,d),$.toast({kind:"success",message:s}).catch(()=>{})}catch(f){$.toast({kind:"error",message:f.message}).catch(()=>{})}finally{Te.delete(e),de()}}}function Dt(e,o,...n){return E("section",{class:"group","aria-label":e},E("div",{class:"label"},e,o!==null&&E("span",{class:"count"},o)),...n)}function $t(e){return E("span",{class:`dot t-${e}`,"aria-hidden":"true"})}function Ar(e){if(e.todo.length===0)return null;let o=zo(e.todo),n=e.todo.map(Ct),d=n.reduce((R,O)=>R+O.done,0),s=n.reduce((R,O)=>R+O.total,0),f=e.todo.flatMap((R,O)=>{let v=n[O],N=`${O}:${R.name}`,P=Pt.get(N)??O===o,ee=v.total===0?100:Math.round(v.done/v.total*100),Y=E("button",{class:`row t-${v.tone}${P?" is-open":""}`,type:"button","aria-expanded":String(P),click:()=>{Pt.set(N,!P),q()}},$t(v.tone),E("span",{class:"stack"},E("span",{class:"title"},v.name),!P&&v.current!==void 0&&E("span",{class:"meta"},v.current)),E("span",{class:"side"},`${v.done}/${v.total}`,E("span",{class:"bar","aria-hidden":"true"},E("i",{style:`width:${ee}%`}))));if(!P)return[Y];let z=E("div",{class:"tasks"},...R.tasks.map(j=>E("div",{class:`task s-${j.status}`},E("span",{class:"glyph","aria-label":j.status.replace("_"," ")},hr[j.status]),E("span",{},j.content))));return[Y,z]});return Dt("Todo",`${d}/${s}`,...f)}function kr(e){let o=e.goal;if(o===null)return null;let n=Object.entries(o.wakeSources??{}).filter(([,s])=>s>0).map(([s,f])=>`${f} ${Mt(s)}`).join(", "),d=E("div",{class:`row t-${o.armed?"run":"idle"}`},$t(o.armed?"run":"idle"),E("span",{class:"stack"},E("span",{class:"title"},o.armed?"Goal continuation armed":"Goal continuation idle"),o.armed&&o.dueAtMs!==void 0?xr(s=>`${o.kind??"next"} ${(o.dueAtMs??s)>s?`in ${Vo((o.dueAtMs??s)-s)}`:"due now"}${n?` \xB7 waiting on ${n}`:""}`):n&&E("span",{class:"meta"},`waiting on ${n}`)),E("span",{class:"side"},o.armed&&e.live&&E("button",{class:"action",type:"button",disabled:Te.has("goal"),click:()=>{gr("goal","POST","/goal/fire",{},"Goal continuation fired")}},"Fire now")));return Dt("Goal",null,d)}function yr(e){return e.wakeSources.length===0?null:Dt("Other activity",null,...e.wakeSources.map(o=>E("div",{class:"row t-run"},$t("run"),E("span",{class:"stack"},E("span",{class:"title"},Mt(o.source)),o.items.length>0&&E("span",{class:"meta"},o.items.map(n=>n.description).join(", "))),E("span",{class:"side"},`${o.activeCount} active`))))}function Or(){let e=E("input",{name:"stateDir",value:Z,placeholder:"~/.config/antechamber (default)",autocomplete:"off",spellcheck:"false"}),o=()=>{Z=e.value.trim(),Xe=!1,$.storage.set("stateDir",Z).catch(()=>{}),de()};return E("form",{class:"settings",submit:n=>{n.preventDefault(),o()}},E("label",{},"antechamber state directory",e),E("div",{class:"buttons"},E("button",{class:"action",type:"submit"},"Save")))}function q(){Ht=[];let e=[];if(Xe&&e.push(Or()),me===null)e.push(E("div",{class:"note"},"Open a session to see its background work."));else if(W===null&&J===null)e.push(E("div",{class:"note"},"Loading\u2026"));else if(W===null)e.push(E("div",{class:"note is-error"},J));else{J!==null&&e.push(E("div",{class:"note is-error"},J));let o=[Ar,kr,yr].map(n=>n(W));e.push(...o),jo(W)&&e.push(E("div",{class:"note"},W.live?"No todo list or goal.":"No todo list or goal. The agent is not running."))}Gt.replaceChildren(...e.filter(o=>!!o))}setInterval(()=>{let e=Date.now();for(let o of Ht)o(e)},1e3);new ResizeObserver(()=>{$.setHeight(Math.ceil(Gt.getBoundingClientRect().height)).catch(()=>{})}).observe(Gt);document.addEventListener("visibilitychange",()=>{document.hidden||de()});$.onStatusControl(e=>{e.id==="data-path"&&(Xe=!Xe,q())});$.onReady(e=>{bt(e,document.documentElement),e.features?.statusControls&&$.setStatusControls([{kind:"button",id:"data-path",label:"Data path"}]).catch(()=>{})});$.onSession(e=>{let o=e?.id??null;o!==me&&(me=o,W=null,J=null,Te.clear(),Pt.clear(),Fe++,de())});$.storage.get("stateDir").then(e=>{typeof e=="string"&&e!==Z&&(Z=e,de())}).catch(()=>{});q();})();
