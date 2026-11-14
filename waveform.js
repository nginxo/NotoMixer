// Three crossover envelopes from PCM, in a common amplitude scale.
function analyzeWaveformBands(buffers) {
  const duration = Math.max(0, ...buffers.map(buffer => buffer.duration));
  const count = Math.min(65536, Math.ceil(duration * 96));
  const bands = new Float32Array(count * 3);
  if (!count) return new Uint8Array();
  for (const buffer of buffers) {
    const rate = buffer.sampleRate;
    const bassAlpha = 1 - Math.exp(-2 * Math.PI * 180 / rate);
    const trebleAlpha = 1 - Math.exp(-2 * Math.PI * 2600 / rate);
    for (let channel = 0; channel < Math.min(2, buffer.numberOfChannels); channel++) {
      const samples = buffer.getChannelData(channel);
      let low = 0;
      let lowMid = 0;
      let bucket = 0;
      let peakLow = 0;
      let peakMid = 0;
      let peakHigh = 0;
      let boundary = duration * rate / count;
      const samplesPerBucket = boundary;
      for (let i = 0; i <= samples.length; i++) {
        if (i >= boundary || i === samples.length) {
          bands[bucket * 3] += peakLow;
          bands[bucket * 3 + 1] += peakMid;
          bands[bucket * 3 + 2] += peakHigh;
          bucket = Math.floor(i / samplesPerBucket);
          boundary = (bucket + 1) * samplesPerBucket;
          peakLow = peakMid = peakHigh = 0;
        }
        if (i === samples.length || bucket >= count) break;
        const sample = samples[i];
        low += bassAlpha * (sample - low);
        lowMid += trebleAlpha * (sample - lowMid);
        peakLow = Math.max(peakLow, Math.abs(low));
        peakMid = Math.max(peakMid, Math.abs(lowMid - low));
        peakHigh = Math.max(peakHigh, Math.abs(sample - lowMid));
      }
    }
  }
  const weights = [1, 0.85, 0.72];
  let scale = 0;
  for (let i = 0; i < bands.length; i++) {
    bands[i] *= weights[i % 3];
    scale = Math.max(scale, bands[i]);
  }
  return Uint8Array.from(bands, value => Math.round(255 * Math.sqrt(value / (scale || 1))));
}

const BandColors = ['#368af2', '#ff9d42', '#f4edcf'];
const overviewCache = new WeakMap();

function drawBands(ctx, bands, width, height, start, span, playhead) {
  if (width <= 0 || height <= 0) return;
  const count = bands.length / 3;
  const half = Math.max(1, (height - 4) / 2);
  const center = height / 2;
  const step = span * count / width;
  for (let band = 0; band < 3; band++) {
    ctx.beginPath();
    for (let x = 0; x < width; x++) {
      const left = start * count + x * step;
      const first = Math.max(0, Math.floor(left));
      const end = Math.min(count, Math.ceil(left + step));
      let amplitude = 0;
      for (let i = first; i < end; i++) amplitude = Math.max(amplitude, bands[3 * i + band]);
      const h = Math.round(amplitude * half / 255);
      if (h) ctx.rect(x, center - h, 1, h * 2);
    }
    ctx.fillStyle = BandColors[band];
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(4,8,15,0.24)';
  ctx.fillRect(playhead, 0, width - playhead, height);
}

function drawBandOverview(ctx, bands, width, height, playhead) {
  if (width <= 0 || height <= 0) return;
  let image = overviewCache.get(bands);
  if (!image || width !== image.width || height !== image.height) {
    image = document.createElement('canvas');
    image.width = width;
    image.height = height;
    drawBands(image.getContext('2d'), bands, width, height, 0, 1, width);
    overviewCache.set(bands, image);
  }
  ctx.drawImage(image, 0, 0);
  ctx.fillStyle = 'rgba(4,8,15,0.35)';
  ctx.fillRect(playhead, 0, width - playhead, height);
}

module.exports = { analyzeWaveformBands, drawBands, drawBandOverview };
