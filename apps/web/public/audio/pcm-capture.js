/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// AudioWorklet render quanta may vary; use actual input lengths and the native
// sampleRate. https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(Math.round(sampleRate * 0.02));
    this.offset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame++) {
      let mono = 0;
      for (const channel of channels) mono += channel[frame] / channels.length;
      this.samples[this.offset++] = mono;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(Math.round(sampleRate * 0.02));
        this.offset = 0;
      }
    }
    // Outputs retain their default zeros, so the user never hears their mic.
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
