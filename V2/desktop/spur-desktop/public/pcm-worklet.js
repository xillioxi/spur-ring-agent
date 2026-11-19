class SpurPCM extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = (options.processorOptions.inputRate || sampleRate) / 16000;
    this.position = 0;
    this.samples = [];
    this.output = new Int16Array(1600);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      this.samples.push(value);
    }
    while (this.position + 1 < this.samples.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const value = Math.max(-1, Math.min(1, this.samples[index] * (1 - fraction) + this.samples[index + 1] * fraction));
      this.output[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
      this.position += this.ratio;
      if (this.offset === this.output.length) {
        const bytes = this.output.buffer;
        this.port.postMessage(bytes, [bytes]);
        this.output = new Int16Array(1600);
        this.offset = 0;
      }
    }
    const consumed = Math.floor(this.position);
    this.samples.splice(0, consumed);
    this.position -= consumed;
    return true;
  }
}
registerProcessor('spur-pcm', SpurPCM);
