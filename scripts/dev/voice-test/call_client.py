"""Scripted, silent test call: signs /webrtc/offer like the web app, plays clips with gaps, records the agent's
audio and reports (caller side) first sound and answer start per turn. Nothing plays on the speakers.
Usage: uv run --project ../../../apps/worker python call_client.py en,fr,hi 8   (needs ./clips from gen_clips.sh)
Needs TEST_CALL_HMAC_SECRET in the environment (source .env.local)."""
import asyncio, base64, hashlib, hmac, json, math, os, sys, time, urllib.request, wave
import numpy as np
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer

SECRET = os.environ["TEST_CALL_HMAC_SECRET"]
BASE = os.environ.get("WORKER_URL", "http://127.0.0.1:8080")
# Seed ids from supabase/seed.sql (local Supabase); change for another database.
AGENT_VERSION = os.environ.get("AGENT_VERSION_ID", "09000000-0000-4000-8000-000000000010")
RESTAURANT = os.environ.get("RESTAURANT_ID", "02000000-0000-4000-8000-000000000002")
HERE = os.path.dirname(os.path.abspath(__file__))


def signed_headers(body: bytes):
    ts = str(int(time.time()))
    digest = hmac.new(SECRET.encode(), f"{ts}\nPOST\n/webrtc/offer\n{hashlib.sha256(body).hexdigest()}".encode(), hashlib.sha256).hexdigest()
    claims = {"exp": int(time.time()) + 60, "mode": "test", "agent_version_id": AGENT_VERSION, "restaurant_id": RESTAURANT}
    payload = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).rstrip(b"=").decode()
    token = payload + "." + hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return {"authorization": "Bearer " + token, "content-type": "application/json", "x-timestamp": ts, "x-signature": "sha256=" + digest}


def build_wav(names, gap_s, lead_s=9.0):
    out = os.path.join(HERE, "combined.wav")
    frames, rate, ends = b"", None, []
    def silence(sec): return b"\x00\x00" * int(rate * sec)
    for n in names:
        with wave.open(os.path.join(HERE, "clips", f"{n}.wav")) as w:
            if rate is None:
                rate = w.getframerate(); frames += silence(lead_s)
            assert w.getnchannels() == 1 and w.getframerate() == rate, (n, w.getnchannels(), w.getframerate())
            frames += w.readframes(w.getnframes())  # Soniox streams a bogus length in the header; read to EOF
            ends.append(len(frames) / 2 / rate)
            frames += silence(gap_s)
    with wave.open(out, "wb") as o:
        o.setnchannels(1); o.setsampwidth(2); o.setframerate(rate); o.writeframes(frames)
    return out, len(frames) / 2 / rate, ends


class TimedTrack(MediaStreamTrack):
    kind = "audio"
    def __init__(self, inner):
        super().__init__(); self.inner = inner; self.t0 = None
    async def recv(self):
        frame = await self.inner.recv()
        if self.t0 is None:
            self.t0 = time.monotonic()
        return frame


def pct(values, fraction):
    return values[max(0, math.ceil(fraction * len(values)) - 1)] if values else float("nan")


def report(samples, t0, ends, gap_s, thr=150.0):
    """Per caller turn: first agent audio after the clip ends, and the start of a second burst (the answer)."""
    rows = []
    for k, end in enumerate(ends):
        e = t0 + end
        loud = [(t, r) for t, r in samples if e <= t <= e + gap_s and r > thr]
        if not loud:
            rows.append((k, None, None)); continue
        first, burst_end, second = loud[0][0], loud[0][0], None
        for t, r in loud[1:]:
            if t - burst_end > 0.25:
                second = t; break
            burst_end = t
        rows.append((k, (first - e) * 1000, None if second is None else (second - e) * 1000))
    firsts = sorted(r[1] for r in rows if r[1] is not None)
    seconds = sorted(r[2] for r in rows if r[2] is not None)
    print("RESULT turns", len(rows), "heard", len(firsts))
    print("RESULT first_sound p50 %.0f p95 %.0f" % (pct(firsts, .5), pct(firsts, .95)))
    print("RESULT second_burst n=%d p50 %.0f p95 %.0f" % (len(seconds), pct(seconds, .5), pct(seconds, .95)))
    for k, a, b in rows:
        print("TURN", k, "first", None if a is None else round(a), "second", None if b is None else round(b))


async def main(names, gap_s):
    wav, total, ends = build_wav(names, gap_s)
    pc = RTCPeerConnection()
    samples = []
    async def reader(track):
        while True:
            try:
                frame = await track.recv()
            except Exception:
                return
            arr = frame.to_ndarray().astype(np.float32)
            samples.append((time.monotonic(), float(np.sqrt((arr ** 2).mean()))))
    @pc.on("track")
    def on_track(track):
        asyncio.ensure_future(reader(track))
    timed = TimedTrack(MediaPlayer(wav).audio)
    pc.addTrack(timed)
    await pc.setLocalDescription(await pc.createOffer())
    body = json.dumps({"sdp": pc.localDescription.sdp, "type": "offer"}).encode()
    req = urllib.request.Request(BASE + "/webrtc/offer", data=body, headers=signed_headers(body), method="POST")
    answer = json.loads(urllib.request.urlopen(req, timeout=30).read())
    await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
    await asyncio.sleep(total + 4)
    await pc.close()
    report(samples, timed.t0, ends, gap_s)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1].split(","), float(sys.argv[2]) if len(sys.argv) > 2 else 8.0))
