import { useState, useEffect, useRef, useCallback } from "react";

const C = {
  bg:"#080d12", panel:"#0d1520", border:"#172130",
  ferm:"#00d4ff", keezer:"#00f0a0", heat:"#ff6b35",
  cool:"#38bdf8", warn:"#f59e0b", danger:"#ef4444",
  ok:"#22c55e", text:"#dde6f0", muted:"#3d5470",
};
const MONO = "'Share Tech Mono', monospace";
const HEAD = "'Rajdhani', sans-serif";
const MAX_HIST = 300;

const rnd = (v, d=2) => +v.toFixed(d);
const clamp = (v,mn,mx) => Math.min(mx, Math.max(mn,v));
const simNoise = (v,drift) => rnd(v + drift + (Math.random()-0.5)*0.25);
const fmtTime = ts => new Date(ts).toLocaleTimeString("hr-HR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
const fmtDT = ts => new Date(ts).toLocaleString("hr-HR");

// ── Firebase config ──────────────────────────────────────────────
const FIREBASE_URL = "https://fermentationcontroller-default-rtdb.europe-west1.firebasedatabase.app";
const FIREBASE_STATE = FIREBASE_URL + "/state.json";

async function fetchFirebase() {
  try {
    const r = await fetch(FIREBASE_STATE);
    if (!r.ok) throw new Error("Firebase error");
    return await r.json();
  } catch(e) {
    console.error("[Firebase]", e);
    return null;
  }
}

async function pushFirebase(cmd) {
  try {
    // Push command to Firebase commands node — ESP32 polls this
    await fetch(FIREBASE_URL + "/cmd.json", {
      method: "PUT",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(cmd)
    });
  } catch(e) {
    console.error("[Firebase cmd]", e);
  }
}

function calcFermRelays(temp,sp,hyst,heat,cool) {
  const d = temp-sp;
  if (d < -hyst) return {heat:true, cool:false};
  if (d >  hyst) return {heat:false,cool:true};
  if (Math.abs(d) < hyst*0.4) return {heat:false,cool:false};
  return {heat,cool};
}
function calcKeezerRelay(temp,sp,hyst,prev) {
  if (temp-sp >  hyst) return true;
  if (temp-sp < -hyst) return false;
  return prev;
}

function drawChart(canvas, series, height=200) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio||1;
  const W = (canvas.parentElement?.clientWidth-40)||400;
  canvas.width=W*dpr; canvas.height=height*dpr;
  canvas.style.width=W+"px"; canvas.style.height=height+"px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr,dpr); ctx.clearRect(0,0,W,height);
  const pad={top:14,right:16,bottom:28,left:42};
  const fw=W-pad.left-pad.right, fh=height-pad.top-pad.bottom;
  const allVals = series.flatMap(s=>[...s.data.map(d=>d.temp),s.sp]);
  if (!allVals.length) return;
  const mnV=Math.floor(Math.min(...allVals)-1), mxV=Math.ceil(Math.max(...allVals)+1), range=mxV-mnV||1;
  const toX=(i,len)=>pad.left+(i/Math.max(len-1,1))*fw;
  const toY=v=>pad.top+fh-((v-mnV)/range)*fh;
  for (let t=mnV;t<=mxV;t++) {
    const y=toY(t);
    ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(W-pad.right,y);
    ctx.strokeStyle="#172130";ctx.lineWidth=1;ctx.setLineDash([3,5]);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle="#3d5470";ctx.font="9px Share Tech Mono";ctx.textAlign="right";
    ctx.fillText(t+"°",pad.left-5,y+4);
  }
  series.forEach(({data,color,sp,label})=>{
    const spy=toY(sp);
    ctx.beginPath();ctx.moveTo(pad.left,spy);ctx.lineTo(W-pad.right,spy);
    ctx.strokeStyle=color+"55";ctx.lineWidth=1;ctx.setLineDash([6,5]);ctx.stroke();ctx.setLineDash([]);
    if (data.length<2) return;
    ctx.beginPath();ctx.moveTo(toX(0,data.length),height-pad.bottom);
    data.forEach((d,i)=>ctx.lineTo(toX(i,data.length),toY(d.temp)));
    ctx.lineTo(toX(data.length-1,data.length),height-pad.bottom);ctx.closePath();
    const g=ctx.createLinearGradient(0,0,0,height);
    g.addColorStop(0,color+"44");g.addColorStop(1,color+"05");
    ctx.fillStyle=g;ctx.fill();
    ctx.beginPath();
    data.forEach((d,i)=>{const x=toX(i,data.length),y=toY(d.temp);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
    ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineJoin="round";ctx.stroke();
  });
  if (series.length>1) {
    series.forEach(({color,label},idx)=>{
      const ox=idx*120;
      ctx.beginPath();ctx.arc(pad.left+8+ox,pad.top+8,4,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
      ctx.fillStyle=color;ctx.font="10px Share Tech Mono";ctx.textAlign="left";
      ctx.fillText(label,pad.left+16+ox,pad.top+13);
    });
  }
}

function drawSparkline(canvas,data,color) {
  if (!canvas||data.length<2) return;
  const dpr=window.devicePixelRatio||1;
  const W=canvas.clientWidth||300, H=canvas.clientHeight||52;
  canvas.width=W*dpr; canvas.height=H*dpr;
  const ctx=canvas.getContext("2d");
  ctx.scale(dpr,dpr); ctx.clearRect(0,0,W,H);
  const vals=data.map(d=>d.temp);
  const mn=Math.min(...vals)-.3, mx=Math.max(...vals)+.3, range=mx-mn||1;
  const pts=data.map((d,i)=>({x:(i/(data.length-1))*W,y:H-((d.temp-mn)/range)*H}));
  ctx.beginPath();ctx.moveTo(0,H);
  pts.forEach(p=>ctx.lineTo(p.x,p.y));
  ctx.lineTo(W,H);ctx.closePath();
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,color+"55");g.addColorStop(1,color+"05");
  ctx.fillStyle=g;ctx.fill();
  ctx.beginPath();
  pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineJoin="round";ctx.stroke();
}

// ── Sub components ────────────────────────────────────────────────

function RelayDot({on,color}) {
  return <div style={{width:12,height:12,borderRadius:"50%",background:on?color:"#1a2a3a",border:`1px solid ${on?color:C.border}`,boxShadow:on?`0 0 10px ${color}`:"none",transition:"all .3s"}} />;
}

function RelayCard({label,sub,active,color}) {
  return (
    <div style={{background:"#060b11",borderRadius:10,padding:"12px 14px",border:`1px solid ${active?color+"88":C.border}`,boxShadow:active?`0 0 18px ${color}30`:"none",display:"flex",flexDirection:"column",gap:8,transition:"all .3s"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:9,letterSpacing:1,color,fontFamily:MONO}}>{label}</span>
        <div style={{width:10,height:10,borderRadius:"50%",background:active?color:"#1a2a3a",border:`1px solid ${active?color:C.border}`,boxShadow:active?`0 0 8px ${color}`:"none",transition:"all .3s"}} />
      </div>
      <div style={{fontSize:9,color:C.muted,fontFamily:MONO}}>{sub}</div>
      <div style={{fontSize:18,fontFamily:HEAD,fontWeight:700,color:active?color:C.muted,transition:"color .3s"}}>{active?"ON":"OFF"}</div>
    </div>
  );
}

function CtrlRow({label,value,onDec,onInc,accent}) {
  const btn = {width:26,height:26,borderRadius:6,cursor:"pointer",fontSize:16,fontFamily:MONO,display:"flex",alignItems:"center",justifyContent:"center",border:`1px solid ${accent}44`,background:accent+"15",color:accent,transition:".15s"};
  return (
    <div style={{display:"flex",flexDirection:"column",gap:6}}>
      <span style={{fontSize:9,color:C.muted,letterSpacing:1,fontFamily:MONO}}>{label}</span>
      <div style={{display:"flex",alignItems:"center",gap:5}}>
        <button onClick={e=>{e.stopPropagation();onDec();}} style={btn}>−</button>
        <span style={{minWidth:42,textAlign:"center",fontFamily:MONO,fontSize:13,color:C.text}}>{value}</span>
        <button onClick={e=>{e.stopPropagation();onInc();}} style={btn}>+</button>
      </div>
    </div>
  );
}

function SectionCard({sec,state,focused,onFocus,onToggle,onAdj,sparkRef}) {
  const s = state[sec];
  const accent = sec==="ferm" ? C.ferm : C.keezer;
  const icon   = sec==="ferm" ? "🧫" : "🍺";
  const name   = sec==="ferm" ? "Fermentacija" : "Keezer";
  const diff   = rnd(s.temp-s.sp,2);
  const isAlarm = Math.abs(diff)>s.alarm && s.enabled;
  const diffColor = isAlarm?C.danger:Math.abs(diff)>s.hyst?C.warn:C.ok;
  return (
    <div onClick={e=>!focused&&onFocus(e)} style={{background:C.panel,border:`1px solid ${s.enabled?accent+"55":C.border}`,borderRadius:16,padding:"20px 22px",display:"flex",flexDirection:"column",gap:14,position:"relative",overflow:"hidden",boxShadow:s.enabled?`0 0 30px ${accent}08`:"none",cursor:focused?"default":"pointer",transition:"border-color .4s,box-shadow .4s,transform .2s",gridColumn:focused?"1 / -1":undefined}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:s.enabled?`linear-gradient(90deg,transparent,${accent},transparent)`:"transparent",borderRadius:"16px 16px 0 0",transition:"all .4s"}} />
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontFamily:HEAD,fontSize:14,fontWeight:600,letterSpacing:3,textTransform:"uppercase",color:accent}}>{name}</span>
        <button onClick={e=>{e.stopPropagation();onToggle();}} style={{padding:"4px 14px",borderRadius:20,cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1,transition:".2s",border:`1px solid ${s.enabled?accent:C.border}`,background:s.enabled?accent+"15":"transparent",color:s.enabled?accent:C.muted}}>
          {s.enabled?"AKTIVAN":"ISKLJUČEN"}
        </button>
      </div>
      <div style={{display:"flex",alignItems:"baseline",gap:14}}>
        <div style={{fontFamily:HEAD,fontSize:focused?80:60,fontWeight:700,lineHeight:1,letterSpacing:-3,color:s.enabled?accent:C.muted,transition:"all .3s"}}>{s.temp.toFixed(1)}°</div>
        <div>
          <div style={{fontSize:11,color:C.muted,fontFamily:MONO}}>SP <span style={{color:C.text}}>{s.sp.toFixed(1)}°C</span></div>
          <div style={{fontSize:12,color:diffColor,fontFamily:MONO,marginTop:2}}>{diff>=0?"+":""}{diff}°</div>
        </div>
      </div>
      <div style={{width:"100%",height:focused?64:52,position:"relative"}}>
        <canvas ref={sparkRef} style={{position:"absolute",inset:0,width:"100%",height:"100%"}} width={400} height={focused?64:52} />
      </div>
      <div style={{fontSize:28,textAlign:"center",opacity:s.enabled?.85:.25,lineHeight:1}}>{icon}</div>
      <div style={{display:"flex",gap:16,padding:"10px 14px",background:"#060b11",borderRadius:10,border:`1px solid ${C.border}`,alignItems:"center"}}>
        <span style={{fontSize:10,color:C.muted,letterSpacing:1,fontFamily:MONO}}>RELEJ</span>
        {sec==="ferm"&&<><div style={{display:"flex",alignItems:"center",gap:6}}><RelayDot on={s.heat&&s.enabled} color={C.heat}/><span style={{fontSize:9,color:C.muted,letterSpacing:1,fontFamily:MONO}}>GRIJANJE</span></div><div style={{display:"flex",alignItems:"center",gap:6}}><RelayDot on={s.cool&&s.enabled} color={C.cool}/><span style={{fontSize:9,color:C.muted,letterSpacing:1,fontFamily:MONO}}>HLAĐENJE</span></div></>}
        {sec==="keezer"&&<><div style={{display:"flex",alignItems:"center",gap:6}}><RelayDot on={s.relay&&s.enabled} color={C.keezer}/><span style={{fontSize:9,color:C.muted,letterSpacing:1,fontFamily:MONO}}>HLAĐENJE</span></div></>}
        {isAlarm&&<div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}><div style={{width:8,height:8,borderRadius:"50%",background:C.danger,boxShadow:`0 0 8px ${C.danger}`,animation:"pulse 1s infinite"}}/><span style={{fontSize:10,color:C.danger,fontFamily:MONO}}>ALARM</span></div>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
        <CtrlRow label="SETPOINT (°C)"  value={s.sp.toFixed(1)}    accent={accent} onDec={()=>onAdj("sp",-0.5)}    onInc={()=>onAdj("sp",0.5)} />
        <CtrlRow label="HISTEREZA (°C)" value={s.hyst.toFixed(1)}  accent={accent} onDec={()=>onAdj("hyst",-0.1)}  onInc={()=>onAdj("hyst",0.1)} />
        <CtrlRow label="ALARM Δ (°C)"   value={s.alarm.toFixed(1)} accent={accent} onDec={()=>onAdj("alarm",-0.5)} onInc={()=>onAdj("alarm",0.5)} />
      </div>
    </div>
  );
}

function RelayLog({log,onClear}) {
  const ref=useRef();
  useEffect(()=>{if(ref.current)ref.current.scrollTop=ref.current.scrollHeight;},[log]);
  return (
    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 20px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <span style={{fontSize:10,color:C.muted,letterSpacing:2,fontFamily:MONO}}>ON/OFF LOG RELEJA ({log.length} zapisa)</span>
        <button onClick={onClear} style={{padding:"4px 14px",borderRadius:20,border:`1px solid ${C.border}`,background:"transparent",color:C.muted,cursor:"pointer",fontFamily:MONO,fontSize:10}}>Obriši log</button>
      </div>
      <div ref={ref} style={{height:180,overflowY:"auto",background:"#060a0f",border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 12px",fontSize:10,lineHeight:1.8,fontFamily:MONO}}>
        {log.length===0?<div style={{color:C.muted}}>— nema log zapisa —</div>
          :log.map((e,i)=><div key={i}><span style={{color:C.muted}}>[{fmtTime(e.ts)}]</span> <span style={{color:e.color}}>{e.msg}</span></div>)}
      </div>
    </div>
  );
}

// ── Analytics Tab Component ───────────────────────────────────────
function AnalyticsTab({cycles, period, setPeriod}) {
  const now = Date.now();
  const periodMs = {dan:86400000, tjedan:604800000, mjesec:2592000000};
  const filtered = cycles.filter(c=>c.onTs >= now - periodMs[period]);

  const total   = filtered.length;
  const avgDur  = total ? Math.round(filtered.reduce((a,b)=>a+b.sec,0)/total) : 0;
  const maxDur  = total ? Math.max(...filtered.map(c=>c.sec)) : 1;
  const totalOn = filtered.reduce((a,b)=>a+b.sec,0);
  const elapsed = filtered.length>1 ? Math.round((filtered[filtered.length-1].offTs-filtered[0].onTs)/1000) : 0;
  const duty    = elapsed>0 ? Math.round((totalOn/elapsed)*100) : 0;

  const DAYS = ["Pon","Uto","Sri","Čet","Pet","Sub","Ned"];
  let buckets=[], bucketLabels=[];
  if (period==="dan") {
    buckets=Array(24).fill(0);
    bucketLabels=Array.from({length:24},(_,h)=>h%6===0?`${h}h`:"");
    filtered.forEach(c=>{buckets[new Date(c.onTs).getHours()]++;});
  } else if (period==="tjedan") {
    buckets=Array(7).fill(0);
    bucketLabels=DAYS;
    filtered.forEach(c=>{buckets[(new Date(c.onTs).getDay()+6)%7]++;});
  } else {
    buckets=Array(5).fill(0);
    bucketLabels=["Tj.1","Tj.2","Tj.3","Tj.4","Tj.5"];
    filtered.forEach(c=>{const w=Math.min(4,Math.floor((new Date(c.onTs).getDate()-1)/7));buckets[w]++;});
  }
  const maxBucket=Math.max(1,...buckets);

  let dutyBuckets=buckets.map(()=>0);
  if (period==="dan") {
    filtered.forEach(c=>{dutyBuckets[new Date(c.onTs).getHours()]+=c.sec;});
    dutyBuckets=dutyBuckets.map(s=>Math.round(s/36));
  } else if (period==="tjedan") {
    filtered.forEach(c=>{dutyBuckets[(new Date(c.onTs).getDay()+6)%7]+=c.sec;});
    dutyBuckets=dutyBuckets.map(s=>Math.round(s/864));
  } else {
    filtered.forEach(c=>{const w=Math.min(4,Math.floor((new Date(c.onTs).getDate()-1)/7));dutyBuckets[w]+=c.sec;});
    dutyBuckets=dutyBuckets.map(s=>Math.round(s/6048));
  }
  const maxDuty=Math.max(1,...dutyBuckets);
  const periodLabel={dan:"danas",tjedan:"ovaj tjedan",mjesec:"ovaj mjesec"};

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16,animation:"fadeIn .3s ease"}}>

      {/* Period filter */}
      <div style={{display:"flex",gap:6,background:C.panel,borderRadius:12,padding:"6px",border:`1px solid ${C.border}`,alignSelf:"flex-start"}}>
        {["dan","tjedan","mjesec"].map(p=>(
          <button key={p} onClick={()=>setPeriod(p)} style={{padding:"6px 18px",borderRadius:8,border:"none",cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1,transition:".2s",background:period===p?C.keezer+"22":"transparent",color:period===p?C.keezer:C.muted,borderBottom:period===p?`2px solid ${C.keezer}`:"2px solid transparent"}}>
            {p.toUpperCase()}
          </button>
        ))}
      </div>

      {/* KPI */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
        {[["Ciklusa",total||"—",C.keezer],["Prosj. trajanje",avgDur?`${avgDur}s`:"—",C.cool],["Najduži",total?`${maxDur}s`:"—",C.ferm],["Duty cycle",duty?`${duty}%`:"—",C.warn]].map(([label,val,color])=>(
          <div key={label} style={{background:C.panel,border:`1px solid ${color}33`,borderRadius:12,padding:"14px 16px",textAlign:"center"}}>
            <div style={{fontSize:9,color:C.muted,letterSpacing:1,fontFamily:MONO,marginBottom:6}}>{label.toUpperCase()}</div>
            <div style={{fontSize:26,fontFamily:HEAD,fontWeight:700,color}}>{val}</div>
            <div style={{fontSize:9,color:C.muted,fontFamily:MONO,marginTop:4}}>{periodLabel[period]}</div>
          </div>
        ))}
      </div>

      {/* Broj uključivanja */}
      <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 20px"}}>
        <div style={{fontSize:10,color:C.muted,letterSpacing:2,marginBottom:14,fontFamily:MONO}}>
          BROJ UKLJUČIVANJA — {period==="dan"?"PO SATU":period==="tjedan"?"PO DANU":"PO TJEDNU"}
        </div>
        {filtered.length===0
          ?<div style={{color:C.muted,fontFamily:MONO,fontSize:11,padding:"20px 0"}}>Nema podataka za odabrani period</div>
          :<div style={{display:"flex",alignItems:"flex-end",gap:4,height:100}}>
            {buckets.map((count,i)=>(
              <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,height:"100%",justifyContent:"flex-end"}}>
                {count>0&&<span style={{fontSize:9,color:C.keezer,fontFamily:MONO}}>{count}</span>}
                <div style={{width:"100%",borderRadius:"3px 3px 0 0",background:count>0?C.keezer+"99":C.border,height:`${Math.max(count>0?8:2,(count/maxBucket)*88)}%`,transition:"height .3s"}}/>
                <span style={{fontSize:9,color:C.muted,fontFamily:MONO,whiteSpace:"nowrap"}}>{bucketLabels[i]}</span>
              </div>
            ))}
          </div>
        }
      </div>

      {/* Duty cycle */}
      <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 20px"}}>
        <div style={{fontSize:10,color:C.muted,letterSpacing:2,marginBottom:14,fontFamily:MONO}}>
          DUTY CYCLE % — {period==="dan"?"PO SATU":period==="tjedan"?"PO DANU":"PO TJEDNU"}
        </div>
        {filtered.length===0
          ?<div style={{color:C.muted,fontFamily:MONO,fontSize:11,padding:"20px 0"}}>Nema podataka</div>
          :<div style={{display:"flex",alignItems:"flex-end",gap:4,height:100}}>
            {dutyBuckets.map((pct,i)=>(
              <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,height:"100%",justifyContent:"flex-end"}}>
                {pct>0&&<span style={{fontSize:9,color:C.warn,fontFamily:MONO}}>{pct}%</span>}
                <div style={{width:"100%",borderRadius:"3px 3px 0 0",background:pct>0?C.warn+"88":C.border,height:`${Math.max(pct>0?8:2,(pct/maxDuty)*88)}%`,transition:"height .3s"}}/>
                <span style={{fontSize:9,color:C.muted,fontFamily:MONO,whiteSpace:"nowrap"}}>{bucketLabels[i]}</span>
              </div>
            ))}
          </div>
        }
      </div>

      {/* Tablica */}
      <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 20px"}}>
        <div style={{fontSize:10,color:C.muted,letterSpacing:2,marginBottom:12,fontFamily:MONO}}>ZADNJIH 10 CIKLUSA — {periodLabel[period].toUpperCase()}</div>
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <div style={{display:"grid",gridTemplateColumns:"36px 1fr 1fr 1fr",gap:8,padding:"0 8px 8px",borderBottom:`1px solid ${C.border}`}}>
            {["#","Uključen","Isključen","Trajanje"].map(h=><span key={h} style={{fontSize:9,color:C.muted,fontFamily:MONO,letterSpacing:1}}>{h}</span>)}
          </div>
          {filtered.length===0
            ?<div style={{color:C.muted,fontFamily:MONO,fontSize:11,padding:"8px 0"}}>Nema podataka</div>
            :filtered.slice(-10).reverse().map((c,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"36px 1fr 1fr 1fr",gap:8,padding:"5px 8px",background:i===0?C.keezer+"11":"transparent",borderRadius:6}}>
                <span style={{fontSize:10,color:C.muted,fontFamily:MONO}}>{filtered.length-i}</span>
                <span style={{fontSize:10,color:C.text,fontFamily:MONO}}>{fmtTime(c.onTs)}</span>
                <span style={{fontSize:10,color:C.text,fontFamily:MONO}}>{fmtTime(c.offTs)}</span>
                <span style={{fontSize:10,color:C.keezer,fontFamily:MONO,fontWeight:700}}>
                  {c.sec>=60?`${Math.floor(c.sec/60)}m ${c.sec%60}s`:`${c.sec}s`}
                </span>
              </div>
            ))
          }
        </div>
      </div>

    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────
export default function FermentationController() {
  const initFerm   = {enabled:true,temp:18.0,sp:18.0,hyst:0.5,alarm:2.0,relay:false,history:[]};
  const initKeezer = {enabled:true,temp:5.0, sp:5.0, hyst:0.3,alarm:2.0,relay:false,history:[]};

  const [ferm,   setFerm]   = useState(initFerm);
  const [keezer, setKeezer] = useState(initKeezer);
  const [log,    setLog]    = useState([]);
  const [cycles, setCycles] = useState([]);
  const [analyticsPeriod, setAnalyticsPeriod] = useState("dan");
  const [tab,    setTab]    = useState("dashboard");
  const [focus,  setFocus]  = useState(null);

  // ── Fermentacija mod: "heat" | "cool" ──────────────────────────
  const [fermMode,       setFermMode]       = useState("heat"); // default grijanje
  const [confirmModal,   setConfirmModal]   = useState(false);  // potvrda prebacivanja
  const fermModeRef = useRef("heat");
  const RISE_RATE_LIMIT  = 0.5;  // °C/min — soft alarm
  const HARD_ALARM_DELTA = 5.0;  // °C iznad SP — hard alarm + safe mode
  const [keezerSafeMode,  setKeezerSafeMode]  = useState(false);
  const [keezerRiseAlarm, setKeezerRiseAlarm] = useState(false);
  const [keezerRiseRate,  setKeezerRiseRate]  = useState(0);
  const keezerSafeModeRef  = useRef(false);
  const keezerRiseAlarmRef = useRef(false);

  // ── Fermentacija zaštita (opcijska) ─────────────────────────────
  const [fermProtection,  setFermProtection]  = useState(false); // isključena po defaultu
  const [fermSafeMode,    setFermSafeMode]    = useState(false);
  const [fermRiseAlarm,   setFermRiseAlarm]   = useState(false);
  const [fermRiseRate,    setFermRiseRate]     = useState(0);
  const fermSafeModeRef  = useRef(false);
  const fermRiseAlarmRef = useRef(false);
  const fermProtectionRef = useRef(false);
  useEffect(()=>{fermProtectionRef.current=fermProtection;},[fermProtection]);

  // ── 1. Compressor delay zaštita ────────────────────────────────
  const COMPRESSOR_DELAY_MS = 3 * 60 * 1000; // 3 minute
  const [compDelay,    setCompDelay]    = useState(false); // je li u delay fazi
  const [compDelayLeft,setCompDelayLeft]= useState(0);     // sekundi do unlock
  const compOffTs   = useRef(null);  // kad se kompresor zadnji put isključio
  const compDelayRef= useRef(false);

  // ── 2. Fermentacijski profil ─────────────────────────────────────
  // Koraci: [ {dan, sp}, ... ] — automatski mijenja SP po danima
  const defaultProfile = [
    {day:1,  sp:18.0, label:"Početak"},
    {day:4,  sp:20.0, label:"Diacetyl rest"},
    {day:8,  sp:4.0,  label:"Crash cooling"},
  ];
  const [profileEnabled, setProfileEnabled] = useState(false);
  const [profileSteps,   setProfileSteps]   = useState(defaultProfile);
  const [profileStartTs, setProfileStartTs] = useState(null); // kad je fermentacija startala
  const [profileDay,     setProfileDay]     = useState(1);
  const [profileStep,    setProfileStep]    = useState(0);    // aktivni korak
  const profileEnabledRef = useRef(false);
  const profileStartRef   = useRef(null);
  const profileStepsRef   = useRef(defaultProfile);
  useEffect(()=>{profileEnabledRef.current=profileEnabled;},[profileEnabled]);
  useEffect(()=>{profileStartRef.current=profileStartTs;},[profileStartTs]);
  useEffect(()=>{profileStepsRef.current=profileSteps;},[profileSteps]);

  // ── 3. Serija log ─────────────────────────────────────────────────
  const [batch, setBatch] = useState({
    name:"",       // npr. "IPA #5"
    style:"",      // npr. "India Pale Ale"
    startTs:null,  // timestamp početka
    active:false,
  });
  const [batchModal, setBatchModal] = useState(false);
  const [batchDraft, setBatchDraft] = useState({name:"",style:""});
  const fermRef     = useRef(ferm);
  const keezerRef   = useRef(keezer);
  const logRef     = useRef(log);
  const cyclesRef  = useRef([]);
  const keezerOnTs = useRef(null);
  const sparkFermRef    = useRef();
  const sparkKeezerRef  = useRef();
  const chartMainRef    = useRef();
  const chartFocusedRef = useRef();

  useEffect(()=>{fermRef.current=ferm;},[ferm]);
  useEffect(()=>{keezerRef.current=keezer;},[keezer]);
  useEffect(()=>{logRef.current=log;},[log]);
  useEffect(()=>{keezerSafeModeRef.current=keezerSafeMode;},[keezerSafeMode]);
  useEffect(()=>{fermSafeModeRef.current=fermSafeMode;},[fermSafeMode]);
  useEffect(()=>{fermModeRef.current=fermMode;},[fermMode]);

  const confirmModeSwitch = () => {
    const newMode = fermMode==="heat" ? "cool" : "heat";
    setFermMode(newMode);
    fermModeRef.current = newMode;
    setFerm(f=>({...f,relay:false}));
    setConfirmModal(false);
    pushFirebase({cmd:"heatMode",sec:"ferm",val:newMode==="heat"});
    addLog(`Mod → ${newMode==="heat"?"GRIJANJE":"HLADENJE"}`,newMode==="heat"?C.heat:C.cool,"Fermentacija","MOD");
  };

  const addLog = useCallback((msg,color,section,relay)=>{
    const entry={ts:Date.now(),msg,color,section,relay};
    const next=[...logRef.current.slice(-199),entry];
    logRef.current=next; setLog(next);
  },[]);

  // ── Firebase polling ─────────────────────────────────────────────
  const [connected, setConnected] = useState(false);

  useEffect(()=>{
    const poll = async () => {
      const ts = Date.now();
      const data = await fetchFirebase();
      if (!data) { setConnected(false); return; }
      setConnected(true);
      const fs = fermRef.current, ks = keezerRef.current;

      if (data.ferm) {
        const fnext = data.ferm.temp ?? fs.temp;
        const newRelay = data.ferm.relay ?? false;
        if (fermProtectionRef.current && data.ferm.enabled) {
          let fermRate = 0;
          if (fs.history.length >= 20) {
            const old = fs.history[fs.history.length-20];
            const elMin = (ts-old.ts)/60000;
            fermRate = elMin>0 ? rnd((fnext-old.temp)/elMin,2) : 0;
          }
          setFermRiseRate(fermRate);
          if (fnext > fs.sp + HARD_ALARM_DELTA && !fermSafeModeRef.current) {
            setFermSafeMode(true); fermSafeModeRef.current=true;
            addLog(`FERM SAFE MODE! ${fnext.toFixed(1)}C`,C.danger,"Fermentacija","SAFE MODE");
          }
          if (fermRate > RISE_RATE_LIMIT && !fermRiseAlarmRef.current) {
            fermRiseAlarmRef.current=true; setFermRiseAlarm(true);
            addLog(`Nagli rast +${fermRate}C/min`,C.warn,"Fermentacija","RAST");
          }
          if (fermRate <= RISE_RATE_LIMIT && fermRiseAlarmRef.current) {
            fermRiseAlarmRef.current=false; setFermRiseAlarm(false);
          }
        }
        if (newRelay !== fs.relay) {
          addLog(`Ferm relay ${newRelay?"ON":"OFF"}`,newRelay?C.heat:C.muted,"Fermentacija","R1");
        }
        const fhist=[...fs.history.slice(-(MAX_HIST-1)),{ts,temp:fnext,sp:data.ferm.sp??fs.sp}];
        setFerm(f=>({...f,temp:fnext,relay:newRelay,sp:data.ferm.sp??f.sp,hyst:data.ferm.hyst??f.hyst,alarm:data.ferm.alarm??f.alarm,enabled:data.ferm.enabled??f.enabled,history:fhist}));
      }

      if (data.keezer) {
        const knext = data.keezer.temp ?? ks.temp;
        const kcool = data.keezer.relay ?? false;
        const safeMode = data.keezer.safeMode ?? false;
        const compDelayActive = data.keezer.compDelay ?? false;
        let riseRate = 0;
        if (ks.history.length >= 20) {
          const old = ks.history[ks.history.length-20];
          const elMin = (ts-old.ts)/60000;
          riseRate = elMin>0 ? rnd((knext-old.temp)/elMin,2) : 0;
        }
        setKeezerRiseRate(riseRate);
        if (safeMode !== keezerSafeModeRef.current) {
          keezerSafeModeRef.current=safeMode; setKeezerSafeMode(safeMode);
          if (safeMode) addLog(`KEEZER SAFE MODE`,C.danger,"Keezer","SAFE MODE");
        }
        if (riseRate > RISE_RATE_LIMIT && !keezerRiseAlarmRef.current) {
          keezerRiseAlarmRef.current=true; setKeezerRiseAlarm(true);
          addLog(`Keezer nagli rast +${riseRate}C/min`,C.warn,"Keezer","RAST");
        }
        if (riseRate <= RISE_RATE_LIMIT && keezerRiseAlarmRef.current) {
          keezerRiseAlarmRef.current=false; setKeezerRiseAlarm(false);
        }
        if (compDelayActive !== compDelayRef.current) {
          compDelayRef.current=compDelayActive; setCompDelay(compDelayActive);
          if (compDelayActive) addLog(`Compressor delay`,C.warn,"Keezer","DELAY");
        }
        if (kcool !== ks.relay) {
          addLog(`Keezer ${kcool?"ON":"OFF"}`,kcool?C.keezer:C.muted,"Keezer","R2");
          if (kcool) keezerOnTs.current=ts;
          else if (keezerOnTs.current) {
            const dur=Math.round((ts-keezerOnTs.current)/1000);
            const nc=[...cyclesRef.current.slice(-199),{onTs:keezerOnTs.current,offTs:ts,sec:dur}];
            cyclesRef.current=nc; setCycles(nc); keezerOnTs.current=null;
          }
        }
        if (profileEnabledRef.current && profileStartRef.current) {
          const dayNum=Math.floor((ts-profileStartRef.current)/86400000)+1;
          setProfileDay(dayNum);
          const steps=profileStepsRef.current;
          let activeStep=0;
          for (let i=0;i<steps.length;i++){if(dayNum>=steps[i].day)activeStep=i;}
          setProfileStep(activeStep);
          const targetSP=steps[activeStep].sp;
          if (Math.abs(targetSP-fermRef.current.sp)>0.05) {
            addLog(`Profil dan ${dayNum}: SP ${targetSP}C`,C.ferm,"Fermentacija","PROFIL");
            pushFirebase({cmd:"setpoint",sec:"ferm",val:targetSP});
          }
        }
        const khist=[...ks.history.slice(-(MAX_HIST-1)),{ts,temp:knext,sp:data.keezer.sp??ks.sp}];
        setKeezer(k=>({...k,temp:knext,relay:kcool,sp:data.keezer.sp??k.sp,hyst:data.keezer.hyst??k.hyst,alarm:data.keezer.alarm??k.alarm,enabled:data.keezer.enabled??k.enabled,history:khist}));
      }
    };
    const id=setInterval(poll,3000);
    poll();
    return ()=>clearInterval(id);
  },[addLog]);

  useEffect(()=>{
    drawSparkline(sparkFermRef.current,  ferm.history,   C.ferm);
    drawSparkline(sparkKeezerRef.current,keezer.history, C.keezer);
  });

  useEffect(()=>{
    if (tab==="chart"&&!focus) {
      drawChart(chartMainRef.current,[
        {data:ferm.history,  color:C.ferm,  sp:ferm.sp,  label:"Fermentacija"},
        {data:keezer.history,color:C.keezer,sp:keezer.sp,label:"Keezer"},
      ],200);
    }
    if (focus) {
      const s=focus==="ferm"?ferm:keezer;
      const color=focus==="ferm"?C.ferm:C.keezer;
      drawChart(chartFocusedRef.current,[{data:s.history,color,sp:s.sp}],180);
    }
  });

  const adj=(sec,param,delta)=>{
    const limits={sp:[-5,40],hyst:[0.1,3],alarm:[0.5,10]};
    const [mn,mx]=limits[param];
    const s = sec==="ferm" ? fermRef.current : keezerRef.current;
    const cur = param==="sp" ? s.sp : param==="hyst" ? s.hyst : s.alarm;
    const val = rnd(clamp(cur+delta,mn,mx),1);
    pushFirebase({cmd:param,sec,val});
    if (sec==="ferm")   setFerm(f=>({...f,[param]:val}));
    if (sec==="keezer") setKeezer(k=>({...k,[param]:val}));
  };
  const toggle=sec=>{
    pushFirebase({cmd:"toggle",sec});
    if (sec==="ferm")   setFerm(f=>({...f,enabled:!f.enabled,relay:false}));
    if (sec==="keezer") setKeezer(k=>({...k,enabled:!k.enabled,relay:false}));
  };
  const startBatch = () => {
    const ts = Date.now();
    setBatch({...batchDraft, startTs:ts, active:true});
    if (profileEnabled) {
      setProfileStartTs(ts); profileStartRef.current=ts;
      setProfileDay(1); setProfileStep(0);
      const sp = profileSteps[0].sp;
      setFerm(f=>({...f,sp}));
      addLog(`🍺 Serija "${batchDraft.name}" startala — Profil SP: ${sp}°C`,C.ferm,"Fermentacija","SERIJA");
    } else {
      addLog(`🍺 Serija "${batchDraft.name}" startala`,C.ferm,"Fermentacija","SERIJA");
    }
    setBatchModal(false);
  };

  const stopBatch = () => {
    addLog(`🏁 Serija "${batch.name}" završena`,C.muted,"Fermentacija","SERIJA");
    setBatch({name:"",style:"",startTs:null,active:false});
    setProfileEnabled(false); setProfileStartTs(null);
    profileEnabledRef.current=false; profileStartRef.current=null;
  };

  const batchDayNum = batch.startTs ? Math.floor((Date.now()-batch.startTs)/86400000)+1 : 0;

  const exportCSV=()=>{
    const rows=["Timestamp,Sekcija,Temperatura (°C),Setpoint (°C)"];
    ferm.history.forEach(d=>rows.push(`${fmtDT(d.ts)},Fermentacija,${d.temp},${d.sp}`));
    keezer.history.forEach(d=>rows.push(`${fmtDT(d.ts)},Keezer,${d.temp},${d.sp}`));
    rows.push("","Timestamp,Sekcija,Relej,Poruka");
    log.forEach(e=>rows.push(`${fmtDT(e.ts)},${e.section||""},${e.relay||""},${e.msg}`));
    const blob=new Blob([rows.join("\n")],{type:"text/csv"});
    const url=URL.createObjectURL(blob);
    Object.assign(document.createElement("a"),{href:url,download:`fermentation_${new Date().toISOString().slice(0,10)}.csv`}).click();
    URL.revokeObjectURL(url);
  };

  const fermAlarm   = Math.abs(rnd(ferm.temp-ferm.sp,2))>ferm.alarm     && ferm.enabled;
  const keezerAlarm = Math.abs(rnd(keezer.temp-keezer.sp,2))>keezer.alarm && keezer.enabled;

  const resetSafeMode = (sec) => {
    pushFirebase({cmd:"resetSafe",sec});
    if (sec==="keezer") {
      setKeezerSafeMode(false); keezerSafeModeRef.current=false;
      setKeezerRiseAlarm(false); keezerRiseAlarmRef.current=false;
      addLog("Keezer safe mode resetiran",C.ok,"Keezer","SAFE MODE");
    } else {
      setFermSafeMode(false); fermSafeModeRef.current=false;
      setFermRiseAlarm(false); fermRiseAlarmRef.current=false;
      addLog("Ferm safe mode resetiran",C.ok,"Fermentacija","SAFE MODE");
    }
  };

  const FocusedDetail=({sec})=>{
    const s=sec==="ferm"?ferm:keezer;
    const name=sec==="ferm"?"Fermentacija":"Keezer";
    const color=sec==="ferm"?C.ferm:C.keezer;
    const diff=rnd(s.temp-s.sp,2);
    const alarmActive=Math.abs(diff)>s.alarm&&s.enabled;
    return (
      <div style={{gridColumn:"1 / -1",display:"flex",flexDirection:"column",gap:16,animation:"fadeIn .3s ease"}}>
        <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:14,padding:"16px 20px"}}>
          <div style={{fontSize:10,color:C.muted,letterSpacing:2,marginBottom:14,fontFamily:MONO}}>RELEJ STATUS — {name.toUpperCase()}</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,maxWidth:400}}>
            {sec==="ferm"?<><RelayCard label="R1 — GRIJANJE" sub="Fermentacija" active={s.heat&&s.enabled} color={C.heat}/><RelayCard label="R2 — HLAĐENJE" sub="Fermentacija" active={s.cool&&s.enabled} color={C.cool}/></>
              :<><RelayCard label="R3 — KEEZER" sub="Hlađenje" active={s.cool&&s.enabled} color={C.keezer}/><RelayCard label="R4 — REZERVA" sub="Slobodan izlaz" active={s.extra&&s.enabled} color={C.warn}/></>}
          </div>
        </div>
        <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:14,padding:"20px 20px 14px"}}>
          <div style={{fontSize:10,color:C.muted,letterSpacing:2,marginBottom:14,fontFamily:MONO}}>TEMPERATURA — {name.toUpperCase()} ({s.history.length} mjerenja)</div>
          <canvas ref={chartFocusedRef} style={{display:"block",width:"100%"}} />
          <div style={{fontSize:9,color:C.muted,marginTop:10,fontFamily:MONO}}>Isprekidana linija = setpoint · Osvježava svake 3s</div>
        </div>
        <div style={{background:C.panel,border:`1px solid ${alarmActive?C.danger+"55":C.border}`,borderRadius:14,padding:"16px 20px"}}>
          <div style={{fontSize:10,color:C.muted,letterSpacing:2,marginBottom:12,fontFamily:MONO}}>ALARM STATUS</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:11,color:C.muted,fontFamily:MONO,lineHeight:2}}>
              Trenutna: <span style={{color:C.text}}>{s.temp.toFixed(2)}°C</span><br/>
              Setpoint: <span style={{color:C.text}}>{s.sp.toFixed(1)}°C</span><br/>
              Razlika: <span style={{color:alarmActive?C.danger:C.ok}}>{diff>=0?"+":""}{diff}°C</span>
            </div>
            <div style={{padding:"8px 18px",borderRadius:20,border:`1px solid ${alarmActive?C.danger:C.ok}`,background:alarmActive?C.danger+"22":C.ok+"22",color:alarmActive?C.danger:C.ok,fontFamily:MONO,fontSize:12,animation:alarmActive?"pulse 1s infinite":"none"}}>
              {alarmActive?"⚠ ALARM":"✓ OK"}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text,fontFamily:MONO}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#060a0f}
        ::-webkit-scrollbar-thumb{background:#172130;border-radius:4px}
        button:hover{filter:brightness(1.2)}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      `}</style>

      {/* HEADER */}
      <div style={{background:"linear-gradient(180deg,#0d1a26 0%,#080d12 100%)",borderBottom:`1px solid ${C.border}`,padding:"16px 28px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:10,color:C.muted,letterSpacing:3,marginBottom:4,fontFamily:MONO}}>ESP32 · DS18B20 · 2-RELAY · R1 FERM · R2 KEEZER</div>
          <div style={{fontFamily:HEAD,fontSize:22,fontWeight:700,letterSpacing:1}}>
            <span style={{color:C.ferm}}>Fermentacija</span>
            <span style={{color:C.muted,margin:"0 10px"}}>+</span>
            <span style={{color:C.keezer}}>Keezer</span>
            <span style={{color:C.muted,fontSize:14,marginLeft:10}}>Controller</span>
          </div>
        </div>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          {fermAlarm&&<div style={{padding:"5px 14px",borderRadius:20,background:"rgba(239,68,68,.15)",border:`1px solid ${C.danger}`,color:C.danger,fontSize:10,letterSpacing:1,animation:"pulse 1s infinite"}}>⚠ FERMENTACIJA ALARM</div>}
          {keezerAlarm&&<div style={{padding:"5px 14px",borderRadius:20,background:"rgba(239,68,68,.15)",border:`1px solid ${C.danger}`,color:C.danger,fontSize:10,letterSpacing:1,animation:"pulse 1s infinite"}}>⚠ KEEZER ALARM</div>}
          {fermProtection&&fermRiseAlarm&&!fermSafeMode&&<div style={{padding:"5px 14px",borderRadius:20,background:"rgba(245,158,11,.15)",border:`1px solid ${C.warn}`,color:C.warn,fontSize:10,letterSpacing:1,animation:"pulse 1s infinite"}}>⚡ FERM RAST +{fermRiseRate}°/min</div>}
          {fermProtection&&fermSafeMode&&<button onClick={()=>resetSafeMode("ferm")} style={{padding:"5px 14px",borderRadius:20,background:"rgba(239,68,68,.2)",border:`1px solid ${C.danger}`,color:C.danger,fontSize:10,letterSpacing:1,cursor:"pointer",animation:"pulse 1s infinite",fontFamily:MONO}}>⛔ FERM SAFE MODE — reset</button>}
          {keezerRiseAlarm&&!keezerSafeMode&&<div style={{padding:"5px 14px",borderRadius:20,background:"rgba(245,158,11,.15)",border:`1px solid ${C.warn}`,color:C.warn,fontSize:10,letterSpacing:1,animation:"pulse 1s infinite"}}>⚡ NAGLI RAST +{keezerRiseRate}°/min</div>}
          {keezerSafeMode&&<button onClick={()=>resetSafeMode("keezer")} style={{padding:"5px 14px",borderRadius:20,background:"rgba(239,68,68,.2)",border:`1px solid ${C.danger}`,color:C.danger,fontSize:10,letterSpacing:1,cursor:"pointer",animation:"pulse 1s infinite",fontFamily:MONO}}>⛔ KEEZER SAFE MODE — reset</button>}
          {focus&&<button onClick={()=>setFocus(null)} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 18px",borderRadius:20,border:`1px solid ${C.border}`,background:"transparent",color:C.muted,cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1}}>← Natrag</button>}
          <button onClick={exportCSV} style={{padding:"7px 18px",borderRadius:20,border:`1px solid ${C.border}`,background:"transparent",color:C.muted,cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1}}>↓ CSV</button>
          <div title={connected?"Firebase OK":"Firebase veza prekinuta"} style={{width:8,height:8,borderRadius:"50%",background:connected?C.ok:C.danger,boxShadow:connected?`0 0 8px ${C.ok}`:`0 0 8px ${C.danger}`,transition:"all .5s"}}/>
        </div>
      </div>

      {/* TABS */}
      {!focus&&(
        <div style={{display:"flex",gap:2,padding:"12px 28px 0",borderBottom:`1px solid ${C.border}`}}>
          {[["dashboard","📊 Dashboard"],["chart","📈 Graf"],["log","📋 Log"],["analytics","🔄 Ciklusi"],["serija","🍺 Serija"]].map(([key,label])=>(
            <button key={key} onClick={()=>setTab(key)} style={{padding:"8px 22px",borderRadius:"10px 10px 0 0",border:`1px solid ${tab===key?C.border:"transparent"}`,borderBottom:tab===key?`1px solid ${C.bg}`:"transparent",background:tab===key?C.bg:"transparent",color:tab===key?C.text:C.muted,cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1}}>
              {label}
            </button>
          ))}
        </div>
      )}

      <div style={{padding:"24px 28px 40px"}}>

        {/* DASHBOARD */}
        {(tab==="dashboard"||focus)&&(
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,animation:"fadeIn .3s ease"}}>
            {focus!=="keezer"&&(
              <div onClick={e=>focus!=="ferm"&&!e.target.closest("button")&&setFocus("ferm")} style={{background:C.panel,border:`1px solid ${ferm.enabled?C.ferm+"55":C.border}`,borderRadius:16,padding:"20px 22px",display:"flex",flexDirection:"column",gap:14,position:"relative",overflow:"hidden",boxShadow:ferm.enabled?`0 0 30px ${C.ferm}08`:"none",cursor:focus==="ferm"?"default":"pointer",gridColumn:focus==="ferm"?"1 / -1":undefined}}>
                <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:ferm.enabled?`linear-gradient(90deg,transparent,${C.ferm},transparent)`:"transparent",borderRadius:"16px 16px 0 0"}}/>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontFamily:HEAD,fontSize:14,fontWeight:600,letterSpacing:3,textTransform:"uppercase",color:ferm.enabled?C.ferm:C.muted}}>
                      {ferm.enabled?"Fermentacija":"Ambient"}
                    </span>
                    {!ferm.enabled&&<span style={{fontSize:9,color:C.muted,fontFamily:MONO,letterSpacing:1,padding:"2px 8px",border:`1px solid ${C.border}`,borderRadius:10}}>SONDA AKTIVNA</span>}
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    {ferm.enabled&&(
                      <button onClick={e=>{e.stopPropagation();setConfirmModal(true);}} style={{padding:"4px 12px",borderRadius:20,cursor:"pointer",fontFamily:MONO,fontSize:10,letterSpacing:1,border:`1px solid ${fermMode==="heat"?C.heat:C.cool}`,background:fermMode==="heat"?C.heat+"22":C.cool+"22",color:fermMode==="heat"?C.heat:C.cool,transition:".2s"}}>
                        {fermMode==="heat"?"🔥 GRIJANJE":"❄ HLAĐENJE"}
                      </button>
                    )}
                    <button onClick={e=>{e.stopPropagation();toggle("ferm");}} style={{padding:"4px 12px",borderRadius:20,cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1,transition:".2s",border:`1px solid ${ferm.enabled?C.ferm:C.border}`,background:ferm.enabled?C.ferm+"15":"transparent",color:ferm.enabled?C.ferm:C.muted}}>
                      {ferm.enabled?"AKTIVAN":"AMBIENT"}
                    </button>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"baseline",gap:14}}>
                  <div style={{fontFamily:HEAD,fontSize:focus==="ferm"?80:60,fontWeight:700,lineHeight:1,letterSpacing:-3,color:ferm.enabled?C.ferm:C.warn,transition:"all .3s"}}>{ferm.temp.toFixed(1)}°</div>
                  <div>
                    {ferm.enabled
                      ? <>
                          <div style={{fontSize:11,color:C.muted,fontFamily:MONO}}>SP <span style={{color:C.text}}>{ferm.sp.toFixed(1)}°C</span></div>
                          <div style={{fontSize:12,fontFamily:MONO,marginTop:2,color:Math.abs(ferm.temp-ferm.sp)>ferm.alarm?C.danger:Math.abs(ferm.temp-ferm.sp)>ferm.hyst?C.warn:C.ok}}>{ferm.temp-ferm.sp>=0?"+":""}{rnd(ferm.temp-ferm.sp,2)}°</div>
                        </>
                      : <>
                          <div style={{fontSize:11,color:C.muted,fontFamily:MONO}}>Temperatura</div>
                          <div style={{fontSize:11,color:C.warn,fontFamily:MONO,marginTop:2}}>prostorije</div>
                        </>
                    }
                  </div>
                </div>
                <div style={{width:"100%",height:focus==="ferm"?64:52,position:"relative"}}>
                  <canvas ref={sparkFermRef} style={{position:"absolute",inset:0,width:"100%",height:"100%"}} width={400} height={focus==="ferm"?64:52}/>
                </div>
                <div style={{fontSize:28,textAlign:"center",opacity:ferm.enabled?.85:.6,lineHeight:1}}>{ferm.enabled?"🧫":"🌡️"}</div>
                <div style={{display:"flex",gap:16,padding:"10px 14px",background:"#060b11",borderRadius:10,border:`1px solid ${C.border}`,alignItems:"center"}}>
                  <span style={{fontSize:10,color:C.muted,letterSpacing:1,fontFamily:MONO}}>{ferm.enabled?"R1":"AMBIENT"}</span>
                  {ferm.enabled
                    ? <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <RelayDot on={ferm.relay&&ferm.enabled} color={fermMode==="heat"?C.heat:C.cool}/>
                        <span style={{fontSize:9,color:C.muted,letterSpacing:1,fontFamily:MONO}}>{fermMode==="heat"?"GRIJANJE":"HLAĐENJE"}</span>
                      </div>
                    : <span style={{fontSize:10,color:C.warn,fontFamily:MONO,letterSpacing:1}}>Mjeri temperaturu prostorije</span>
                  }
                  {ferm.enabled&&fermAlarm&&<div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}><div style={{width:8,height:8,borderRadius:"50%",background:C.danger,boxShadow:`0 0 8px ${C.danger}`,animation:"pulse 1s infinite"}}/><span style={{fontSize:10,color:C.danger,fontFamily:MONO}}>ALARM</span></div>}
                </div>
                {ferm.enabled&&(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
                    <CtrlRow label="SETPOINT (°C)"  value={ferm.sp.toFixed(1)}    accent={C.ferm} onDec={()=>adj("ferm","sp",-0.5)}    onInc={()=>adj("ferm","sp",0.5)}/>
                    <CtrlRow label="HISTEREZA (°C)" value={ferm.hyst.toFixed(1)}  accent={C.ferm} onDec={()=>adj("ferm","hyst",-0.1)}  onInc={()=>adj("ferm","hyst",0.1)}/>
                    <CtrlRow label="ALARM Δ (°C)"   value={ferm.alarm.toFixed(1)} accent={C.ferm} onDec={()=>adj("ferm","alarm",-0.5)} onInc={()=>adj("ferm","alarm",0.5)}/>
                  </div>
                )}
              </div>
            )}

            {focus!=="ferm"&&<SectionCard sec="keezer" state={{ferm,keezer}} focused={focus==="keezer"} onFocus={e=>{if(!e.target.closest("button"))setFocus("keezer");}} onToggle={()=>toggle("keezer")} onAdj={(p,d)=>adj("keezer",p,d)} sparkRef={sparkKeezerRef}/>}
            {focus==="ferm"&&<FocusedDetail sec="ferm"/>}
            {focus==="keezer"&&<FocusedDetail sec="keezer"/>}

            {!focus&&(
              <div style={{gridColumn:"1 / -1",background:C.panel,border:`1px solid ${C.border}`,borderRadius:14,padding:"16px 20px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <div style={{fontSize:10,color:C.muted,letterSpacing:2,fontFamily:MONO}}>STATUS RELEJA — 2 AKTIVNA KANALA (220V)</div>
                  {compDelay&&<div style={{fontSize:10,color:C.warn,fontFamily:MONO,letterSpacing:1,padding:"3px 10px",border:`1px solid ${C.warn}44`,borderRadius:10}}>⏱ Kompresor delay: {compDelayLeft}s</div>}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12}}>
                  <RelayCard label={`R1 — ${fermMode==="heat"?"GRIJANJE":"HLAĐENJE"}`} sub="Fermentacija" active={ferm.relay&&ferm.enabled} color={fermMode==="heat"?C.heat:C.cool}/>
                  <RelayCard label="R2 — KEEZER" sub={compDelay?`Delay: ${compDelayLeft}s`:"Hlađenje"} active={keezer.relay&&keezer.enabled&&!keezerSafeMode&&!compDelay} color={compDelay?C.warn:C.keezer}/>
                </div>
              </div>
            )}

            {/* ── ZAŠTITNI PANELI ── */}
            {!focus&&(
              <div style={{gridColumn:"1 / -1",display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>

                {/* Keezer zaštita — uvijek aktivna */}
                <div style={{background:keezerSafeMode?"rgba(239,68,68,.08)":keezerRiseAlarm?"rgba(245,158,11,.08)":C.panel,border:`1px solid ${keezerSafeMode?C.danger:keezerRiseAlarm?C.warn:C.border}`,borderRadius:14,padding:"14px 18px",transition:"all .4s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <div style={{fontSize:10,color:keezerSafeMode?C.danger:keezerRiseAlarm?C.warn:C.keezer,letterSpacing:2,fontFamily:MONO}}>
                      {keezerSafeMode?"⛔ KEEZER SAFE MODE":keezerRiseAlarm?"⚡ KEEZER RAST ALARM":"🛡 KEEZER ZAŠTITA"}
                    </div>
                    <div style={{fontSize:9,color:C.ok,fontFamily:MONO,letterSpacing:1,padding:"2px 8px",border:`1px solid ${C.ok}44`,borderRadius:10}}>UVIJEK AKTIVNA</div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:keezerSafeMode?10:0}}>
                    {[
                      ["Brzina rasta", keezerRiseRate>0?`+${keezerRiseRate}°/min`:keezerRiseRate<0?`${keezerRiseRate}°/min`:"Stabilan", keezerRiseRate>RISE_RATE_LIMIT?C.warn:C.ok],
                      ["Status", keezerSafeMode?"SAFE MODE":keezerRiseAlarm?"RAST ALARM":"OK", keezerSafeMode?C.danger:keezerRiseAlarm?C.warn:C.ok],
                    ].map(([label,val,color])=>(
                      <div key={label} style={{background:"#060b11",borderRadius:8,padding:"8px 12px",border:`1px solid ${C.border}`}}>
                        <div style={{fontSize:9,color:C.muted,letterSpacing:1,fontFamily:MONO,marginBottom:4}}>{label.toUpperCase()}</div>
                        <div style={{fontSize:14,fontFamily:HEAD,fontWeight:700,color}}>{val}</div>
                      </div>
                    ))}
                  </div>
                  {keezerSafeMode&&(
                    <>
                      <div style={{fontSize:10,color:C.danger,fontFamily:MONO,lineHeight:1.8,marginBottom:8}}>
                        Provjeri kompresor, vrata, hladnjak.
                      </div>
                      <button onClick={()=>resetSafeMode("keezer")} style={{width:"100%",padding:"7px",borderRadius:10,border:`1px solid ${C.danger}`,background:C.danger+"22",color:C.danger,cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1}}>
                        Reset sigurnog moda
                      </button>
                    </>
                  )}
                </div>

                {/* Fermentacija zaštita — opcijska */}
                <div style={{background:fermSafeMode?"rgba(239,68,68,.08)":fermRiseAlarm&&fermProtection?"rgba(245,158,11,.08)":C.panel,border:`1px solid ${fermSafeMode?C.danger:fermRiseAlarm&&fermProtection?C.warn:C.border}`,borderRadius:14,padding:"14px 18px",transition:"all .4s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <div style={{fontSize:10,color:fermSafeMode?C.danger:fermRiseAlarm&&fermProtection?C.warn:C.ferm,letterSpacing:2,fontFamily:MONO}}>
                      {fermSafeMode?"⛔ FERM SAFE MODE":fermRiseAlarm&&fermProtection?"⚡ FERM RAST ALARM":"🛡 FERM ZAŠTITA"}
                    </div>
                    <button onClick={()=>setFermProtection(p=>!p)} style={{fontSize:9,fontFamily:MONO,letterSpacing:1,padding:"2px 10px",border:`1px solid ${fermProtection?C.ferm:C.border}`,borderRadius:10,background:fermProtection?C.ferm+"22":"transparent",color:fermProtection?C.ferm:C.muted,cursor:"pointer",transition:".2s"}}>
                      {fermProtection?"AKTIVNA":"ISKLJUČENA"}
                    </button>
                  </div>
                  {!fermProtection
                    ? <div style={{fontSize:11,color:C.muted,fontFamily:MONO,padding:"16px 0",textAlign:"center"}}>
                        Zaštita isključena<br/>
                        <span style={{fontSize:9}}>Klikni gumb za uključiti</span>
                      </div>
                    : <>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:fermSafeMode?10:0}}>
                        {[
                          ["Brzina rasta", fermRiseRate>0?`+${fermRiseRate}°/min`:fermRiseRate<0?`${fermRiseRate}°/min`:"Stabilan", fermRiseRate>RISE_RATE_LIMIT?C.warn:C.ok],
                          ["Status", fermSafeMode?"SAFE MODE":fermRiseAlarm?"RAST ALARM":"OK", fermSafeMode?C.danger:fermRiseAlarm?C.warn:C.ok],
                        ].map(([label,val,color])=>(
                          <div key={label} style={{background:"#060b11",borderRadius:8,padding:"8px 12px",border:`1px solid ${C.border}`}}>
                            <div style={{fontSize:9,color:C.muted,letterSpacing:1,fontFamily:MONO,marginBottom:4}}>{label.toUpperCase()}</div>
                            <div style={{fontSize:14,fontFamily:HEAD,fontWeight:700,color}}>{val}</div>
                          </div>
                        ))}
                      </div>
                      {fermSafeMode&&(
                        <>
                          <div style={{fontSize:10,color:C.danger,fontFamily:MONO,lineHeight:1.8,marginBottom:8}}>
                            Provjeri grijač, hlađenje, senzor.
                          </div>
                          <button onClick={()=>resetSafeMode("ferm")} style={{width:"100%",padding:"7px",borderRadius:10,border:`1px solid ${C.danger}`,background:C.danger+"22",color:C.danger,cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1}}>
                            Reset sigurnog moda
                          </button>
                        </>
                      )}
                    </>
                  }
                </div>

              </div>
            )}
          </div>
        )}

        {/* GRAF */}
        {tab==="chart"&&!focus&&(
          <div style={{display:"flex",flexDirection:"column",gap:20,animation:"fadeIn .3s ease"}}>
            <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:14,padding:"20px 20px 14px"}}>
              <div style={{fontSize:10,color:C.muted,letterSpacing:2,marginBottom:14,fontFamily:MONO}}>TEMPERATURA — LIVE GRAF ({Math.max(ferm.history.length,keezer.history.length)} mjerenja)</div>
              <canvas ref={chartMainRef} style={{display:"block",width:"100%"}}/>
              <div style={{fontSize:9,color:C.muted,marginTop:10,fontFamily:MONO}}>Isprekidana linija = setpoint · Osvježava svake 3 sekunde</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
              {[["ferm",ferm,C.ferm,"FERMENTACIJA"],["keezer",keezer,C.keezer,"KEEZER"]].map(([sec,s,color,label])=>{
                const temps=s.history.map(d=>d.temp);
                const avg=temps.length?(temps.reduce((a,b)=>a+b,0)/temps.length).toFixed(2)+"°":"—";
                const mn=temps.length?Math.min(...temps).toFixed(2)+"°":"—";
                const mx=temps.length?Math.max(...temps).toFixed(2)+"°":"—";
                return (
                  <div key={sec} style={{background:C.panel,border:`1px solid ${color}33`,borderRadius:12,padding:"16px 18px"}}>
                    <div style={{fontSize:10,color,letterSpacing:2,marginBottom:12,fontFamily:MONO}}>{label} — STATISTIKA</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                      {[["Prosjek",avg],["Min",mn],["Max",mx],["SP",s.sp.toFixed(1)+"°"]].map(([k,v])=>(
                        <div key={k} style={{textAlign:"center"}}>
                          <div style={{fontSize:9,color:C.muted,fontFamily:MONO}}>{k}</div>
                          <div style={{fontSize:17,color,fontFamily:HEAD,fontWeight:700}}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* LOG */}
        {tab==="log"&&!focus&&(
          <div style={{display:"flex",flexDirection:"column",gap:16,animation:"fadeIn .3s ease"}}>
            <RelayLog log={log} onClear={()=>{logRef.current=[];setLog([]);}}/>
            <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 20px"}}>
              <div style={{fontSize:10,color:C.muted,letterSpacing:2,marginBottom:12,fontFamily:MONO}}>ALARM STATUS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[["ferm",ferm,C.ferm,"Fermentacija",fermAlarm],["keezer",keezer,C.keezer,"Keezer",keezerAlarm]].map(([sec,s,color,name,alarm])=>{
                  const diff=rnd(s.temp-s.sp,2);
                  return (
                    <div key={sec} style={{background:"#060a0f",borderRadius:10,padding:"14px 16px",border:`1px solid ${alarm?C.danger+"55":C.border}`}}>
                      <div style={{fontSize:10,color,letterSpacing:1,marginBottom:8,fontFamily:MONO}}>{name}</div>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{fontSize:11,color:C.muted,fontFamily:MONO,lineHeight:2}}>
                          Trenutna: <span style={{color:C.text}}>{s.temp.toFixed(2)}°C</span><br/>
                          Setpoint: <span style={{color:C.text}}>{s.sp.toFixed(1)}°C</span><br/>
                          Razlika: <span style={{color:alarm?C.danger:C.ok}}>{diff>=0?"+":""}{diff}°C</span>
                        </div>
                        <div style={{padding:"6px 14px",borderRadius:20,border:`1px solid ${alarm?C.danger:C.ok}`,background:alarm?C.danger+"22":C.ok+"22",color:alarm?C.danger:C.ok,fontFamily:MONO,fontSize:11,animation:alarm?"pulse 1s infinite":"none"}}>
                          {alarm?"⚠ ALARM":"✓ OK"}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{textAlign:"center"}}>
              <button onClick={exportCSV} style={{padding:"10px 28px",borderRadius:24,border:`1px solid ${C.ferm}55`,background:C.ferm+"18",color:C.ferm,cursor:"pointer",fontFamily:MONO,fontSize:12,letterSpacing:2}}>
                ↓ EXPORT CSV — Temperatura + Relay Log
              </button>
            </div>
          </div>
        )}

        {/* SERIJA TAB */}
        {tab==="serija"&&!focus&&(
          <div style={{display:"flex",flexDirection:"column",gap:16,animation:"fadeIn .3s ease"}}>

            {/* Aktivna serija */}
            <div style={{background:C.panel,border:`1px solid ${batch.active?C.ferm+"55":C.border}`,borderRadius:14,padding:"18px 20px",boxShadow:batch.active?`0 0 24px ${C.ferm}10`:"none"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                <div style={{fontSize:10,color:batch.active?C.ferm:C.muted,letterSpacing:2,fontFamily:MONO}}>
                  {batch.active?"🍺 AKTIVNA SERIJA":"🍺 NOVA SERIJA"}
                </div>
                {!batch.active
                  ? <button onClick={()=>{setBatchDraft({name:"",style:""});setBatchModal(true);}} style={{padding:"6px 18px",borderRadius:20,border:`1px solid ${C.ferm}`,background:C.ferm+"18",color:C.ferm,cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1}}>+ Nova serija</button>
                  : <button onClick={stopBatch} style={{padding:"6px 18px",borderRadius:20,border:`1px solid ${C.danger}`,background:C.danger+"18",color:C.danger,cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1}}>🏁 Završi</button>
                }
              </div>
              {batch.active
                ? <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
                    {[
                      ["Naziv",   batch.name,                   C.ferm],
                      ["Stil",    batch.style||"—",             C.muted],
                      ["Dan",     `${batchDayNum}. dan`,        C.cool],
                      ["Start",   new Date(batch.startTs).toLocaleDateString("hr-HR"), C.muted],
                    ].map(([k,v,color])=>(
                      <div key={k} style={{background:"#060b11",borderRadius:10,padding:"10px 14px",border:`1px solid ${C.border}`}}>
                        <div style={{fontSize:9,color:C.muted,letterSpacing:1,fontFamily:MONO,marginBottom:6}}>{k.toUpperCase()}</div>
                        <div style={{fontSize:15,fontFamily:HEAD,fontWeight:700,color}}>{v}</div>
                      </div>
                    ))}
                  </div>
                : <div style={{fontSize:11,color:C.muted,fontFamily:MONO,padding:"12px 0"}}>Nema aktivne serije. Klikni "+ Nova serija" za početak.</div>
              }
            </div>

            {/* Fermentacijski profil */}
            <div style={{background:C.panel,border:`1px solid ${profileEnabled?C.ferm+"44":C.border}`,borderRadius:14,padding:"18px 20px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div style={{fontSize:10,color:profileEnabled?C.ferm:C.muted,letterSpacing:2,fontFamily:MONO}}>
                  📅 FERMENTACIJSKI PROFIL
                </div>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  {profileEnabled&&batch.active&&(
                    <div style={{fontSize:10,color:C.ferm,fontFamily:MONO,letterSpacing:1}}>
                      Dan {profileDay} — {profileSteps[profileStep]?.label}
                    </div>
                  )}
                  <button onClick={()=>setProfileEnabled(p=>!p)} style={{padding:"4px 14px",borderRadius:20,border:`1px solid ${profileEnabled?C.ferm:C.border}`,background:profileEnabled?C.ferm+"22":"transparent",color:profileEnabled?C.ferm:C.muted,cursor:"pointer",fontFamily:MONO,fontSize:11,letterSpacing:1}}>
                    {profileEnabled?"AKTIVAN":"ISKLJUČEN"}
                  </button>
                </div>
              </div>

              {/* Profil koraci */}
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {profileSteps.map((step,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"80px 1fr 120px 40px",gap:10,alignItems:"center",padding:"10px 14px",background:profileEnabled&&batch.active&&i===profileStep?"#060b11":i===profileStep&&profileEnabled?"#060b11":"transparent",border:`1px solid ${profileEnabled&&batch.active&&i===profileStep?C.ferm+"44":C.border}`,borderRadius:10}}>
                    <div style={{fontSize:11,fontFamily:MONO,color:C.muted}}>Dan {step.day}+</div>
                    <div style={{fontSize:11,fontFamily:MONO,color:C.text}}>{step.label}</div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <button onClick={()=>setProfileSteps(ps=>ps.map((s,j)=>j===i?{...s,sp:rnd(Math.max(0,s.sp-0.5),1)}:s))} style={{width:22,height:22,borderRadius:5,border:`1px solid ${C.border}`,background:"transparent",color:C.ferm,cursor:"pointer",fontFamily:MONO,fontSize:14}}>−</button>
                      <span style={{minWidth:36,textAlign:"center",fontFamily:MONO,fontSize:13,color:profileEnabled&&i===profileStep?C.ferm:C.text}}>{step.sp.toFixed(1)}°C</span>
                      <button onClick={()=>setProfileSteps(ps=>ps.map((s,j)=>j===i?{...s,sp:rnd(Math.min(40,s.sp+0.5),1)}:s))} style={{width:22,height:22,borderRadius:5,border:`1px solid ${C.border}`,background:"transparent",color:C.ferm,cursor:"pointer",fontFamily:MONO,fontSize:14}}>+</button>
                    </div>
                    {profileEnabled&&batch.active&&i===profileStep&&<div style={{width:8,height:8,borderRadius:"50%",background:C.ferm,boxShadow:`0 0 8px ${C.ferm}`,margin:"0 auto"}}/>}
                  </div>
                ))}
              </div>
              <div style={{fontSize:9,color:C.muted,fontFamily:MONO,marginTop:10}}>Profil se aktivira automatski kad startaš novu seriju.</div>
            </div>

            {/* Compressor delay info */}
            <div style={{background:C.panel,border:`1px solid ${compDelay?C.warn+"55":C.border}`,borderRadius:14,padding:"16px 20px"}}>
              <div style={{fontSize:10,color:compDelay?C.warn:C.muted,letterSpacing:2,marginBottom:12,fontFamily:MONO}}>
                ⏱ COMPRESSOR DELAY ZAŠTITA
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                {[
                  ["Delay",  `${COMPRESSOR_DELAY_MS/60000} min`, C.muted],
                  ["Status", compDelay?`Čekam ${compDelayLeft}s`:"Slobodan", compDelay?C.warn:C.ok],
                  ["Svrha",  "Štiti kompresor", C.muted],
                ].map(([k,v,color])=>(
                  <div key={k} style={{background:"#060b11",borderRadius:10,padding:"10px 14px",border:`1px solid ${C.border}`}}>
                    <div style={{fontSize:9,color:C.muted,letterSpacing:1,fontFamily:MONO,marginBottom:6}}>{k.toUpperCase()}</div>
                    <div style={{fontSize:14,fontFamily:HEAD,fontWeight:700,color}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}

        {/* ANALYTICS */}
        {tab==="analytics"&&!focus&&(
          <AnalyticsTab cycles={cycles} period={analyticsPeriod} setPeriod={setAnalyticsPeriod}/>
        )}

      </div>

      {/* BATCH MODAL */}
      {batchModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:20,padding:"28px 32px",maxWidth:380,width:"90%",display:"flex",flexDirection:"column",gap:18}}>
            <div style={{fontFamily:HEAD,fontSize:18,fontWeight:700,color:C.text}}>🍺 Nova serija</div>
            {[["Naziv serije","name","npr. IPA #5"],["Stil","style","npr. India Pale Ale"]].map(([label,field,ph])=>(
              <div key={field} style={{display:"flex",flexDirection:"column",gap:6}}>
                <span style={{fontSize:10,color:C.muted,fontFamily:MONO,letterSpacing:1}}>{label.toUpperCase()}</span>
                <input value={batchDraft[field]} onChange={e=>setBatchDraft(d=>({...d,[field]:e.target.value}))}
                  placeholder={ph}
                  style={{background:"#060b11",border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",color:C.text,fontFamily:MONO,fontSize:12,outline:"none"}}
                />
              </div>
            ))}
            <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"#060b11",borderRadius:10,border:`1px solid ${profileEnabled?C.ferm+"44":C.border}`}}>
              <input type="checkbox" checked={profileEnabled} onChange={e=>{setProfileEnabled(e.target.checked);profileEnabledRef.current=e.target.checked;}} id="prof-toggle" style={{accentColor:C.ferm}}/>
              <label htmlFor="prof-toggle" style={{fontSize:11,color:profileEnabled?C.ferm:C.muted,fontFamily:MONO,cursor:"pointer",letterSpacing:1}}>
                Koristi fermentacijski profil
              </label>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setBatchModal(false)} style={{flex:1,padding:"10px",borderRadius:12,border:`1px solid ${C.border}`,background:"transparent",color:C.muted,cursor:"pointer",fontFamily:MONO,fontSize:12}}>Odustani</button>
              <button onClick={startBatch} disabled={!batchDraft.name} style={{flex:1,padding:"10px",borderRadius:12,border:`1px solid ${C.ferm}`,background:C.ferm+"22",color:batchDraft.name?C.ferm:C.muted,cursor:batchDraft.name?"pointer":"not-allowed",fontFamily:MONO,fontSize:12,fontWeight:700}}>Start 🍺</button>
            </div>
          </div>
        </div>
      )}

      {/* CONFIRM MOD SWITCH MODAL */}
      {confirmModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:20,padding:"28px 32px",maxWidth:360,width:"90%",display:"flex",flexDirection:"column",gap:20}}>
            <div style={{fontFamily:HEAD,fontSize:18,fontWeight:700,color:C.text,letterSpacing:1}}>Promjena moda</div>
            <div style={{fontSize:12,color:C.muted,fontFamily:MONO,lineHeight:1.8}}>
              Trenutni mod: <span style={{color:fermMode==="heat"?C.heat:C.cool,fontWeight:700}}>{fermMode==="heat"?"🔥 GRIJANJE":"❄ HLAĐENJE"}</span><br/>
              Novi mod: <span style={{color:fermMode==="heat"?C.cool:C.heat,fontWeight:700}}>{fermMode==="heat"?"❄ HLAĐENJE":"🔥 GRIJANJE"}</span><br/><br/>
              <span style={{color:C.warn}}>⚠ Relay će se odmah isključiti pri prebacivanju.</span><br/>
              Jesi li siguran?
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setConfirmModal(false)} style={{flex:1,padding:"10px",borderRadius:12,border:`1px solid ${C.border}`,background:"transparent",color:C.muted,cursor:"pointer",fontFamily:MONO,fontSize:12,letterSpacing:1}}>
                Odustani
              </button>
              <button onClick={confirmModeSwitch} style={{flex:1,padding:"10px",borderRadius:12,border:`1px solid ${fermMode==="heat"?C.cool:C.heat}`,background:fermMode==="heat"?C.cool+"22":C.heat+"22",color:fermMode==="heat"?C.cool:C.heat,cursor:"pointer",fontFamily:MONO,fontSize:12,letterSpacing:1,fontWeight:700}}>
                Potvrdi
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
