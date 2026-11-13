// Throwaway test page for phone/browser test calls: serves a mic page, signs /webrtc/offer like
// apps/web/app/api/test-call/offer/route.ts, and serves ICE servers at /ice. Not production code.
// Run: set -a; source ../../../.env.local; set +a; node harness.mjs   (then expose :3100 with `cloudflared tunnel --url http://localhost:3100`)
import {createServer} from 'node:http';
import {createHash, createHmac} from 'node:crypto';

const secret = process.env.TEST_CALL_HMAC_SECRET;
const worker = process.env.WORKER_URL ?? 'http://127.0.0.1:8080';
const agentVersionId = process.env.AGENT_VERSION_ID ?? '09000000-0000-4000-8000-000000000010';
const restaurantId = process.env.RESTAURANT_ID ?? '02000000-0000-4000-8000-000000000002';

const page = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Voice test</title>
<body style="font:18px system-ui;max-width:480px;margin:24px auto;padding:0 16px">
<h2>Voice test call</h2>
<button id=go style="font-size:22px;padding:14px 24px">Start call</button>
<button id=stop style="font-size:22px;padding:14px 24px" disabled>Hang up</button>
<p id=s>Idle</p><audio id=a autoplay></audio>
<script>
const s=document.getElementById('s'),go=document.getElementById('go'),stop=document.getElementById('stop');
let pc,ms;
go.onclick=async()=>{try{
 s.textContent='Asking for mic…';
 ms=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
 const ice=await (await fetch('/ice')).json();
 pc=new RTCPeerConnection({iceServers:ice,iceTransportPolicy:location.search.includes('relay')?'relay':'all'});
 ms.getTracks().forEach(t=>pc.addTrack(t,ms));
 pc.ontrack=e=>{document.getElementById('a').srcObject=e.streams[0]};
 pc.onconnectionstatechange=()=>{s.textContent='Connection: '+pc.connectionState+' at '+new Date().toLocaleTimeString()};
 pc.oniceconnectionstatechange=()=>{s.textContent+=' | ICE: '+pc.iceConnectionState};
 try{if(navigator.wakeLock){navigator.wakeLock.request('screen').then(()=>{s.textContent+=' (screen kept awake)'}).catch(()=>{})}}catch(e){}
 const o=await pc.createOffer();await pc.setLocalDescription(o);
 await new Promise(r=>{if(pc.iceGatheringState==='complete')return r();pc.addEventListener('icegatheringstatechange',()=>pc.iceGatheringState==='complete'&&r());setTimeout(r,3000)});
 s.textContent='Connecting…';
 const r=await fetch('/offer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sdp:pc.localDescription.sdp,type:'offer'})});
 if(!r.ok){s.textContent='Worker said '+r.status+': '+(await r.text()).slice(0,300);return}
 await pc.setRemoteDescription(await r.json());
 go.disabled=true;stop.disabled=false;
}catch(e){s.textContent='Error: '+e.message}};
stop.onclick=()=>{pc&&pc.close();ms&&ms.getTracks().forEach(t=>t.stop());go.disabled=false;stop.disabled=true;s.textContent='Call ended'};
</script>`;

function sign(body, path) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const digest = createHmac('sha256', secret).update(`${timestamp}\nPOST\n${path}\n${bodyHash}`).digest('hex');
  return {timestamp, signature: `sha256=${digest}`};
}

function token() {
  const claims = {exp: Math.floor(Date.now() / 1000) + 60, mode: 'test', agent_version_id: agentVersionId, restaurant_id: restaurantId};
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/ice') { res.writeHead(200, {'content-type': 'application/json'}); return res.end(process.env.WEBRTC_ICE_SERVERS || '[]'); }
  if (req.method === 'GET') { res.writeHead(200, {'content-type': 'text/html'}); return res.end(page); }
  if (req.method === 'POST' && req.url === '/offer') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const sig = sign(body, '/webrtc/offer');
    const r = await fetch(`${worker}/webrtc/offer`, {method: 'POST', headers: {authorization: `Bearer ${token()}`, 'content-type': 'application/json', 'x-timestamp': sig.timestamp, 'x-signature': sig.signature}, body});
    res.writeHead(r.status, {'content-type': r.headers.get('content-type') ?? 'application/json'});
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  res.writeHead(404); res.end();
}).listen(3100, '0.0.0.0', () => console.log('harness on 3100'));
