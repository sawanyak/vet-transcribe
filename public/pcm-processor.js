// Runs on the audio thread. Receives float samples, converts to 16-bit PCM,
// and posts them back to the main thread.
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const float32 = input[0]; // mono channel, Float32 [-1, 1]
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff; // clamp + scale to 16-bit
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true; // keep processor alive
  }
}
registerProcessor("pcm-processor", PCMProcessor);