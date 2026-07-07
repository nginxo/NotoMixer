const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// Global audio context
let audioCtx = null;
let workingDir = ''; // Root directory containing songs folder

// Center Snap Assist Settings
let snapEnabled = false;
let snapThresholdPct = 5; // Default 5%

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.aac': return 'audio/aac';
    case '.flac': return 'audio/flac';
    case '.m4a': return 'audio/mp4';
    default: return 'audio/mpeg';
  }
}

// Simple real-time granular resampler for independent pitch shifting
class PitchShifterNode {
  constructor(context) {
    this.context = context;
    this.pitch = 1.0;
    
    // ScriptProcessorNode with 4096 buffer size
    this.node = context.createScriptProcessor(4096, 2, 2);
    
    // Use a power-of-two buffer size for fast bitwise masking
    const bufferSize = 131072; // 2^17 (approx 3 seconds of audio at 44.1kHz)
    const mask = bufferSize - 1;
    
    this.ringBufferL = new Float32Array(bufferSize);
    this.ringBufferR = new Float32Array(bufferSize);
    this.writePtr = 0;
    
    // Granular pitch shifting parameters
    this.offset1 = 0.0;
    const delaySize = 2048; // grain window size (approx 46ms)
    const halfDelay = delaySize / 2;
    const safetyOffset = 256; // safe distance from write pointer to avoid reads on dirty samples
    
    // Precompute Hanning window table to avoid calling Math.cos() per sample
    this.windowTable = new Float32Array(delaySize);
    for (let i = 0; i < delaySize; i++) {
      this.windowTable[i] = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / delaySize);
    }
    
    this.process = (e) => {
      const inputL = e.inputBuffer.getChannelData(0);
      const inputR = e.inputBuffer.getChannelData(1);
      const outputL = e.outputBuffer.getChannelData(0);
      const outputR = e.outputBuffer.getChannelData(1);
      const len = inputL.length;
      
      // If pitch is 1.0 (normal), bypass to save CPU and maintain native audio quality
      if (this.pitch === 1.0) {
        outputL.set(inputL);
        outputR.set(inputR);
        // Fill ring buffer to avoid silence gaps when pitch is suddenly changed
        for (let i = 0; i < len; i++) {
          this.ringBufferL[this.writePtr] = inputL[i];
          this.ringBufferR[this.writePtr] = inputR[i];
          this.writePtr = (this.writePtr + 1) & mask;
        }
        return;
      }
      
      const rate = 1.0 - this.pitch;
      
      for (let i = 0; i < len; i++) {
        // Record current input sample to ring buffer
        this.ringBufferL[this.writePtr] = inputL[i];
        this.ringBufferR[this.writePtr] = inputR[i];
        
        // Calculate the second overlapping pointer (180 degrees offset) - avoided % operator
        let offset2 = this.offset1 + halfDelay;
        if (offset2 >= delaySize) {
          offset2 -= delaySize;
        }
        
        // Get integer parts for array lookups
        const offset1Int = Math.floor(this.offset1);
        const offset2Int = Math.floor(offset2);
        
        // Safety clamp to prevent out-of-bounds indexing (e.g. if Math.floor of 2047.9999999999998 yields 2048)
        const idx1 = offset1Int >= delaySize ? delaySize - 1 : (offset1Int < 0 ? 0 : offset1Int);
        const idx2 = offset2Int >= delaySize ? delaySize - 1 : (offset2Int < 0 ? 0 : offset2Int);
        
        // Calculate read index positions using fast bitwise mask
        const readPtr1 = (this.writePtr - idx1 - safetyOffset) & mask;
        const readPtr2 = (this.writePtr - idx2 - safetyOffset) & mask;
        
        const readPtr1Prev = (readPtr1 - 1) & mask;
        const readPtr2Prev = (readPtr2 - 1) & mask;
        
        // Interpolation fractional parts
        const frac1 = this.offset1 - offset1Int;
        const frac2 = offset2 - offset2Int;
        
        // Interpolate samples for Tap 1 (Stereo)
        const sample1L = (1 - frac1) * this.ringBufferL[readPtr1] + frac1 * this.ringBufferL[readPtr1Prev];
        const sample1R = (1 - frac1) * this.ringBufferR[readPtr1] + frac1 * this.ringBufferR[readPtr1Prev];
        
        // Interpolate samples for Tap 2 (Stereo)
        const sample2L = (1 - frac2) * this.ringBufferL[readPtr2] + frac2 * this.ringBufferL[readPtr2Prev];
        const sample2R = (1 - frac2) * this.ringBufferR[readPtr2] + frac2 * this.ringBufferR[readPtr2Prev];
        
        // Fast table lookup for Hanning Window weight
        const w = this.windowTable[idx1];
        
        // Perform clean crossfade
        outputL[i] = w * sample1L + (1.0 - w) * sample2L;
        outputR[i] = w * sample1R + (1.0 - w) * sample2R;
        
        // Advance write pointer using fast mask
        this.writePtr = (this.writePtr + 1) & mask;
        
        // Advance sweep offset
        this.offset1 = this.offset1 + rate;
        if (this.offset1 < 0) {
          this.offset1 += delaySize;
        } else if (this.offset1 >= delaySize) {
          this.offset1 -= delaySize;
        }
      }
    };
    this.node.onaudioprocess = null; // Bypassed and disabled by default on startup
  }
  
  setPitch(pitch) {
    this.pitch = pitch;
  }
}


// Bypasses the PitchShifter node when Pitch is at 0 (default) to run at C++ speeds with 0% JS overhead
function updateAudioGraphConnections(trackNum) {
  const track = tracks[trackNum];
  if (!track.gainNode) return; // not initialized yet
  
  try {
    track.filterHPFNode.disconnect();
  } catch(e) {}
  try {
    track.pitchShifter.node.disconnect();
  } catch(e) {}
  
  // Safe check with threshold and type coercion to prevent floating decimal glitches
  const isPitchActive = (Math.abs(Number(track.pitchVal)) > 0.05);
  
  if (isPitchActive) {
    track.pitchShifter.node.onaudioprocess = track.pitchShifter.process; // Enable processing
    track.filterHPFNode.connect(track.pitchShifter.node);
    track.pitchShifter.node.connect(track.gainNode);
    track.pitchShifter.node.connect(track.echoDelayNode);
  } else {
    track.pitchShifter.node.onaudioprocess = null; // Disable processing to save 100% CPU and run at native C++ speeds
    track.filterHPFNode.connect(track.gainNode);
    track.filterHPFNode.connect(track.echoDelayNode);
  }
}

// Track states supporting:
// - main (main.mp3)
// - vocals (vocals.mp3)
// - inst (dynamic list of any other audio files in the folder)
let masterTrackNum = 1;
const tracks = {
  1: {
    stems: {
      main: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'main.mp3' },
      vocals: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'vocals.mp3' },
      inst: {
        audios: [], // Dynamic array of { audio, source, gainNode, file }
        exists: false
      }
    },
    soundButtons: [
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null }
    ],
    hotCues: Array(8).fill(null),
    // EQ filters (applied on combined mix)
    bassFilter: null,
    lowFilter: null,
    trebFilter: null,
    
    // Bipolar Filter Sweep Nodes
    filterLPFNode: null,
    filterHPFNode: null,
    
    // Master Gain (Volume)
    gainNode: null,
    analyser: null,
    
    // Pan and Reverb Nodes
    panNode: null,
    reverbConvolverNode: null,
    reverbWetNode: null,
    
    // State
    isPlaying: false,
    isSynth: false,
    synthTimer: null,
    dirPath: '',
    title: 'TRACK 1 (EMPTY)',
    
    // EQ Row 3 state
    pitchVal: 0,   // semitones, -12 to 12
    speedVal: 1.0, // playback speed factor, 0.5 to 2.0
    echoVal: 0,    // echo percentage, 0 to 100
    
    // Row 4 and Filter state
    filterVal: 50,    // 0 to 100 (50 is bypass)
    panVal: 0,        // -100 to 100 (0 is center)
    reverbVal: 0,     // 0 to 100 (wet percentage)
    echoTimeVal: 350, // 100ms to 1000ms delay time
    
    // Metronome and Tempo state
    bpmVal: 120,
    bpmDivVal: '1/1',
    metronomeOn: false,
    metronomeIntervalId: null,
    
    // Web Audio Nodes
    pitchShifter: null,
    echoDelayNode: null,
    echoFeedbackNode: null,
    echoWetNode: null,
    
    // Loop State
    loopEnabled: false,
    loopStartTime: null,
    loopEndTime: null,
    autoLoopBeats: 4,
    syncEnabled: false,
    visMode: 'waveform',
    beatOffset: 0,
    quantizeEnabled: false,
    _quantizePendingTimer: null
  },
  2: {
    stems: {
      main: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'main.mp3' },
      vocals: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'vocals.mp3' },
      inst: {
        audios: [], // Dynamic array of { audio, source, gainNode, file }
        exists: false
      }
    },
    soundButtons: [
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null },
      { path: '', name: 'DROP FILE', buffer: null }
    ],
    hotCues: Array(8).fill(null),
    // EQ filters (applied on combined mix)
    bassFilter: null,
    lowFilter: null,
    trebFilter: null,
    
    // Bipolar Filter Sweep Nodes
    filterLPFNode: null,
    filterHPFNode: null,
    
    // Master Gain (Volume)
    gainNode: null,
    analyser: null,
    
    // Pan and Reverb Nodes
    panNode: null,
    reverbConvolverNode: null,
    reverbWetNode: null,
    
    // State
    isPlaying: false,
    isSynth: false,
    synthTimer: null,
    dirPath: '',
    title: 'TRACK 2 (EMPTY)',
    
    // EQ Row 3 state
    pitchVal: 0,
    speedVal: 1.0,
    echoVal: 0,
    
    // Row 4 and Filter state
    filterVal: 50,
    panVal: 0,
    reverbVal: 0,
    echoTimeVal: 350,
    
    // Metronome and Tempo state
    bpmVal: 120,
    bpmDivVal: '1/1',
    metronomeOn: false,
    metronomeIntervalId: null,
    
    // Web Audio Nodes
    pitchShifter: null,
    echoDelayNode: null,
    echoFeedbackNode: null,
    echoWetNode: null,
    
    // Loop State
    loopEnabled: false,
    loopStartTime: null,
    loopEndTime: null,
    autoLoopBeats: 4,
    syncEnabled: false,
    visMode: 'waveform',
    beatOffset: 0,
    quantizeEnabled: false,
    _quantizePendingTimer: null
  }
};

// Web Serial State
let activePort = null;
let handshakeInterval = null;
let syncedParams = {};
let activeWriter = null;
let serialReaderLoop = null;
let esp32Ip = null;
const esp32Port = 41234;

// -------------------------------------------------------------
// Audio & Synth Control Logic
// -------------------------------------------------------------

function createReverbImpulseResponse(duration, decay, sampleRate) {
  const length = sampleRate * duration;
  const impulse = audioCtx.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);
  for (let i = 0; i < length; i++) {
    const percent = i / length;
    const envelope = Math.pow(1 - percent, decay);
    left[i] = (Math.random() * 2 - 1) * envelope;
    right[i] = (Math.random() * 2 - 1) * envelope;
  }
  return impulse;
}

function initAudio(trackNum) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    // Apply saved main audio device if present
    const savedMain = localStorage.getItem('notoMixer_mainAudioDevice');
    if (savedMain && savedMain !== 'default' && typeof audioCtx.setSinkId === 'function') {
      audioCtx.setSinkId(savedMain).catch(err => {
        console.error("Error setting initial main sink ID, falling back to default:", err);
        audioCtx.setSinkId('');
      });
    }
  }
  
  const track = tracks[trackNum];
  if (track.gainNode) return; // Already initialized

  // Common filters for combined mix
  track.bassFilter = audioCtx.createBiquadFilter();
  track.bassFilter.type = 'peaking';
  track.bassFilter.frequency.value = 80;
  track.bassFilter.Q.value = 1.0;
  track.bassFilter.gain.value = 0;

  track.lowFilter = audioCtx.createBiquadFilter();
  track.lowFilter.type = 'peaking';
  track.lowFilter.frequency.value = 320;
  track.lowFilter.Q.value = 1.0;
  track.lowFilter.gain.value = 0;

  track.trebFilter = audioCtx.createBiquadFilter();
  track.trebFilter.type = 'peaking';
  track.trebFilter.frequency.value = 8000;
  track.trebFilter.Q.value = 1.0;
  track.trebFilter.gain.value = 0;

  // Bipolar Filter Sweep Nodes (LPF and HPF)
  track.filterLPFNode = audioCtx.createBiquadFilter();
  track.filterLPFNode.type = 'lowpass';
  track.filterLPFNode.Q.value = 1.0;
  
  track.filterHPFNode = audioCtx.createBiquadFilter();
  track.filterHPFNode.type = 'highpass';
  track.filterHPFNode.Q.value = 1.0;
  
  // Set initial filter frequencies based on filterVal
  const fVal = track.filterVal;
  if (fVal === 50) {
    track.filterLPFNode.frequency.value = 22000;
    track.filterHPFNode.frequency.value = 20;
  } else if (fVal < 50) {
    track.filterLPFNode.frequency.value = 20 * Math.pow(22000 / 20, fVal / 50);
    track.filterHPFNode.frequency.value = 20;
  } else {
    track.filterLPFNode.frequency.value = 22000;
    track.filterHPFNode.frequency.value = 20 * Math.pow(20000 / 20, (fVal - 50) / 50);
  }

  // Master Gain node for volume
  track.gainNode = audioCtx.createGain();
  track.gainNode.gain.value = 0.8; // default 80%

  // Stereo Panner
  track.panNode = audioCtx.createStereoPanner();
  track.panNode.pan.value = track.panVal / 100;

  // Convolution Reverb
  track.reverbConvolverNode = audioCtx.createConvolver();
  track.reverbConvolverNode.buffer = createReverbImpulseResponse(2.0, 2.0, audioCtx.sampleRate);
  
  track.reverbWetNode = audioCtx.createGain();
  track.reverbWetNode.gain.value = (track.reverbVal / 100) * 0.8;

  // Analyser node for visualizer
  track.analyser = audioCtx.createAnalyser();
  track.analyser.fftSize = 256;

  // Create Pitch Shifter
  track.pitchShifter = new PitchShifterNode(audioCtx);
  const pitchFactor = Math.pow(2, track.pitchVal / 12);
  track.pitchShifter.setPitch(pitchFactor);

  // Create Echo Delay chain
  track.echoDelayNode = audioCtx.createDelay(2.0);
  track.echoDelayNode.delayTime.value = track.echoTimeVal / 1000; // delay in seconds
  
  track.echoFeedbackNode = audioCtx.createGain();
  track.echoFeedbackNode.gain.value = (track.echoVal / 100) * 0.75;
  
  track.echoWetNode = audioCtx.createGain();
  track.echoWetNode.gain.value = (track.echoVal / 100) * 0.6;

  // Connect common chain: Bass -> Low -> Treble -> LPF -> HPF
  track.bassFilter.connect(track.lowFilter);
  track.lowFilter.connect(track.trebFilter);
  track.trebFilter.connect(track.filterLPFNode);
  track.filterLPFNode.connect(track.filterHPFNode);
  
  // Feedback loop for echo delay line
  track.echoDelayNode.connect(track.echoFeedbackNode);
  track.echoFeedbackNode.connect(track.echoDelayNode);
  
  // Delay output connects to wet gain node which routes back into fader input (gainNode)
  track.echoDelayNode.connect(track.echoWetNode);
  track.echoWetNode.connect(track.gainNode);
  
  // Dry path: gainNode -> panNode
  track.gainNode.connect(track.panNode);
  
  // Wet Reverb path: gainNode -> reverbConvolverNode -> reverbWetNode -> panNode
  track.gainNode.connect(track.reverbConvolverNode);
  track.reverbConvolverNode.connect(track.reverbWetNode);
  track.reverbWetNode.connect(track.panNode);
  
  // PanNode connects to Analyser, which connects to destination
  track.panNode.connect(track.analyser);
  track.analyser.connect(audioCtx.destination);
  
  // Dynamically configure graph to bypass PitchShifter ScriptProcessor if pitchVal is 0
  updateAudioGraphConnections(trackNum);

  // Initialize static gain nodes for all stems (main, vocals, inst) and connect them to Bass filter
  ['main', 'vocals', 'inst'].forEach(key => {
    const stem = track.stems[key];
    
    if (key !== 'inst') {
      // Append to DOM to prevent Chromium silence routing bug
      if (!stem.audio.parentNode) {
        stem.audio.style.display = 'none';
        document.body.appendChild(stem.audio);
      }
    }

    stem.gainNode = audioCtx.createGain();
    stem.gainNode.gain.value = 1.0; // default 100% volume
    stem.gainNode.connect(track.bassFilter);
  });
}

// -------------------------------------------------------------
// exertia Live UI Knobs and Sliders Calculations
// -------------------------------------------------------------

function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
  const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
  return {
    x: centerX + (radius * Math.cos(angleInRadians)),
    y: centerY + (radius * Math.sin(angleInRadians))
  };
}

function drawKnobArc(element, percent) {
  const startAngle = -135;
  const endAngle = -135 + (percent * 270);
  
  if (percent <= 0) {
    element.setAttribute('d', '');
    return;
  }
  
  const start = polarToCartesian(20, 20, 16, startAngle);
  const end = polarToCartesian(20, 20, 16, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  
  const d = [
    "M", start.x, start.y,
    "A", 16, 16, 0, largeArcFlag, 1, end.x, end.y
  ].join(" ");
  
  element.setAttribute('d', d);
}

function updateKnobUI(trackNum, param, val) {
  const knobFill = document.getElementById(`knob-${param}-${trackNum}-fill`);
  const knobPointer = document.getElementById(`knob-${param}-${trackNum}-pointer`);
  const valDisplay = document.getElementById(`val-${param}-${trackNum}`);
  
  if (!knobFill || !knobPointer) return;

  // Sync the hidden range input value so that drag physics start from the correct value
  const input = document.getElementById(`${param}-${trackNum}`);
  if (input) {
    input.value = val;
  }

  let percent = 0;
  let formatted = '';

  if (param === 'bass' || param === 'low' || param === 'treb' || param === 'pitch') {
    percent = (val - (-12)) / (12 - (-12));
    if (param === 'pitch') {
      formatted = `${val > 0 ? '+' : ''}${Math.round(val)} st`;
    } else {
      formatted = `${val > 0 ? '+' : ''}${val.toFixed(1)} dB`;
    }
  } else if (param === 'speed') {
    percent = (val - 50) / (200 - 50);
    formatted = `${Math.round(val)}%`;
  } else if (param === 'filter') {
    percent = val / 100;
    if (val === 50) {
      formatted = 'Byp';
    } else if (val < 50) {
      formatted = `LP ${Math.round((50 - val) * 2)}%`;
    } else {
      formatted = `HP ${Math.round((val - 50) * 2)}%`;
    }
  } else if (param === 'pan') {
    percent = (val - (-100)) / (100 - (-100));
    if (val === 0) {
      formatted = 'C';
    } else if (val < 0) {
      formatted = `L ${Math.abs(val)}`;
    } else {
      formatted = `R ${val}`;
    }
  } else if (param === 'echotime') {
    percent = (val - 100) / (1000 - 100);
    formatted = `${Math.round(val)} ms`;
  } else {
    // inst, voc, echo, reverb
    percent = val / 100;
    formatted = `${Math.round(val)}%`;
  }

  drawKnobArc(knobFill, percent);

  const angle = -135 + (percent * 270);
  knobPointer.setAttribute('transform', `rotate(${angle} 20 20)`);

  if (valDisplay) {
    valDisplay.textContent = formatted;
  }
}

function updateVolUI(trackNum, val) {
  const volInput = document.getElementById(`vol-${trackNum}`);
  if (volInput) {
    volInput.value = val;
  }
}

function updateProgressUI(trackNum, val) {
  const fill = document.getElementById(`progress-fill-${trackNum}`);
  if (fill) fill.style.width = `${val}%`;
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds === Infinity) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// -------------------------------------------------------------
// Playback Sync and Engine
// -------------------------------------------------------------

function performBeatSync(targetNum) {
  const sourceNum = (targetNum === 1) ? 2 : 1;
  const target = tracks[targetNum];
  const source = tracks[sourceNum];
  
  if (!target.bpmVal || !source.bpmVal) return;
  
  // 1. BPM SYNC
  const sourceCurrentBpm = source.bpmVal * source.speedVal;
  const newSpeedVal = sourceCurrentBpm / target.bpmVal;
  const speedPercentage = newSpeedVal * 100;
  
  setSpeed(targetNum, speedPercentage);
  
  // 2. PHASE SYNC
  if (target.isPlaying && source.isPlaying) {
    let targetAudio = null;
    if (target.stems.main.exists) targetAudio = target.stems.main.audio;
    else if (target.stems.vocals.exists) targetAudio = target.stems.vocals.audio;
    else if (target.stems.inst.audios.length > 0) targetAudio = target.stems.inst.audios[0].audio;
    
    let sourceAudio = null;
    if (source.stems.main.exists) sourceAudio = source.stems.main.audio;
    else if (source.stems.vocals.exists) sourceAudio = source.stems.vocals.audio;
    else if (source.stems.inst.audios.length > 0) sourceAudio = source.stems.inst.audios[0].audio;
    
    if (targetAudio && sourceAudio) {
      const beatDurationSec = 60 / sourceCurrentBpm;
      const sourceTime = sourceAudio.currentTime;
      const targetTime = targetAudio.currentTime;
      
      // Calculate beat offset phase relative to each track's beatGridOffset (beatOffset)
      const sourceGridTime = sourceTime - (source.beatOffset || 0);
      const sourcePhase = sourceGridTime % beatDurationSec;
      
      const targetGridIndex = Math.round((targetTime - (target.beatOffset || 0)) / beatDurationSec);
      let newTargetTime = (targetGridIndex * beatDurationSec + sourcePhase) + (target.beatOffset || 0);
      
      if (newTargetTime < 0) newTargetTime = 0;
      if (newTargetTime > targetAudio.duration) newTargetTime = targetAudio.duration;
      
      if (target.stems.main.exists) target.stems.main.audio.currentTime = newTargetTime;
      if (target.stems.vocals.exists) target.stems.vocals.audio.currentTime = newTargetTime;
      target.stems.inst.audios.forEach(item => item.audio.currentTime = newTargetTime);
      
      logConsole(`Sync: Aligned Track ${targetNum} phase to match Track ${sourceNum}`, 'system');
    }
  }
}

function toggleBeatSync(trackNum) {
  const track = tracks[trackNum];
  track.syncEnabled = !track.syncEnabled;
  
  const btn = document.getElementById(`btn-sync-${trackNum}`);
  if (btn) {
    if (track.syncEnabled) {
      btn.classList.add('active');
      logConsole(`Sync: Enabled on Track ${trackNum}`, 'system');
      performBeatSync(trackNum);
    } else {
      btn.classList.remove('active');
      logConsole(`Sync: Disabled on Track ${trackNum}`, 'system');
      setSpeed(trackNum, 100);
    }
  }
}

function syncStems(trackNum) {
  const track = tracks[trackNum];
  if (!track.isPlaying || track.isSynth) return;
  
  // Reference audio is the first loaded active audio element
  let refAudio = null;
  if (track.stems.main.exists) {
    refAudio = track.stems.main.audio;
  } else if (track.stems.vocals.exists) {
    refAudio = track.stems.vocals.audio;
  } else if (track.stems.inst.audios.length > 0) {
    refAudio = track.stems.inst.audios[0].audio;
  }
  
  if (!refAudio) return;
  
  const refTime = refAudio.currentTime;
  
  // Align main
  if (track.stems.main.exists && track.stems.main.audio !== refAudio) {
    if (Math.abs(track.stems.main.audio.currentTime - refTime) > 0.05) {
      track.stems.main.audio.currentTime = refTime;
    }
  }
  // Align vocals
  if (track.stems.vocals.exists && track.stems.vocals.audio !== refAudio) {
    if (Math.abs(track.stems.vocals.audio.currentTime - refTime) > 0.05) {
      track.stems.vocals.audio.currentTime = refTime;
    }
  }
  // Align all instrumental tracks
  track.stems.inst.audios.forEach(item => {
    if (item.audio !== refAudio) {
      if (Math.abs(item.audio.currentTime - refTime) > 0.05) {
        item.audio.currentTime = refTime;
      }
    }
  });
}

function handleTrackProgress(trackNum, forceUpdate = false) {
  const track = tracks[trackNum];
  if ((!track.isPlaying && !forceUpdate) || track.isSynth) return;

  let refAudio = null;
  if (track.stems.main.exists) {
    refAudio = track.stems.main.audio;
  } else if (track.stems.vocals.exists) {
    refAudio = track.stems.vocals.audio;
  } else if (track.stems.inst.audios.length > 0) {
    refAudio = track.stems.inst.audios[0].audio;
  }
  
  if (!refAudio) return;

  const current = refAudio.currentTime;
  const duration = refAudio.duration || 0;
  const percent = duration > 0 ? (current / duration) * 100 : 0;
  
  updateProgressUI(trackNum, percent);
  document.getElementById(`time-current-${trackNum}`).textContent = formatTime(current);
  
  syncStems(trackNum);
}

// -------------------------------------------------------------
// Quantize Engine — Snap-to-beat helpers
// -------------------------------------------------------------

/**
 * Returns the reference HTMLAudioElement for a given track (first valid stem).
 */
function getRefAudio(trackNum) {
  const track = tracks[trackNum];
  if (track.stems.main.exists) return track.stems.main.audio;
  if (track.stems.vocals.exists) return track.stems.vocals.audio;
  if (track.stems.inst.audios.length > 0) return track.stems.inst.audios[0].audio;
  return null;
}

/**
 * Returns the number of seconds per beat for a track.
 */
function getSecondsPerBeat(trackNum) {
  const bpm = tracks[trackNum].bpmVal || 120;
  return 60.0 / bpm;
}

/**
 * Snaps a given time (seconds) to the nearest beat grid boundary.
 * Uses the track's beatOffset for phase alignment.
 * @param {number} trackNum
 * @param {number} time — the raw time in seconds
 * @param {string} mode — 'nearest' | 'next' | 'prev'
 * @returns {number} the snapped time in seconds
 */
function snapTimeToBeat(trackNum, time, mode = 'nearest') {
  const track = tracks[trackNum];
  const spb = getSecondsPerBeat(trackNum);
  const offset = track.beatOffset || 0;

  // How many beats (fractional) since the beat offset?
  const beatsElapsed = (time - offset) / spb;

  let snappedBeat;
  if (mode === 'next') {
    snappedBeat = Math.ceil(beatsElapsed + 0.001); // tiny epsilon to avoid snapping to current if exactly on beat
  } else if (mode === 'prev') {
    snappedBeat = Math.floor(beatsElapsed);
  } else {
    snappedBeat = Math.round(beatsElapsed);
  }

  return Math.max(0, offset + snappedBeat * spb);
}

/**
 * Returns the time in seconds until the next beat for a playing track.
 * If the track is not playing, returns 0.
 */
function getTimeUntilNextBeat(trackNum) {
  const refAudio = getRefAudio(trackNum);
  if (!refAudio || !tracks[trackNum].isPlaying) return 0;

  const currentTime = refAudio.currentTime;
  const nextBeatTime = snapTimeToBeat(trackNum, currentTime, 'next');
  return Math.max(0, (nextBeatTime - currentTime) / (tracks[trackNum].speedVal || 1.0));
}

/**
 * Schedules an action to execute on the next beat if quantize is enabled.
 * If quantize is off, the action runs immediately.
 * @param {number} trackNum — the track whose beat grid to snap to
 * @param {Function} action — the function to call when the beat arrives
 * @param {string} label — description for logging
 */
function quantizeAction(trackNum, action, label = 'action') {
  const track = tracks[trackNum];

  // Cancel any already-pending quantize timer
  if (track._quantizePendingTimer) {
    clearTimeout(track._quantizePendingTimer);
    track._quantizePendingTimer = null;
  }

  if (!track.quantizeEnabled || !track.isPlaying) {
    // No quantize or track not playing → run immediately
    action();
    return;
  }

  const delayMs = getTimeUntilNextBeat(trackNum) * 1000;

  if (delayMs < 15) {
    // Already on or very close to a beat → run immediately
    action();
    return;
  }

  logConsole(`Quantize: "${label}" scheduled in ${delayMs.toFixed(0)}ms (Track ${trackNum})`, 'system');

  track._quantizePendingTimer = setTimeout(() => {
    track._quantizePendingTimer = null;
    action();
  }, delayMs);
}

function playTrack(trackNum) {
  initAudio(trackNum);
  const track = tracks[trackNum];
  
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // Handle master track assignment
  const otherNum = (trackNum === 1) ? 2 : 1;
  if (!tracks[otherNum].isPlaying) {
    masterTrackNum = trackNum;
    logConsole(`Sync: Track ${trackNum} is now MASTER`, 'system');
  }

  let hasValidStems = false;
  if (track.stems.main.exists || track.stems.vocals.exists || track.stems.inst.exists) {
    hasValidStems = true;
  }

  if (hasValidStems) {
    track.isPlaying = true;
    
    // If sync is enabled, lock tempo and phase
    if (track.syncEnabled) {
      performBeatSync(trackNum);
    }
    
    // Play static stems
    if (track.stems.main.exists) {
      track.stems.main.audio.preservesPitch = true;
      track.stems.main.audio.playbackRate = track.speedVal;
      track.stems.main.audio.play().catch(err => {
        logConsole(`Err: Cannot play main on track ${trackNum}: ${err.message}`, 'err');
      });
    }
    if (track.stems.vocals.exists) {
      track.stems.vocals.audio.preservesPitch = true;
      track.stems.vocals.audio.playbackRate = track.speedVal;
      track.stems.vocals.audio.play().catch(err => {
        logConsole(`Err: Cannot play vocals on track ${trackNum}: ${err.message}`, 'err');
      });
    }
    // Play dynamic instrumental stems
    track.stems.inst.audios.forEach(item => {
      item.audio.preservesPitch = true;
      item.audio.playbackRate = track.speedVal;
      item.audio.play().catch(err => {
        logConsole(`Err: Cannot play ${item.file} on track ${trackNum}: ${err.message}`, 'err');
      });
    });

    document.getElementById(`btn-play-${trackNum}`).classList.add('playing');
    document.getElementById(`btn-play-${trackNum}`).textContent = 'PAUSE';
    sendSerialMessage(`T${trackNum}:PLAYING:1`);
  } else {
    // Play electronic beats fallback / demo mode
    track.isPlaying = true;
    startSynthDemo(trackNum);
    document.getElementById(`btn-play-${trackNum}`).classList.add('playing');
    document.getElementById(`btn-play-${trackNum}`).textContent = 'PAUSE';
    sendSerialMessage(`T${trackNum}:PLAYING:1`);
    logConsole(`Info: Start Synth Demo for Track ${trackNum}`, 'system');
  }

  if (track.metronomeOn) {
    startMetronome(trackNum);
  }

  // Flash play button on screen
  const btn = document.getElementById(`btn-play-${trackNum}`);
  if (btn) {
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 50);
  }
}

function pauseTrack(trackNum) {
  const track = tracks[trackNum];
  track.isPlaying = false;
  document.getElementById(`btn-play-${trackNum}`).classList.remove('playing');
  document.getElementById(`btn-play-${trackNum}`).textContent = 'PLAY';
  sendSerialMessage(`T${trackNum}:PLAYING:0`);
  
  // Update Master track assignment if paused track was Master
  const otherNum = (trackNum === 1) ? 2 : 1;
  if (masterTrackNum === trackNum && tracks[otherNum].isPlaying) {
    masterTrackNum = otherNum;
    logConsole(`Sync: Track ${otherNum} is now MASTER (previous paused)`, 'system');
  }
  
  if (track.isSynth) {
    stopSynthDemo(trackNum);
  } else {
    if (track.stems.main.exists) track.stems.main.audio.pause();
    if (track.stems.vocals.exists) track.stems.vocals.audio.pause();
    track.stems.inst.audios.forEach(item => item.audio.pause());
  }
  if (track.metronomeOn) {
    stopMetronome(trackNum);
  }
  logConsole(`Info: Pause Track ${trackNum}`, 'system');

  // Flash play button on screen when pausing
  const btn = document.getElementById(`btn-play-${trackNum}`);
  if (btn) {
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 50);
  }
}

function togglePlayTrack(trackNum) {
  const track = tracks[trackNum];
  if (track.isPlaying) {
    pauseTrack(trackNum);
  } else {
    // Quantize: if Q is on and the OTHER track is playing, wait for next beat
    const otherNum = (trackNum === 1) ? 2 : 1;
    const otherTrack = tracks[otherNum];
    if (track.quantizeEnabled && otherTrack.isPlaying) {
      quantizeAction(otherNum, () => playTrack(trackNum), `Play Track ${trackNum}`);
    } else {
      playTrack(trackNum);
    }
  }
}

function stopTrack(trackNum) {
  const track = tracks[trackNum];
  track.isPlaying = false;
  document.getElementById(`btn-play-${trackNum}`).classList.remove('playing');
  document.getElementById(`btn-play-${trackNum}`).textContent = 'PLAY';
  sendSerialMessage(`T${trackNum}:PLAYING:0`);
  
  // Update Master track assignment if stopped track was Master
  const otherNum = (trackNum === 1) ? 2 : 1;
  if (masterTrackNum === trackNum && tracks[otherNum].isPlaying) {
    masterTrackNum = otherNum;
    logConsole(`Sync: Track ${otherNum} is now MASTER (previous stopped)`, 'system');
  }
  
  if (track.isSynth) {
    stopSynthDemo(trackNum);
    updateProgressUI(trackNum, 0);
    document.getElementById(`time-current-${trackNum}`).textContent = '0:00';
  } else {
    if (track.stems.main.exists) {
      track.stems.main.audio.pause();
      track.stems.main.audio.currentTime = 0;
    }
    if (track.stems.vocals.exists) {
      track.stems.vocals.audio.pause();
      track.stems.vocals.audio.currentTime = 0;
    }
    track.stems.inst.audios.forEach(item => {
      item.audio.pause();
      item.audio.currentTime = 0;
    });
    updateProgressUI(trackNum, 0);
    document.getElementById(`time-current-${trackNum}`).textContent = '0:00';
  }
  if (track.metronomeOn) {
    stopMetronome(trackNum);
  }
  logConsole(`Info: Stop Track ${trackNum}`, 'system');

  // Flash stop button on screen
  const btn = document.getElementById(`btn-stop-${trackNum}`);
  if (btn) {
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 50);
  }
}

function setVolume(trackNum, value) {
  initAudio(trackNum);
  const track = tracks[trackNum];
  value = Math.max(0, Math.min(100, value));
  
  const normalized = value / 100;
  if (track.gainNode) {
    track.gainNode.gain.setValueAtTime(normalized, audioCtx.currentTime);
  }
  updateVolUI(trackNum, value);
}

function setEQ(trackNum, param, val) {
  initAudio(trackNum);
  const track = tracks[trackNum];
  let filter = null;
  
  switch(param) {
    case 'bass': filter = track.bassFilter; break;
    case 'low': filter = track.lowFilter; break;
    case 'treb': filter = track.trebFilter; break;
  }
  
  if (filter) {
    filter.gain.setValueAtTime(val, audioCtx.currentTime);
    updateKnobUI(trackNum, param, val);
  }
}

function setStemVolume(trackNum, stemKey, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  const normalized = value / 100;
  
  if (stemKey === 'inst') {
    if (track.stems.inst.gainNode) {
      track.stems.inst.gainNode.gain.setValueAtTime(normalized, audioCtx.currentTime);
    }
    updateKnobUI(trackNum, 'inst', value);
  } else {
    // Static stems (main or vocals)
    const stem = track.stems[stemKey];
    if (stem.gainNode) {
      stem.gainNode.gain.setValueAtTime(normalized, audioCtx.currentTime);
    }
    const paramDisplay = stemKey === 'main' ? 'main' : 'voc';
    updateKnobUI(trackNum, paramDisplay, value);
  }
}

function setPitch(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  
  // Snap very small values (close to 0) to exactly 0 (helps with analog noise and visual center snapping)
  if (Math.abs(value) < 0.05) {
    value = 0;
  }
  
  const wasPitchActive = (track.pitchVal !== 0);
  track.pitchVal = value; // semitones, -12 to 12
  
  const pitchFactor = Math.pow(2, value / 12);
  if (track.pitchShifter) {
    track.pitchShifter.setPitch(pitchFactor);
  }
  
  const isPitchActive = (value !== 0);
  if (wasPitchActive !== isPitchActive) {
    updateAudioGraphConnections(trackNum);
  }
  
  updateKnobUI(trackNum, 'pitch', value);
}

function setSpeed(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.speedVal = value / 100; // factor, e.g. 0.5 to 2.0
  
  // Set preservesPitch to true to keep key constant while speed changes
  if (track.stems.main.exists) {
    track.stems.main.audio.preservesPitch = true;
    track.stems.main.audio.playbackRate = track.speedVal;
  }
  if (track.stems.vocals.exists) {
    track.stems.vocals.audio.preservesPitch = true;
    track.stems.vocals.audio.playbackRate = track.speedVal;
  }
  track.stems.inst.audios.forEach(item => {
    item.audio.preservesPitch = true;
    item.audio.playbackRate = track.speedVal;
  });
  
  updateKnobUI(trackNum, 'speed', value);
  
  if (track.bpmVal) {
    const bpmInput = document.getElementById(`bpm-${trackNum}`);
    if (bpmInput) {
      // If speed is 100%, show base BPM exactly, otherwise calculate effective BPM
      let effectiveBPM = (Math.abs(track.speedVal - 1.0) < 0.001) ? track.bpmVal : (track.bpmVal * track.speedVal);
      bpmInput.value = Math.round(effectiveBPM);
    }
  }

  // Restart metronome if active to match the new speed
  if (track.metronomeOn) {
    startMetronome(trackNum);
  }

  // If the other track is synced to this one, match its tempo speed
  const otherNum = (trackNum === 1) ? 2 : 1;
  const otherTrack = tracks[otherNum];
  if (otherTrack.syncEnabled && otherTrack.bpmVal) {
    const targetBpm = (track.bpmVal * track.speedVal);
    const newOtherSpeedVal = targetBpm / otherTrack.bpmVal;
    
    // Only update if difference is significant to avoid rounding loop updates
    if (Math.abs(otherTrack.speedVal - newOtherSpeedVal) > 0.0001) {
      setSpeed(otherNum, newOtherSpeedVal * 100);
    }
  }
}

function setEcho(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.echoVal = value; // 0 to 100
  
  const feedback = (value / 100) * 0.75;
  const wet = (value / 100) * 0.6;
  
  if (track.echoFeedbackNode) {
    track.echoFeedbackNode.gain.setValueAtTime(feedback, audioCtx.currentTime);
  }
  if (track.echoWetNode) {
    track.echoWetNode.gain.setValueAtTime(wet, audioCtx.currentTime);
  }
  
  updateKnobUI(trackNum, 'echo', value);
}

function setFilter(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.filterVal = value;
  
  if (value === 50) {
    if (track.filterLPFNode) track.filterLPFNode.frequency.setValueAtTime(22000, audioCtx.currentTime);
    if (track.filterHPFNode) track.filterHPFNode.frequency.setValueAtTime(20, audioCtx.currentTime);
  } else if (value < 50) {
    const pct = value / 50;
    const freq = 20 * Math.pow(22000 / 20, pct);
    if (track.filterLPFNode) track.filterLPFNode.frequency.setValueAtTime(freq, audioCtx.currentTime);
    if (track.filterHPFNode) track.filterHPFNode.frequency.setValueAtTime(20, audioCtx.currentTime);
  } else {
    const pct = (value - 50) / 50;
    const freq = 20 * Math.pow(20000 / 20, pct);
    if (track.filterLPFNode) track.filterLPFNode.frequency.setValueAtTime(22000, audioCtx.currentTime);
    if (track.filterHPFNode) track.filterHPFNode.frequency.setValueAtTime(freq, audioCtx.currentTime);
  }
  
  updateKnobUI(trackNum, 'filter', value);
}

function setPan(trackNum, value) {
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.panVal = value;
  if (track.panNode) {
    track.panNode.pan.setValueAtTime(value / 100, audioCtx.currentTime);
  }
  updateKnobUI(trackNum, 'pan', value);
}

function setReverb(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.reverbVal = value;
  if (track.reverbWetNode) {
    track.reverbWetNode.gain.setValueAtTime((value / 100) * 0.8, audioCtx.currentTime);
  }
  updateKnobUI(trackNum, 'reverb', value);
}

function setEchoTime(trackNum, value) {
  if (tracks[trackNum].isSynth) return;
  initAudio(trackNum);
  const track = tracks[trackNum];
  track.echoTimeVal = value;
  if (track.echoDelayNode) {
    track.echoDelayNode.delayTime.setValueAtTime(value / 1000, audioCtx.currentTime);
  }
  updateKnobUI(trackNum, 'echotime', value);
}

function startMetronome(trackNum) {
  stopMetronome(trackNum);
  const track = tracks[trackNum];
  if (!track.metronomeOn) return;
  
  initAudio(trackNum);
  
  let nextNoteTime = audioCtx.currentTime;
  let beatCount = 0;
  
  track.metronomeIntervalId = setInterval(() => {
    const scheduleAheadTime = 0.1; // Schedule 100ms in advance
    const bpm = track.bpmVal || 120;
    const speed = track.speedVal || 1.0;
    
    let beatDuration = 60 / bpm;
    if (track.bpmDivVal === '1/2') {
      beatDuration = beatDuration / 2;
    } else if (track.bpmDivVal === '1/4') {
      beatDuration = beatDuration / 4;
    }
    
    // Scale by track speed factor
    beatDuration = beatDuration / speed;
    
    while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
      const isDownbeat = (beatCount % 4 === 0);
      
      // Metronome clicks run when track is playing
      if (track.isPlaying) {
        try {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.connect(gain).connect(audioCtx.destination);
          
          osc.frequency.setValueAtTime(isDownbeat ? 1200 : 800, nextNoteTime);
          gain.gain.setValueAtTime(0.2, nextNoteTime); // Full, clear volume bypass
          gain.gain.exponentialRampToValueAtTime(0.001, nextNoteTime + 0.04);
          
          osc.start(nextNoteTime);
          osc.stop(nextNoteTime + 0.05);
        } catch(e) {}
      }
      
      nextNoteTime += beatDuration;
      beatCount++;
    }
  }, 40); // Checked every 40ms
}

function stopMetronome(trackNum) {
  const track = tracks[trackNum];
  if (track.metronomeIntervalId) {
    clearInterval(track.metronomeIntervalId);
    track.metronomeIntervalId = null;
  }
}

function setBPM(trackNum, val) {
  const track = tracks[trackNum];
  val = Math.max(20, Math.min(300, val));
  
  // The value is the effective BPM; set the base BPM accordingly
  const speed = track.speedVal || 1.0;
  track.bpmVal = val / speed;
  
  const input = document.getElementById(`bpm-${trackNum}`);
  if (input) input.value = val;
  
  if (track.metronomeOn) {
    startMetronome(trackNum);
  }

  // Update BPM compatibility indicators in songs list
  if (typeof updateBpmCompatIndicators === 'function') {
    updateBpmCompatIndicators();
  }
}

function setBPMDiv(trackNum, val) {
  const track = tracks[trackNum];
  track.bpmDivVal = val;
  
  const select = document.getElementById(`bpmdiv-${trackNum}`);
  if (select) select.value = val;
  
  if (track.metronomeOn) {
    startMetronome(trackNum);
  }
}

function toggleMetronome(trackNum) {
  const track = tracks[trackNum];
  track.metronomeOn = !track.metronomeOn;
  
  const btn = document.getElementById(`btn-metro-${trackNum}`);
  if (btn) {
    if (track.metronomeOn) {
      btn.classList.add('active');
      startMetronome(trackNum);
      logConsole(`Metronome Channel ${trackNum} ACTIVE (BPM: ${track.bpmVal}, Division: ${track.bpmDivVal})`, 'system');
    } else {
      btn.classList.remove('active');
      stopMetronome(trackNum);
      logConsole(`Metronome Channel ${trackNum} DEACTIVATED`, 'system');
    }
  }
}

function seekTrack(trackNum, percent, forceNoAudioSeek = false) {
  const track = tracks[trackNum];
  
  let duration = 180; // default 3 min simulated duration if empty
  let hasAudio = false;

  if (!track.isSynth) {
    if (track.stems.main.exists && track.stems.main.audio.duration) {
      duration = track.stems.main.audio.duration;
      hasAudio = true;
    } else if (track.stems.vocals.exists && track.stems.vocals.audio.duration) {
      duration = track.stems.vocals.audio.duration;
      hasAudio = true;
    } else if (track.stems.inst.audios.length > 0 && track.stems.inst.audios[0].audio.duration) {
      duration = track.stems.inst.audios[0].audio.duration;
      hasAudio = true;
    }
  }

  const time = (percent / 100) * duration;

  if (hasAudio && !track.isSynth && !forceNoAudioSeek) {
    initAudio(trackNum);
    if (track.stems.main.exists) track.stems.main.audio.currentTime = time;
    if (track.stems.vocals.exists) track.stems.vocals.audio.currentTime = time;
    track.stems.inst.audios.forEach(item => {
      item.audio.currentTime = time;
    });
    
    // Snap phase back to sync grid if sync is enabled
    if (tracks[1].syncEnabled) performBeatSync(1);
    if (tracks[2].syncEnabled) performBeatSync(2);
  }

  updateProgressUI(trackNum, percent);
  document.getElementById(`time-current-${trackNum}`).textContent = formatTime(time);
  if (!hasAudio && !track.isSynth) {
    document.getElementById(`time-duration-${trackNum}`).textContent = formatTime(duration);
  }
}

// -------------------------------------------------------------
// Synthesizer Beat Generator (Demo Mode)
// -------------------------------------------------------------

function startSynthDemo(trackNum) {
  if (!audioCtx) return;
  const track = tracks[trackNum];
  if (track.synthTimer) {
    clearInterval(track.synthTimer);
    track.synthTimer = null;
  }
  
  track.isSynth = true;
  document.getElementById(`track-name-${trackNum}`).textContent = `TEST AUDIO ${trackNum}`;
  document.getElementById(`time-duration-${trackNum}`).textContent = '--:--';
  
  if (track.fallbackWaveform) {
    track.staticWaveform = track.fallbackWaveform;
  } else {
    track.staticWaveform = Array.from({length: 2000}, () => Math.random() * 0.5 + 0.25);
  }
  
  ['inst', 'main', 'vocals'].forEach(key => {
    const indicator = document.getElementById(`ind-${key}-${trackNum}`);
    if (indicator) indicator.classList.remove('present');
    const cellId = key === 'main' ? 'main' : key === 'vocals' ? 'voc' : 'inst';
    const cell = document.getElementById(`cell-${cellId}-${trackNum}`);
    if (cell) cell.classList.add('disabled');
  });

  ['filter', 'pitch', 'speed', 'echo', 'reverb', 'echotime'].forEach(key => {
    const cell = document.getElementById(`cell-${key}-${trackNum}`);
    if (cell) cell.classList.add('disabled');
  });

  const bpmInput = document.getElementById(`bpm-${trackNum}`);
  if (bpmInput && bpmInput.parentElement && bpmInput.parentElement.parentElement) {
    bpmInput.parentElement.parentElement.classList.add('disabled-control');
  }
  
  const bpmDiv = document.getElementById(`bpmdiv-${trackNum}`);
  if (bpmDiv && bpmDiv.parentElement) {
    bpmDiv.parentElement.classList.add('disabled-control');
  }
  
  const metroBtn = document.getElementById(`btn-metro-${trackNum}`);
  if (metroBtn && metroBtn.parentElement) {
    metroBtn.parentElement.classList.add('disabled-control');
  }

  const syncBtn = document.getElementById(`btn-sync-${trackNum}`);
  if (syncBtn) syncBtn.classList.add('disabled-control');
  
  const quantizeBtn = document.getElementById(`btn-quantize-${trackNum}`);
  if (quantizeBtn) quantizeBtn.classList.add('disabled-control');

  if (!track.fallbackAudio) {
    track.fallbackAudio = new Audio('assets/audio/test-audio.mp3');
    track.fallbackAudio.loop = true;
    const source = audioCtx.createMediaElementSource(track.fallbackAudio);
    source.connect(track.gainNode);
    
    // Analyze BPM, Offset, and Waveform for the test audio
    fetch('assets/audio/test-audio.mp3')
      .then(res => res.arrayBuffer())
      .then(ab => audioCtx.decodeAudioData(ab))
      .then(buffer => {
        const detectedBpm = estimateBPM(buffer);
        const detectedOffset = estimateBeatOffset(buffer, detectedBpm);
        
        track.fallbackBpm = detectedBpm;
        track.fallbackOffset = detectedOffset;
        
        if (track.isSynth) {
          track.beatOffset = detectedOffset;
          setBPM(trackNum, detectedBpm);
          logConsole(`BPM: Analyzed test audio -> ${detectedBpm} BPM`, 'system');
        }
        
        const numPeaks = 2000;
        const rawData = buffer.getChannelData(0);
        const L = rawData.length;
        const SR = buffer.sampleRate;
        const duration = buffer.duration;
        const peaks = new Float32Array(numPeaks);
        
        for (let i = 0; i < numPeaks; i++) {
          const startTime = (i / numPeaks) * duration;
          const endTime = ((i + 1) / numPeaks) * duration;
          const startIdx = Math.floor(startTime * SR);
          const endIdx = Math.min(L, Math.floor(endTime * SR));
          if (endIdx > startIdx) {
            let sum = 0;
            for (let j = startIdx; j < endIdx; j++) {
              sum += Math.abs(rawData[j]);
            }
            peaks[i] = sum / (endIdx - startIdx);
          }
        }
        const maxVal = Math.max(...peaks);
        track.fallbackWaveform = Array.from(peaks).map(p => p / (maxVal || 1));
        
        if (track.isSynth) {
          track.staticWaveform = track.fallbackWaveform;
        }
      })
      .catch(e => console.error('Failed to analyze test audio:', e));
    
    track.fallbackAudio.addEventListener('timeupdate', () => {
      if (!track.isSynth) return;
      const dur = track.fallbackAudio.duration;
      const cur = track.fallbackAudio.currentTime;
      if (dur > 0) {
        const pct = (cur / dur) * 100;
        updateProgressUI(trackNum, pct);
        document.getElementById(`time-current-${trackNum}`).textContent = formatTime(cur);
        document.getElementById(`time-duration-${trackNum}`).textContent = formatTime(dur);
      }
    });
  } else {
    // If already analyzed, re-apply the cached BPM immediately
    if (track.fallbackBpm) {
      track.beatOffset = track.fallbackOffset;
      setBPM(trackNum, track.fallbackBpm);
    }
  }
  
  track.fallbackAudio.playbackRate = track.speedVal || 1.0;
  track.fallbackAudio.play().catch(e => logConsole(`Err: ${e.message}`, 'err'));
}

function stopSynthDemo(trackNum) {
  const track = tracks[trackNum];
  if (track.synthTimer) {
    clearInterval(track.synthTimer);
    track.synthTimer = null;
  }
  
  if (track.fallbackAudio) {
    track.fallbackAudio.pause();
    track.fallbackAudio.currentTime = 0;
  }
  
  track.isSynth = false;
  track.staticWaveform = null;
  track.synthStep = 0;
  
  ['inst', 'main', 'vocals'].forEach(key => {
    const indicator = document.getElementById(`ind-${key}-${trackNum}`);
    if (indicator) indicator.className = 'stem-indicator';
    const cellId = key === 'main' ? 'main' : key === 'vocals' ? 'voc' : 'inst';
    const cell = document.getElementById(`cell-${cellId}-${trackNum}`);
    if (cell) cell.classList.add('disabled');
  });
}

function playSynthStep(trackNum, step) {
  const track = tracks[trackNum];
  const time = audioCtx.currentTime;
  
  if (track.stems.inst.gainNode && step % 4 === 0) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain).connect(track.stems.inst.gainNode);
    osc.frequency.setValueAtTime(120, time);
    osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.15);
    gain.gain.setValueAtTime(1.0, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.15);
    osc.start(time);
    osc.stop(time + 0.16);
  }

  // Generate Sound on MAIN Stem (Rhythmic melody)
  if (track.stems.main.gainNode && step % 2 === 1) {
    const notes = [65.4, 73.4, 82.4, 98.0, 110];
    const note = notes[(step + trackNum) % notes.length];
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain).connect(track.stems.main.gainNode);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(note, time);
    gain.gain.setValueAtTime(0.25, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.2);
    osc.start(time);
    osc.stop(time + 0.22);
  }

  // Generate Sound on VOCALS Stem (High synth melody notes)
  if (track.stems.vocals.gainNode && (step % 4 === 2 || step % 8 === 6)) {
    const notes = [329.6, 392, 523.3, 659.3];
    const note = notes[(step * trackNum) % notes.length];
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain).connect(track.stems.vocals.gainNode);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(note, time);
    gain.gain.setValueAtTime(0.15, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.18);
    osc.start(time);
    osc.stop(time + 0.2);
  }
}

// -------------------------------------------------------------
// Interactive UI Listeners (Sliders, Drag Knobs, Drag & Drop)
// -------------------------------------------------------------

function setupUIListeners() {
  [1, 2].forEach(trackNum => {
    // Play button
    document.getElementById(`btn-play-${trackNum}`).addEventListener('click', () => {
      togglePlayTrack(trackNum);
    });

    // Stop button
    document.getElementById(`btn-stop-${trackNum}`).addEventListener('click', () => {
      stopTrack(trackNum);
    });

    // Beat Sync button
    const syncBtn = document.getElementById(`btn-sync-${trackNum}`);
    if (syncBtn) {
      syncBtn.addEventListener('click', () => {
        toggleBeatSync(trackNum);
      });
      
      syncBtn.addEventListener('mouseenter', () => {
        const otherNum = (trackNum === 1) ? 2 : 1;
        const target = tracks[trackNum];
        const source = tracks[otherNum];
        
        let targetSpeedPercentage = 100;
        let targetBPM = target.bpmVal;

        if (target.syncEnabled) {
          // Preview turning OFF (resets to 100%)
          targetSpeedPercentage = 100;
          targetBPM = target.bpmVal;
        } else if (target.bpmVal && source.bpmVal) {
          // Preview turning ON (matches other track)
          const sourceCurrentBpm = source.bpmVal * (source.speedVal || 1.0);
          const newSpeedVal = sourceCurrentBpm / target.bpmVal;
          targetSpeedPercentage = newSpeedVal * 100;
          targetBPM = sourceCurrentBpm;
        } else {
          return;
        }
        
        updateKnobUI(trackNum, 'speed', targetSpeedPercentage);
        
        const speedSpan = document.getElementById(`val-speed-${trackNum}`);
        if (speedSpan) {
          speedSpan.style.color = '#ffff00';
          speedSpan.style.textShadow = '0 0 5px #ffff00';
        }
        
        const bpmInput = document.getElementById(`bpm-${trackNum}`);
        if (bpmInput) {
          bpmInput.dataset.originalValue = bpmInput.value;
          bpmInput.value = Math.round(targetBPM);
          bpmInput.style.color = '#ffff00';
          bpmInput.style.textShadow = '0 0 5px #ffff00';
          bpmInput.style.borderColor = '#ffff00';
        }
      });
      
      syncBtn.addEventListener('mouseleave', () => {
        const target = tracks[trackNum];
        updateKnobUI(trackNum, 'speed', (target.speedVal || 1.0) * 100);
        
        const speedSpan = document.getElementById(`val-speed-${trackNum}`);
        if (speedSpan) {
          speedSpan.style.color = '';
          speedSpan.style.textShadow = '';
        }
        
        const bpmInput = document.getElementById(`bpm-${trackNum}`);
        if (bpmInput && bpmInput.dataset.originalValue !== undefined) {
          bpmInput.value = bpmInput.dataset.originalValue;
          bpmInput.style.color = '';
          bpmInput.style.textShadow = '';
          bpmInput.style.borderColor = '';
          delete bpmInput.dataset.originalValue;
        }
      });
    }

    // Quantize button
    const quantizeBtn = document.getElementById(`btn-quantize-${trackNum}`);
    if (quantizeBtn) {
      quantizeBtn.addEventListener('click', () => {
        tracks[trackNum].quantizeEnabled = !tracks[trackNum].quantizeEnabled;
        if (tracks[trackNum].quantizeEnabled) {
          quantizeBtn.classList.add('active');
        } else {
          quantizeBtn.classList.remove('active');
        }
      });
    }

    // Fallback LOAD DIR button (wrapped in safe check)
    const loadBtn = document.getElementById(`btn-load-${trackNum}`);
    if (loadBtn) {
      loadBtn.addEventListener('click', () => {
        ipcRenderer.send('open-directory-dialog', trackNum);
      });
    }

    // Keyboard Volume Input change
    const volInput = document.getElementById(`vol-${trackNum}`);
    volInput.addEventListener('change', (e) => {
      let val = parseInt(e.target.value);
      if (isNaN(val)) val = 80;
      setVolume(trackNum, val);
    });
    volInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        volInput.blur();
      }
    });

    // Progress bar scrubbing (click and drag)
    const progHit = document.getElementById(`prog-hit-${trackNum}`);
    const progContainer = document.getElementById(`prog-container-${trackNum}`);
    let isScrubbing = false;

    function handleScrub(clientX) {
      const rect = progHit.getBoundingClientRect();
      const clickX = clientX - rect.left;
      const percent = Math.max(0, Math.min(100, Math.round((clickX / rect.width) * 100)));
      seekTrack(trackNum, percent);
    }

    progHit.addEventListener('mousedown', (e) => {
      isScrubbing = true;
      if (progContainer) progContainer.classList.add('scrubbing');
      handleScrub(e.clientX);
      
      window.addEventListener('mousemove', onScrubMove);
      window.addEventListener('mouseup', onScrubUp);
      e.preventDefault(); // Prevent text highlight/selection
    });

    function onScrubMove(e) {
      if (isScrubbing) {
        handleScrub(e.clientX);
      }
    }

    function onScrubUp() {
      if (isScrubbing) {
        isScrubbing = false;
        if (progContainer) progContainer.classList.remove('scrubbing');
        window.removeEventListener('mousemove', onScrubMove);
        window.removeEventListener('mouseup', onScrubUp);
      }
    }

    // Visualizer Mode Buttons
    ['spectrum', 'waveform'].forEach(mode => {
      const btn = document.getElementById(`btn-vis-${mode}-${trackNum}`);
      if (btn) {
        btn.addEventListener('click', () => {
          tracks[trackNum].visMode = mode;
          
          // Toggle active class among buttons in this track's header
          ['spectrum', 'waveform'].forEach(m => {
            const b = document.getElementById(`btn-vis-${m}-${trackNum}`);
            if (b) {
              if (m === mode) b.classList.add('active');
              else b.classList.remove('active');
            }
          });
        });
      }
    });

    // EQ Knobs input listeners (Bass, Lows, Treble)
    ['bass', 'low', 'treb'].forEach(param => {
      const slider = document.getElementById(`${param}-${trackNum}`);
      slider.addEventListener('input', (e) => {
        setEQ(trackNum, param, parseFloat(e.target.value));
      });
      updateKnobUI(trackNum, param, 0);
    });

    // Stems EQ Knobs (Inst, Vocals)
    const stemParams = {
      'inst': 'inst',
      'voc': 'vocals'
    };

    Object.keys(stemParams).forEach(param => {
      const stemKey = stemParams[param];
      const slider = document.getElementById(`${param}-${trackNum}`);
      slider.addEventListener('input', (e) => {
        setStemVolume(trackNum, stemKey, parseInt(e.target.value));
      });
      updateKnobUI(trackNum, param, 100);
    });

    // Pitch, Speed, Echo knobs input listeners
    const pitchSlider = document.getElementById(`pitch-${trackNum}`);
    pitchSlider.addEventListener('input', (e) => {
      setPitch(trackNum, parseInt(e.target.value));
    });
    updateKnobUI(trackNum, 'pitch', 0);

    const speedSlider = document.getElementById(`speed-${trackNum}`);
    speedSlider.addEventListener('input', (e) => {
      setSpeed(trackNum, parseInt(e.target.value));
    });
    updateKnobUI(trackNum, 'speed', 100);

    const echoSlider = document.getElementById(`echo-${trackNum}`);
    echoSlider.addEventListener('input', (e) => {
      setEcho(trackNum, parseInt(e.target.value));
    });
    updateKnobUI(trackNum, 'echo', 0);

    const filterSlider = document.getElementById(`filter-${trackNum}`);
    if (filterSlider) {
      filterSlider.addEventListener('input', (e) => {
        setFilter(trackNum, parseInt(e.target.value));
      });
      updateKnobUI(trackNum, 'filter', 50);
    }

    const panSlider = document.getElementById(`pan-${trackNum}`);
    if (panSlider) {
      panSlider.addEventListener('input', (e) => {
        setPan(trackNum, parseInt(e.target.value));
      });
      updateKnobUI(trackNum, 'pan', 0);
    }

    const reverbSlider = document.getElementById(`reverb-${trackNum}`);
    if (reverbSlider) {
      reverbSlider.addEventListener('input', (e) => {
        setReverb(trackNum, parseInt(e.target.value));
      });
      updateKnobUI(trackNum, 'reverb', 0);
    }

    const echotimeSlider = document.getElementById(`echotime-${trackNum}`);
    if (echotimeSlider) {
      echotimeSlider.addEventListener('input', (e) => {
        setEchoTime(trackNum, parseInt(e.target.value));
      });
      updateKnobUI(trackNum, 'echotime', 350);
    }

    // BPM and Metronome listeners
    const bpmInput = document.getElementById(`bpm-${trackNum}`);
    if (bpmInput) {
      bpmInput.addEventListener('change', (e) => {
        let val = parseInt(e.target.value);
        if (isNaN(val)) val = 120;
        setBPM(trackNum, val);
      });
      bpmInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          bpmInput.blur();
        }
      });
    }

    const bpmdivSelect = document.getElementById(`bpmdiv-${trackNum}`);
    if (bpmdivSelect) {
      bpmdivSelect.addEventListener('change', (e) => {
        setBPMDiv(trackNum, e.target.value);
      });
    }

    const metroBtn = document.getElementById(`btn-metro-${trackNum}`);
    if (metroBtn) {
      metroBtn.addEventListener('click', () => {
        toggleMetronome(trackNum);
      });
    }

    // Register Drag & Drop Dropzone behaviors on track strips
    const trackStrip = document.getElementById(`track-${trackNum}`);
    
    trackStrip.addEventListener('dragover', (e) => {
      e.preventDefault();
      trackStrip.classList.add('dragover');
    });

    trackStrip.addEventListener('dragleave', () => {
      trackStrip.classList.remove('dragover');
    });

    trackStrip.addEventListener('drop', (e) => {
      e.preventDefault();
      trackStrip.classList.remove('dragover');
      
      if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        loadDirectoryStems(trackNum, file.path);
      } else {
        const folderName = e.dataTransfer.getData('text/plain');
        if (folderName && workingDir) {
          const fullPath = path.join(workingDir, folderName);
          loadDirectoryStems(trackNum, fullPath);
        }
      }
    });

    // Setup events for static stems (main and vocals)
    const stems = tracks[trackNum].stems;
    ['main', 'vocals'].forEach(key => {
      const stem = stems[key];
      
      stem.audio.addEventListener('timeupdate', () => {
        let firstActiveAudio = null;
        if (tracks[trackNum].stems.main.exists) firstActiveAudio = tracks[trackNum].stems.main.audio;
        else if (tracks[trackNum].stems.vocals.exists) firstActiveAudio = tracks[trackNum].stems.vocals.audio;
        else if (tracks[trackNum].stems.inst.audios.length > 0) firstActiveAudio = tracks[trackNum].stems.inst.audios[0].audio;
        
        if (firstActiveAudio === stem.audio) {
          handleTrackProgress(trackNum);
        }
      });

      stem.audio.addEventListener('durationchange', () => {
        let firstActiveAudio = null;
        if (tracks[trackNum].stems.main.exists) firstActiveAudio = tracks[trackNum].stems.main.audio;
        else if (tracks[trackNum].stems.vocals.exists) firstActiveAudio = tracks[trackNum].stems.vocals.audio;
        else if (tracks[trackNum].stems.inst.audios.length > 0) firstActiveAudio = tracks[trackNum].stems.inst.audios[0].audio;
        
        if (firstActiveAudio === stem.audio) {
          document.getElementById(`time-duration-${trackNum}`).textContent = formatTime(stem.audio.duration);
        }
      });

      stem.audio.addEventListener('ended', () => {
        let firstActiveAudio = null;
        if (tracks[trackNum].stems.main.exists) firstActiveAudio = tracks[trackNum].stems.main.audio;
        else if (tracks[trackNum].stems.vocals.exists) firstActiveAudio = tracks[trackNum].stems.vocals.audio;
        else if (tracks[trackNum].stems.inst.audios.length > 0) firstActiveAudio = tracks[trackNum].stems.inst.audios[0].audio;
        
        if (firstActiveAudio === stem.audio) {
          stopTrack(trackNum);
        }
      });
    });

    // Track tab switches
    const tabButtons = document.querySelectorAll(`.track-tab-btn[data-track="${trackNum}"]`);
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        document.getElementById(`track-content-eq-${trackNum}`).classList.remove('active');
        document.getElementById(`track-content-buttons-${trackNum}`).classList.remove('active');
        const contentLoop = document.getElementById(`track-content-loop-${trackNum}`);
        if (contentLoop) contentLoop.classList.remove('active');
        
        const targetTab = btn.getAttribute('data-tab');
        document.getElementById(`track-content-${targetTab}-${trackNum}`).classList.add('active');
      });
    });

    // Drag, Drop, and Click for track-specific sampler buttons
    for (let btnIdx = 0; btnIdx < 8; btnIdx++) {
      const cell = document.getElementById(`sound-btn-cell-${trackNum}-${btnIdx}`);
      const btn = document.getElementById(`sound-btn-${trackNum}-${btnIdx}`);
      if (!cell || !btn) continue;
      
      cell.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cell.classList.add('dragover');
      });
      
      cell.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cell.classList.remove('dragover');
      });
      
      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cell.classList.remove('dragover');
        
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          const file = files[0];
          const filePath = file.path;
          
          const ext = path.extname(filePath).toLowerCase();
          const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
          if (!audioExtensions.includes(ext)) {
            logConsole(`Err: File dropped is not a supported audio format: ${file.name}`, 'err');
            return;
          }
          
          try {
            initAudio(trackNum);
            btn.textContent = "LOADING...";
            
            const fileData = fs.readFileSync(filePath);
            const arrayBuffer = fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength);
            
            audioCtx.decodeAudioData(arrayBuffer, (audioBuffer) => {
              tracks[trackNum].soundButtons[btnIdx] = {
                path: filePath,
                name: file.name,
                buffer: audioBuffer
              };
              
              btn.textContent = file.name.toUpperCase();
              btn.classList.add('loaded');
              btn.style.color = ''; // Reset inline color
              btn.style.borderColor = ''; // Reset inline border color
              btn.title = filePath;
              
              // Also clear any hot cue for this slot
              tracks[trackNum].hotCues[btnIdx] = null;
              logConsole(`Success: Loaded sample '${file.name}' into Track ${trackNum} button ${btnIdx + 1}`, 'system');
            }, (decodeErr) => {
              btn.textContent = "DECODE ERR";
              logConsole(`Err: Decode failed for '${file.name}': ${decodeErr.message}`, 'err');
            });
          } catch (readErr) {
            btn.textContent = "READ ERR";
            logConsole(`Err: Failed to read file '${file.name}': ${readErr.message}`, 'err');
          }
        }
      });
      
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const track = tracks[trackNum];
        let refAudio = null;
        if (track.stems.main.exists) refAudio = track.stems.main.audio;
        else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
        else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
        else if (track.isSynth && track.fallbackAudio) refAudio = track.fallbackAudio;
        
        if (refAudio && refAudio.duration) {
          const cueTime = refAudio.currentTime;
          track.hotCues[btnIdx] = cueTime;
          const hotCueColors = ['#ff0055', '#ffaa00', '#ffff00', '#00ff00', '#00ffff', '#0055ff', '#aa00ff', '#ff00aa'];
          const cueColor = hotCueColors[btnIdx % hotCueColors.length];
          track.soundButtons[btnIdx] = { path: '', name: 'CUE', buffer: null };
          
          btn.textContent = `CUE ${btnIdx + 1}`;
          btn.classList.add('loaded');
          btn.style.color = cueColor; // Special color for cues
          btn.style.borderColor = cueColor; // Outline color matches the cue color
          logConsole(`Success: Set Hot Cue ${btnIdx + 1} at ${cueTime.toFixed(2)}s on Track ${trackNum}`, 'system');
        } else {
          logConsole(`Err: Cannot set cue, no audio playing on Track ${trackNum}`, 'err');
        }
      });

      btn.addEventListener('click', () => {
        const track = tracks[trackNum];
        const cueTime = track.hotCues[btnIdx];
        
        if (cueTime !== null) {
          // It's a Hot Cue
          if (track.stems.main.exists) track.stems.main.audio.currentTime = cueTime;
          if (track.stems.vocals.exists) track.stems.vocals.audio.currentTime = cueTime;
          track.stems.inst.audios.forEach(item => item.audio.currentTime = cueTime);
          if (track.isSynth && track.fallbackAudio) track.fallbackAudio.currentTime = cueTime;
          handleTrackProgress(trackNum);
          
          // Flash the button
          btn.classList.add('playing');
          setTimeout(() => btn.classList.remove('playing'), 150);
          
          // Start playback if not already playing (optional but standard for hot cues)
          if (!track.isPlaying) {
             const playBtn = document.getElementById(`btn-play-${trackNum}`);
             if (playBtn) playBtn.click();
          }
        } else {
          // It's a Sample (or empty)
          const soundData = track.soundButtons[btnIdx];
          if (soundData && soundData.buffer) {
            initAudio(trackNum);
            if (audioCtx && audioCtx.state === 'suspended') {
              audioCtx.resume();
            }
            try {
              const sourceNode = audioCtx.createBufferSource();
              sourceNode.buffer = soundData.buffer;
              
              // Connect to track's Bass filter to apply EQ, Volume, Filters, etc.
              sourceNode.connect(track.bassFilter);
              
              btn.classList.add('playing');
              sourceNode.onended = () => {
                btn.classList.remove('playing');
              };
              
              sourceNode.start(0);
            } catch (playErr) {
              logConsole(`Err: Failed to play sample: ${playErr.message}`, 'err');
            }
          } else {
            logConsole(`Info: Button ${btnIdx + 1} is empty. Drag & drop an audio file, or right-click to set a Hot Cue.`, 'system');
          }
        }
      });
    }

    // Hook up canvas scratching
    const canvas = document.getElementById(`canvas-${trackNum}`);
    if (canvas) {
      setupCanvasScratching(trackNum, canvas);
    }

    const overviewCanvas = document.getElementById(`overview-canvas-${trackNum}`);
    if (overviewCanvas) {
      overviewCanvas.addEventListener('click', (e) => {
        const rect = overviewCanvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = clickX / rect.width;
        
        const track = tracks[trackNum];
        let refAudio = null;
        if (track.stems.main.exists) refAudio = track.stems.main.audio;
        else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
        else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
        
        if (refAudio && !isNaN(refAudio.duration)) {
          const newTime = pct * refAudio.duration;
          if (track.stems.main.exists) track.stems.main.audio.currentTime = newTime;
          if (track.stems.vocals.exists) track.stems.vocals.audio.currentTime = newTime;
          track.stems.inst.audios.forEach(item => item.audio.currentTime = newTime);
          handleTrackProgress(trackNum);
          
          // Snap phase back to sync grid if sync is enabled
          if (tracks[1].syncEnabled) performBeatSync(1);
          if (tracks[2].syncEnabled) performBeatSync(2);
        }
      });
    }

    // Loop control UI bindings
    const btnAutoLoop = document.getElementById(`btn-auto-loop-${trackNum}`);
    const btnHalve = document.getElementById(`btn-loop-halve-${trackNum}`);
    const btnDouble = document.getElementById(`btn-loop-double-${trackNum}`);
    const displayLoop = document.getElementById(`loop-display-${trackNum}`);
    const btnLoopIn = document.getElementById(`btn-loop-in-${trackNum}`);
    const btnLoopOut = document.getElementById(`btn-loop-out-${trackNum}`);
    const btnLoopExit = document.getElementById(`btn-loop-exit-${trackNum}`);
    
    const loopOptions = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
    let selectedOptionIndex = 6; // default 4 BEATS
    
    function updateLoopDisplay() {
      const beats = loopOptions[selectedOptionIndex];
      tracks[trackNum].autoLoopBeats = beats;
      if (beats < 1) {
        if (beats === 0.0625) displayLoop.textContent = "1/16";
        else if (beats === 0.125) displayLoop.textContent = "1/8";
        else if (beats === 0.25) displayLoop.textContent = "1/4";
        else if (beats === 0.5) displayLoop.textContent = "1/2";
      } else {
        displayLoop.textContent = beats.toString();
      }
    }
    
    if (btnHalve && btnDouble && displayLoop) {
      btnHalve.addEventListener('click', () => {
        if (selectedOptionIndex > 0) {
          selectedOptionIndex--;
          updateLoopDisplay();
          if (tracks[trackNum].loopEnabled) {
            triggerAutoLoop(trackNum);
          }
        }
      });
      btnDouble.addEventListener('click', () => {
        if (selectedOptionIndex < loopOptions.length - 1) {
          selectedOptionIndex++;
          updateLoopDisplay();
          if (tracks[trackNum].loopEnabled) {
            triggerAutoLoop(trackNum);
          }
        }
      });
    }
    
    if (btnAutoLoop) {
      btnAutoLoop.addEventListener('click', () => {
        const track = tracks[trackNum];
        if (track.loopEnabled) {
          track.loopEnabled = false;
          track.loopStartTime = null;
          track.loopEndTime = null;
          btnAutoLoop.classList.remove('active');
          btnAutoLoop.textContent = "AUTO LOOP OFF";
          if (btnLoopIn) btnLoopIn.classList.remove('active');
          if (btnLoopOut) btnLoopOut.classList.remove('active');
        } else {
          triggerAutoLoop(trackNum);
        }
      });
    }
    
    function triggerAutoLoop(tNum) {
      const track = tracks[tNum];
      quantizeAction(tNum, () => {
        let refAudio = null;
        if (track.stems.main.exists) refAudio = track.stems.main.audio;
        else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
        else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
        
        if (!refAudio || isNaN(refAudio.duration)) return;
        
        const bpm = track.bpmVal || 120;
        const beatDuration = 60 / bpm;
        const loopDuration = track.autoLoopBeats * beatDuration;
        
        if (track.loopStartTime === null) {
          track.loopStartTime = track.quantizeEnabled 
            ? snapTimeToBeat(tNum, refAudio.currentTime, 'nearest') 
            : refAudio.currentTime;
        }
        track.loopEndTime = track.loopStartTime + loopDuration;
        
        if (track.loopEndTime > refAudio.duration) {
          track.loopEndTime = refAudio.duration;
          track.loopStartTime = Math.max(0, track.loopEndTime - loopDuration);
        }
        
        track.loopEnabled = true;
        if (btnAutoLoop) {
          btnAutoLoop.classList.add('active');
          btnAutoLoop.textContent = `AUTO LOOP ON`;
        }
        if (btnLoopIn) btnLoopIn.classList.add('active');
        if (btnLoopOut) btnLoopOut.classList.add('active');
      }, 'Auto Loop');
    }
    
    if (btnLoopIn) {
      btnLoopIn.addEventListener('click', () => {
        quantizeAction(trackNum, () => {
          const track = tracks[trackNum];
          let refAudio = null;
          if (track.stems.main.exists) refAudio = track.stems.main.audio;
          else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
          else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
          
          if (!refAudio || isNaN(refAudio.duration)) return;
          
          track.loopStartTime = track.quantizeEnabled 
            ? snapTimeToBeat(trackNum, refAudio.currentTime, 'nearest') 
            : refAudio.currentTime;
          btnLoopIn.classList.add('active');
          
          if (track.loopEndTime !== null && track.loopEndTime > track.loopStartTime) {
            track.loopEnabled = true;
            if (btnLoopOut) btnLoopOut.classList.add('active');
          }
        }, 'Loop In');
      });
    }
    
    if (btnLoopOut) {
      btnLoopOut.addEventListener('click', () => {
        quantizeAction(trackNum, () => {
          const track = tracks[trackNum];
          let refAudio = null;
          if (track.stems.main.exists) refAudio = track.stems.main.audio;
          else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
          else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
          
          if (!refAudio || isNaN(refAudio.duration)) return;
          
          if (track.loopStartTime === null) {
            track.loopStartTime = track.quantizeEnabled ? snapTimeToBeat(trackNum, 0, 'nearest') : 0;
            if (btnLoopIn) btnLoopIn.classList.add('active');
          }
          
          track.loopEndTime = track.quantizeEnabled
            ? snapTimeToBeat(trackNum, refAudio.currentTime, 'nearest')
            : refAudio.currentTime;
            
          if (track.loopEndTime <= track.loopStartTime) {
            track.loopEndTime = track.loopStartTime + 1;
          }
          
          track.loopEnabled = true;
          btnLoopOut.classList.add('active');
        }, 'Loop Out');
      });
    }
    
    if (btnLoopExit) {
      btnLoopExit.addEventListener('click', () => {
        const track = tracks[trackNum];
        track.loopEnabled = false;
        track.loopStartTime = null;
        track.loopEndTime = null;
        if (btnAutoLoop) {
          btnAutoLoop.classList.remove('active');
          btnAutoLoop.textContent = "AUTO LOOP OFF";
        }
        if (btnLoopIn) btnLoopIn.classList.remove('active');
        if (btnLoopOut) btnLoopOut.classList.remove('active');
      });
    }
  });

  // Console toggle
  const consoleHeader = document.getElementById('console-toggle');
  consoleHeader.addEventListener('click', () => {
    document.querySelector('.exertia-console').classList.toggle('collapsed');
  });


  
  // Choose working directory click
  document.getElementById('btn-set-working-dir').addEventListener('click', () => {
    ipcRenderer.send('select-working-directory');
  });

  // Resizable explorer sidebar/bottom panel logic
  const resizeHandle = document.getElementById('sidebar-resize-handle');
  const sidebar = document.querySelector('.exertia-sidebar');
  if (resizeHandle && sidebar) {
    let isResizing = false;
    
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      resizeHandle.classList.add('active');
      
      const startX = e.clientX;
      const startY = e.clientY;
      const startWidth = sidebar.clientWidth;
      const startHeight = sidebar.clientHeight;
      
      function onMouseMove(moveEvent) {
        if (!isResizing) return;
        
        if (explorerLayout === 'bottom') {
          // Bottom layout: Resize height (drag UP = increase height)
          const deltaY = startY - moveEvent.clientY;
          const newHeight = startHeight + deltaY;
          if (newHeight >= 100 && newHeight <= 450) {
            sidebar.style.height = newHeight + 'px';
            localStorage.setItem('notoMixer_explorerHeight', newHeight);
          }
        } else {
          // Sidebar layout: Resize width (drag RIGHT = increase width)
          const deltaX = moveEvent.clientX - startX;
          const newWidth = startWidth + deltaX;
          if (newWidth >= 160 && newWidth <= 450) {
            sidebar.style.width = newWidth + 'px';
            localStorage.setItem('notoMixer_explorerWidth', newWidth);
          }
        }
      }
      
      function onMouseUp() {
        isResizing = false;
        resizeHandle.classList.remove('active');
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      }
      
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  // Resizable Stacked Visualizer logic
  const stackedHandle = document.getElementById('stacked-resize-handle');
  const stackedArea = document.getElementById('stacked-visualizer-area');
  if (stackedHandle && stackedArea) {
    let isResizingStacked = false;
    
    stackedHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizingStacked = true;
      stackedHandle.classList.add('active');
      
      const startYStacked = e.clientY;
      const startHeightStacked = stackedArea.clientHeight;
      
      function onMouseMoveStacked(moveEvent) {
        if (!isResizingStacked) return;
        const deltaY = moveEvent.clientY - startYStacked;
        const newHeight = startHeightStacked + deltaY;
        if (newHeight >= 100 && newHeight <= 800) {
          stackedArea.style.height = newHeight + 'px';
          localStorage.setItem('notoMixer_stackedHeight', newHeight);
        }
      }
      
      function onMouseUpStacked() {
        isResizingStacked = false;
        stackedHandle.classList.remove('active');
        window.removeEventListener('mousemove', onMouseMoveStacked);
        window.removeEventListener('mouseup', onMouseUpStacked);
      }
      
      window.addEventListener('mousemove', onMouseMoveStacked);
      window.addEventListener('mouseup', onMouseUpStacked);
    });
  }
}

function reverseAudioBuffer(buffer, audioCtx) {
  if (!buffer) return null;
  const numChannels = buffer.numberOfChannels;
  const numFrames = buffer.length;
  const sampleRate = buffer.sampleRate;
  
  const reversed = audioCtx.createBuffer(numChannels, numFrames, sampleRate);
  
  for (let c = 0; c < numChannels; c++) {
    const srcData = buffer.getChannelData(c);
    const destData = reversed.getChannelData(c);
    for (let i = 0; i < numFrames; i++) {
      destData[i] = srcData[numFrames - 1 - i];
    }
  }
  return reversed;
}

// -------------------------------------------------------------
// Song Directory Loading System & Sync
// -------------------------------------------------------------

function loadDirectoryStems(trackNum, dirPath) {
  try {
    const track = tracks[trackNum];
    stopTrack(trackNum); // Force stop channel
    
    track.dirPath = dirPath;
    
    // Check if path is a file
    let isFile = false;
    let actualDirPath = dirPath;
    try {
      const stats = fs.statSync(dirPath);
      isFile = stats.isFile();
    } catch (err) {}

    let mainFile = '';
    let vocalsFile = '';
    const instFiles = [];
    let songTitle = '';

    if (isFile) {
      actualDirPath = path.dirname(dirPath);
      mainFile = path.basename(dirPath);
      songTitle = path.basename(dirPath, path.extname(dirPath));
    } else {
      songTitle = dirPath.split(/[\\/]/).pop();
    }

    document.getElementById(`track-name-${trackNum}`).textContent = songTitle.toUpperCase();
    document.getElementById(`dir-path-${trackNum}`).textContent = dirPath;

    // Clean up any dynamic inst audio elements first
    track.stems.inst.audios.forEach(item => {
      item.audio.pause();
      item.audio.src = '';
      item.audio.remove(); // Remove from DOM to release resources
      if (item.source) item.source.disconnect();
    });
    track.stems.inst.audios = [];
    track.stems.inst.exists = false;

    if (!isFile) {
      // Read files inside directory
      const files = fs.readdirSync(dirPath);
      const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
      
      files.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        if (audioExtensions.includes(ext)) {
          const name = path.basename(file, ext).toLowerCase();
          if (name === 'main') {
            mainFile = file;
          } else if (name === 'vocals') {
            vocalsFile = file;
          } else {
            instFiles.push(file);
          }
        }
      });

      // If we don't have main/vocals and only have exactly 1 audio file, treat it as main
      if (!mainFile && !vocalsFile && instFiles.length === 1) {
        mainFile = instFiles.pop();
      }
    }

    let hasAtLeastOneFile = false;
    initAudio(trackNum); // Ensure context exists

    // Load main stem (main.mp3)
    const mainIndicator = document.getElementById(`ind-main-${trackNum}`);
    const mainCell = document.getElementById(`cell-main-${trackNum}`);
    track.staticWaveform = null; // Clear old static waveform
    if (mainFile) {
      const filePath = path.join(actualDirPath, mainFile);
      const data = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      const blob = new Blob([data], { type: mimeType });
      track.stems.main.audio.src = URL.createObjectURL(blob);
      track.stems.main.audio.preservesPitch = true;
      track.stems.main.audio.playbackRate = track.speedVal;
      track.stems.main.audio.load();
      track.stems.main.exists = true;
      hasAtLeastOneFile = true;
      
      // Lazily create and connect source node after src is set
      if (!track.stems.main.source && track.stems.main.gainNode) {
        track.stems.main.source = audioCtx.createMediaElementSource(track.stems.main.audio);
        track.stems.main.source.connect(track.stems.main.gainNode);
      }
      
      if (mainIndicator) mainIndicator.classList.add('present');
      if (mainCell) mainCell.classList.remove('disabled');
      logConsole(`Main Stem loaded: Track ${trackNum} -> ${mainFile}`, 'system');
    } else {
      track.stems.main.audio.src = '';
      track.stems.main.exists = false;
      if (mainIndicator) mainIndicator.classList.remove('present');
      if (mainCell) mainCell.classList.add('disabled');
      logConsole(`Main Stem missing: Track ${trackNum}`, 'system');
    }

    // Load vocals stem (vocals.mp3)
    const vocalsIndicator = document.getElementById(`ind-vocals-${trackNum}`);
    const vocalsCell = document.getElementById(`cell-voc-${trackNum}`);
    if (vocalsFile) {
      const filePath = path.join(actualDirPath, vocalsFile);
      const data = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      const blob = new Blob([data], { type: mimeType });
      track.stems.vocals.audio.src = URL.createObjectURL(blob);
      track.stems.vocals.audio.preservesPitch = true;
      track.stems.vocals.audio.playbackRate = track.speedVal;
      track.stems.vocals.audio.load();
      track.stems.vocals.exists = true;
      hasAtLeastOneFile = true;
      
      // Lazily create and connect source node after src is set
      if (!track.stems.vocals.source && track.stems.vocals.gainNode) {
        track.stems.vocals.source = audioCtx.createMediaElementSource(track.stems.vocals.audio);
        track.stems.vocals.source.connect(track.stems.vocals.gainNode);
      }

      vocalsIndicator.classList.add('present');
      vocalsCell.classList.remove('disabled');
      logConsole(`Vocals Stem loaded: Track ${trackNum} -> ${vocalsFile}`, 'system');
    } else {
      track.stems.vocals.audio.src = '';
      track.stems.vocals.exists = false;
      vocalsIndicator.classList.remove('present');
      vocalsCell.classList.add('disabled');
      logConsole(`Vocals Stem missing: Track ${trackNum} (EQ VOCALS disabled)`, 'system');
    }

    // Load all remaining files as instrumental stems (Dynamic Multi-Stem INST)
    const instIndicator = document.getElementById(`ind-inst-${trackNum}`);
    const instCell = document.getElementById(`cell-inst-${trackNum}`);
    
    if (instFiles.length > 0) {
      instFiles.forEach(file => {
        const filePath = path.join(actualDirPath, file);
        const data = fs.readFileSync(filePath);
        const mimeType = getMimeType(filePath);
        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        
        const audio = new Audio();
        audio.src = url;
        audio.style.display = 'none';
        document.body.appendChild(audio); // Append to DOM to prevent Chromium silence bug
        audio.preservesPitch = true;
        audio.playbackRate = track.speedVal;
        audio.load();
        
        const source = audioCtx.createMediaElementSource(audio);
        
        // Connect to static inst gain node
        if (track.stems.inst.gainNode) {
          source.connect(track.stems.inst.gainNode);
        }
        
        // Set up event listeners for this dynamic instrumental audio element
        audio.addEventListener('timeupdate', () => {
          let firstActiveAudio = null;
          if (track.stems.main.exists) firstActiveAudio = track.stems.main.audio;
          else if (track.stems.vocals.exists) firstActiveAudio = track.stems.vocals.audio;
          else if (track.stems.inst.audios.length > 0) firstActiveAudio = track.stems.inst.audios[0].audio;
          
          if (firstActiveAudio === audio) {
            handleTrackProgress(trackNum);
          }
        });

        audio.addEventListener('durationchange', () => {
          let firstActiveAudio = null;
          if (track.stems.main.exists) firstActiveAudio = track.stems.main.audio;
          else if (track.stems.vocals.exists) firstActiveAudio = track.stems.vocals.audio;
          else if (track.stems.inst.audios.length > 0) firstActiveAudio = track.stems.inst.audios[0].audio;
          
          if (firstActiveAudio === audio) {
            document.getElementById(`time-duration-${trackNum}`).textContent = formatTime(audio.duration);
          }
        });

        audio.addEventListener('ended', () => {
          let firstActiveAudio = null;
          if (track.stems.main.exists) firstActiveAudio = track.stems.main.audio;
          else if (track.stems.vocals.exists) firstActiveAudio = track.stems.vocals.audio;
          else if (track.stems.inst.audios.length > 0) firstActiveAudio = track.stems.inst.audios[0].audio;
          
          if (firstActiveAudio === audio) {
            stopTrack(trackNum);
          }
        });

        track.stems.inst.audios.push({
          audio,
          source,
          gainNode: null,
          file
        });
        hasAtLeastOneFile = true;
        logConsole(`Instrumental Stem loaded: Track ${trackNum} -> ${file}`, 'system');
      });
      
      track.stems.inst.exists = true;
      instIndicator.classList.add('present');
      instCell.classList.remove('disabled');
      logConsole(`Success: Loaded ${instFiles.length} instrumental stems in Track ${trackNum}`, 'system');
    } else {
      track.stems.inst.exists = false;
      instIndicator.classList.remove('present');
      instCell.classList.add('disabled');
      logConsole(`Instrumental Stem absent: Track ${trackNum} (EQ INST disabled)`, 'system');
    }

    // Generate combined static waveform for all loaded stems
    track.staticWaveform = null; // Clear old waveform
    const pathsToDecode = [];
    if (mainFile) pathsToDecode.push(path.join(actualDirPath, mainFile));
    if (vocalsFile) pathsToDecode.push(path.join(actualDirPath, vocalsFile));
    instFiles.forEach(file => pathsToDecode.push(path.join(actualDirPath, file)));

    if (pathsToDecode.length > 0) {
      logConsole(`Waveform: Starting combined decode for ${pathsToDecode.length} files...`, 'system');
      const decodePromises = pathsToDecode.map(filePath => {
        return new Promise((resolve, reject) => {
          try {
            const data = fs.readFileSync(filePath);
            const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            audioCtx.decodeAudioData(arrayBuffer)
              .then(resolve)
              .catch(err => {
                logConsole(`Warning Waveform: Unable to decode ${path.basename(filePath)}: ${err.message}`, 'err');
                resolve(null); // Resolve as null to not block other tracks
              });
          } catch (err) {
            logConsole(`Warning Waveform: Unable to read ${path.basename(filePath)}: ${err.message}`, 'err');
            resolve(null);
          }
        });
      });

      Promise.all(decodePromises).then(buffers => {
        // Associate decoded buffers with stems for real-time scratching
        let bufIdx = 0;
        if (mainFile && buffers[bufIdx]) {
          track.stems.main.buffer = buffers[bufIdx];
          track.stems.main.reversedBuffer = reverseAudioBuffer(buffers[bufIdx], audioCtx);
          bufIdx++;
        }
        if (vocalsFile && buffers[bufIdx]) {
          track.stems.vocals.buffer = buffers[bufIdx];
          track.stems.vocals.reversedBuffer = reverseAudioBuffer(buffers[bufIdx], audioCtx);
          bufIdx++;
        }
        instFiles.forEach(file => {
          if (buffers[bufIdx]) {
            const instAudio = track.stems.inst.audios.find(item => item.file === file);
            if (instAudio) {
              instAudio.buffer = buffers[bufIdx];
              instAudio.reversedBuffer = reverseAudioBuffer(buffers[bufIdx], audioCtx);
            }
            bufIdx++;
          }
        });

        const audioBuffers = buffers.filter(buf => buf !== null);
        if (audioBuffers.length === 0) return;

        // Auto-analyze BPM (Rekordbox-style)
        try {
          logConsole(`BPM: Analyzing tempo for Track ${trackNum}...`, 'system');
          
          let detectedBpm = 120;
          let detectedOffset = 0;
          
          // Try loading from metadata cache first
          const mainAudioPath = pathsToDecode[0];
          const cacheKey = `notoMixer_meta8_${mainAudioPath}`;
          const cachedData = localStorage.getItem(cacheKey);
          let gotCache = false;
          
          if (cachedData) {
            try {
              const meta = JSON.parse(cachedData);
              detectedBpm = meta.bpm;
              detectedOffset = meta.offset || 0;
              gotCache = true;
              logConsole(`BPM: Loaded cached ${detectedBpm} BPM and ${detectedOffset.toFixed(3)}s offset for Track ${trackNum}`, 'system');
            } catch (err) {}
          }
          
          if (!gotCache) {
            detectedBpm = estimateBPM(audioBuffers[0]);
            detectedOffset = estimateBeatOffset(audioBuffers[0], detectedBpm);
            logConsole(`BPM: Analyzed ${detectedBpm} BPM and ${detectedOffset.toFixed(3)}s offset for Track ${trackNum}`, 'system');
          }
          
          track.beatOffset = detectedOffset;
          setBPM(trackNum, detectedBpm);
        } catch (bpmErr) {
          console.error("BPM analysis error:", bpmErr);
        }

        const numPeaks = 2000;
        const maxDuration = Math.max(...audioBuffers.map(buf => buf.duration));
        const peaks = new Float32Array(numPeaks);

        audioBuffers.forEach(buf => {
          const rawData = buf.getChannelData(0);
          const L = rawData.length;
          const SR = buf.sampleRate;
          const duration = buf.duration;

          for (let i = 0; i < numPeaks; i++) {
            const startTime = (i / numPeaks) * maxDuration;
            const endTime = ((i + 1) / numPeaks) * maxDuration;

            if (startTime < duration) {
              const startIdx = Math.floor(startTime * SR);
              const endIdx = Math.min(L, Math.floor(endTime * SR));
              if (endIdx > startIdx) {
                let sum = 0;
                for (let j = startIdx; j < endIdx; j++) {
                  sum += Math.abs(rawData[j]);
                }
                peaks[i] += sum / (endIdx - startIdx);
              }
            }
          }
        });

        const maxVal = Math.max(...peaks);
        track.staticWaveform = Array.from(peaks).map(p => p / (maxVal || 1));
        logConsole(`Waveform: Track ${trackNum} decoded successfully (${audioBuffers.length} stems combined).`, 'system');
      }).catch(err => {
        logConsole(`Err Waveform: Combined decode failed on Track ${trackNum}: ${err.message}`, 'err');
      });
    }

    // Re-enable effects that might have been disabled by the test track
    ['filter', 'pitch', 'speed', 'echo', 'reverb', 'echotime'].forEach(key => {
      const cell = document.getElementById(`cell-${key}-${trackNum}`);
      if (cell) cell.classList.remove('disabled');
    });

    const bpmInput = document.getElementById(`bpm-${trackNum}`);
    if (bpmInput && bpmInput.parentElement && bpmInput.parentElement.parentElement) {
      bpmInput.parentElement.parentElement.classList.remove('disabled-control');
    }
    
    const bpmDiv = document.getElementById(`bpmdiv-${trackNum}`);
    if (bpmDiv && bpmDiv.parentElement) {
      bpmDiv.parentElement.classList.remove('disabled-control');
    }
    
    const metroBtn = document.getElementById(`btn-metro-${trackNum}`);
    if (metroBtn && metroBtn.parentElement) {
      metroBtn.parentElement.classList.remove('disabled-control');
    }

    const syncBtn = document.getElementById(`btn-sync-${trackNum}`);
    if (syncBtn) syncBtn.classList.remove('disabled-control');
    
    const quantizeBtn = document.getElementById(`btn-quantize-${trackNum}`);
    if (quantizeBtn) quantizeBtn.classList.remove('disabled-control');

    if (hasAtLeastOneFile) {
      logConsole(`Success: Song loaded on Channel ${trackNum} -> ${folderName}`, 'system');
    } else {
      logConsole(`Warning: No valid audio file found in ${folderName}`, 'err');
    }
  } catch (err) {
    logConsole(`Err: Folder load failed: ${err.message}`, 'err');
  }
}

// Fallback folder loader from IPC
ipcRenderer.on('directory-selected', (event, { trackNum, dirPath }) => {
  loadDirectoryStems(trackNum, dirPath);
});

// BPM Filter / Compatibility Indicator
let bpmFilterTrack = 1; // 1 or 2, which track to compare against
let currentStatusFilter = 'ALL'; // 'ALL', '✓', '⚠', '✗'
let currentSearchQuery = '';

function applySongListFilters() {
  const songsList = document.getElementById('songs-list');
  if (!songsList) return;
  
  const items = Array.from(songsList.querySelectorAll('li'));
  // Don't sort the placeholder
  if (items.length === 1 && items[0].classList.contains('song-list-placeholder')) return;

  const query = currentSearchQuery.toLowerCase();
  
  // 1. Filter by search query
  items.forEach(li => {
    const folderName = li.dataset.folder || '';
    if (folderName.toLowerCase().includes(query)) {
      li.style.display = 'flex';
    } else {
      li.style.display = 'none';
    }
  });

  // 2. Sort by status
  if (currentStatusFilter !== 'ALL') {
    items.sort((a, b) => {
      const iconA = a.querySelector('.bpm-compat-icon');
      const iconB = b.querySelector('.bpm-compat-icon');
      
      const charA = iconA ? iconA.textContent : '';
      const charB = iconB ? iconB.textContent : '';
      
      const aMatches = (charA === currentStatusFilter) ? 1 : 0;
      const bMatches = (charB === currentStatusFilter) ? 1 : 0;
      
      // Matchers bubble to the top
      return bMatches - aMatches;
    });
    
    // Re-append in new order
    items.forEach(li => songsList.appendChild(li));
  } else {
    // Revert to alphabetical sort
    items.sort((a, b) => {
      const nameA = (a.dataset.folder || '').toLowerCase();
      const nameB = (b.dataset.folder || '').toLowerCase();
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });
    items.forEach(li => songsList.appendChild(li));
  }
}

function updateBpmCompatIndicators() {
  const songsList = document.getElementById('songs-list');
  if (!songsList) return;

  const refTrack = tracks[bpmFilterTrack];
  const refBpm = refTrack ? refTrack.bpmVal : null;
  const filterBtn = document.getElementById('btn-bpm-filter');

  const items = songsList.querySelectorAll('li[data-bpm]');
  items.forEach(li => {
    const icon = li.querySelector('.bpm-compat-icon');
    if (!icon) return;

    const songBpm = parseFloat(li.dataset.bpm);
    if (!songBpm || isNaN(songBpm) || !refBpm) {
      icon.className = 'bpm-compat-icon unknown';
      icon.textContent = '·';
      return;
    }

    const diff = Math.abs(songBpm - refBpm);

    if (diff <= 5) {
      // Match - checkmark in the track's color
      icon.className = bpmFilterTrack === 1 ? 'bpm-compat-icon match' : 'bpm-compat-icon match-t2';
      icon.textContent = '✓';
    } else if (diff <= 20) {
      // Warning - within 20 BPM
      icon.className = 'bpm-compat-icon warn';
      icon.textContent = '⚠';
    } else {
      // Far - more than 20 BPM
      icon.className = 'bpm-compat-icon far';
      icon.textContent = '✗';
    }
  });
  
  // Re-apply filters whenever BPM compatibility updates
  applySongListFilters();
}

function scanWorkingDirectory() {
  const songsList = document.getElementById('songs-list');
  if (!songsList) return;
  
  songsList.innerHTML = '';
  
  if (!workingDir) {
    songsList.innerHTML = '<li class="song-list-placeholder">No folder selected</li>';
    return;
  }

  try {
    const files = fs.readdirSync(workingDir, { withFileTypes: true });
    const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
    
    const songItems = files.filter(f => {
      if (f.isDirectory()) return true;
      const ext = path.extname(f.name).toLowerCase();
      return f.isFile() && audioExtensions.includes(ext);
    }).map(f => f.name);
    
    if (songItems.length === 0) {
      songsList.innerHTML = '<li class="song-list-placeholder">No songs or folders found</li>';
      return;
    }

    songItems.forEach(folderName => {
      const li = document.createElement('li');
      li.setAttribute('draggable', 'true');
      li.dataset.folder = folderName;
      
      // 1. Artwork thumbnail
      const artDiv = document.createElement('div');
      artDiv.className = 'song-item-art';
      const artImg = document.createElement('img');
      artImg.className = 'song-art-img';
      
      // Try to find cover art inside song folder
      let artSrc = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23555555"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>`;
      try {
        const sPath = path.join(workingDir, folderName);
        const sStats = fs.statSync(sPath);
        if (sStats.isDirectory()) {
          const sFiles = fs.readdirSync(sPath);
          const imgFile = sFiles.find(file => {
            const ext = path.extname(file).toLowerCase();
            const nameLc = path.basename(file, ext).toLowerCase();
            return ['.jpg', '.jpeg', '.png', '.gif'].includes(ext) && 
                   (nameLc.includes('cover') || nameLc.includes('art') || nameLc.includes('folder') || nameLc.includes('thumb') || nameLc.includes('artwork'));
          });
          if (imgFile) {
            artSrc = path.join(sPath, imgFile);
          }
        }
      } catch (err) {}
      artImg.src = artSrc;
      artDiv.appendChild(artImg);
      li.appendChild(artDiv);

      // 2. Mini Preview Waveform Canvas
      const waveCanvas = document.createElement('canvas');
      waveCanvas.className = 'song-item-wave-canvas';
      waveCanvas.width = 140;
      waveCanvas.height = 22;
      li.appendChild(waveCanvas);
      
      // Initial flat waveform line placeholder
      const wCtx = waveCanvas.getContext('2d');
      wCtx.fillStyle = '#333';
      wCtx.fillRect(0, 10, 140, 2);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'song-item-name';
      nameSpan.textContent = folderName;
      li.appendChild(nameSpan);
      
      const metaDiv = document.createElement('div');
      metaDiv.className = 'song-item-meta';

      const bpmCompatIcon = document.createElement('span');
      bpmCompatIcon.className = 'bpm-compat-icon unknown';
      bpmCompatIcon.textContent = '·';
      
      const bpmSpan = document.createElement('span');
      bpmSpan.className = 'song-item-bpm';
      bpmSpan.textContent = '-- BPM';
      
      const durSpan = document.createElement('span');
      durSpan.className = 'song-item-duration';
      durSpan.textContent = '--:--';
      
      metaDiv.appendChild(bpmCompatIcon);
      metaDiv.appendChild(bpmSpan);
      metaDiv.appendChild(durSpan);
      li.appendChild(metaDiv);
      
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', folderName);
        e.dataTransfer.effectAllowed = 'copy';
      });

      // Middle click to open preview window
      li.addEventListener('auxclick', (e) => {
        if (e.button === 1) { // 1 is middle click
          e.preventDefault();
          const folderName = li.dataset.folder;
          const fullPath = path.join(workingDir, folderName);
          loadPreviewSong(fullPath, folderName);
        }
      });

      // Prevent middle click auto-scrolling cursor from appearing
      li.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
        }
      });
      
      songsList.appendChild(li);

      // Asynchronously load and analyze metadata (BPM + Duration)
      loadSongMetadata(path.join(workingDir, folderName), bpmSpan, durSpan, waveCanvas, artImg);
    });
    
    logConsole(`Explorer: Found ${songItems.length} songs/folders in ${workingDir}`, 'system');
  } catch (err) {
    logConsole(`Err Explorer: Folder read failed: ${err.message}`, 'err');
    songsList.innerHTML = `<li class="song-list-placeholder text-red">Read error</li>`;
  }
}

function drawSongMiniWaveform(waveCanvas, peaks) {
  if (!waveCanvas) return;
  const ctx = waveCanvas.getContext('2d');
  const w = waveCanvas.width;
  const h = waveCanvas.height;
  ctx.clearRect(0, 0, w, h);
  
  if (!peaks || peaks.length === 0) {
    ctx.fillStyle = '#333';
    ctx.fillRect(0, h / 2 - 1, w, 2);
    return;
  }
  
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0055ff');
  grad.addColorStop(0.5, '#00ffff');
  grad.addColorStop(1, '#0055ff');
  ctx.fillStyle = grad;
  
  const barWidth = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const peak = peaks[i];
    const valH = Math.max(1, peak * h * 0.9);
    const x = i * barWidth;
    const y = (h - valH) / 2;
    ctx.fillRect(x, y, barWidth - 0.5, valH);
  }
}

function loadSongMetadata(songPath, bpmElement, durElement, waveCanvas, artImg) {
  try {
    let isFile = false;
    try {
      const stats = fs.statSync(songPath);
      isFile = stats.isFile();
    } catch (e) {
      return;
    }

    let mainAudioPath = '';
    let mtime = 0;
    let size = 0;
    
    if (isFile) {
      mainAudioPath = songPath;
      const stats = fs.statSync(songPath);
      mtime = stats.mtimeMs;
      size = stats.size;
    } else {
      // It's a directory. Look for main audio stem
      const files = fs.readdirSync(songPath);
      const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
      let chosenFile = '';
      
      // Look for 'main' first, then 'vocals', then first audio file
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (audioExtensions.includes(ext)) {
          const name = path.basename(file, ext).toLowerCase();
          if (name === 'main') {
            chosenFile = file;
            break;
          } else if (name === 'vocals' && !chosenFile) {
            chosenFile = file;
          } else if (!chosenFile) {
            chosenFile = file;
          }
        }
      }
      
      if (chosenFile) {
        mainAudioPath = path.join(songPath, chosenFile);
        const stats = fs.statSync(mainAudioPath);
        mtime = stats.mtimeMs;
        size = stats.size;
      }
    }

    if (!mainAudioPath) {
      bpmElement.textContent = 'NO AUDIO';
      durElement.textContent = '--:--';
      return;
    }

    // Try reading from cache
    const cacheKey = `notoMixer_meta8_${mainAudioPath}`;
    const cachedData = localStorage.getItem(cacheKey);
    if (cachedData) {
      try {
        const meta = JSON.parse(cachedData);
        if (meta.mtime === mtime && meta.size === size && meta.peaks && (!meta.cover || fs.existsSync(meta.cover))) {
          bpmElement.textContent = `${meta.bpm} BPM`;
          durElement.textContent = formatTime(meta.duration);
          const parentLi = bpmElement.closest('li');
          if (parentLi) parentLi.dataset.bpm = meta.bpm;
          if (waveCanvas && meta.peaks) {
            drawSongMiniWaveform(waveCanvas, meta.peaks);
          }
          if (artImg && meta.cover && fs.existsSync(meta.cover)) {
            artImg.src = meta.cover;
          }
          updateBpmCompatIndicators();
          return;
        }
      } catch (err) {}
    }

    // Cache miss: load and decode in the background asynchronously
    fs.readFile(mainAudioPath, (err, data) => {
      if (err) return;
      
      const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      initPreviewAudio();
      previewAudioCtx.decodeAudioData(arrayBuffer)
        .then(buffer => {
          const duration = buffer.duration;
          const bpm = estimateBPM(buffer);
          const offset = estimateBeatOffset(buffer, bpm);
          
          // Generate peaks array for mini visualizer
          const peaksCount = 60;
          const peaks = new Float32Array(peaksCount);
          const rawData = buffer.getChannelData(0);
          const step = Math.floor(rawData.length / peaksCount);
          for (let i = 0; i < peaksCount; i++) {
            let sum = 0;
            const start = i * step;
            const end = Math.min(start + step, rawData.length);
            for (let j = start; j < end; j++) {
              sum += Math.abs(rawData[j]);
            }
            peaks[i] = sum / (end - start);
          }
          
          let maxPeak = 0;
          for (let i = 0; i < peaksCount; i++) {
            if (peaks[i] > maxPeak) maxPeak = peaks[i];
          }
          const peakArray = Array.from(peaks).map(p => Math.round((p / (maxPeak || 1)) * 100) / 100);
          
          // Update DOM elements safely
          bpmElement.textContent = `${bpm} BPM`;
          durElement.textContent = formatTime(duration);
          const parentLi = bpmElement.closest('li');
          if (parentLi) parentLi.dataset.bpm = bpm;
          updateBpmCompatIndicators();
          if (waveCanvas) {
            drawSongMiniWaveform(waveCanvas, peakArray);
          }

          // Handle cover art extraction
          let coverPath = '';
          if (!isFile) {
            try {
              const sFiles = fs.readdirSync(songPath);
              const imgFile = sFiles.find(file => {
                const ext = path.extname(file).toLowerCase();
                const nameLc = path.basename(file, ext).toLowerCase();
                return ['.jpg', '.jpeg', '.png', '.gif'].includes(ext) && 
                       (nameLc.includes('cover') || nameLc.includes('art') || nameLc.includes('folder') || nameLc.includes('thumb') || nameLc.includes('artwork'));
              });
              if (imgFile) {
                coverPath = path.join(songPath, imgFile);
                if (artImg) artImg.src = coverPath;
              }
            } catch (err) {}
            
            const metaObj = { bpm, duration, offset, peaks: peakArray, mtime, size, cover: coverPath };
            localStorage.setItem(cacheKey, JSON.stringify(metaObj));
          } else {
            // Extract embedded picture using CommonJS require
            console.log("[METADATA] Extracting cover art for file:", mainAudioPath);
            try {
              const mm = require('music-metadata');
              mm.parseFile(mainAudioPath).then(metadata => {
                console.log("[METADATA] Metadata parsed successfully for " + mainAudioPath + ". Has picture:", !!(metadata.common.picture && metadata.common.picture.length > 0));
                if (metadata.common.picture && metadata.common.picture.length > 0) {
                  const pic = metadata.common.picture[0];
                  const cacheDir = path.join(__dirname, '.cover_cache');
                  console.log("[METADATA] Cover cache dir path:", cacheDir);
                  if (!fs.existsSync(cacheDir)) {
                    fs.mkdirSync(cacheDir, { recursive: true });
                  }
                  const safeName = mainAudioPath.replace(/[^a-zA-Z0-9]/g, '_') + '.jpg';
                  const cachedCoverPath = path.join(cacheDir, safeName);
                  fs.writeFileSync(cachedCoverPath, pic.data);
                  coverPath = cachedCoverPath;
                  console.log("[METADATA] Saved cached cover to:", cachedCoverPath);
                  if (artImg) artImg.src = cachedCoverPath;
                }
                const metaObj = { bpm, duration, offset, peaks: peakArray, mtime, size, cover: coverPath };
                localStorage.setItem(cacheKey, JSON.stringify(metaObj));
              }).catch(e => {
                console.error("[METADATA] Error parsing embedded picture:", e);
                const metaObj = { bpm, duration, offset, peaks: peakArray, mtime, size, cover: '' };
                localStorage.setItem(cacheKey, JSON.stringify(metaObj));
              });
            } catch (err) {
              console.error("[METADATA] Error requiring music-metadata:", err);
              const metaObj = { bpm, duration, offset, peaks: peakArray, mtime, size, cover: '' };
              localStorage.setItem(cacheKey, JSON.stringify(metaObj));
            }
          }
        })
        .catch(decodeErr => {
          console.warn(`Metadata load error for ${mainAudioPath}:`, decodeErr);
          bpmElement.textContent = 'ERR';
        });
    });
  } catch (err) {
    console.error("Metadata loader error:", err);
  }
}

ipcRenderer.on('working-directory-selected', (event, dirPath) => {
  workingDir = dirPath;
  localStorage.setItem('notoMixer_workingDir', dirPath);
  document.getElementById('working-dir-path').textContent = dirPath;
  
  const headerTitle = document.getElementById('songs-header-title');
  if (headerTitle) {
    headerTitle.textContent = dirPath ? `AVAILABLE SONGS (${dirPath})` : 'AVAILABLE SONGS';
  }
  
  scanWorkingDirectory();
});

function showConnectionModal() {
  const modal = document.getElementById('connection-modal');
  if (modal) {
    modal.classList.add('show');
    // Play the alert sound when the connection modal appears
    const errorSound = new Audio('assets/audio/error.mp3');
    errorSound.play().catch(e => console.log('Could not play error sound:', e));
  }
}

function hideConnectionModal() {
  const modal = document.getElementById('connection-modal');
  if (modal) {
    modal.classList.remove('show');
  }
}

async function populateAudioDevices() {
  const mainSelect = document.getElementById('setting-main-audio');
  const previewSelect = document.getElementById('setting-preview-audio');
  if (!mainSelect || !previewSelect) return;

  mainSelect.innerHTML = '<option value="default">Default</option>';
  previewSelect.innerHTML = '<option value="default">Default</option>';

  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    logConsole("Err Settings: Media devices enumeration not supported in this environment", "err");
    return;
  }

  try {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch (e) {
      console.warn("Permission request failed for audio labels:", e);
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

    let allLabelsEmpty = true;
    audioOutputs.forEach(device => {
      if (device.label) allLabelsEmpty = false;
      const deviceIdStr = device.deviceId || '';
      const displayLabel = device.label || `Output Device (${deviceIdStr.slice(0, 5)}...)`;
      
      const opt1 = document.createElement('option');
      opt1.value = deviceIdStr;
      opt1.textContent = displayLabel;
      mainSelect.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = deviceIdStr;
      opt2.textContent = displayLabel;
      previewSelect.appendChild(opt2);
    });


    const savedMain = localStorage.getItem('notoMixer_mainAudioDevice');
    const savedPreview = localStorage.getItem('notoMixer_previewAudioDevice');
    if (savedMain) mainSelect.value = savedMain;
    if (savedPreview) previewSelect.value = savedPreview;
    
    logConsole(`Settings: Found ${audioOutputs.length} audio output devices`, 'system');
  } catch (err) {
    logConsole(`Err Settings: Failed to populate devices: ${err.message}`, 'err');
    console.error("Error populating audio devices:", err);
  }
}

let zoomText = 100;
let zoomWaveform = 100;
let zoomButtons = 100;
let zoomCover = 100;

function applyZoomSettings() {
  document.documentElement.style.setProperty('--zoom-text', zoomText / 100);
  document.documentElement.style.setProperty('--zoom-waveform', zoomWaveform / 100);
  document.documentElement.style.setProperty('--zoom-buttons', zoomButtons / 100);
  document.documentElement.style.setProperty('--zoom-cover-scale', zoomCover / 100);
}

function loadZoomSettings() {
  const savedText = localStorage.getItem('notoMixer_zoomText');
  const savedWaveform = localStorage.getItem('notoMixer_zoomWaveform');
  const savedButtons = localStorage.getItem('notoMixer_zoomButtons');
  const savedCover = localStorage.getItem('notoMixer_zoomCover');

  zoomText = savedText !== null ? parseInt(savedText) : 100;
  zoomWaveform = savedWaveform !== null ? parseInt(savedWaveform) : 100;
  zoomButtons = savedButtons !== null ? parseInt(savedButtons) : 100;
  zoomCover = savedCover !== null ? parseInt(savedCover) : 100;

  applyZoomSettings();
}

function showSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.classList.add('show');
  }
  populateAudioDevices();

  // Set zoom sliders and labels
  const zoomTextSlider = document.getElementById('setting-zoom-text');
  const zoomTextDisplay = document.getElementById('zoom-text-display');
  if (zoomTextSlider) {
    zoomTextSlider.value = zoomText;
    if (zoomTextDisplay) zoomTextDisplay.textContent = `${zoomText}%`;
  }
  
  const zoomWaveformSlider = document.getElementById('setting-zoom-waveform');
  const zoomWaveformDisplay = document.getElementById('zoom-waveform-display');
  if (zoomWaveformSlider) {
    zoomWaveformSlider.value = zoomWaveform;
    if (zoomWaveformDisplay) zoomWaveformDisplay.textContent = `${zoomWaveform}%`;
  }

  const zoomButtonsSlider = document.getElementById('setting-zoom-buttons');
  const zoomButtonsDisplay = document.getElementById('zoom-buttons-display');
  if (zoomButtonsSlider) {
    zoomButtonsSlider.value = zoomButtons;
    if (zoomButtonsDisplay) zoomButtonsDisplay.textContent = `${zoomButtons}%`;
  }

  const zoomCoverSlider = document.getElementById('setting-zoom-cover');
  const zoomCoverDisplay = document.getElementById('zoom-cover-display');
  if (zoomCoverSlider) {
    zoomCoverSlider.value = zoomCover;
    if (zoomCoverDisplay) zoomCoverDisplay.textContent = `${zoomCover}%`;
  }
}

function hideSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.classList.remove('show');
  }
}

function loadSnapSettings() {
  const savedEnabled = localStorage.getItem('notoMixer_snapEnabled');
  const savedThreshold = localStorage.getItem('notoMixer_snapThreshold');
  
  if (savedEnabled !== null) {
    snapEnabled = (savedEnabled === 'true');
  } else {
    snapEnabled = false; // default off
  }
  
  if (savedThreshold !== null) {
    snapThresholdPct = parseInt(savedThreshold) || 5;
  } else {
    snapThresholdPct = 5;
  }
}

let layoutMode = 'default';
let explorerLayout = 'sidebar';

function loadLayoutSettings() {
  const savedLayout = localStorage.getItem('notoMixer_layoutMode');
  if (savedLayout !== null) {
    layoutMode = savedLayout;
  } else {
    layoutMode = 'default';
  }
  applyLayoutMode(layoutMode);

  const savedExplorer = localStorage.getItem('notoMixer_explorerLayout');
  if (savedExplorer !== null) {
    explorerLayout = savedExplorer;
  } else {
    explorerLayout = 'sidebar';
  }
  applyExplorerLayout(explorerLayout);
}

function applyLayoutMode(mode) {
  layoutMode = mode;
  const container = document.body;
  const block1 = document.getElementById('visualizer-block-1');
  const block2 = document.getElementById('visualizer-block-2');
  const stackedArea = document.getElementById('stacked-visualizer-area');
  const stackedHandle = document.getElementById('stacked-resize-handle');
  
  if (mode === 'stacked') {
    container.classList.add('layout-stacked');
    if (stackedArea && block1 && block2) {
      stackedArea.appendChild(block1);
      stackedArea.appendChild(block2);
      stackedArea.style.display = 'flex';
      
      const savedHeight = localStorage.getItem('notoMixer_stackedHeight');
      if (savedHeight) {
        stackedArea.style.height = savedHeight + 'px';
      }
      
      if (stackedHandle) stackedHandle.style.display = 'block';
    }
  } else {
    container.classList.remove('layout-stacked');
    if (stackedArea) {
      stackedArea.style.display = 'none';
    }
    if (stackedHandle) {
      stackedHandle.style.display = 'none';
    }
    const body1 = document.querySelector('#track-1 .track-body');
    const folder1 = body1 ? body1.querySelector('.folder-status-panel') : null;
    if (body1 && folder1 && block1) {
      body1.insertBefore(block1, folder1.nextSibling);
    }
    
    const body2 = document.querySelector('#track-2 .track-body');
    const folder2 = body2 ? body2.querySelector('.folder-status-panel') : null;
    if (body2 && folder2 && block2) {
      body2.insertBefore(block2, folder2.nextSibling);
    }
  }
  
  const layoutSelect = document.getElementById('setting-layout-mode');
  if (layoutSelect) {
    layoutSelect.value = mode;
  }
}

function applyExplorerLayout(layout) {
  explorerLayout = layout;
  const workspace = document.querySelector('.exertia-workspace');
  const sidebar = document.querySelector('.exertia-sidebar');
  if (workspace && sidebar) {
    if (layout === 'bottom') {
      workspace.classList.add('explorer-bottom');
      const savedHeight = localStorage.getItem('notoMixer_explorerHeight') || '180';
      sidebar.style.height = savedHeight + 'px';
      sidebar.style.width = '100%';
    } else {
      workspace.classList.remove('explorer-bottom');
      const savedWidth = localStorage.getItem('notoMixer_explorerWidth') || '220';
      sidebar.style.width = savedWidth + 'px';
      sidebar.style.height = 'auto';
    }
  }
  const explorerSelect = document.getElementById('setting-explorer-layout');
  if (explorerSelect) {
    explorerSelect.value = layout;
  }
}

function estimateBPM(audioBuffer) {
  try {
    const rawData = audioBuffer.getChannelData(0); // Use first channel
    const sampleRate = audioBuffer.sampleRate;
    
    // Select a representative 45-second chunk from a part of the song where the main beat is active
    // Starting at 60 seconds to bypass drumless intros/buildups (like in "I Gotta Feeling")
    let startSec = 0;
    if (audioBuffer.duration > 90) {
      startSec = 60; // Start at 60 seconds for normal length tracks
    } else if (audioBuffer.duration > 30) {
      startSec = 15; // Start at 15 seconds for short tracks
    }
    const startOffset = Math.floor(sampleRate * startSec);
    const analysisDuration = 45; // seconds
    const sampleLength = Math.min(Math.floor(sampleRate * analysisDuration), rawData.length - startOffset);
    
    if (sampleLength <= 0) return 120;
    
    // Apply a software Low Pass Filter at ~150Hz to isolate bass transients (kicks)
    // First-order IIR LPF: y[n] = alpha * x[n] + (1 - alpha) * y[n-1]
    const fc = 150;
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * fc);
    const alpha = dt / (rc + dt);
    
    const filteredData = new Float32Array(sampleLength);
    let lastOut = 0;
    for (let i = 0; i < sampleLength; i++) {
      const x = rawData[startOffset + i];
      filteredData[i] = alpha * x + (1 - alpha) * lastOut;
      lastOut = filteredData[i];
    }
    
    // Downsample the filtered data to a sampling rate of ~1000Hz (1ms resolution)
    const dsFactor = Math.max(1, Math.round(sampleRate / 1000));
    const dsLength = Math.floor(sampleLength / dsFactor);
    const envelope = new Float32Array(dsLength);
    
    for (let i = 0; i < dsLength; i++) {
      let maxVal = 0;
      const start = i * dsFactor;
      const end = Math.min(start + dsFactor, sampleLength);
      for (let j = start; j < end; j++) {
        const val = Math.abs(filteredData[j]);
        if (val > maxVal) maxVal = val;
      }
      envelope[i] = maxVal;
    }
    
    // Compute the temporal onset envelope (first-order derivative of energy)
    const onset = new Float32Array(dsLength);
    for (let i = 1; i < dsLength; i++) {
      onset[i] = Math.max(0, envelope[i] - envelope[i - 1]);
    }
    
    // Autocorrelation match scoring over standard tempos (75 to 160 BPM)
    let bestBpm = 120;
    let maxScore = 0;
    
    for (let bpm = 75; bpm <= 160; bpm++) {
      const beatIntervalMs = 60000 / bpm;
      let score = 0;
      
      // Calculate autocorrelation at the fundamental beat interval and its first 3 sub-harmonics
      const lags = [beatIntervalMs, beatIntervalMs * 2, beatIntervalMs * 3, beatIntervalMs * 4];
      const weights = [1.0, 0.75, 0.45, 0.2];
      
      for (let j = 0; j < lags.length; j++) {
        const lag = Math.round(lags[j]);
        if (lag < dsLength) {
          let sum = 0;
          let count = 0;
          // Step by 4 for fast computation while preserving full alignment representation
          for (let i = 0; i < dsLength - lag; i += 4) {
            sum += onset[i] * onset[i + lag];
            count++;
          }
          if (count > 0) {
            score += weights[j] * (sum / count);
          }
        }
      }
      
      if (score > maxScore) {
        maxScore = score;
        bestBpm = bpm;
      }
    }
    
    return bestBpm;
  } catch (err) {
    console.error("Error during BPM estimation:", err);
    return 120;
  }
}

function estimateBeatOffset(audioBuffer, bpm) {
  try {
    const rawData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    
    // Scan the first 15 seconds to find the first beat offset
    const scanDuration = 15;
    const sampleLength = Math.min(Math.floor(sampleRate * scanDuration), rawData.length);
    
    if (sampleLength <= 0) return 0;
    
    // Low pass filter at 150Hz
    const fc = 150;
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * fc);
    const alpha = dt / (rc + dt);
    
    const filteredData = new Float32Array(sampleLength);
    let lastOut = 0;
    for (let i = 0; i < sampleLength; i++) {
      filteredData[i] = alpha * rawData[i] + (1 - alpha) * lastOut;
      lastOut = filteredData[i];
    }
    
    // Downsample to 1000Hz (1ms resolution)
    const dsFactor = Math.max(1, Math.round(sampleRate / 1000));
    const dsLength = Math.floor(sampleLength / dsFactor);
    const envelope = new Float32Array(dsLength);
    
    for (let i = 0; i < dsLength; i++) {
      let maxVal = 0;
      const start = i * dsFactor;
      const end = Math.min(start + dsFactor, sampleLength);
      for (let j = start; j < end; j++) {
        const val = Math.abs(filteredData[j]);
        if (val > maxVal) maxVal = val;
      }
      envelope[i] = maxVal;
    }
    
    // Compute derivative (onset function)
    const onset = new Float32Array(dsLength);
    for (let i = 1; i < dsLength; i++) {
      onset[i] = Math.max(0, envelope[i] - envelope[i - 1]);
    }
    
    // Find peaks in the onset curve
    let sum = 0;
    for (let i = 0; i < dsLength; i++) sum += onset[i];
    const avgOnset = sum / dsLength;
    const threshold = avgOnset * 2.0; // Higher threshold for clear transients
    
    const beatDurationMs = 60000 / bpm;
    const minPeakDist = Math.round(beatDurationMs * 0.85); // 15% tolerance
    
    const peaksMs = [];
    let lastPeakIdx = -minPeakDist;
    for (let i = 1; i < dsLength - 1; i++) {
      if (onset[i] > onset[i - 1] && onset[i] > onset[i + 1] && onset[i] > threshold) {
        if (i - lastPeakIdx >= minPeakDist) {
          peaksMs.push(i); // peak index represents milliseconds
          lastPeakIdx = i;
        }
      }
    }
    
    if (peaksMs.length === 0) return 0;
    
    // Score candidate offsets
    const beatDurationSec = 60 / bpm;
    let bestOffsetSec = 0;
    let maxScore = 0;
    
    // Test the first 5 peaks as candidate offsets
    const candidates = peaksMs.slice(0, 5).map(p => (p / 1000) % beatDurationSec);
    
    candidates.forEach(cand => {
      let score = 0;
      peaksMs.forEach(p => {
        const pSec = p / 1000;
        const diff = Math.abs((pSec - cand) % beatDurationSec);
        const minDiff = Math.min(diff, beatDurationSec - diff);
        if (minDiff < 0.04) { // 40ms alignment tolerance
          score += (1 - minDiff / 0.04);
        }
      });
      
      if (score > maxScore) {
        maxScore = score;
        bestOffsetSec = cand;
      }
    });
    
    return bestOffsetSec;
  } catch (err) {
    console.error("Failed to estimate beat offset:", err);
    return 0;
  }
}

function applyCenterSnap(param, newVal) {
  if (!snapEnabled) return newVal;
  
  let target = null;
  let range = null;
  
  const p = param.toUpperCase();
  if (['BASS', 'LOW', 'TREB', 'PITCH', 'PAN'].includes(p)) {
    target = 0;
    range = (p === 'PAN') ? 200 : 24; // Pan range is 200 (-100 to 100), others are 24 (-12 to 12)
  } else if (p === 'FILT' || p === 'FILTER') {
    target = 50;
    range = 100;
  } else if (p === 'SPEED') {
    target = 100;
    range = 150; // min 50, max 200
  }
  
  if (target !== null && range !== null) {
    const thresholdVal = (snapThresholdPct / 100) * range;
    if (Math.abs(newVal - target) <= thresholdVal) {
      return target;
    }
  }
  
  return newVal;
}

async function handleDeviceLost() {
  logConsole('Warning: Device has been lost (unplugged).', 'err');
  
  if (serialReaderLoop) {
    try { await serialReaderLoop.cancel(); } catch(e){}
    serialReaderLoop = null;
  }
  
  if (activeWriter) {
    try { activeWriter.releaseLock(); } catch(e){}
    activeWriter = null;
  }
  
  if (activePort) {
    try { await activePort.close(); } catch(e){}
    activePort = null;
  }
  
  setConnectedStatus(false);
  showConnectionModal();
}

let autoConnectInterval = null;

function startAutoConnectScanner() {
  if (autoConnectInterval) return;
  autoConnectInterval = setInterval(async () => {
    if (activePort) return; // Already connected
    if (navigator.serial) {
      try {
        const ports = await navigator.serial.getPorts();
        if (ports.length > 0) {
          const port = ports[0];
          logConsole('Info: Auto-scanner detected COM port. Connecting...', 'system');
          await port.open({ baudRate: 115200 });
          
          activePort = port;
          activeWriter = port.writable.getWriter();
          
          // Update UI dropdown
          const select = document.getElementById('port-select');
          let portName = 'COM';
          if (select && select.options.length > 1) {
            select.selectedIndex = 1;
            portName = select.value;
            select.disabled = true;
          }
          
          setConnectedStatus(true, portName);
          startReading(port);
          await initSerialHandshake();
          
          logConsole(`Success: Connected to ${portName}!`, 'system');
          hideConnectionModal();
        }
      } catch (err) {
        // Silently skip if port cannot be opened (e.g., unplugged or locked)
      }
    }
  }, 1000);
}

async function scanPorts() {
  logConsole('Info: Scanning and automatically connecting serial ports...', 'system');
  ipcRenderer.send('set-target-port', '');
  
  try {
    const port = await navigator.serial.requestPort();
    if (port) {
      await port.open({ baudRate: 115200 });
      
      activePort = port;
      activeWriter = port.writable.getWriter();
      
      // Update UI dropdown
      const select = document.getElementById('port-select');
      let portName = 'COM';
      if (select && select.options.length > 1) {
        select.selectedIndex = 1;
        portName = select.value;
        select.disabled = true;
      }
      
      setConnectedStatus(true, portName);
      startReading(port);
      await initSerialHandshake();
      
      logConsole(`Success: Automatically connected to ${portName}!`, 'system');
    }
  } catch (err) {
    logConsole(`Info: No serial port found or connection failed: ${err.message}`, 'system');
  }
}

ipcRenderer.on('serial-ports-list', (event, portList) => {
  const select = document.getElementById('port-select');
  const prevVal = select.value;
  select.innerHTML = '<option value="">None</option>';
  
  portList.forEach(port => {
    const opt = document.createElement('option');
    opt.value = port.portName;
    opt.textContent = port.portName;
    select.appendChild(opt);
  });

  if (prevVal && portList.find(p => p.portName === prevVal)) {
    select.value = prevVal;
  }
  
  logConsole(`Info: COM ports detected: [${portList.map(p => p.portName).join(', ')}]`, 'system');
});

async function toggleConnection() {
  const select = document.getElementById('port-select');
  const portName = select.value;

  if (activePort) {
    logConsole('Info: Serial disconnect...', 'system');
    try {
      await sendSerialMessage('CONN:0');
      
      if (serialReaderLoop) {
        await serialReaderLoop.cancel();
        serialReaderLoop = null;
      }
      
      if (activeWriter) {
        activeWriter.releaseLock();
        activeWriter = null;
      }
      
      await activePort.close();
      activePort = null;
      
      setConnectedStatus(false);
      logConsole('Success: Disconnected from ESP32.', 'system');
    } catch (err) {
      logConsole(`Err: Disconnect failed: ${err.message}`, 'err');
      activePort = null;
      activeWriter = null;
      setConnectedStatus(false);
    }
  } else {
    if (!portName) {
      logConsole('Warning: Select a COM port!', 'err');
      return;
    }
    
    logConsole(`Info: Connecting to ${portName}...`, 'system');
    ipcRenderer.send('set-target-port', portName);
    
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      
      activePort = port;
      activeWriter = port.writable.getWriter();
      
      setConnectedStatus(true, portName);
      startReading(port);
      await initSerialHandshake();
      
      logConsole(`Success: Connected to ${portName}!`, 'system');
    } catch (err) {
      logConsole(`Err: Serial connection failed: ${err.message}`, 'err');
    }
  }
}

function setConnectedStatus(connected, portName = '') {
  const led = document.getElementById('connection-led');
  const text = document.getElementById('connection-status');
  const btn = document.getElementById('btn-connect');
  const select = document.getElementById('port-select');
  
  if (connected) {
    led.className = 'conn-led connected';
    text.textContent = `CONNECTED: ${portName}`;
    btn.textContent = 'DISCONNECT';
    select.disabled = true;
  } else {
    led.className = 'conn-led disconnected';
    text.textContent = 'DISCONNECTED';
    btn.textContent = 'CONNECT';
    select.disabled = false;
  }
}

function animateValue(trackNum, paramKey, startVal, targetVal, setterFn) {
  const duration = 800; // 800ms duration for a smooth visual sweep
  const startTime = performance.now();
  
  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    
    // Easing function (easeOutQuad)
    const easeProgress = progress * (2 - progress);
    let currentVal = startVal + (targetVal - startVal) * easeProgress;
    
    if (!paramKey.endsWith('_SPEED') && !paramKey.endsWith('_POS')) {
      currentVal = Math.round(currentVal);
    }
    
    if (progress < 1) {
      if (paramKey.endsWith('_POS')) {
        setterFn(trackNum, currentVal, true); // forceNoAudioSeek = true
      } else {
        setterFn(trackNum, currentVal);
      }
      requestAnimationFrame(update);
    } else {
      setterFn(trackNum, targetVal, false);
    }
  }
  
  requestAnimationFrame(update);
}

async function initSerialHandshake() {
  syncedParams = {}; // Reset tracking so we re-animate knobs on handshake completion
  if (handshakeInterval) {
    clearInterval(handshakeInterval);
  }

  // Send CONN:1 immediately
  await sendSerialMessage('CONN:1');

  let attempts = 1;
  handshakeInterval = setInterval(async () => {
    if (activePort && attempts < 5) {
      await sendSerialMessage('CONN:1');
      attempts++;
    } else {
      clearInterval(handshakeInterval);
      handshakeInterval = null;
    }
  }, 1000);
}

// -------------------------------------------------------------
// Serial Read/Write Processing (TX/RX)
// -------------------------------------------------------------

async function sendSerialMessage(msg) {
  if (activeWriter) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(msg + '\n');
      await activeWriter.write(data);
      logConsole(`TX (Serial) -> ${msg}`, 'tx');
    } catch (err) {
      logConsole(`Err: Serial write failed: ${err.message}`, 'err');
    }
  }
  
  if (esp32Ip) {
    try {
      const dgram = require('dgram');
      const client = dgram.createSocket('udp4');
      const data = Buffer.from(msg + '\n');
      client.send(data, esp32Port, esp32Ip, (err) => {
        client.close();
        if (err) {
          logConsole(`Err UDP TX: ${err.message}`, 'err');
        } else {
          logConsole(`TX (UDP) -> ${msg}`, 'tx');
        }
      });
    } catch (err) {
      logConsole(`Err UDP Invio: ${err.message}`, 'err');
    }
  }
}

async function startReading(port) {
  const textDecoder = new TextDecoderStream();
  serialReaderLoop = port.readable.pipeTo(textDecoder.writable);
  const reader = textDecoder.readable.getReader();
  
  let buffer = '';
  
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        buffer += value;
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            parseIncomingMessage(line);
          }
        }
      }
    }
  } catch (err) {
    logConsole(`Err: Serial read error: ${err.message}`, 'err');
    if (activePort) {
      handleDeviceLost();
    }
  } finally {
    reader.releaseLock();
  }
}

function parseIncomingMessage(msg) {
  logConsole(`RX <- ${msg}`, 'rx');
  
  if (handshakeInterval) {
    clearInterval(handshakeInterval);
    handshakeInterval = null;
    logConsole("Info: ESP32 synchronization completed successfully!", "system");
  }
  
  const parts = msg.split(':');
  if (parts.length < 3) return;
  
  const trackStr = parts[0];
  const param = parts[1].toUpperCase();
  const val = parseInt(parts[2]);
  
  if (isNaN(val)) return;

  const trackNum = (trackStr === 'T1') ? 1 : (trackStr === 'T2') ? 2 : null;
  if (!trackNum) return;

  const paramKey = `${trackNum}_${param}`;
  const isFirstSync = !syncedParams[paramKey];
  if (isFirstSync) {
    syncedParams[paramKey] = true;
  }

  switch (param) {
    case 'VOL': {
      const mappedVol = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`vol-${trackNum}`).value) || 80;
        animateValue(trackNum, paramKey, start, mappedVol, setVolume);
      } else {
        setVolume(trackNum, mappedVol);
      }
      break;
    }
    case 'BASS': {
      const mappedGain = (val / 1023) * 24 - 12;
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`bass-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedGain, (t, v) => setEQ(t, 'bass', v));
      } else {
        setEQ(trackNum, 'bass', mappedGain);
      }
      break;
    }
    case 'LOW': {
      const mappedGain = (val / 1023) * 24 - 12;
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`low-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedGain, (t, v) => setEQ(t, 'low', v));
      } else {
        setEQ(trackNum, 'low', mappedGain);
      }
      break;
    }
    case 'TREB': {
      const mappedGain = (val / 1023) * 24 - 12;
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`treb-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedGain, (t, v) => setEQ(t, 'treb', v));
      } else {
        setEQ(trackNum, 'treb', mappedGain);
      }
      break;
    }
    case 'PITCH': {
      const mappedPitch = (val / 1023) * 24 - 12;
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`pitch-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedPitch, setPitch);
      } else {
        setPitch(trackNum, mappedPitch);
      }
      break;
    }
    case 'SPEED': {
      const mappedSpeed = (val / 1023) * 150 + 50; // 50% to 200%
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`speed-${trackNum}`).value) || 100;
        animateValue(trackNum, paramKey, start, mappedSpeed, setSpeed);
      } else {
        setSpeed(trackNum, mappedSpeed);
      }
      break;
    }
    case 'ECHO': {
      const mappedEcho = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`echo-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedEcho, setEcho);
      } else {
        setEcho(trackNum, mappedEcho);
      }
      break;
    }
    case 'FILT': {
      const mappedFilt = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`filter-${trackNum}`).value) || 50;
        animateValue(trackNum, paramKey, start, mappedFilt, setFilter);
      } else {
        setFilter(trackNum, mappedFilt);
      }
      break;
    }
    case 'PAN': {
      const mappedPan = Math.round((val / 1023) * 200 - 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`pan-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedPan, setPan);
      } else {
        setPan(trackNum, mappedPan);
      }
      break;
    }
    case 'REV': {
      const mappedRev = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`reverb-${trackNum}`).value) || 0;
        animateValue(trackNum, paramKey, start, mappedRev, setReverb);
      } else {
        setReverb(trackNum, mappedRev);
      }
      break;
    }
    case 'ECHOTIME': {
      const mappedEchoTime = Math.round((val / 1023) * 900 + 100); // 100 to 1000
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`echotime-${trackNum}`).value) || 350;
        animateValue(trackNum, paramKey, start, mappedEchoTime, setEchoTime);
      } else {
        setEchoTime(trackNum, mappedEchoTime);
      }
      break;
    }
    case 'INST': {
      const mappedVol = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`inst-${trackNum}`).value) || 100;
        animateValue(trackNum, paramKey, start, mappedVol, (t, v) => setStemVolume(t, 'inst', Math.round(v)));
      } else {
        setStemVolume(trackNum, 'inst', mappedVol);
      }
      break;
    }
    case 'MAIN': {
      const mappedVol = Math.round((val / 1023) * 100);
      setStemVolume(trackNum, 'main', mappedVol);
      break;
    }
    case 'LYR':
    case 'VOC': {
      const mappedVol = Math.round((val / 1023) * 100);
      if (isFirstSync) {
        const start = parseFloat(document.getElementById(`voc-${trackNum}`).value) || 100;
        animateValue(trackNum, paramKey, start, mappedVol, (t, v) => setStemVolume(t, 'vocals', Math.round(v)));
      } else {
        setStemVolume(trackNum, 'vocals', mappedVol);
      }
      break;
    }
    case 'POS': {
      const mappedPercent = Math.max(0, Math.min(100, Math.round((val / 2040) * 100)));
      if (isFirstSync) {
        const fill = document.getElementById(`progress-fill-${trackNum}`);
        const start = fill ? (parseFloat(fill.style.width) || 0) : 0;
        animateValue(trackNum, paramKey, start, mappedPercent, seekTrack);
      } else {
        seekTrack(trackNum, mappedPercent);
      }
      break;
    }
    case 'PLAY': {
      if (val === 1) togglePlayTrack(trackNum);
      break;
    }
    case 'STOP': {
      if (val === 1) stopTrack(trackNum);
      break;
    }
    default:
      logConsole(`Warning: Command '${param}' not handled`, 'err');
  }
}

function logConsole(text, type = '') {
  const consoleLog = document.getElementById('console-log');
  if (!consoleLog) return;
  
  const div = document.createElement('div');
  div.className = `log-line ${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  consoleLog.appendChild(div);
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

function sendManualCommand() {
  const input = document.getElementById('console-input');
  const cmd = input.value.trim();
  if (cmd) {
    if (activeWriter) {
      sendSerialMessage(cmd);
    } else {
      logConsole(`Simulator: Executing '${cmd}'`, 'system');
      parseIncomingMessage(cmd);
    }
    input.value = '';
  }
}

// -------------------------------------------------------------
// Real-time Canvas Rendering (exertia Solid Green Style)
// -------------------------------------------------------------

function startVisualizers() {
  [1, 2].forEach(trackNum => {
    const canvas = document.getElementById(`canvas-${trackNum}`);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    function resizeCanvas() {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    const track = tracks[trackNum];
    
    function draw() {
      requestAnimationFrame(draw);
      
      try {
        if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
          canvas.width = canvas.clientWidth;
          canvas.height = canvas.clientHeight;
        }
        
        const width = canvas.width;
        const height = canvas.height;
        if (width <= 0 || height <= 0) return;

        const trackColor = (trackNum === 1) ? '#00ffcc' : '#ff5500';

        // Hide or show the overview canvas
        const overviewCanvas = document.getElementById(`overview-canvas-${trackNum}`);
        if (overviewCanvas) {
          overviewCanvas.style.display = (track.visMode === 'waveform') ? 'block' : 'none';
        }
        
        let refAudio = null;
        if (track.stems.main.exists) refAudio = track.stems.main.audio;
        else if (track.stems.vocals.exists) refAudio = track.stems.vocals.audio;
        else if (track.stems.inst.audios.length > 0) refAudio = track.stems.inst.audios[0].audio;
        else if (track.isSynth && track.fallbackAudio) refAudio = track.fallbackAudio;
        
        const duration = (refAudio && refAudio.duration && !isNaN(refAudio.duration) && refAudio.duration > 0) ? refAudio.duration : 180;

        // Draw Overview Waveform if available and in waveform mode
        if (overviewCanvas && track.visMode === 'waveform' && track.staticWaveform && track.staticWaveform.length > 0) {
          const oCtx = overviewCanvas.getContext('2d');
          const oW = overviewCanvas.width = overviewCanvas.clientWidth;
          const oH = overviewCanvas.height = overviewCanvas.clientHeight;
          
          if (oW > 0 && oH > 0) {
            oCtx.fillStyle = '#0d0d0d';
            oCtx.fillRect(0, 0, oW, oH);
            
            // Draw continuous Audacity-style waveform for overview (unplayed grey base with gradient)
            const unplayedGrad = oCtx.createLinearGradient(0, oH * 0.1, 0, oH * 0.9);
            unplayedGrad.addColorStop(0, '#2a2a2a');
            unplayedGrad.addColorStop(0.5, '#5c5c5c');
            unplayedGrad.addColorStop(1, '#2a2a2a');
            oCtx.fillStyle = unplayedGrad;
            
            oCtx.beginPath();
            let first = true;
            const step = oW / track.staticWaveform.length;
            for (let i = 0; i < track.staticWaveform.length; i++) {
              const peak = track.staticWaveform[i];
              const h = Math.max(1, peak * oH * 0.85);
              const y = (oH - h) / 2;
              const x = i * step;
              if (first) {
                oCtx.moveTo(x, y);
                first = false;
              } else {
                oCtx.lineTo(x, y);
              }
            }
            for (let i = track.staticWaveform.length - 1; i >= 0; i--) {
              const peak = track.staticWaveform[i];
              const h = Math.max(1, peak * oH * 0.85);
              const y = (oH + h) / 2;
              const x = i * step;
              oCtx.lineTo(x, y);
            }
            oCtx.closePath();
            oCtx.fill();
            
            // Fill the played portion in gradient color
            let currentPct = 0;
            if (refAudio) {
              currentPct = refAudio.currentTime / duration;
            }
            const playedX = Math.max(0, Math.min(oW, currentPct * oW));
            
            oCtx.save();
            oCtx.beginPath();
            oCtx.rect(0, 0, playedX, oH);
            oCtx.clip();
            
            const playedGrad = oCtx.createLinearGradient(0, oH * 0.1, 0, oH * 0.9);
            if (trackNum === 1) {
              playedGrad.addColorStop(0, '#00b38f');
              playedGrad.addColorStop(0.5, '#b3fff0');
              playedGrad.addColorStop(1, '#00b38f');
            } else {
              playedGrad.addColorStop(0, '#cc4400');
              playedGrad.addColorStop(0.5, '#ffccb3');
              playedGrad.addColorStop(1, '#cc4400');
            }
            oCtx.fillStyle = playedGrad;
            
            oCtx.beginPath();
            first = true;
            for (let i = 0; i < track.staticWaveform.length; i++) {
              const peak = track.staticWaveform[i];
              const h = Math.max(1, peak * oH * 0.85);
              const y = (oH - h) / 2;
              const x = i * step;
              if (first) {
                oCtx.moveTo(x, y);
                first = false;
              } else {
                oCtx.lineTo(x, y);
              }
            }
            for (let i = track.staticWaveform.length - 1; i >= 0; i--) {
              const peak = track.staticWaveform[i];
              const h = Math.max(1, peak * oH * 0.85);
              const y = (oH + h) / 2;
              const x = i * step;
              oCtx.lineTo(x, y);
            }
            oCtx.closePath();
            oCtx.fill();
            oCtx.restore();
            
            // Draw moving vertical playhead indicator (red line)
            oCtx.strokeStyle = '#ff003c';
            oCtx.lineWidth = 1.5;
            oCtx.beginPath();
            oCtx.moveTo(playedX, 0);
            oCtx.lineTo(playedX, oH);
            oCtx.stroke();

            // Highlight loop region on overview
            if (track.loopEnabled && track.loopStartTime !== null && track.loopEndTime !== null) {
              const loopStartX = (track.loopStartTime / duration) * oW;
              const loopEndX = (track.loopEndTime / duration) * oW;
              
              oCtx.fillStyle = 'rgba(0, 255, 204, 0.25)';
              oCtx.fillRect(loopStartX, 0, loopEndX - loopStartX, oH);
              oCtx.strokeStyle = '#00ffcc';
              oCtx.lineWidth = 1;
              oCtx.beginPath();
              oCtx.moveTo(loopStartX, 0); oCtx.lineTo(loopStartX, oH);
              oCtx.moveTo(loopEndX, 0); oCtx.lineTo(loopEndX, oH);
              oCtx.stroke();
            }

            // Draw Hot Cues on overview
            if (track.hotCues) {
              const hotCueColors = ['#ff0055', '#ffaa00', '#ffff00', '#00ff00', '#00ffff', '#0055ff', '#aa00ff', '#ff00aa'];
              for (let i = 0; i < 8; i++) {
                const cueTime = track.hotCues[i];
                if (cueTime !== null) {
                  const cueColor = hotCueColors[i % hotCueColors.length];
                  const cueX = (cueTime / duration) * oW;
                  oCtx.fillStyle = cueColor;
                  oCtx.beginPath();
                  oCtx.moveTo(cueX - 3, 0);
                  oCtx.lineTo(cueX + 3, 0);
                  oCtx.lineTo(cueX, 4);
                  oCtx.fill();
                  oCtx.strokeStyle = cueColor;
                  oCtx.lineWidth = 1;
                  oCtx.beginPath();
                  oCtx.moveTo(cueX, 0);
                  oCtx.lineTo(cueX, oH);
                  oCtx.stroke();
                }
              }
            }
          }
        }
        
        // Loop Check
        if (track.loopEnabled && track.loopStartTime !== null && track.loopEndTime !== null && track.loopEndTime > track.loopStartTime) {
          if (refAudio && refAudio.currentTime >= track.loopEndTime) {
            const overshoot = refAudio.currentTime - track.loopEndTime;
            const targetTime = track.loopStartTime + (overshoot % (track.loopEndTime - track.loopStartTime));
            
            if (track.stems.main.exists) track.stems.main.audio.currentTime = targetTime;
            if (track.stems.vocals.exists) track.stems.vocals.audio.currentTime = targetTime;
            track.stems.inst.audios.forEach(item => item.audio.currentTime = targetTime);
          }
        }
        
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(0, 0, width, height);
        
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 1;
        for (let x = 0; x < width; x += 20) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
        
        const mode = track.visMode || 'waveform';
        
        let refAnalyser = null;
        if (track.analyser && track.isPlaying) {
          refAnalyser = track.analyser;
        }

        
        if (mode === 'osc') {
          if (refAnalyser) {
            const bufferLength = refAnalyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            refAnalyser.getByteTimeDomainData(dataArray);
            
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = trackColor;
            ctx.beginPath();
            
            const sliceWidth = width / bufferLength;
            let x = 0;
            
            for (let i = 0; i < bufferLength; i++) {
              const v = dataArray[i] / 128.0;
              const y = (v * height) / 2;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
              x += sliceWidth;
            }
            ctx.lineTo(width, height / 2);
            ctx.stroke();
          } else {
            ctx.strokeStyle = '#444';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();
          }
        } else if (mode === 'spectrum') {
          if (refAnalyser) {
            const bufferLength = refAnalyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            refAnalyser.getByteFrequencyData(dataArray);
            
            const numBars = 40;
            const barWidth = width / numBars;
            
            for (let i = 0; i < numBars; i++) {
              const dataIndex = Math.floor((i / numBars) * (bufferLength * 0.6));
              const val = dataArray[dataIndex] || 0;
              const barHeight = (val / 255) * height * 0.85;
              ctx.fillStyle = trackColor;
              ctx.fillRect(i * barWidth, height - barHeight, barWidth - 1.5, barHeight);
            }
          } else {
            ctx.strokeStyle = '#444';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();
          }
        } else if (mode === 'waveform') {
          // SCROLLING AUDIO WAVEFORM (Audacity Smooth Style)
          if (track.staticWaveform && track.staticWaveform.length > 0) {
            let currentPct = 0;
            if (refAudio) {
              currentPct = refAudio.currentTime / duration;
            } else {
              const fill = document.getElementById(`progress-fill-${trackNum}`);
              if (fill && fill.style.width) {
                currentPct = parseFloat(fill.style.width) / 100;
              }
            }
            
            // Draw grid/background
            ctx.fillStyle = '#0d0d0d';
            ctx.fillRect(0, 0, width, height);
            
            // Draw grid lines
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.lineWidth = 1;
            for (let x = 0; x < width; x += 40) {
              ctx.beginPath();
              ctx.moveTo(x, 0);
              ctx.lineTo(x, height);
              ctx.stroke();
            }
            
            const visibleSeconds = 30; // Zoomed out as requested
            const zoomPercent = (visibleSeconds / 2) / duration;
            
            // Draw smooth Audacity-style waveform (Top and Bottom curves filled with gradient)
            function drawContinuousWaveform(startPixel, endPixel, colorType) {
              const grad = ctx.createLinearGradient(0, height * 0.075, 0, height * 0.925);
              if (colorType === 'played') {
                if (trackNum === 1) {
                  grad.addColorStop(0, '#00b38f');
                  grad.addColorStop(0.5, '#b3fff0');
                  grad.addColorStop(1, '#00b38f');
                } else {
                  grad.addColorStop(0, '#cc4400');
                  grad.addColorStop(0.5, '#ffccb3');
                  grad.addColorStop(1, '#cc4400');
                }
              } else {
                grad.addColorStop(0, '#2e2e2e');
                grad.addColorStop(0.5, '#5c5c5c');
                grad.addColorStop(1, '#2e2e2e');
              }

              ctx.fillStyle = grad;
              ctx.beginPath();
              
              let first = true;
              // Top half
              for (let pixelX = startPixel; pixelX <= endPixel; pixelX += 2) {
                const pct = currentPct + ((pixelX - width / 2) / (width / 2)) * zoomPercent;
                if (pct >= 0 && pct <= 1) {
                  const waveformIndex = Math.floor(pct * track.staticWaveform.length);
                  const peak = track.staticWaveform[waveformIndex] || 0;
                  const h = Math.max(1, peak * height * 0.85);
                  const y = (height - h) / 2;
                  if (first) {
                    ctx.moveTo(pixelX, y);
                    first = false;
                  } else {
                    ctx.lineTo(pixelX, y);
                  }
                }
              }
              
              // Bottom half
              for (let pixelX = endPixel; pixelX >= startPixel; pixelX -= 2) {
                const pct = currentPct + ((pixelX - width / 2) / (width / 2)) * zoomPercent;
                if (pct >= 0 && pct <= 1) {
                  const waveformIndex = Math.floor(pct * track.staticWaveform.length);
                  const peak = track.staticWaveform[waveformIndex] || 0;
                  const h = Math.max(1, peak * height * 0.85);
                  const y = (height + h) / 2;
                  ctx.lineTo(pixelX, y);
                }
              }
              
              ctx.closePath();
              ctx.fill();
            }
            
            // Draw played section (left of center playhead)
            drawContinuousWaveform(0, width / 2, 'played');
            
            // Draw unplayed section (right of center playhead)
            drawContinuousWaveform(width / 2, width, 'unplayed');
            
            // Draw horizontal center line on top of the scrolling waveform (Audacity style)
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();

            // Draw Rekordbox-style beat grid lines
            const beatDuration = 60 / track.bpmVal;
            const offset = track.beatOffset || 0;
            const leftTime = (currentPct - zoomPercent) * duration;
            const rightTime = (currentPct + zoomPercent) * duration;
            
            const firstVisibleBeat = Math.ceil((leftTime - offset) / beatDuration);
            const lastVisibleBeat = Math.floor((rightTime - offset) / beatDuration);
            
            for (let n = Math.max(0, firstVisibleBeat); n <= lastVisibleBeat; n++) {
              const beatTime = offset + n * beatDuration;
              const beatPct = beatTime / duration;
              const beatX = width / 2 + ((beatPct - currentPct) / zoomPercent) * (width / 2);
              
              if (n % 4 === 0) {
                // Downbeat (Red/orange line with bar number)
                ctx.strokeStyle = 'rgba(255, 0, 60, 0.45)';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.moveTo(beatX, 0);
                ctx.lineTo(beatX, height);
                ctx.stroke();
                
                ctx.fillStyle = 'rgba(255, 0, 60, 0.7)';
                ctx.font = '8px monospace';
                ctx.textAlign = 'left';
                ctx.fillText(Math.floor(n / 4) + 1, beatX + 3, 10);
              } else {
                // Offbeat (White/grey line)
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.moveTo(beatX, 0);
                ctx.lineTo(beatX, height);
                ctx.stroke();
                
                ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
                ctx.font = '8px monospace';
                ctx.textAlign = 'left';
                ctx.fillText((n % 4) + 1, beatX + 3, height - 4);
              }
            }

            // Draw fixed center playhead (Red line with Rekordbox triangles)
            ctx.strokeStyle = '#ff003c';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(width / 2, 0);
            ctx.lineTo(width / 2, height);
            ctx.stroke();
            
            // Top playhead triangle marker
            ctx.fillStyle = '#ff003c';
            ctx.beginPath();
            ctx.moveTo(width / 2 - 5, 0);
            ctx.lineTo(width / 2 + 5, 0);
            ctx.lineTo(width / 2, 6);
            ctx.closePath();
            ctx.fill();
            
            // Bottom playhead triangle marker
            ctx.beginPath();
            ctx.moveTo(width / 2 - 5, height);
            ctx.lineTo(width / 2 + 5, height);
            ctx.lineTo(width / 2, height - 6);
            ctx.closePath();
            ctx.fill();
            
            // Highlight current loop boundaries on scrolling waveform
            if (track.loopEnabled && track.loopStartTime !== null && track.loopEndTime !== null) {
              const startPct = track.loopStartTime / duration;
              const endPct = track.loopEndTime / duration;
              
              const startX = width / 2 + ((startPct - currentPct) / zoomPercent) * (width / 2);
              const endX = width / 2 + ((endPct - currentPct) / zoomPercent) * (width / 2);
              
              ctx.fillStyle = 'rgba(0, 255, 204, 0.15)';
              ctx.fillRect(startX, 0, endX - startX, height);
              
              ctx.strokeStyle = '#00ffcc';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(startX, 0); ctx.lineTo(startX, height);
              ctx.moveTo(endX, 0); ctx.lineTo(endX, height);
              ctx.stroke();
            }
            
            // Draw Hot Cues on scrolling waveform
            if (track.hotCues) {
              const hotCueColors = ['#ff0055', '#ffaa00', '#ffff00', '#00ff00', '#00ffff', '#0055ff', '#aa00ff', '#ff00aa'];
              for (let i = 0; i < 8; i++) {
                const cueTime = track.hotCues[i];
                if (cueTime !== null) {
                  const cuePct = cueTime / duration;
                  const cueX = width / 2 + ((cuePct - currentPct) / zoomPercent) * (width / 2);
                  
                  if (cueX >= 0 && cueX <= width) {
                    const cueColor = hotCueColors[i % hotCueColors.length];
                    ctx.strokeStyle = cueColor;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(cueX, 0);
                    ctx.lineTo(cueX, height);
                    ctx.stroke();
                    
                    const text = `CUE ${i + 1}`;
                    ctx.font = 'bold 9px monospace';
                    const textWidth = ctx.measureText(text).width;
                    const rectWidth = textWidth + 8;
                    const rectHeight = 14;
                    
                    ctx.fillStyle = cueColor;
                    ctx.fillRect(cueX, height - rectHeight, rectWidth, rectHeight);
                    
                    ctx.fillStyle = '#111';
                    ctx.textAlign = 'left';
                    ctx.fillText(text, cueX + 4, height - 4);
                  }
                }
              }
            }
          } else {
            ctx.fillStyle = '#666';
            ctx.font = '12px monospace';
            ctx.textAlign = 'center';
            ctx.fillText("NO AUDIO FILE LOADED", width / 2, height / 2 + 3);
          }
        }

        if (track.analyser) {
          const bufferLength = track.analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          track.analyser.getByteTimeDomainData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0 - 1.0;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / bufferLength);
          let level = Math.min(1, rms * 3.5);
          const vuCover = document.getElementById(`vu-bar-t${trackNum}-cover`);
          if (vuCover) {
            vuCover.style.width = (100 - level * 100) + '%';
          }
        }

      } catch (err) {
        console.error("Track visualizer draw error:", err);
      }
    }
    
    draw();
  });
}

// Adds dynamic vertical drag physics to custom knobs
function setupKnobDrag(trackNum, param) {
  const wrapper = document.getElementById(`knob-${param}-${trackNum}-wrapper`);
  const slider = document.getElementById(`${param}-${trackNum}`);
  if (!wrapper || !slider) return;

  let isDragging = false;
  let startY = 0;
  let startValue = 0;

  // Determine center snap target if applicable
  let snapTarget = null;
  if (['bass', 'low', 'treb', 'pitch', 'pan'].includes(param)) {
    snapTarget = 0;
  } else if (param === 'filter') {
    snapTarget = 50;
  } else if (param === 'speed') {
    snapTarget = 100;
  }

  wrapper.addEventListener('mousedown', (e) => {
    isDragging = true;
    startY = e.clientY;
    startValue = parseFloat(slider.value);
    
    // Add temp listeners to window to support dragging outside the bounds
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault(); // Prevent text highlights
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    const deltaY = startY - e.clientY; // drag up increases
    
    const rangePixels = 100; // sensitivity
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const range = max - min;
    
    let newVal = startValue + (deltaY / rangePixels) * range;
    newVal = Math.max(min, Math.min(max, newVal));
    
    // Apply center snap if enabled and parameter is eligible
    if (snapEnabled && snapTarget !== null) {
      const thresholdVal = (snapThresholdPct / 100) * range;
      if (Math.abs(newVal - snapTarget) <= thresholdVal) {
        newVal = snapTarget;
      }
    }
    
    slider.value = newVal;
    
    // Fire the input event on the slider
    slider.dispatchEvent(new Event('input'));
  }

  function onMouseUp() {
    isDragging = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }
}

// Allows vertical dragging of the % symbol to adjust volume
function setupVolumePercentDrag(trackNum) {
  const percentSymbol = document.querySelector(`#track-${trackNum} .vol-percent-symbol`);
  if (!percentSymbol) return;

  percentSymbol.style.cursor = 'ns-resize';
  percentSymbol.style.userSelect = 'none';

  let isDragging = false;
  let startY = 0;
  let startVal = 80;

  percentSymbol.addEventListener('mousedown', (e) => {
    isDragging = true;
    startY = e.clientY;
    startVal = parseInt(document.getElementById(`vol-${trackNum}`).value) || 80;

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    const deltaY = startY - e.clientY; // Drag up increases
    const sensitivity = 0.6; // Scale sensitivity
    let newVal = startVal + deltaY * sensitivity;
    newVal = Math.max(0, Math.min(100, Math.round(newVal)));
    setVolume(trackNum, newVal);
  }

  function onMouseUp() {
    isDragging = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }
}

function startUdpServer() {
  try {
    const dgram = require('dgram');
    const server = dgram.createSocket('udp4');
    
    server.on('error', (err) => {
      logConsole(`UDP Server Error: ${err.message}`, 'err');
      try { server.close(); } catch(e){}
    });
    
    server.on('message', (msg, rinfo) => {
      esp32Ip = rinfo.address; // Save the IP of the ESP32
      const data = msg.toString().trim();
      const lines = data.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          parseIncomingMessage(line.trim());
        }
      });
    });
    
    server.on('listening', () => {
      const address = server.address();
      logConsole(`UDP Server listening on port ${address.port}`, 'system');
      
      // No connection status UI update for UDP server
    });
    
    server.bind(esp32Port);
    window.udpSocket = server;
  } catch (err) {
    logConsole(`UDP Initialization error: ${err.message}`, 'err');
  }
}

// -------------------------------------------------------------
// App Initialization
// -------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  loadSnapSettings(); // Load snap settings from local storage
  loadLayoutSettings(); // Load layout settings from local storage
  loadZoomSettings(); // Load zoom settings from local storage
  setupUIListeners();
  startVisualizers();
  
  document.getElementById('btn-refresh-ports').addEventListener('click', scanPorts);
  document.getElementById('btn-connect').addEventListener('click', toggleConnection);
  
  // Initialize all controls with standard values
  [1, 2].forEach(trackNum => {
    setVolume(trackNum, 80);
    ['bass', 'low', 'treb', 'pitch', 'pan', 'reverb'].forEach(param => updateKnobUI(trackNum, param, 0));
    ['inst', 'voc', 'speed'].forEach(param => updateKnobUI(trackNum, param, 100));
    updateKnobUI(trackNum, 'echo', 0);
    updateKnobUI(trackNum, 'filter', 50);
    updateKnobUI(trackNum, 'echotime', 350);
    setBPM(trackNum, 120);
    setBPMDiv(trackNum, '1/1');
    
    // Bind vertical drag physics to SVG knobs
    ['bass', 'low', 'treb', 'inst', 'voc', 'pitch', 'speed', 'echo', 'filter', 'pan', 'reverb', 'echotime'].forEach(param => {
      setupKnobDrag(trackNum, param);
    });
    setupVolumePercentDrag(trackNum);
  });
  
  // Proactive: Restore previously selected working directory if saved
  const savedDir = localStorage.getItem('notoMixer_workingDir');
  if (savedDir && fs.existsSync(savedDir)) {
    workingDir = savedDir;
    document.getElementById('working-dir-path').textContent = savedDir;
    const headerTitle = document.getElementById('songs-header-title');
    if (headerTitle) {
      headerTitle.textContent = `AVAILABLE SONGS (${savedDir})`;
    }
    scanWorkingDirectory();
  }
  
  // Modal Buttons listeners
  const btnRetry = document.getElementById('modal-btn-retry');
  if (btnRetry) {
    btnRetry.addEventListener('click', async () => {
      hideConnectionModal();
      try {
        await scanPorts();
        if (!activePort) {
          showConnectionModal();
        }
      } catch (err) {
        showConnectionModal();
      }
    });
  }

  const btnBypass = document.getElementById('modal-btn-bypass');
  if (btnBypass) {
    btnBypass.addEventListener('click', () => {
      hideConnectionModal();
      logConsole("Info: Using app in standalone mode (without notoMixer)", 'system');
    });
  }

  // Settings Button and Modal listeners
  const btnOpenSettings = document.getElementById('btn-open-settings');
  if (btnOpenSettings) {
    btnOpenSettings.addEventListener('click', () => {
      showSettingsModal();
    });
  }

  // BPM Filter Toggle Button
  const btnBpmFilter = document.getElementById('btn-bpm-filter');
  if (btnBpmFilter) {
    btnBpmFilter.dataset.track = '1';
    btnBpmFilter.addEventListener('click', () => {
      bpmFilterTrack = bpmFilterTrack === 1 ? 2 : 1;
      const trackNumSpan = document.getElementById('bpm-filter-track-num');
      if (trackNumSpan) trackNumSpan.textContent = bpmFilterTrack;
      btnBpmFilter.dataset.track = String(bpmFilterTrack);
      updateBpmCompatIndicators();
    });
  }

  // Search bar input
  const songSearchInput = document.getElementById('song-search-input');
  if (songSearchInput) {
    songSearchInput.addEventListener('input', (e) => {
      currentSearchQuery = e.target.value;
      applySongListFilters();
    });
  }

  // Status Filter button
  const btnStatusFilter = document.getElementById('btn-status-filter');
  if (btnStatusFilter) {
    btnStatusFilter.addEventListener('click', () => {
      // Cycle: ALL -> ✓ -> ⚠ -> ✗ -> ALL
      if (currentStatusFilter === 'ALL') {
        currentStatusFilter = '✓';
        btnStatusFilter.style.color = '#00ffcc';
        btnStatusFilter.style.borderColor = '#00ffcc';
      } else if (currentStatusFilter === '✓') {
        currentStatusFilter = '⚠';
        btnStatusFilter.style.color = '#ffcc00';
        btnStatusFilter.style.borderColor = '#ffcc00';
      } else if (currentStatusFilter === '⚠') {
        currentStatusFilter = '✗';
        btnStatusFilter.style.color = '#ff3333';
        btnStatusFilter.style.borderColor = '#ff3333';
      } else {
        currentStatusFilter = 'ALL';
        btnStatusFilter.style.color = 'white';
        btnStatusFilter.style.borderColor = 'var(--border-light)';
      }
      btnStatusFilter.textContent = currentStatusFilter;
      applySongListFilters();
    });
  }

  const btnCloseSettings = document.getElementById('settings-btn-close');
  if (btnCloseSettings) {
    btnCloseSettings.addEventListener('click', () => {
      // Revert settings changes in UI to current saved state
      const snapCheck = document.getElementById('setting-snap-enable');
      const snapSlider = document.getElementById('setting-snap-threshold');
      const snapDisplay = document.getElementById('snap-threshold-display');
      
      if (snapCheck) snapCheck.checked = snapEnabled;
      if (snapSlider) {
        snapSlider.value = snapThresholdPct;
        if (snapDisplay) snapDisplay.textContent = `${snapThresholdPct}%`;
      }

      const mainSelect = document.getElementById('setting-main-audio');
      const previewSelect = document.getElementById('setting-preview-audio');
      const savedMain = localStorage.getItem('notoMixer_mainAudioDevice');
      const savedPreview = localStorage.getItem('notoMixer_previewAudioDevice');
      if (mainSelect && savedMain) mainSelect.value = savedMain;
      if (previewSelect && savedPreview) previewSelect.value = savedPreview;
      
      const layoutSelect = document.getElementById('setting-layout-mode');
      if (layoutSelect) layoutSelect.value = layoutMode;
      const explorerLayoutSelect = document.getElementById('setting-explorer-layout');
      if (explorerLayoutSelect) explorerLayoutSelect.value = explorerLayout;
      
      // Revert Zoom changes in UI and DOM
      const zoomTextSlider = document.getElementById('setting-zoom-text');
      const zoomWaveformSlider = document.getElementById('setting-zoom-waveform');
      const zoomButtonsSlider = document.getElementById('setting-zoom-buttons');
      const zoomCoverSlider = document.getElementById('setting-zoom-cover');
      
      if (zoomTextSlider) zoomTextSlider.value = zoomText;
      if (zoomWaveformSlider) zoomWaveformSlider.value = zoomWaveform;
      if (zoomButtonsSlider) zoomButtonsSlider.value = zoomButtons;
      if (zoomCoverSlider) zoomCoverSlider.value = zoomCover;
      
      applyZoomSettings();
      
      hideSettingsModal();
    });
  }

  const btnSaveSettings = document.getElementById('settings-btn-save');
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', () => {
      const snapCheck = document.getElementById('setting-snap-enable');
      const snapSlider = document.getElementById('setting-snap-threshold');
      
      if (snapCheck) {
        snapEnabled = snapCheck.checked;
        localStorage.setItem('notoMixer_snapEnabled', snapEnabled ? 'true' : 'false');
      }
      if (snapSlider) {
        snapThresholdPct = parseInt(snapSlider.value) || 5;
        localStorage.setItem('notoMixer_snapThreshold', snapThresholdPct);
      }

      const mainSelect = document.getElementById('setting-main-audio');
      const previewSelect = document.getElementById('setting-preview-audio');
      if (mainSelect) {
        localStorage.setItem('notoMixer_mainAudioDevice', mainSelect.value);
        if (audioCtx && typeof audioCtx.setSinkId === 'function') {
          audioCtx.setSinkId(mainSelect.value === 'default' ? '' : mainSelect.value)
            .catch(err => {
              console.error("Error setting main sink ID on save, falling back to default:", err);
              audioCtx.setSinkId('');
            });
        }
      }
      if (previewSelect) {
        localStorage.setItem('notoMixer_previewAudioDevice', previewSelect.value);
        if (previewAudioCtx && typeof previewAudioCtx.setSinkId === 'function') {
          previewAudioCtx.setSinkId(previewSelect.value === 'default' ? '' : previewSelect.value)
            .catch(err => {
              console.error("Error setting preview sink ID on save, falling back to default:", err);
              previewAudioCtx.setSinkId('');
            });
        }
      }
      
      const layoutSelect = document.getElementById('setting-layout-mode');
      if (layoutSelect) {
        const newLayout = layoutSelect.value || 'default';
        localStorage.setItem('notoMixer_layoutMode', newLayout);
        applyLayoutMode(newLayout);
      }

      const explorerLayoutSelect = document.getElementById('setting-explorer-layout');
      if (explorerLayoutSelect) {
        const newExplorerLayout = explorerLayoutSelect.value || 'sidebar';
        localStorage.setItem('notoMixer_explorerLayout', newExplorerLayout);
        applyExplorerLayout(newExplorerLayout);
      }

      // Save zoom settings
      const zoomTextSlider = document.getElementById('setting-zoom-text');
      if (zoomTextSlider) {
        zoomText = parseInt(zoomTextSlider.value) || 100;
        localStorage.setItem('notoMixer_zoomText', zoomText);
      }
      const zoomWaveformSlider = document.getElementById('setting-zoom-waveform');
      if (zoomWaveformSlider) {
        zoomWaveform = parseInt(zoomWaveformSlider.value) || 100;
        localStorage.setItem('notoMixer_zoomWaveform', zoomWaveform);
      }
      const zoomButtonsSlider = document.getElementById('setting-zoom-buttons');
      if (zoomButtonsSlider) {
        zoomButtons = parseInt(zoomButtonsSlider.value) || 100;
        localStorage.setItem('notoMixer_zoomButtons', zoomButtons);
      }
      const zoomCoverSlider = document.getElementById('setting-zoom-cover');
      if (zoomCoverSlider) {
        zoomCover = parseInt(zoomCoverSlider.value) || 100;
        localStorage.setItem('notoMixer_zoomCover', zoomCover);
      }
      applyZoomSettings();
      
      hideSettingsModal();
      logConsole("Info: Settings saved successfully", 'system');
    });
  }

  // Settings Tab Switching Logic
  const settingsMenuItems = document.querySelectorAll('.settings-menu-item');
  settingsMenuItems.forEach(item => {
    item.addEventListener('click', () => {
      // Deactivate all tab menu items
      settingsMenuItems.forEach(menuItem => menuItem.classList.remove('active'));
      
      // Hide all tab contents
      document.querySelectorAll('.settings-tab-content').forEach(content => {
        content.classList.remove('active');
      });
      
      // Activate clicked item
      item.classList.add('active');
      
      // Show corresponding tab content
      const tabId = item.getAttribute('data-tab');
      const targetTab = document.getElementById(`tab-${tabId}`);
      if (targetTab) {
        targetTab.classList.add('active');
      }
    });
  });

  // Settings UI Initialization and Listeners
  const layoutSelect = document.getElementById('setting-layout-mode');
  if (layoutSelect) {
    layoutSelect.value = layoutMode;
  }
  const explorerLayoutSelect = document.getElementById('setting-explorer-layout');
  if (explorerLayoutSelect) {
    explorerLayoutSelect.value = explorerLayout;
  }

  const snapCheck = document.getElementById('setting-snap-enable');
  const snapSlider = document.getElementById('setting-snap-threshold');
  const snapDisplay = document.getElementById('snap-threshold-display');
  
  if (snapCheck) {
    snapCheck.checked = snapEnabled;
  }
  if (snapSlider) {
    snapSlider.value = snapThresholdPct;
    snapSlider.addEventListener('input', () => {
      if (snapDisplay) {
        snapDisplay.textContent = `${snapSlider.value}%`;
      }
    });
  }
  if (snapDisplay) {
    snapDisplay.textContent = `${snapThresholdPct}%`;
  }

  // Try to connect automatically if we have previously authorized ports (no click needed)
  if (navigator.serial) {
    navigator.serial.addEventListener('disconnect', (event) => {
      if (activePort && event.port === activePort) {
        handleDeviceLost();
      }
    });
  }

  // Start the background scanner for COM port connections
  startAutoConnectScanner();
  
  // Show connection modal if not connected (give scanner a tiny moment to run first)
  setTimeout(() => {
    if (!activePort) {
      showConnectionModal();
    }
  }, 150);

  // Live Zoom adjustments
  const zoomTextSlider = document.getElementById('setting-zoom-text');
  if (zoomTextSlider) {
    zoomTextSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      const display = document.getElementById('zoom-text-display');
      if (display) display.textContent = `${val}%`;
      document.documentElement.style.setProperty('--zoom-text', val / 100);
    });
  }

  const zoomWaveformSlider = document.getElementById('setting-zoom-waveform');
  if (zoomWaveformSlider) {
    zoomWaveformSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      const display = document.getElementById('zoom-waveform-display');
      if (display) display.textContent = `${val}%`;
      document.documentElement.style.setProperty('--zoom-waveform', val / 100);
    });
  }

  const zoomButtonsSlider = document.getElementById('setting-zoom-buttons');
  if (zoomButtonsSlider) {
    zoomButtonsSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      const display = document.getElementById('zoom-buttons-display');
      if (display) display.textContent = `${val}%`;
      document.documentElement.style.setProperty('--zoom-buttons', val / 100);
    });
  }

  const zoomCoverSlider = document.getElementById('setting-zoom-cover');
  if (zoomCoverSlider) {
    zoomCoverSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      const display = document.getElementById('zoom-cover-display');
      if (display) display.textContent = `${val}%`;
      document.documentElement.style.setProperty('--zoom-cover-scale', val / 100);
    });
  }

  // Initialize the draggable preview panel
  initInAppPreview();
  startUdpServer(); // Start the UDP Server automatically
});

// -------------------------------------------------------------
// In-App Draggable Preview Panel System
// -------------------------------------------------------------

let previewAudioCtx = null;
let previewIsPlaying = false;
let previewVisMode = 'waveform';

// EQ/FX Parameter Values for Preview
let prevBassVal = 0;
let prevLowVal = 0;
let prevTrebVal = 0;
let prevInstVal = 100;
let prevVocVal = 100;
let prevFilterVal = 50;
let prevPitchVal = 0;
let prevSpeedVal = 1.0;
let prevEchoVal = 0;
let prevPanVal = 0;
let prevReverbVal = 0;
let prevEchoTimeVal = 350;
let prevVolVal = 80;

// Metronome and Tempo State for Preview
let prevBpmVal = 120;
let prevBeatOffset = 0;
let prevBpmDivVal = '1/1';
let prevMetronomeOn = false;
let prevMetronomeIntervalId = null;

// Loop State for Preview
let prevLoopEnabled = false;
let prevLoopStartTime = null;
let prevLoopEndTime = null;
let prevAutoLoopBeats = 4;

// Combined Static Waveform for Preview
let previewStaticWaveform = null;

// Audio Nodes for Preview
let prevBassFilter = null;
let prevLowFilter = null;
let prevTrebFilter = null;
let prevFilterLPFNode = null;
let prevFilterHPFNode = null;
let prevGainNode = null;
let prevPanNode = null;
let prevReverbConvolverNode = null;
let prevReverbWetNode = null;
let prevAnalyser = null;
let prevEchoDelayNode = null;
let prevEchoFeedbackNode = null;
let prevEchoWetNode = null;
let prevPitchShifter = null;

// Stems Data for Preview
const previewStems = {
  main: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'main.mp3' },
  vocals: { audio: new Audio(), source: null, gainNode: null, exists: false, file: 'vocals.mp3' },
  inst: { audios: [], exists: false }
};

// Sound Sampler Buttons Data for Preview
const previewSoundButtons = [
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null },
  { path: '', name: 'DROP FILE', buffer: null }
];

function makeElementDraggable(el, header) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  header.onmousedown = dragMouseDown;

  function dragMouseDown(e) {
    if (e.target.id === 'preview-panel-close-btn') return;
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    
    let newTop = el.offsetTop - pos2;
    let newLeft = el.offsetLeft - pos1;
    
    // Constrain to window bounds
    newTop = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, newTop));
    newLeft = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, newLeft));
    
    el.style.top = newTop + "px";
    el.style.left = newLeft + "px";
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
  }
}

function makeElementResizable(el) {
  const handles = el.querySelectorAll('.resize-handle');
  
  handles.forEach(handle => {
    handle.addEventListener('mousedown', initResize);
  });

  function initResize(e) {
    e.preventDefault();
    const handle = e.target;
    let startX = e.clientX;
    let startY = e.clientY;
    let startWidth = el.offsetWidth;
    let startHeight = el.offsetHeight;
    let startLeft = el.offsetLeft;
    let startTop = el.offsetTop;

    const minWidth = 320;
    const minHeight = 500;
    const maxWidth = 700;
    const maxHeight = 950;

    function resize(moveEvent) {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      let newWidth = startWidth;
      let newHeight = startHeight;
      let newLeft = startLeft;
      let newTop = startTop;

      if (handle.classList.contains('right')) {
        newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + dx));
      }
      if (handle.classList.contains('left')) {
        const targetWidth = startWidth - dx;
        if (targetWidth >= minWidth && targetWidth <= maxWidth) {
          newWidth = targetWidth;
          newLeft = startLeft + dx;
        }
      }
      if (handle.classList.contains('bottom')) {
        newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + dy));
      }
      if (handle.classList.contains('top')) {
        const targetHeight = startHeight - dy;
        if (targetHeight >= minHeight && targetHeight <= maxHeight) {
          newHeight = targetHeight;
          newTop = startTop + dy;
        }
      }
      
      if (handle.classList.contains('top-left')) {
        const targetWidth = startWidth - dx;
        const targetHeight = startHeight - dy;
        if (targetWidth >= minWidth && targetWidth <= maxWidth) {
          newWidth = targetWidth;
          newLeft = startLeft + dx;
        }
        if (targetHeight >= minHeight && targetHeight <= maxHeight) {
          newHeight = targetHeight;
          newTop = startTop + dy;
        }
      }
      if (handle.classList.contains('top-right')) {
        newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + dx));
        const targetHeight = startHeight - dy;
        if (targetHeight >= minHeight && targetHeight <= maxHeight) {
          newHeight = targetHeight;
          newTop = startTop + dy;
        }
      }
      if (handle.classList.contains('bottom-left')) {
        const targetWidth = startWidth - dx;
        if (targetWidth >= minWidth && targetWidth <= maxWidth) {
          newWidth = targetWidth;
          newLeft = startLeft + dx;
        }
        newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + dy));
      }
      if (handle.classList.contains('bottom-right')) {
        newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + dx));
        newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + dy));
      }

      el.style.width = newWidth + 'px';
      el.style.height = newHeight + 'px';
      el.style.left = newLeft + 'px';
      el.style.top = newTop + 'px';
    }

    function stopResize() {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResize);
    }

    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stopResize);
  }
}

function initPreviewAudio() {
  if (previewAudioCtx) return;
  previewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  
  const savedPreview = localStorage.getItem('notoMixer_previewAudioDevice');
  if (savedPreview && savedPreview !== 'default' && typeof previewAudioCtx.setSinkId === 'function') {
    previewAudioCtx.setSinkId(savedPreview).catch(err => {
      console.error("Error setting preview sink ID, falling back to default:", err);
      previewAudioCtx.setSinkId('');
    });
  }
  
  prevBassFilter = previewAudioCtx.createBiquadFilter();
  prevBassFilter.type = 'peaking';
  prevBassFilter.frequency.value = 80;
  prevBassFilter.Q.value = 1.0;
  prevBassFilter.gain.value = prevBassVal;
  
  prevLowFilter = previewAudioCtx.createBiquadFilter();
  prevLowFilter.type = 'peaking';
  prevLowFilter.frequency.value = 320;
  prevLowFilter.Q.value = 1.0;
  prevLowFilter.gain.value = prevLowVal;
  
  prevTrebFilter = previewAudioCtx.createBiquadFilter();
  prevTrebFilter.type = 'peaking';
  prevTrebFilter.frequency.value = 3000;
  prevTrebFilter.Q.value = 1.0;
  prevTrebFilter.gain.value = prevTrebVal;
  
  prevFilterLPFNode = previewAudioCtx.createBiquadFilter();
  prevFilterLPFNode.type = 'lowpass';
  prevFilterLPFNode.frequency.value = 22000;
  
  prevFilterHPFNode = previewAudioCtx.createBiquadFilter();
  prevFilterHPFNode.type = 'highpass';
  prevFilterHPFNode.frequency.value = 20;
  
  prevGainNode = previewAudioCtx.createGain();
  prevGainNode.gain.value = prevVolVal / 100;
  
  prevPanNode = previewAudioCtx.createStereoPanner();
  prevPanNode.pan.value = prevPanVal / 100;
  
  prevReverbConvolverNode = previewAudioCtx.createConvolver();
  prevReverbConvolverNode.buffer = createReverbImpulseResponse(2.0, 2.0, previewAudioCtx.sampleRate);
  prevReverbWetNode = previewAudioCtx.createGain();
  prevReverbWetNode.gain.value = (prevReverbVal / 100) * 0.8;
  
  prevEchoDelayNode = previewAudioCtx.createDelay(2.0);
  prevEchoDelayNode.delayTime.value = prevEchoTimeVal / 1000;
  
  prevEchoFeedbackNode = previewAudioCtx.createGain();
  prevEchoFeedbackNode.gain.value = (prevEchoVal / 100) * 0.7;
  
  prevEchoWetNode = previewAudioCtx.createGain();
  prevEchoWetNode.gain.value = prevEchoVal / 100;
  
  prevAnalyser = previewAudioCtx.createAnalyser();
  prevAnalyser.fftSize = 256;
  
  prevPitchShifter = new PitchShifterNode(previewAudioCtx);
  prevPitchShifter.setPitch(Math.pow(2, prevPitchVal / 12));
  
  previewStems.main.gainNode = previewAudioCtx.createGain();
  previewStems.main.gainNode.gain.value = 1.0;
  previewStems.vocals.gainNode = previewAudioCtx.createGain();
  previewStems.vocals.gainNode.gain.value = prevVocVal / 100;
  previewStems.inst.gainNode = previewAudioCtx.createGain();
  previewStems.inst.gainNode.gain.value = prevInstVal / 100;
  
  previewStems.main.gainNode.connect(prevBassFilter);
  previewStems.vocals.gainNode.connect(prevBassFilter);
  previewStems.inst.gainNode.connect(prevBassFilter);
  
  prevBassFilter.connect(prevLowFilter);
  prevLowFilter.connect(prevTrebFilter);
  prevTrebFilter.connect(prevFilterLPFNode);
  prevFilterLPFNode.connect(prevFilterHPFNode);
  
  prevEchoDelayNode.connect(prevEchoFeedbackNode);
  prevEchoFeedbackNode.connect(prevEchoDelayNode);
  
  prevEchoDelayNode.connect(prevEchoWetNode);
  prevEchoWetNode.connect(prevGainNode);
  
  prevGainNode.connect(prevPanNode);
  
  prevGainNode.connect(prevReverbConvolverNode);
  prevReverbConvolverNode.connect(prevReverbWetNode);
  prevReverbWetNode.connect(prevPanNode);
  
  prevPanNode.connect(prevAnalyser);
  prevAnalyser.connect(previewAudioCtx.destination);
  
  updatePreviewAudioGraphConnections();
  applyPreviewFilters();
}

function updatePreviewAudioGraphConnections() {
  if (!previewAudioCtx) return;
  
  try {
    prevFilterHPFNode.disconnect();
  } catch(e) {}
  try {
    prevPitchShifter.node.disconnect();
  } catch(e) {}
  
  const isPitchActive = (Math.abs(Number(prevPitchVal)) > 0.05);
  
  if (isPitchActive) {
    prevPitchShifter.node.onaudioprocess = prevPitchShifter.process;
    prevFilterHPFNode.connect(prevPitchShifter.node);
    prevPitchShifter.node.connect(prevGainNode);
    prevPitchShifter.node.connect(prevEchoDelayNode);
  } else {
    prevPitchShifter.node.onaudioprocess = null;
    prevFilterHPFNode.connect(prevGainNode);
    prevFilterHPFNode.connect(prevEchoDelayNode);
  }
}

function applyPreviewFilters() {
  if (!previewAudioCtx) return;
  const time = previewAudioCtx.currentTime;
  
  prevBassFilter.gain.setValueAtTime(prevBassVal, time);
  prevLowFilter.gain.setValueAtTime(prevLowVal, time);
  prevTrebFilter.gain.setValueAtTime(prevTrebVal, time);
  
  previewStems.vocals.gainNode.gain.setValueAtTime(prevVocVal / 100, time);
  previewStems.inst.gainNode.gain.setValueAtTime(prevInstVal / 100, time);
  
  if (prevFilterVal === 50) {
    prevFilterLPFNode.frequency.setValueAtTime(22000, time);
    prevFilterHPFNode.frequency.setValueAtTime(20, time);
  } else if (prevFilterVal < 50) {
    const pct = prevFilterVal / 50;
    const freq = 200 + pct * 21800;
    prevFilterLPFNode.frequency.setValueAtTime(freq, time);
    prevFilterHPFNode.frequency.setValueAtTime(20, time);
  } else {
    const pct = (prevFilterVal - 50) / 50;
    const freq = 20 + pct * 4000;
    prevFilterLPFNode.frequency.setValueAtTime(22000, time);
    prevFilterHPFNode.frequency.setValueAtTime(freq, time);
  }
  
  updatePreviewAudioGraphConnections();
  prevPitchShifter.setPitch(Math.pow(2, prevPitchVal / 12));
  
  previewStems.main.audio.playbackRate = prevSpeedVal;
  previewStems.vocals.audio.playbackRate = prevSpeedVal;
  previewStems.inst.audios.forEach(item => {
    item.audio.playbackRate = prevSpeedVal;
  });
  
  prevEchoWetNode.gain.setValueAtTime(prevEchoVal / 100, time);
  prevEchoFeedbackNode.gain.setValueAtTime((prevEchoVal / 100) * 0.7, time);
  prevEchoDelayNode.delayTime.setValueAtTime(prevEchoTimeVal / 1000, time);
  
  prevPanNode.pan.setValueAtTime(prevPanVal / 100, time);
  prevReverbWetNode.gain.setValueAtTime((prevReverbVal / 100) * 0.8, time);
  prevGainNode.gain.setValueAtTime(prevVolVal / 100, time);
}

function loadPreviewSong(dirPath, folderName) {
  try {
    const previewPanel = document.getElementById('preview-panel');
    
    // Check if path is a file
    let isFile = false;
    let actualDirPath = dirPath;
    try {
      const stats = fs.statSync(dirPath);
      isFile = stats.isFile();
    } catch (err) {}

    let mainFile = '';
    let vocalsFile = '';
    const instFiles = [];
    let songTitle = folderName;

    if (isFile) {
      actualDirPath = path.dirname(dirPath);
      mainFile = path.basename(dirPath);
      songTitle = path.basename(dirPath, path.extname(dirPath));
    }

    if (previewPanel) {
      previewPanel.classList.add('show');
      document.getElementById('prev-panel-song-title').textContent = songTitle.toUpperCase();
    }
    
    document.getElementById('prev-track-name').textContent = songTitle.toUpperCase();
    document.getElementById('prev-dir-path').textContent = dirPath;
    
    stopPreviewTrack();
    
    // Clean up dynamic instruments
    previewStems.inst.audios.forEach(item => {
      item.audio.pause();
      item.audio.src = '';
      item.audio.remove();
      if (item.source) item.source.disconnect();
    });
    previewStems.inst.audios = [];
    previewStems.inst.exists = false;
    
    if (!isFile) {
      const files = fs.readdirSync(dirPath);
      const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
      
      files.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        if (audioExtensions.includes(ext)) {
          const nameLc = path.basename(file, ext).toLowerCase();
          if (nameLc === 'main') mainFile = file;
          else if (nameLc === 'vocals') vocalsFile = file;
          else instFiles.push(file);
        }
      });
      
      // If we don't have main/vocals and only have exactly 1 audio file, treat it as main
      if (!mainFile && !vocalsFile && instFiles.length === 1) {
        mainFile = instFiles.pop();
      }
    }
    
    initPreviewAudio();
    
    // Load main stem
    const mainIndicator = document.getElementById('prev-ind-main');
    if (mainFile) {
      const filePath = path.join(actualDirPath, mainFile);
      const data = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      const blob = new Blob([data], { type: mimeType });
      previewStems.main.audio.src = URL.createObjectURL(blob);
      previewStems.main.audio.preservesPitch = true;
      previewStems.main.audio.playbackRate = prevSpeedVal;
      previewStems.main.audio.load();
      previewStems.main.exists = true;
      
      if (!previewStems.main.source) {
        previewStems.main.source = previewAudioCtx.createMediaElementSource(previewStems.main.audio);
        previewStems.main.source.connect(previewStems.main.gainNode);
      }
      if (mainIndicator) mainIndicator.classList.add('present');
    } else {
      previewStems.main.audio.src = '';
      previewStems.main.exists = false;
      if (mainIndicator) mainIndicator.classList.remove('present');
    }
    
    // Load vocals stem
    const vocalsIndicator = document.getElementById('prev-ind-vocals');
    if (vocalsFile) {
      const filePath = path.join(actualDirPath, vocalsFile);
      const data = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      const blob = new Blob([data], { type: mimeType });
      previewStems.vocals.audio.src = URL.createObjectURL(blob);
      previewStems.vocals.audio.preservesPitch = true;
      previewStems.vocals.audio.playbackRate = prevSpeedVal;
      previewStems.vocals.audio.load();
      previewStems.vocals.exists = true;
      
      if (!previewStems.vocals.source) {
        previewStems.vocals.source = previewAudioCtx.createMediaElementSource(previewStems.vocals.audio);
        previewStems.vocals.source.connect(previewStems.vocals.gainNode);
      }
      if (vocalsIndicator) vocalsIndicator.classList.add('present');
    } else {
      previewStems.vocals.audio.src = '';
      previewStems.vocals.exists = false;
      if (vocalsIndicator) vocalsIndicator.classList.remove('present');
    }
    
    // Load instrumental stems
    const instIndicator = document.getElementById('prev-ind-inst');
    if (instFiles.length > 0) {
      instFiles.forEach(file => {
        const filePath = path.join(actualDirPath, file);
        const data = fs.readFileSync(filePath);
        const mimeType = getMimeType(filePath);
        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        
        const audio = new Audio();
        audio.src = url;
        audio.style.display = 'none';
        document.body.appendChild(audio);
        audio.preservesPitch = true;
        audio.playbackRate = prevSpeedVal;
        audio.load();
        
        const source = previewAudioCtx.createMediaElementSource(audio);
        source.connect(previewStems.inst.gainNode);
        
        audio.addEventListener('timeupdate', () => {
          let firstAudio = null;
          if (previewStems.main.exists) firstAudio = previewStems.main.audio;
          else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
          else if (previewStems.inst.audios.length > 0) firstAudio = previewStems.inst.audios[0].audio;
          
          if (firstAudio === audio) {
            updatePreviewProgress();
          }
        });
        
        audio.addEventListener('durationchange', () => {
          let firstAudio = null;
          if (previewStems.main.exists) firstAudio = previewStems.main.audio;
          else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
          else if (previewStems.inst.audios.length > 0) firstAudio = previewStems.inst.audios[0].audio;
          
          if (firstAudio === audio) {
            document.getElementById('prev-time-duration').textContent = formatTime(audio.duration);
          }
        });
        
        audio.addEventListener('ended', () => {
          let firstAudio = null;
          if (previewStems.main.exists) firstAudio = previewStems.main.audio;
          else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
          else if (previewStems.inst.audios.length > 0) firstAudio = previewStems.inst.audios[0].audio;
          
          if (firstAudio === audio) {
            stopPreviewTrack();
          }
        });
        
        previewStems.inst.audios.push({ audio, source, file });
      });
      
      previewStems.inst.exists = true;
      if (instIndicator) instIndicator.classList.add('present');
    } else {
      previewStems.inst.exists = false;
      if (instIndicator) instIndicator.classList.remove('present');
    }
    
    // Wire up listeners for main & vocals elements
    [previewStems.main.audio, previewStems.vocals.audio].forEach(audio => {
      audio.addEventListener('timeupdate', () => {
        let firstAudio = null;
        if (previewStems.main.exists) firstAudio = previewStems.main.audio;
        else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
        
        if (firstAudio === audio) {
          updatePreviewProgress();
        }
      });
      
      audio.addEventListener('durationchange', () => {
        let firstAudio = null;
        if (previewStems.main.exists) firstAudio = previewStems.main.audio;
        else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
        
        if (firstAudio === audio) {
          document.getElementById('prev-time-duration').textContent = formatTime(audio.duration);
        }
      });
      
      audio.addEventListener('ended', () => {
        let firstAudio = null;
        if (previewStems.main.exists) firstAudio = previewStems.main.audio;
        else if (previewStems.vocals.exists) firstAudio = previewStems.vocals.audio;
        
        if (firstAudio === audio) {
          stopPreviewTrack();
        }
      });
    });
    
    const previewPaths = [];
    if (mainFile) previewPaths.push(mainFile);
    if (vocalsFile) previewPaths.push(vocalsFile);
    instFiles.forEach(f => previewPaths.push(f));
    generatePreviewStaticWaveform(actualDirPath, previewPaths);
    
    setTimeout(() => {
      playPreviewTrack();
    }, 300);
    
  } catch (err) {
    console.error("Error loading preview song:", err);
  }
}

function generatePreviewStaticWaveform(dirPath, files) {
  previewStaticWaveform = null;
  const pathsToDecode = [];
  files.forEach(file => pathsToDecode.push(path.join(dirPath, file)));
  
  if (pathsToDecode.length === 0) return;
  
  const decodePromises = pathsToDecode.map(filePath => {
    return new Promise((resolve) => {
      try {
        const data = fs.readFileSync(filePath);
        const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        initPreviewAudio();
        previewAudioCtx.decodeAudioData(arrayBuffer)
          .then(resolve)
          .catch(err => {
            console.warn(`Warning Preview Waveform: Unable to decode ${path.basename(filePath)}: ${err.message}`);
            resolve(null);
          });
      } catch (err) {
        console.warn(`Warning Preview Waveform: Unable to read ${path.basename(filePath)}: ${err.message}`);
        resolve(null);
      }
    });
  });

  Promise.all(decodePromises).then(buffers => {
    // Associate decoded buffers with preview stems for real-time scratching
    let bufIdx = 0;
    files.forEach(file => {
      if (buffers[bufIdx]) {
        const rev = reverseAudioBuffer(buffers[bufIdx], previewAudioCtx);
        if (previewStems.main.exists && path.basename(previewStems.main.file || '') === path.basename(file)) {
          previewStems.main.buffer = buffers[bufIdx];
          previewStems.main.reversedBuffer = rev;
        } else if (previewStems.vocals.exists && path.basename(previewStems.vocals.file || '') === path.basename(file)) {
          previewStems.vocals.buffer = buffers[bufIdx];
          previewStems.vocals.reversedBuffer = rev;
        } else {
          const instAudio = previewStems.inst.audios.find(item => path.basename(item.file || '') === path.basename(file));
          if (instAudio) {
            instAudio.buffer = buffers[bufIdx];
            instAudio.reversedBuffer = rev;
          }
        }
      }
      bufIdx++;
    });

    const audioBuffers = buffers.filter(buf => buf !== null);
    if (audioBuffers.length === 0) return;

    // Auto-analyze BPM for Preview (Rekordbox-style)
    try {
      const detectedBpm = estimateBPM(audioBuffers[0]);
      console.log(`BPM Preview: Detected ${detectedBpm} BPM`);
      prevBpmVal = detectedBpm;
      const detectedOffset = estimateBeatOffset(audioBuffers[0], detectedBpm);
      prevBeatOffset = detectedOffset;
      const bpmInput = document.getElementById('prev-bpm');
      if (bpmInput) bpmInput.value = detectedBpm;
    } catch (bpmErr) {
      console.error("Preview BPM analysis error:", bpmErr);
    }

    const numPeaks = 2000;
    const maxDuration = Math.max(...audioBuffers.map(buf => buf.duration));
    const peaks = new Float32Array(numPeaks);

    audioBuffers.forEach(buf => {
      const rawData = buf.getChannelData(0);
      const L = rawData.length;
      const SR = buf.sampleRate;
      const duration = buf.duration;

      for (let i = 0; i < numPeaks; i++) {
        const startTime = (i / numPeaks) * maxDuration;
        const endTime = ((i + 1) / numPeaks) * maxDuration;

        if (startTime < duration) {
          const startIdx = Math.floor(startTime * SR);
          const endIdx = Math.min(L, Math.floor(endTime * SR));
          if (endIdx > startIdx) {
            let sum = 0;
            for (let j = startIdx; j < endIdx; j++) {
              sum += Math.abs(rawData[j]);
            }
            peaks[i] += sum / (endIdx - startIdx);
          }
        }
      }
    });

    const maxVal = Math.max(...peaks);
    previewStaticWaveform = Array.from(peaks).map(p => p / (maxVal || 1));
  }).catch(err => {
    console.error("Preview Waveform decode failed:", err);
  });
}

function updatePreviewProgress() {
  let refAudio = null;
  if (previewStems.main.exists) refAudio = previewStems.main.audio;
  else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
  else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
  
  if (!refAudio || isNaN(refAudio.currentTime)) return;
  
  document.getElementById('prev-time-current').textContent = formatTime(refAudio.currentTime);
  
  const fill = document.getElementById('prev-progress-fill');
  if (fill) {
    const pct = (refAudio.currentTime / (refAudio.duration || 1)) * 100;
    fill.style.width = `${pct}%`;
  }
}

function playPreviewTrack() {
  if (!previewAudioCtx) initPreviewAudio();
  if (previewAudioCtx.state === 'suspended') previewAudioCtx.resume();
  
  let refAudio = null;
  if (previewStems.main.exists) refAudio = previewStems.main.audio;
  if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
  if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
  
  if (!refAudio) return;
  
  const startPos = refAudio.currentTime;
  
  if (previewStems.main.exists) {
    previewStems.main.audio.currentTime = startPos;
    previewStems.main.audio.play().catch(e => console.warn(e));
  }
  if (previewStems.vocals.exists) {
    previewStems.vocals.audio.currentTime = startPos;
    previewStems.vocals.audio.play().catch(e => console.warn(e));
  }
  previewStems.inst.audios.forEach(item => {
    item.audio.currentTime = startPos;
    item.audio.play().catch(e => console.warn(e));
  });
  
  previewIsPlaying = true;
  const playBtn = document.getElementById('prev-btn-play');
  if (playBtn) playBtn.classList.add('playing');
  
  if (prevMetronomeOn) {
    startPreviewMetronome();
  }
}

function stopPreviewTrack() {
  if (previewStems.main.exists) previewStems.main.audio.pause();
  if (previewStems.vocals.exists) previewStems.vocals.audio.pause();
  previewStems.inst.audios.forEach(item => item.audio.pause());
  
  previewIsPlaying = false;
  const playBtn = document.getElementById('prev-btn-play');
  if (playBtn) playBtn.classList.remove('playing');
  
  stopPreviewMetronome();
}

function startPreviewMetronome() {
  stopPreviewMetronome();
  if (!prevMetronomeOn) return;
  initPreviewAudio();
  if (previewAudioCtx.state === 'suspended') previewAudioCtx.resume();
  
  let nextNoteTime = previewAudioCtx.currentTime;
  let beatCount = 0;
  
  prevMetronomeIntervalId = setInterval(() => {
    const scheduleAheadTime = 0.1;
    let beatDuration = 60 / prevBpmVal;
    if (prevBpmDivVal === '1/2') beatDuration /= 2;
    else if (prevBpmDivVal === '1/4') beatDuration /= 4;
    beatDuration /= prevSpeedVal;
    
    while (nextNoteTime < previewAudioCtx.currentTime + scheduleAheadTime) {
      const isDownbeat = (beatCount % 4 === 0);
      if (previewIsPlaying) {
        try {
          const osc = previewAudioCtx.createOscillator();
          const gain = previewAudioCtx.createGain();
          osc.connect(gain).connect(previewAudioCtx.destination);
          
          osc.frequency.setValueAtTime(isDownbeat ? 1200 : 800, nextNoteTime);
          gain.gain.setValueAtTime(0.2, nextNoteTime);
          gain.gain.exponentialRampToValueAtTime(0.001, nextNoteTime + 0.04);
          
          osc.start(nextNoteTime);
          osc.stop(nextNoteTime + 0.05);
        } catch(e) {}
      }
      nextNoteTime += beatDuration;
      beatCount++;
    }
  }, 40);
}

function stopPreviewMetronome() {
  if (prevMetronomeIntervalId) {
    clearInterval(prevMetronomeIntervalId);
    prevMetronomeIntervalId = null;
  }
}

function updatePrevKnobUI(param, val) {
  const knobFill = document.getElementById(`knob-prev-${param}-fill`);
  const knobPointer = document.getElementById(`knob-prev-${param}-pointer`);
  const valDisplay = document.getElementById(`val-prev-${param}`);
  
  if (!knobFill || !knobPointer) return;

  const input = document.getElementById(`prev-${param}`);
  if (input) {
    input.value = val;
  }

  let percent = 0;
  let formatted = '';

  if (param === 'bass' || param === 'low' || param === 'treb' || param === 'pitch') {
    percent = (val - (-12)) / (12 - (-12));
    if (param === 'pitch') {
      formatted = `${val > 0 ? '+' : ''}${Math.round(val)} st`;
    } else {
      formatted = `${val > 0 ? '+' : ''}${val.toFixed(1)} dB`;
    }
  } else if (param === 'speed') {
    percent = (val - 50) / (200 - 50);
    formatted = `${Math.round(val)}%`;
  } else if (param === 'filter') {
    percent = val / 100;
    if (val === 50) {
      formatted = 'Byp';
    } else if (val < 50) {
      formatted = `LP ${Math.round((50 - val) * 2)}%`;
    } else {
      formatted = `HP ${Math.round((val - 50) * 2)}%`;
    }
  } else if (param === 'pan') {
    percent = (val - (-100)) / (100 - (-100));
    if (val === 0) {
      formatted = 'C';
    } else if (val < 0) {
      formatted = `L ${Math.abs(val)}`;
    } else {
      formatted = `R ${val}`;
    }
  } else if (param === 'echotime') {
    percent = (val - 100) / (1000 - 100);
    formatted = `${Math.round(val)} ms`;
  } else {
    percent = val / 100;
    formatted = `${Math.round(val)}%`;
  }

  drawKnobArc(knobFill, percent);
  const angle = -135 + (percent * 270);
  knobPointer.setAttribute('transform', `rotate(${angle} 20 20)`);
  if (valDisplay) {
    valDisplay.textContent = formatted;
  }
}

function setupPrevKnobDrag(param) {
  const wrapper = document.getElementById(`knob-prev-${param}-wrapper`);
  const slider = document.getElementById(`prev-${param}`);
  if (!wrapper || !slider) return;

  let isDragging = false;
  let startY = 0;
  let startValue = 0;
  let snapTarget = null;
  if (['bass', 'low', 'treb', 'pitch', 'pan'].includes(param)) {
    snapTarget = 0;
  } else if (param === 'filter') {
    snapTarget = 50;
  } else if (param === 'speed') {
    snapTarget = 100;
  }

  wrapper.addEventListener('mousedown', (e) => {
    isDragging = true;
    startY = e.clientY;
    startValue = parseFloat(slider.value);
    
    const onMouseMove = (moveEv) => {
      if (!isDragging) return;
      const deltaY = startY - moveEv.clientY;
      const rangePixels = 100;
      const min = parseFloat(slider.min);
      const max = parseFloat(slider.max);
      const range = max - min;
      
      let newVal = startValue + (deltaY / rangePixels) * range;
      newVal = Math.max(min, Math.min(max, newVal));
      
      if (snapEnabled && snapTarget !== null) {
        const thresholdVal = (snapThresholdPct / 100) * range;
        if (Math.abs(newVal - snapTarget) <= thresholdVal) {
          newVal = snapTarget;
        }
      }
      
      slider.value = newVal;
      slider.dispatchEvent(new Event('input'));
    };
    
    const onMouseUp = () => {
      isDragging = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });
}

function drawPrevVisualizer() {
  const canvas = document.getElementById('prev-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }
  resizeCanvas();
  
  function draw() {
    requestAnimationFrame(draw);
    
    try {
      if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
      }
      
      // Hide or show the preview overview canvas
      const overviewCanvas = document.getElementById('prev-overview-canvas');
      if (overviewCanvas) {
        overviewCanvas.style.display = (previewVisMode === 'waveform') ? 'block' : 'none';
      }
      
      const trackColor = '#ff5500'; // Orange theme for preview inside app
    
    // Draw Preview Overview Waveform if available and visible
    if (overviewCanvas && previewVisMode === 'waveform' && previewStaticWaveform && previewStaticWaveform.length > 0) {
      const oCtx = overviewCanvas.getContext('2d');
      const oW = overviewCanvas.width = overviewCanvas.clientWidth;
      const oH = overviewCanvas.height = overviewCanvas.clientHeight;
      
      oCtx.fillStyle = '#0d0d0d';
      oCtx.fillRect(0, 0, oW, oH);
      
      // Draw continuous Audacity-style waveform for overview (unplayed grey base with gradient)
      const unplayedGrad = oCtx.createLinearGradient(0, oH * 0.1, 0, oH * 0.9);
      unplayedGrad.addColorStop(0, '#2a2a2a');
      unplayedGrad.addColorStop(0.5, '#5c5c5c');
      unplayedGrad.addColorStop(1, '#2a2a2a');
      oCtx.fillStyle = unplayedGrad;
      
      oCtx.beginPath();
      let first = true;
      const step = oW / previewStaticWaveform.length;
      for (let i = 0; i < previewStaticWaveform.length; i++) {
        const peak = previewStaticWaveform[i];
        const h = Math.max(1, peak * oH * 0.85);
        const y = (oH - h) / 2;
        const x = i * step;
        if (first) {
          oCtx.moveTo(x, y);
          first = false;
        } else {
          oCtx.lineTo(x, y);
        }
      }
      for (let i = previewStaticWaveform.length - 1; i >= 0; i--) {
        const peak = previewStaticWaveform[i];
        const h = Math.max(1, peak * oH * 0.85);
        const y = (oH + h) / 2;
        const x = i * step;
        oCtx.lineTo(x, y);
      }
      oCtx.closePath();
      oCtx.fill();
      
      // Fill the played portion in gradient color
      let currentPct = 0;
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      if (refAudio) {
        currentPct = refAudio.currentTime / (refAudio.duration || 1);
      }
      const playedX = currentPct * oW;
      
      oCtx.save();
      oCtx.beginPath();
      oCtx.rect(0, 0, playedX, oH);
      oCtx.clip();
      
      const playedGrad = oCtx.createLinearGradient(0, oH * 0.1, 0, oH * 0.9);
      playedGrad.addColorStop(0, '#cc4400');
      playedGrad.addColorStop(0.5, '#ffccb3');
      playedGrad.addColorStop(1, '#cc4400');
      oCtx.fillStyle = playedGrad;
      
      oCtx.beginPath();
      first = true;
      for (let i = 0; i < previewStaticWaveform.length; i++) {
        const peak = previewStaticWaveform[i];
        const h = Math.max(1, peak * oH * 0.85);
        const y = (oH - h) / 2;
        const x = i * step;
        if (first) {
          oCtx.moveTo(x, y);
          first = false;
        } else {
          oCtx.lineTo(x, y);
        }
      }
      for (let i = previewStaticWaveform.length - 1; i >= 0; i--) {
        const peak = previewStaticWaveform[i];
        const h = Math.max(1, peak * oH * 0.85);
        const y = (oH + h) / 2;
        const x = i * step;
        oCtx.lineTo(x, y);
      }
      oCtx.closePath();
      oCtx.fill();
      oCtx.restore();
      
      // Draw moving vertical playhead indicator (red line)
      oCtx.strokeStyle = '#ff003c';
      oCtx.lineWidth = 1.5;
      oCtx.beginPath();
      oCtx.moveTo(playedX, 0);
      oCtx.lineTo(playedX, oH);
      oCtx.stroke();

      // Highlight preview loop region on overview
      if (prevLoopEnabled && prevLoopStartTime !== null && prevLoopEndTime !== null) {
        const duration = (refAudio && refAudio.duration) ? refAudio.duration : 180;
        const loopStartX = (prevLoopStartTime / duration) * oW;
        const loopEndX = (prevLoopEndTime / duration) * oW;
        
        oCtx.fillStyle = 'rgba(0, 255, 204, 0.25)';
        oCtx.fillRect(loopStartX, 0, loopEndX - loopStartX, oH);
        oCtx.strokeStyle = '#00ffcc';
        oCtx.lineWidth = 1;
        oCtx.beginPath();
        oCtx.moveTo(loopStartX, 0); oCtx.lineTo(loopStartX, oH);
        oCtx.moveTo(loopEndX, 0); oCtx.lineTo(loopEndX, oH);
        oCtx.stroke();
      }
    }
    
    // Loop Check for Preview
    if (prevLoopEnabled && prevLoopStartTime !== null && prevLoopEndTime !== null) {
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (refAudio && refAudio.currentTime >= prevLoopEndTime) {
        const overshoot = refAudio.currentTime - prevLoopEndTime;
        const targetTime = prevLoopStartTime + (overshoot % (prevLoopEndTime - prevLoopStartTime));
        
        if (previewStems.main.exists) previewStems.main.audio.currentTime = targetTime;
        if (previewStems.vocals.exists) previewStems.vocals.audio.currentTime = targetTime;
        previewStems.inst.audios.forEach(item => item.audio.currentTime = targetTime);
      }
    }
    
    const width = canvas.width;
    const height = canvas.height;
    
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, width, height);
    
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 20) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    
    const mode = previewVisMode;
    let refAnalyser = null;
    if (prevAnalyser && previewIsPlaying) {
      refAnalyser = prevAnalyser;
    }
    
    if (mode === 'osc') {
      if (refAnalyser) {
        const bufferLength = refAnalyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        refAnalyser.getByteTimeDomainData(dataArray);
        
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = trackColor;
        ctx.beginPath();
        
        const sliceWidth = width / bufferLength;
        let x = 0;
        
        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0;
          const y = (v * height) / 2;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          x += sliceWidth;
        }
        ctx.lineTo(width, height / 2);
        ctx.stroke();
      } else {
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
      }
    } else if (mode === 'spectrum') {
      if (refAnalyser) {
        const bufferLength = refAnalyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        refAnalyser.getByteFrequencyData(dataArray);
        
        const numBars = 40;
        const barWidth = width / numBars;
        
        for (let i = 0; i < numBars; i++) {
          const dataIndex = Math.floor((i / numBars) * (bufferLength * 0.6));
          const val = dataArray[dataIndex] || 0;
          const barHeight = (val / 255) * height * 0.85;
          ctx.fillStyle = trackColor;
          ctx.fillRect(i * barWidth, height - barHeight, barWidth - 1.5, barHeight);
        }
      } else {
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
      }
    } else if (mode === 'waveform') {
      if (previewStaticWaveform && previewStaticWaveform.length > 0) {
        let currentPct = 0;
        let refAudio = null;
        if (previewStems.main.exists) refAudio = previewStems.main.audio;
        else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
        else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
        
        if (refAudio) {
          currentPct = refAudio.currentTime / (refAudio.duration || 1);
        } else {
          const fill = document.getElementById('prev-progress-fill');
          if (fill && fill.style.width) {
            currentPct = parseFloat(fill.style.width) / 100;
          }
        }
        
        // Draw grid/background
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(0, 0, width, height);
        
        // Draw grid lines
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        for (let x = 0; x < width; x += 40) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        
        const duration = (refAudio && refAudio.duration) ? refAudio.duration : 180;
        const visibleSeconds = 30; // Zoomed out as requested
        const zoomPercent = (visibleSeconds / 2) / duration;
        
        // Draw smooth Audacity-style waveform for preview (Top/Bottom curves filled with gradient)
        function drawContinuousWaveform(startPixel, endPixel, colorType) {
          const grad = ctx.createLinearGradient(0, height * 0.075, 0, height * 0.925);
          if (colorType === 'played') {
            grad.addColorStop(0, '#cc4400');
            grad.addColorStop(0.5, '#ffccb3');
            grad.addColorStop(1, '#cc4400');
          } else {
            grad.addColorStop(0, '#2e2e2e');
            grad.addColorStop(0.5, '#5c5c5c');
            grad.addColorStop(1, '#2e2e2e');
          }

          ctx.fillStyle = grad;
          ctx.beginPath();
          
          let first = true;
          // Top half
          for (let pixelX = startPixel; pixelX <= endPixel; pixelX += 2) {
            const pct = currentPct + ((pixelX - width / 2) / (width / 2)) * zoomPercent;
            if (pct >= 0 && pct <= 1) {
              const waveformIndex = Math.floor(pct * previewStaticWaveform.length);
              const peak = previewStaticWaveform[waveformIndex] || 0;
              const h = Math.max(1, peak * height * 0.85);
              const y = (height - h) / 2;
              if (first) {
                ctx.moveTo(pixelX, y);
                first = false;
              } else {
                ctx.lineTo(pixelX, y);
              }
            }
          }
          
          // Bottom half
          for (let pixelX = endPixel; pixelX >= startPixel; pixelX -= 2) {
            const pct = currentPct + ((pixelX - width / 2) / (width / 2)) * zoomPercent;
            if (pct >= 0 && pct <= 1) {
              const waveformIndex = Math.floor(pct * previewStaticWaveform.length);
              const peak = previewStaticWaveform[waveformIndex] || 0;
              const h = Math.max(1, peak * height * 0.85);
              const y = (height + h) / 2;
              ctx.lineTo(pixelX, y);
            }
          }
          
          ctx.closePath();
          ctx.fill();
        }
        
        // Draw played section (left of center playhead)
        drawContinuousWaveform(0, width / 2, 'played');
        
        // Draw unplayed section (right of center playhead)
        drawContinuousWaveform(width / 2, width, 'unplayed');
        
        // Draw horizontal center line on top of the scrolling waveform (Audacity style)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        // Draw Rekordbox-style beat grid lines for Preview
        const beatDuration = 60 / prevBpmVal;
        const offset = prevBeatOffset || 0;
        const leftTime = (currentPct - zoomPercent) * duration;
        const rightTime = (currentPct + zoomPercent) * duration;
        
        const firstVisibleBeat = Math.ceil((leftTime - offset) / beatDuration);
        const lastVisibleBeat = Math.floor((rightTime - offset) / beatDuration);
        
        for (let n = Math.max(0, firstVisibleBeat); n <= lastVisibleBeat; n++) {
          const beatTime = offset + n * beatDuration;
          const beatPct = beatTime / duration;
          const beatX = width / 2 + ((beatPct - currentPct) / zoomPercent) * (width / 2);
          
          if (n % 4 === 0) {
            // Downbeat (Red/orange line with bar number)
            ctx.strokeStyle = 'rgba(255, 0, 60, 0.45)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(beatX, 0);
            ctx.lineTo(beatX, height);
            ctx.stroke();
            
            ctx.fillStyle = 'rgba(255, 0, 60, 0.7)';
            ctx.font = '8px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(Math.floor(n / 4) + 1, beatX + 3, 10);
          } else {
            // Offbeat (White/grey line)
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(beatX, 0);
            ctx.lineTo(beatX, height);
            ctx.stroke();
            
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.font = '8px monospace';
            ctx.textAlign = 'left';
            ctx.fillText((n % 4) + 1, beatX + 3, height - 4);
          }
        }

        // Center playhead (Red line with Rekordbox triangles)
        ctx.strokeStyle = '#ff003c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(width / 2, 0);
        ctx.lineTo(width / 2, height);
        ctx.stroke();
        
        // Top playhead triangle marker
        ctx.fillStyle = '#ff003c';
        ctx.beginPath();
        ctx.moveTo(width / 2 - 5, 0);
        ctx.lineTo(width / 2 + 5, 0);
        ctx.lineTo(width / 2, 6);
        ctx.closePath();
        ctx.fill();
        
        // Bottom playhead triangle marker
        ctx.beginPath();
        ctx.moveTo(width / 2 - 5, height);
        ctx.lineTo(width / 2 + 5, height);
        ctx.lineTo(width / 2, height - 6);
        ctx.closePath();
        ctx.fill();
        
        // Highlight preview loop boundaries on scrolling waveform
        if (prevLoopEnabled && prevLoopStartTime !== null && prevLoopEndTime !== null) {
          const startPct = prevLoopStartTime / duration;
          const endPct = prevLoopEndTime / duration;
          
          const startX = width / 2 + ((startPct - currentPct) / zoomPercent) * (width / 2);
          const endX = width / 2 + ((endPct - currentPct) / zoomPercent) * (width / 2);
          
          ctx.fillStyle = 'rgba(0, 255, 204, 0.15)'; // Cyan overlay matching standard track theme
          ctx.fillRect(startX, 0, endX - startX, height);
          
          ctx.strokeStyle = '#00ffcc';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(startX, 0); ctx.lineTo(startX, height);
          ctx.moveTo(endX, 0); ctx.lineTo(endX, height);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = '#666';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText("NO AUDIO FILE LOADED", width / 2, height / 2 + 3);
      }
    }
  } catch (err) {
    console.error("Preview visualizer draw error:", err);
  }
}
  draw();
  window.addEventListener('resize', resizeCanvas);
  
  const previewPanel = document.getElementById('preview-panel');
  if (previewPanel && typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(() => {
      resizeCanvas();
    });
    resizeObserver.observe(previewPanel);
  }
}

function initInAppPreview() {
  const previewPanel = document.getElementById('preview-panel');
  if (!previewPanel) return;

  const header = previewPanel.querySelector('.in-app-window-header');
  makeElementDraggable(previewPanel, header);
  makeElementResizable(previewPanel);

  const closeBtn = document.getElementById('preview-panel-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      previewPanel.classList.remove('show');
      stopPreviewTrack();
    });
  }

  const playBtn = document.getElementById('prev-btn-play');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (previewIsPlaying) stopPreviewTrack();
      else playPreviewTrack();
    });
  }

  const stopBtn = document.getElementById('prev-btn-stop');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      stopPreviewTrack();
      [previewStems.main.audio, previewStems.vocals.audio].forEach(audio => {
        if (audio) audio.currentTime = 0;
      });
      previewStems.inst.audios.forEach(item => {
        if (item.audio) item.audio.currentTime = 0;
      });
      updatePreviewProgress();
    });
  }

  ['spectrum', 'waveform'].forEach(mode => {
    const btn = document.getElementById(`prev-btn-vis-${mode}`);
    if (btn) {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#prev-visualizer-block .visualizer-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        previewVisMode = mode;
      });
    }
  });

  const tabs = document.querySelectorAll('#track-prev .track-tab-btn');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tabName = btn.getAttribute('data-tab');
      document.querySelectorAll('#track-prev .track-tab-content').forEach(c => c.classList.remove('active'));
      if (tabName === 'eq') {
        document.getElementById('prev-track-content-eq').classList.add('active');
      } else {
        document.getElementById('prev-track-content-buttons').classList.add('active');
      }
    });
  });

  // Hook up canvas scratching for Preview
  const prevCanvas = document.getElementById('prev-canvas');
  if (prevCanvas) {
    setupPreviewCanvasScratching(prevCanvas);
  }

  const prevOverviewCanvas = document.getElementById('prev-overview-canvas');
  if (prevOverviewCanvas) {
    prevOverviewCanvas.addEventListener('click', (e) => {
      const rect = prevOverviewCanvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = clickX / rect.width;
      
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (refAudio && !isNaN(refAudio.duration)) {
        const newTime = pct * refAudio.duration;
        if (previewStems.main.exists) previewStems.main.audio.currentTime = newTime;
        if (previewStems.vocals.exists) previewStems.vocals.audio.currentTime = newTime;
        previewStems.inst.audios.forEach(item => item.audio.currentTime = newTime);
        updatePreviewProgress();
      }
    });
  }

  // Preview Loop control UI bindings
  const btnAutoLoop = document.getElementById('prev-btn-auto-loop');
  const btnHalve = document.getElementById('prev-btn-loop-halve');
  const btnDouble = document.getElementById('prev-btn-loop-double');
  const displayLoop = document.getElementById('prev-loop-display');
  const btnLoopIn = document.getElementById('prev-btn-loop-in');
  const btnLoopOut = document.getElementById('prev-btn-loop-out');
  const btnLoopExit = document.getElementById('prev-btn-loop-exit');
  
  const loopOptions = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
  let selectedOptionIndex = 6; // default 4 BEATS
  
  function updateLoopDisplay() {
    const beats = loopOptions[selectedOptionIndex];
    prevAutoLoopBeats = beats;
    if (beats < 1) {
      if (beats === 0.0625) displayLoop.textContent = "1/16";
      else if (beats === 0.125) displayLoop.textContent = "1/8";
      else if (beats === 0.25) displayLoop.textContent = "1/4";
      else if (beats === 0.5) displayLoop.textContent = "1/2";
    } else {
      displayLoop.textContent = beats.toString();
    }
  }
  
  if (btnHalve && btnDouble && displayLoop) {
    btnHalve.addEventListener('click', () => {
      if (selectedOptionIndex > 0) {
        selectedOptionIndex--;
        updateLoopDisplay();
        if (prevLoopEnabled) {
          triggerAutoLoop();
        }
      }
    });
    btnDouble.addEventListener('click', () => {
      if (selectedOptionIndex < loopOptions.length - 1) {
        selectedOptionIndex++;
        updateLoopDisplay();
        if (prevLoopEnabled) {
          triggerAutoLoop();
        }
      }
    });
  }
  
  if (btnAutoLoop) {
    btnAutoLoop.addEventListener('click', () => {
      if (prevLoopEnabled) {
        prevLoopEnabled = false;
        prevLoopStartTime = null;
        prevLoopEndTime = null;
        btnAutoLoop.classList.remove('active');
        btnAutoLoop.textContent = "AUTO LOOP OFF";
        if (btnLoopIn) btnLoopIn.classList.remove('active');
        if (btnLoopOut) btnLoopOut.classList.remove('active');
      } else {
        triggerAutoLoop();
      }
    });
  }
  
  function triggerAutoLoop() {
    let refAudio = null;
    if (previewStems.main.exists) refAudio = previewStems.main.audio;
    else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
    else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
    
    if (!refAudio || isNaN(refAudio.duration)) return;
    
    const bpm = prevBpmVal || 120;
    const beatDuration = 60 / bpm;
    const loopDuration = prevAutoLoopBeats * beatDuration;
    
    if (prevLoopStartTime === null) {
      prevLoopStartTime = refAudio.currentTime;
    }
    prevLoopEndTime = prevLoopStartTime + loopDuration;
    
    if (prevLoopEndTime > refAudio.duration) {
      prevLoopEndTime = refAudio.duration;
      prevLoopStartTime = Math.max(0, prevLoopEndTime - loopDuration);
    }
    
    prevLoopEnabled = true;
    if (btnAutoLoop) {
      btnAutoLoop.classList.add('active');
      btnAutoLoop.textContent = `AUTO LOOP ON`;
    }
    if (btnLoopIn) btnLoopIn.classList.add('active');
    if (btnLoopOut) btnLoopOut.classList.add('active');
  }
  
  if (btnLoopIn) {
    btnLoopIn.addEventListener('click', () => {
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (!refAudio || isNaN(refAudio.duration)) return;
      
      prevLoopStartTime = refAudio.currentTime;
      btnLoopIn.classList.add('active');
      
      if (prevLoopEndTime !== null && prevLoopEndTime > prevLoopStartTime) {
        prevLoopEnabled = true;
        if (btnLoopOut) btnLoopOut.classList.add('active');
      }
    });
  }
  
  if (btnLoopOut) {
    btnLoopOut.addEventListener('click', () => {
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (!refAudio || isNaN(refAudio.duration)) return;
      
      if (prevLoopStartTime === null) {
        prevLoopStartTime = 0;
        if (btnLoopIn) btnLoopIn.classList.add('active');
      }
      
      prevLoopEndTime = refAudio.currentTime;
      if (prevLoopEndTime <= prevLoopStartTime) {
        prevLoopEndTime = prevLoopStartTime + 1;
      }
      
      prevLoopEnabled = true;
      btnLoopOut.classList.add('active');
    });
  }
  
  if (btnLoopExit) {
    btnLoopExit.addEventListener('click', () => {
      prevLoopEnabled = false;
      prevLoopStartTime = null;
      prevLoopEndTime = null;
      if (btnAutoLoop) {
        btnAutoLoop.classList.remove('active');
        btnAutoLoop.textContent = "AUTO LOOP OFF";
      }
      if (btnLoopIn) btnLoopIn.classList.remove('active');
      if (btnLoopOut) btnLoopOut.classList.remove('active');
    });
  }

  const progHit = document.getElementById('prev-prog-hit');
  const progContainer = document.getElementById('prev-prog-container');
  if (progHit && progContainer) {
    let isScrubbing = false;
    
    function scrub(clientX) {
      let refAudio = null;
      if (previewStems.main.exists) refAudio = previewStems.main.audio;
      else if (previewStems.vocals.exists) refAudio = previewStems.vocals.audio;
      else if (previewStems.inst.audios.length > 0) refAudio = previewStems.inst.audios[0].audio;
      
      if (!refAudio || !refAudio.duration) return;
      
      const rect = progContainer.getBoundingClientRect();
      let pct = (clientX - rect.left) / rect.width;
      pct = Math.max(0, Math.min(1, pct));
      
      const seekTime = pct * refAudio.duration;
      
      if (previewStems.main.exists) previewStems.main.audio.currentTime = seekTime;
      if (previewStems.vocals.exists) previewStems.vocals.audio.currentTime = seekTime;
      previewStems.inst.audios.forEach(item => item.audio.currentTime = seekTime);
      
      updatePreviewProgress();
    }
    
    progHit.addEventListener('mousedown', (e) => {
      isScrubbing = true;
      progContainer.classList.add('scrubbing');
      scrub(e.clientX);
    });
    
    window.addEventListener('mousemove', (e) => {
      if (isScrubbing) scrub(e.clientX);
    });
    
    window.addEventListener('mouseup', () => {
      if (isScrubbing) {
        isScrubbing = false;
        progContainer.classList.remove('scrubbing');
      }
    });
  }

  const volInput = document.getElementById('prev-vol');
  if (volInput) {
    volInput.addEventListener('input', () => {
      let val = parseInt(volInput.value) || 0;
      val = Math.max(0, Math.min(100, val));
      prevVolVal = val;
      applyPreviewFilters();
    });
  }

  const bpmInput = document.getElementById('prev-bpm');
  if (bpmInput) {
    bpmInput.addEventListener('input', () => {
      let val = parseInt(bpmInput.value) || 120;
      val = Math.max(20, Math.min(300, val));
      prevBpmVal = val;
      if (prevMetronomeOn) startPreviewMetronome();
    });
  }

  const beatSelect = document.getElementById('prev-bpmdiv');
  if (beatSelect) {
    beatSelect.addEventListener('change', () => {
      prevBpmDivVal = beatSelect.value;
      if (prevMetronomeOn) startPreviewMetronome();
    });
  }

  const metroBtn = document.getElementById('prev-btn-metro');
  if (metroBtn) {
    metroBtn.addEventListener('click', () => {
      prevMetronomeOn = !prevMetronomeOn;
      if (prevMetronomeOn) {
        metroBtn.classList.add('active');
        startPreviewMetronome();
      } else {
        metroBtn.classList.remove('active');
        stopPreviewMetronome();
      }
    });
  }

  const params = [
    'bass', 'low', 'treb', 'inst', 'voc',
    'filter', 'pitch', 'speed', 'echo',
    'pan', 'reverb', 'echotime'
  ];
  
  params.forEach(param => {
    const slider = document.getElementById(`prev-${param}`);
    if (slider) {
      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        if (param === 'bass') prevBassVal = val;
        else if (param === 'low') prevLowVal = val;
        else if (param === 'treb') prevTrebVal = val;
        else if (param === 'inst') prevInstVal = val;
        else if (param === 'voc') prevVocVal = val;
        else if (param === 'filter') prevFilterVal = val;
        else if (param === 'pitch') prevPitchVal = val;
        else if (param === 'speed') prevSpeedVal = val / 100;
        else if (param === 'echo') prevEchoVal = val;
        else if (param === 'pan') prevPanVal = val;
        else if (param === 'reverb') prevReverbVal = val;
        else if (param === 'echotime') prevEchoTimeVal = val;
        
        updatePrevKnobUI(param, val);
        applyPreviewFilters();
      });
      
      updatePrevKnobUI(param, parseFloat(slider.value));
      setupPrevKnobDrag(param);
    }
  });

  for (let i = 0; i < 8; i++) {
    const btn = document.getElementById(`prev-sound-btn-${i}`);
    const cell = document.getElementById(`prev-sound-btn-cell-${i}`);
    if (btn && cell) {
      
      cell.addEventListener('dragover', (e) => {
        e.preventDefault();
        cell.classList.add('dragover');
      });
      
      cell.addEventListener('dragleave', () => {
        cell.classList.remove('dragover');
      });
      
      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        cell.classList.remove('dragover');
        
        if (e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          const ext = path.extname(file.path).toLowerCase();
          const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
          if (audioExtensions.includes(ext)) {
            try {
              const arrayBuffer = fs.readFileSync(file.path).buffer;
              initPreviewAudio();
              previewAudioCtx.decodeAudioData(arrayBuffer, (audioBuffer) => {
                previewSoundButtons[i].buffer = audioBuffer;
                previewSoundButtons[i].path = file.path;
                previewSoundButtons[i].name = file.name;
                btn.textContent = file.name.toUpperCase();
                btn.classList.add('loaded');
              });
            } catch (err) {
              console.error(err);
            }
          }
        }
      });
      
      btn.addEventListener('click', () => {
        if (!previewSoundButtons[i].buffer) return;
        initPreviewAudio();
        if (previewAudioCtx.state === 'suspended') previewAudioCtx.resume();
        
        const sourceNode = previewAudioCtx.createBufferSource();
        sourceNode.buffer = previewSoundButtons[i].buffer;
        
        sourceNode.connect(previewAudioCtx.destination);
        sourceNode.start(0);
        
        btn.classList.add('playing');
        sourceNode.onended = () => {
          btn.classList.remove('playing');
        };
      });
    }
  }

  const percentSymbol = document.getElementById('prev-vol-percent-symbol');
  if (percentSymbol && volInput) {
    percentSymbol.style.cursor = 'ns-resize';
    percentSymbol.style.userSelect = 'none';
    let isDragging = false;
    let startY = 0;
    let startVal = 0;
    percentSymbol.addEventListener('mousedown', (e) => {
      isDragging = true;
      startY = e.clientY;
      startVal = parseInt(volInput.value) || 0;
      
      const onMove = (moveEv) => {
        if (!isDragging) return;
        const delta = startY - moveEv.clientY;
        let newVol = startVal + delta;
        newVol = Math.max(0, Math.min(100, newVol));
        volInput.value = newVol;
        prevVolVal = newVol;
        applyPreviewFilters();
      };
      
      const onUp = () => {
        isDragging = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  drawPrevVisualizer();
}

function setupCanvasScratching(trackNum, canvas) {
  let isDragging = false;
  let startX = 0;
  let startTime = 0;
  let wasPlaying = false;
  let lastX = 0;
  let scratchSources = [];
  let animId = null;
  
  // Scratch loop parameters
  let lastFrameTime = 0;
  let lastPlayheadTime = 0;
  let currentClientX = 0;
  let edgeScrollSpeed = 0;
  let scratchDirection = null; // true = forward, false = backward

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const track = tracks[trackNum];
    if (track.visMode !== 'waveform') return;
    
    let stems = [];
    if (track.stems.main.exists) stems.push({ stem: track.stems.main, gainNode: track.stems.main.gainNode });
    if (track.stems.vocals.exists) stems.push({ stem: track.stems.vocals, gainNode: track.stems.vocals.gainNode });
    track.stems.inst.audios.forEach(item => {
      stems.push({ stem: item, gainNode: track.stems.inst.gainNode });
    });
    
    if (stems.length === 0) return;
    const refAudio = stems[0].stem.audio;
    if (!refAudio || isNaN(refAudio.duration) || refAudio.duration === 0) return;
    
    isDragging = true;
    startX = e.clientX;
    lastX = e.clientX;
    currentClientX = e.clientX;
    startTime = refAudio.currentTime;
    wasPlaying = track.isPlaying;
    
    // Pause HTML5 audios to avoid double playback stutter
    stems.forEach(s => s.stem.audio.pause());
    
    // Initialize frame calculations
    lastFrameTime = performance.now();
    lastPlayheadTime = startTime;
    edgeScrollSpeed = 0;
    scratchDirection = null;
    scratchSources = [];
    
    const width = canvas.width;
    const visibleSeconds = 30;
    const pixelsPerSecond = width / visibleSeconds;
    let audioPlayheadTime = startTime;

    // Start unified physics animation loop
    function scratchLoop() {
      if (!isDragging) return;
      animId = requestAnimationFrame(scratchLoop);
      
      const now = performance.now();
      const deltaTime = (now - lastFrameTime) / 1000;
      lastFrameTime = now;
      
      if (deltaTime <= 0) return;
      
      if (edgeScrollSpeed !== 0) {
        startTime += edgeScrollSpeed * deltaTime;
        startTime = Math.max(0, Math.min(refAudio.duration - 0.02, startTime));
      }
      
      const dx = currentClientX - startX;
      const timeDelta = (dx / pixelsPerSecond) * 1.0;
      let newTime = startTime - timeDelta;
      
      if (newTime < 0) {
        newTime = 0;
        startX = currentClientX - (startTime * pixelsPerSecond / 1.0);
      } else if (newTime > refAudio.duration - 0.02) {
        newTime = refAudio.duration - 0.02;
        startX = currentClientX + ((refAudio.duration - 0.02 - startTime) * pixelsPerSecond / 1.0);
      }
      
      // 1:1 direct tracking (no lag)
      const dtAudio = newTime - audioPlayheadTime;
      const secondsPerSecond = dtAudio / deltaTime;
      
      let targetRate = secondsPerSecond;
      if (Math.abs(targetRate) >= 1.0) {
         targetRate = Math.sign(targetRate) * Math.pow(Math.abs(targetRate), 0.65);
      }
      targetRate = Math.max(-50.0, Math.min(50.0, targetRate));
      
      // Force waveform to stick perfectly to the mouse
      audioPlayheadTime = newTime;
      
      const isForward = (targetRate >= 0);
      const absRate = Math.abs(targetRate);
      
      // Swap buffers on direction change to support true backward scratching in Chromium
      if (scratchDirection === null || scratchDirection !== isForward) {
        scratchSources.forEach(item => {
          try { item.source.stop(); item.source.disconnect(); item.gain.disconnect(); } catch (err) {}
        });
        scratchSources = [];
        scratchDirection = isForward;
        
        stems.forEach(s => {
          const buf = isForward ? s.stem.buffer : s.stem.reversedBuffer;
          if (buf) {
            try {
              const srcNode = audioCtx.createBufferSource();
              srcNode.buffer = buf;
              srcNode.loop = false;
              
              const gainNode = audioCtx.createGain();
              srcNode.connect(gainNode);
              gainNode.connect(s.gainNode);
              
              const startPos = isForward ? audioPlayheadTime : (buf.duration - audioPlayheadTime);
              srcNode.start(0, Math.max(0, startPos));
              srcNode.playbackRate.setValueAtTime(absRate, audioCtx.currentTime);
              
              scratchSources.push({ source: srcNode, gain: gainNode, stem: s.stem });
            } catch (err) {}
          }
        });
      } else {
        // Modulate playbackRate with turntable platter inertia
        scratchSources.forEach(item => {
          item.source.playbackRate.setTargetAtTime(absRate, audioCtx.currentTime, 0.015);
        });
      }
      
      // Sync HTML5 media position silently to audioPlayheadTime
      stems.forEach(s => {
        s.stem.audio.currentTime = audioPlayheadTime;
      });
      
      handleTrackProgress(trackNum, true);
    }
    
    animId = requestAnimationFrame(scratchLoop);
    canvas.classList.add('grabbing');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    currentClientX = e.clientX;
    
    // Evaluate if mouse pointer is in 75% edge-scrolling zones
    const rect = canvas.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const pctX = relX / rect.width;
    
    if (pctX >= 0.75) {
      edgeScrollSpeed = ((pctX - 0.75) / 0.25) * 5.0; // scroll forward (max 5s/sec)
    } else if (pctX <= 0.25) {
      edgeScrollSpeed = ((pctX - 0.25) / 0.25) * 5.0; // scroll backward (max -5s/sec)
    } else {
      edgeScrollSpeed = 0;
    }
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    canvas.classList.remove('grabbing');
    if (animId) cancelAnimationFrame(animId);
    
    const track = tracks[trackNum];
    let stems = [];
    if (track.stems.main.exists) stems.push(track.stems.main);
    if (track.stems.vocals.exists) stems.push(track.stems.vocals);
    track.stems.inst.audios.forEach(item => stems.push(item));
    
    const finalTime = (stems.length > 0) ? stems[0].audio.currentTime : startTime;
    
    // Start HTML5 audios immediately
    if (wasPlaying && track.isPlaying) {
      stems.forEach(stem => {
        stem.audio.volume = 0;
        stem.audio.currentTime = finalTime;
        stem.audio.preservesPitch = true;
        stem.audio.playbackRate = track.speedVal;
        stem.audio.play().then(() => {
          let startFade = performance.now();
          function fadeIn() {
            const elapsed = performance.now() - startFade;
            if (elapsed < 100) {
              stem.audio.volume = elapsed / 100;
              requestAnimationFrame(fadeIn);
            } else {
              stem.audio.volume = 1.0;
            }
          }
          fadeIn();
        }).catch(() => {});
      });
    } else {
      stems.forEach(stem => {
        stem.audio.currentTime = finalTime;
      });
    }
    
    // Fade out scratch sources over 150ms for gapless handover
    const sourcesToClean = [...scratchSources];
    scratchSources = [];
    
    sourcesToClean.forEach(item => {
      try {
        item.gain.gain.setValueAtTime(1.0, audioCtx.currentTime);
        item.gain.gain.linearRampToValueAtTime(0.0, audioCtx.currentTime + 0.15);
        
        // Match playback rate to normal forward speed during handover
        item.source.playbackRate.setValueAtTime(1.0, audioCtx.currentTime);
        
        setTimeout(() => {
          try {
            item.source.stop();
            item.source.disconnect();
            item.gain.disconnect();
          } catch (err) {}
        }, 160);
      } catch (err) {
        try { item.source.disconnect(); item.gain.disconnect(); } catch (e) {}
      }
    });
  });
}

function setupPreviewCanvasScratching(canvas) {
  let isDragging = false;
  let startX = 0;
  let startTime = 0;
  let wasPlaying = false;
  let lastX = 0;
  let scratchSources = [];
  let animId = null;

  // Scratch loop parameters
  let lastFrameTime = 0;
  let lastPlayheadTime = 0;
  let currentClientX = 0;
  let edgeScrollSpeed = 0;
  let scratchDirection = null;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (previewVisMode !== 'waveform') return;
    
    let stems = [];
    if (previewStems.main.exists) stems.push({ stem: previewStems.main, gainNode: previewStems.main.gainNode });
    if (previewStems.vocals.exists) stems.push({ stem: previewStems.vocals, gainNode: previewStems.vocals.gainNode });
    previewStems.inst.audios.forEach(item => {
      stems.push({ stem: item, gainNode: previewStems.inst.gainNode });
    });
    
    if (stems.length === 0) return;
    const refAudio = stems[0].stem.audio;
    if (!refAudio || isNaN(refAudio.duration) || refAudio.duration === 0) return;
    
    isDragging = true;
    startX = e.clientX;
    lastX = e.clientX;
    currentClientX = e.clientX;
    startTime = refAudio.currentTime;
    wasPlaying = previewIsPlaying;
    
    // Pause HTML5 preview audios
    stems.forEach(s => s.stem.audio.pause());
    
    // Initialize frame calculations
    lastFrameTime = performance.now();
    lastPlayheadTime = startTime;
    edgeScrollSpeed = 0;
    scratchDirection = null;
    scratchSources = [];
    
    const width = canvas.width;
    const visibleSeconds = 30;
    const pixelsPerSecond = width / visibleSeconds;
    let audioPlayheadTime = startTime;

    function scratchLoop() {
      if (!isDragging) return;
      animId = requestAnimationFrame(scratchLoop);
      
      const now = performance.now();
      const deltaTime = (now - lastFrameTime) / 1000;
      lastFrameTime = now;
      
      if (deltaTime <= 0) return;
      
      if (edgeScrollSpeed !== 0) {
        startTime += edgeScrollSpeed * deltaTime;
        startTime = Math.max(0, Math.min(refAudio.duration - 0.02, startTime));
      }
      
      const dx = currentClientX - startX;
      const timeDelta = (dx / pixelsPerSecond) * 1.0;
      let newTime = startTime - timeDelta;
      
      if (newTime < 0) {
        newTime = 0;
        startX = currentClientX - (startTime * pixelsPerSecond / 1.0);
      } else if (newTime > refAudio.duration - 0.02) {
        newTime = refAudio.duration - 0.02;
        startX = currentClientX + ((refAudio.duration - 0.02 - startTime) * pixelsPerSecond / 1.0);
      }
      
      // 1:1 direct tracking (no lag)
      const dtAudio = newTime - audioPlayheadTime;
      const secondsPerSecond = dtAudio / deltaTime;
      
      let targetRate = secondsPerSecond;
      if (Math.abs(targetRate) >= 1.0) {
         targetRate = Math.sign(targetRate) * Math.pow(Math.abs(targetRate), 0.65);
      }
      targetRate = Math.max(-50.0, Math.min(50.0, targetRate));
      
      // Force waveform to stick perfectly to the mouse
      audioPlayheadTime = newTime;
      
      const isForward = (targetRate >= 0);
      const absRate = Math.abs(targetRate);
      
      if (scratchDirection === null || scratchDirection !== isForward) {
        scratchSources.forEach(item => {
          try { item.source.stop(); item.source.disconnect(); item.gain.disconnect(); } catch (err) {}
        });
        scratchSources = [];
        scratchDirection = isForward;
        
        stems.forEach(s => {
          const buf = isForward ? s.stem.buffer : s.stem.reversedBuffer;
          if (buf) {
            try {
              const srcNode = previewAudioCtx.createBufferSource();
              srcNode.buffer = buf;
              srcNode.loop = false;
              
              const gainNode = previewAudioCtx.createGain();
              srcNode.connect(gainNode);
              gainNode.connect(s.gainNode);
              
              const startPos = isForward ? audioPlayheadTime : (buf.duration - audioPlayheadTime);
              srcNode.start(0, Math.max(0, startPos));
              srcNode.playbackRate.setValueAtTime(absRate, previewAudioCtx.currentTime);
              
              scratchSources.push({ source: srcNode, gain: gainNode, stem: s.stem });
            } catch (err) {}
          }
        });
      } else {
        scratchSources.forEach(item => {
          item.source.playbackRate.setTargetAtTime(absRate, previewAudioCtx.currentTime, 0.015);
        });
      }
      
      stems.forEach(s => {
        s.stem.audio.currentTime = audioPlayheadTime;
      });
      
      updatePreviewProgress();
    }
    
    animId = requestAnimationFrame(scratchLoop);
    canvas.classList.add('grabbing');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    currentClientX = e.clientX;
    
    // Evaluate if mouse pointer is in 75% edge-scrolling zones
    const rect = canvas.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const pctX = relX / rect.width;
    
    if (pctX >= 0.75) {
      edgeScrollSpeed = ((pctX - 0.75) / 0.25) * 5.0; // scroll forward (max 5s/sec)
    } else if (pctX <= 0.25) {
      edgeScrollSpeed = ((pctX - 0.25) / 0.25) * 5.0; // scroll backward (max -5s/sec)
    } else {
      edgeScrollSpeed = 0;
    }
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    canvas.classList.remove('grabbing');
    if (animId) cancelAnimationFrame(animId);
    
    let stems = [];
    if (previewStems.main.exists) stems.push(previewStems.main);
    if (previewStems.vocals.exists) stems.push(previewStems.vocals);
    previewStems.inst.audios.forEach(item => stems.push(item));
    
    const finalTime = (stems.length > 0) ? stems[0].audio.currentTime : startTime;
    
    if (wasPlaying && previewIsPlaying) {
      stems.forEach(stem => {
        stem.audio.volume = 0;
        stem.audio.currentTime = finalTime;
        stem.audio.play().then(() => {
          let startFade = performance.now();
          function fadeIn() {
            const elapsed = performance.now() - startFade;
            if (elapsed < 100) {
              stem.audio.volume = elapsed / 100;
              requestAnimationFrame(fadeIn);
            } else {
              stem.audio.volume = 1.0;
            }
          }
          fadeIn();
        }).catch(() => {});
      });
    } else {
      stems.forEach(stem => {
        stem.audio.currentTime = finalTime;
      });
    }
    
    const sourcesToClean = [...scratchSources];
    scratchSources = [];
    
    sourcesToClean.forEach(item => {
      try {
        item.gain.gain.setValueAtTime(1.0, previewAudioCtx.currentTime);
        item.gain.gain.linearRampToValueAtTime(0.0, previewAudioCtx.currentTime + 0.15);
        
        item.source.playbackRate.setValueAtTime(1.0, previewAudioCtx.currentTime);
        
        setTimeout(() => {
          try {
            item.source.stop();
            item.source.disconnect();
            item.gain.disconnect();
          } catch (err) {}
        }, 160);
      } catch (err) {
        try { item.source.disconnect(); item.gain.disconnect(); } catch (e) {}
      }
    });
  });
}

// Signal the main process that the app is completely loaded and ready to be shown
setTimeout(() => {
  ipcRenderer.send('app-ready');
}, 250);
