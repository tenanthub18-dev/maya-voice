export type MicrophoneErrorCode = 'permission-denied' | 'no-device' | 'insecure-context' | 'unavailable';

export class TestCallMicrophoneError extends Error {
  constructor(readonly code: MicrophoneErrorCode) {
    super(code);
    this.name = 'TestCallMicrophoneError';
  }
}

export interface MicrophoneEnvironment {
  isSecureContext: boolean;
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
}

export async function requestTestCallMicrophone(environment: MicrophoneEnvironment): Promise<MediaStream> {
  if (!environment.isSecureContext) throw new TestCallMicrophoneError('insecure-context');
  if (!environment.mediaDevices?.getUserMedia) throw new TestCallMicrophoneError('no-device');
  try {
    return await environment.mediaDevices.getUserMedia({audio: true, video: false});
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new TestCallMicrophoneError('permission-denied');
    }
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      throw new TestCallMicrophoneError('no-device');
    }
    throw new TestCallMicrophoneError('unavailable');
  }
}

export function startMicLevelMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.frequencyBinCount);
  let animationFrame = 0;
  const sample = () => {
    analyser.getByteTimeDomainData(samples);
    const peak = samples.reduce((maximum, value) => Math.max(maximum, Math.abs(value - 128)), 0);
    onLevel(Math.min(100, Math.round((peak / 128) * 100)));
    animationFrame = requestAnimationFrame(sample);
  };
  sample();
  return () => {
    cancelAnimationFrame(animationFrame);
    void context.close();
    onLevel(0);
  };
}
