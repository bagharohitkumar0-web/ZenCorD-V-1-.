(function () {
  "use strict";
  if (window.__RaZe_loaded) {
    return;
  }
  window.__RaZe_loaded = true;

  const STORAGE_KEY = "raze-state";
  
  // DEFAULT STATE
  const defaultState = Object.freeze({
    profile: "normal",
    netQuality: "max", 
    masterGain: 18,
    rageBoost: 2,
    bitrate: 2500,
    distortion: 0,
    noiseGate: 1,
    reverb: 0,
    pitch: 0,
    bass: 0,
    treble: 0,
    eightD: 0,
    clippingMode: "soft", // 'soft', 'hard', 'voicelock'
    turboActive: false,
    bypassActive: false, 
    muteActive: false,
    panelLocked: false,
    collapsed: false,
    panelX: 20,
    panelY: 20
  });

  const initialState = { ...defaultState };
  const appState = Object.seal(initialState);
  
  const TURBO_GAIN = 36;
  const TURBO_RAGE = 3;

  const profilesConfig = Object.freeze({
    normal: { masterGain: 18, rageBoost: 2, bitrate: 2500, distortion: 0, noiseGate: 0, reverb: 0, pitch: 0, bass: 0, treble: 0, eightD: 0, netQuality: "max", clippingMode: "soft" },
    broadcast: { masterGain: 5, rageBoost: 30, bitrate: 2500, distortion: 8, noiseGate: 2.5, reverb: 0, pitch: 0, bass: 5, treble: 2, eightD: 0, netQuality: "max", clippingMode: "soft" },
    max: { masterGain: 30, rageBoost: 3, bitrate: 2500, distortion: 8, noiseGate: 0, reverb: 0, pitch: -3, bass: 50, treble: 10, eightD: 0, netQuality: "max", clippingMode: "hard" },
    bassMonster: { masterGain: 15, rageBoost: 100, bitrate: 2500, distortion: 30, noiseGate: 0, reverb: 10, pitch: -2, bass: 50, treble: -5, eightD: 0, netQuality: "max", clippingMode: "hard" },
    RaZelock: { masterGain: 36, rageBoost: 3, bitrate: 2500, distortion: 4, noiseGate: 0, reverb: 0, pitch: 0, bass: 50, treble: 20, eightD: 0, netQuality: "max", clippingMode: "voicelock" }
  });

  function clampValue(val, min, max) { return Math.min(max, Math.max(min, val)); }

  let saveTimer = null;
  function debouncedSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToStorage, 300);
  }

  function loadFromStorage() {
    try {
      const storedData = localStorage.getItem(STORAGE_KEY);
      if (!storedData) return;
      const parsedData = JSON.parse(storedData);
      if (!parsedData || typeof parsedData !== "object") return;

      if (Object.keys(profilesConfig).includes(parsedData.profile) || parsedData.profile === "custom") appState.profile = parsedData.profile;
      if (["max", "std", "low"].includes(parsedData.netQuality)) appState.netQuality = parsedData.netQuality;
      if (["soft", "hard", "voicelock"].includes(parsedData.clippingMode)) appState.clippingMode = parsedData.clippingMode;
      
      if (typeof parsedData.masterGain === "number") appState.masterGain = clampValue(parsedData.masterGain, 1, 36);
      if (typeof parsedData.rageBoost === "number") appState.rageBoost = clampValue(parsedData.rageBoost, 0, 6);
      if (typeof parsedData.bitrate === "number") appState.bitrate = clampValue(parsedData.bitrate, 1, 2500);
      if (typeof parsedData.distortion === "number") appState.distortion = clampValue(parsedData.distortion, 0, 500);
      if (typeof parsedData.noiseGate === "number") appState.noiseGate = clampValue(parsedData.noiseGate, 0, 50);
      if (typeof parsedData.reverb === "number") appState.reverb = clampValue(parsedData.reverb, 0, 100);
      if (typeof parsedData.pitch === "number") appState.pitch = clampValue(parsedData.pitch, -12, 12);
      if (typeof parsedData.bass === "number") appState.bass = clampValue(parsedData.bass, -20, 50);
      if (typeof parsedData.treble === "number") appState.treble = clampValue(parsedData.treble, -20, 30);
      if (typeof parsedData.eightD === "number") appState.eightD = clampValue(parsedData.eightD, 0, 10);
      
      appState.panelLocked = Boolean(parsedData.panelLocked);
      appState.collapsed = Boolean(parsedData.collapsed);
      if (typeof parsedData.panelX === "number") appState.panelX = Math.max(0, parsedData.panelX);
      if (typeof parsedData.panelY === "number") appState.panelY = Math.max(0, parsedData.panelY);
    } catch (e) {}
    
    appState.turboActive = false;
    appState.muteActive = false;
    appState.bypassActive = true; 
  }

  function saveToStorage() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(appState)); } catch (e) {} }

  loadFromStorage();

  // AUDIO WORKLET ( VOICE LOCK ENGINE)
  const audioWorkletCode = `
        class ZenProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this._dcX = new Float32Array(8); this._dcY = new Float32Array(8);
                this._rvbLens = [887, 1153, 1559, 1907, 2311, 2719, 3109, 3557];
                this._preDelayLen = 577; this._apLens = [241, 433];
                this._rvbBufs = []; this._rvbIdx = []; this._rvbLPState = [];
                this._preDelay = []; this._preIdx = []; this._apBufs = []; this._apIdx = [];
                this._rvbTmp = new Float64Array(8);
                this.psBuf = [];
                
                for (let ch = 0; ch < 8; ch++) {
                    this._rvbBufs[ch] = this._rvbLens.map(l => new Float32Array(l));
                    this._rvbIdx[ch] = new Int32Array(8); this._rvbLPState[ch] = new Float32Array(8);
                    this._preDelay[ch] = new Float32Array(this._preDelayLen); this._preIdx[ch] = 0;
                    this._apBufs[ch] = this._apLens.map(l => new Float32Array(l)); this._apIdx[ch] = new Int32Array(2);
                    this.psBuf[ch] = new Float32Array(4096);
                }
                this.psWPtr = 0; this.psPhase = 0; this.psWindowSize = 2048; this.lfoPhase = 0;
            }

            static get parameterDescriptors() {
                return [
                    { name: 'gain', defaultValue: 1.0 }, { name: 'rage', defaultValue: 0.0 },
                    { name: 'distort', defaultValue: 0.0 }, { name: 'bitrate', defaultValue: 2500 },
                    { name: 'gate', defaultValue: 1.0 }, { name: 'mute', defaultValue: 0 },
                    { name: 'reverb', defaultValue: 0 }, { name: 'pitch', defaultValue: 0 },
                    { name: 'eightD', defaultValue: 0 }, { name: 'clipMode', defaultValue: 0 } // 0=soft, 1=hard, 2=voicelock
                ];
            }

            softClip(x, knee) {
                const abs = Math.abs(x); if (abs <= knee) return x;
                const excess = abs - knee; const headroom = 1.0 - knee;
                return (x > 0 ? 1 : -1) * (knee + headroom * excess / (excess + headroom * 0.3));
            }

            process(inputs, outputs, params) {
                const input = inputs[0]; const output = outputs[0];
                if (!input || !input.length || !input[0].length) return true;

                for (let i = 0; i < input[0].length; i++) {
                    const gain = params.gain.length > 1 ? params.gain[i] : params.gain[0];
                    const rage = params.rage.length > 1 ? params.rage[i] : params.rage[0];
                    const distort = params.distort.length > 1 ? params.distort[i] : params.distort[0];
                    const bitrate = params.bitrate.length > 1 ? params.bitrate[i] : params.bitrate[0];
                    const gate = params.gate.length > 1 ? params.gate[i] : params.gate[0];
                    const mute = params.mute.length > 1 ? params.mute[i] : params.mute[0];
                    const reverb = params.reverb.length > 1 ? params.reverb[i] : params.reverb[0];
                    const pitch = params.pitch.length > 1 ? params.pitch[i] : params.pitch[0];
                    const eightD = params.eightD.length > 1 ? params.eightD[i] : params.eightD[0];
                    const clipMode = params.clipMode.length > 1 ? params.clipMode[i] : params.clipMode[0];

                    const boost = Math.min(gain * (1 + (rage * 0.75)), 36); 
                    const step = 1 / (bitrate / 20);
                    
                    let panL = 1, panR = 1;
                    if (eightD > 0) {
                        this.lfoPhase += (eightD * 0.2) / 48000;
                        if (this.lfoPhase > Math.PI * 2) this.lfoPhase -= Math.PI * 2;
                        const panPos = Math.sin(this.lfoPhase);
                        panL = Math.sqrt(0.5 * (1 - panPos)); panR = Math.sqrt(0.5 * (1 + panPos));
                    }

                    for (let ch = 0; ch < input.length; ch++) {
                        let s = input[ch][i];
                        if (mute > 0.5) { output[ch][i] = 0; continue; }

                        if (Math.abs(pitch) > 0.1) {
                            this.psBuf[ch][this.psWPtr] = s;
                            let delay1 = this.psPhase * this.psWindowSize;
                            let delay2 = ((this.psPhase + 0.5) % 1.0) * this.psWindowSize;
                            let rPtr1 = (this.psWPtr - delay1 + 4096) % 4096, rPtr2 = (this.psWPtr - delay2 + 4096) % 4096;
                            let idx1 = Math.floor(rPtr1), frac1 = rPtr1 - idx1;
                            let s1 = this.psBuf[ch][idx1] * (1-frac1) + this.psBuf[ch][(idx1+1)%4096] * frac1;
                            let idx2 = Math.floor(rPtr2), frac2 = rPtr2 - idx2;
                            let s2 = this.psBuf[ch][idx2] * (1-frac2) + this.psBuf[ch][(idx2+1)%4096] * frac2;
                            s = s1 * (1 - Math.abs(this.psPhase * 2 - 1)) + s2 * (1 - Math.abs(((this.psPhase + 0.5) % 1.0) * 2 - 1));
                        }

                        const prevX = this._dcX[ch]; this._dcX[ch] = s;
                        s = s - prevX + 0.9975 * this._dcY[ch]; this._dcY[ch] = s;

                        const absS = Math.abs(s), gThresh = gate * 0.003, gKnee = gThresh * 4;
                        if (absS < gThresh) s = 0; else if (absS < gKnee) s *= (absS - gThresh) / (gKnee - gThresh);
                        if (bitrate < 2500) s = Math.round(s / step) * step;

                        // RAZECORD LOUD FEATURES
                        s *= boost;

                        if (rage > 0) s *= (1.0 + (rage * 0.04));

                        if (distort > 0) {
                            const shaped = Math.tanh(s * (1 + distort * 0.5));
                            const mix = Math.min(distort / 100, 1.0);
                            s = s * (1 - mix) + shaped * Math.max(Math.abs(s), 0.01) * mix;
                        }

                        if (reverb > 0.5) {
                            const wet = reverb / 100, fdbk = 0.6 + wet * 0.32, dmp = 0.3 + wet * 0.3;
                            const preBuf = this._preDelay[ch], preI = this._preIdx[ch];
                            const preOut = preBuf[preI]; preBuf[preI] = s; this._preIdx[ch] = (preI + 1) % this._preDelayLen;
                            let diff = preOut;
                            for (let ap = 0; ap < 2; ap++) {
                                const ab = this._apBufs[ch][ap], ai = this._apIdx[ch][ap], v = ab[ai];
                                ab[ai] = diff + 0.6 * v; diff = v - 0.6 * diff; this._apIdx[ch][ap] = (ai + 1) % this._apLens[ap];
                            }
                            let lineSum = 0;
                            for (let t = 0; t < 8; t++) {
                                const d = this._rvbBufs[ch][t][this._rvbIdx[ch][t]];
                                this._rvbLPState[ch][t] += dmp * (d - this._rvbLPState[ch][t]);
                                this._rvbTmp[t] = this._rvbLPState[ch][t]; lineSum += this._rvbTmp[t];
                            }
                            let rOut = 0; const mScale = lineSum * 0.25;
                            for (let t = 0; t < 8; t++) {
                                const buf = this._rvbBufs[ch][t], idx = this._rvbIdx[ch][t];
                                buf[idx] = diff * 0.354 + (this._rvbTmp[t] - mScale) * fdbk;
                                this._rvbIdx[ch][t] = (idx + 1) % buf.length; rOut += this._rvbTmp[t];
                            }
                            s = s * Math.sqrt(1.0 - wet) + (rOut * 0.125) * Math.sqrt(wet);
                        }

                        if (eightD > 0) { if (ch === 0) s *= panL; else if (ch === 1) s *= panR; }
                        
                        // NEW: CLIPPING ENGINE ROUTER
                        if (clipMode === 2) {
                            // VOICE LOCK: Extreme RaZecord absolute square wave
                            s = s * 50; 
                            s = Math.max(-1, Math.min(1, s)); 
                        } else if (clipMode === 1) {
                            // HARD CLIP: Standard Brickwall limit
                            s = Math.max(-1, Math.min(1, s));
                        } else {
                            // SOFT CLIP: Smooth saturation limit
                            s = this.softClip(s, 0.88);
                        }

                        output[ch][i] = s;
                    }
                    
                    if (Math.abs(pitch) > 0.1) {
                        this.psPhase += (1 - Math.pow(2, pitch / 12)) / this.psWindowSize;
                        if (this.psPhase >= 1.0) this.psPhase -= 1.0; else if (this.psPhase < 0.0) this.psPhase += 1.0;
                    }
                    this.psWPtr = (this.psWPtr + 1) % 4096;
                }
                return true;
            }
        }
        registerProcessor('raze-processor', RaZeProcessor);
    `;

  const BaseAudioContext = window.AudioContext || window.webkitAudioContext;
  let workletLoadPromise = null;

  window.AudioContext = class extends BaseAudioContext {
    constructor() {
      super({ latencyHint: "interactive", sampleRate: 48000 });
      window.__RaZeAudioCtx = this;
      const blob = new Blob([audioWorkletCode], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      workletLoadPromise = this.audioWorklet.addModule(url).then(() => { URL.revokeObjectURL(url); uiManager.setStatus("SYSTEM LIVE", "ok"); })
        .catch(() => { URL.revokeObjectURL(url); uiManager.setStatus("ENGINE FAILED", "err"); });
    }
  };
  Object.defineProperty(window.AudioContext, "name", { value: "AudioContext" });

  const audioEngine = {
    workletNode: null, analyserNode: null, bassNode: null, trebleNode: null, sourceNode: null,
    clipMonitorTimer: null, clipHoldUntil: 0, visReq: null,
    
    async intercept(mediaStream) {
      const audioCtx = window.__RaZeAudioCtx;
      if (!audioCtx) return mediaStream;
      if (audioCtx.state === "suspended") await audioCtx.resume();
      if (workletLoadPromise) await workletLoadPromise;
      
      this.cleanup();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      const destination = audioCtx.createMediaStreamDestination();
      destination.channelCount = 2; destination.channelCountMode = "explicit";
      
      try {
        this.sourceNode = source;
        this.bassNode = audioCtx.createBiquadFilter(); this.bassNode.type = "lowshelf"; this.bassNode.frequency.value = 120;
        this.trebleNode = audioCtx.createBiquadFilter(); this.trebleNode.type = "highshelf"; this.trebleNode.frequency.value = 4000;
        this.workletNode = new AudioWorkletNode(audioCtx, "raze-processor", { outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
        this.analyserNode = audioCtx.createAnalyser(); this.analyserNode.fftSize = 512;
        
        source.connect(this.bassNode); this.bassNode.connect(this.trebleNode); this.trebleNode.connect(this.workletNode);
        this.workletNode.connect(this.analyserNode); this.analyserNode.connect(destination);
        
        this.pushParams();
        this.startMonitors();
        return destination.stream;
      } catch (e) {
        uiManager.setStatus("FALLBACK MIC", "err");
        return mediaStream;
      }
    },
    
    cleanup() {
      if (this.clipMonitorTimer) clearInterval(this.clipMonitorTimer);
      if (this.visReq) cancelAnimationFrame(this.visReq);
      try { if (this.sourceNode) this.sourceNode.disconnect(); } catch (e) {}
      try { if (this.bassNode) this.bassNode.disconnect(); } catch (e) {}
      try { if (this.trebleNode) this.trebleNode.disconnect(); } catch (e) {}
      try { if (this.workletNode) this.workletNode.disconnect(); } catch (e) {}
      try { if (this.analyserNode) this.analyserNode.disconnect(); } catch (e) {}
    },
    
    startMonitors() {
      if (!this.analyserNode) return;
      if (this.clipMonitorTimer) clearInterval(this.clipMonitorTimer);
      if (this.visReq) cancelAnimationFrame(this.visReq);

      const canvas = document.getElementById("synth-visualizer");
      if (canvas) {
        const ctx = canvas.getContext("2d");
        const bufferLength = this.analyserNode.frequencyBinCount;
        const dataArrayFreq = new Uint8Array(bufferLength);
        
        const draw = () => {
          this.visReq = requestAnimationFrame(draw);
          this.analyserNode.getByteFrequencyData(dataArrayFreq);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          
          const barWidth = (canvas.width / bufferLength) * 2.5;
          let barHeight, x = 0;
          
          for(let i = 0; i < bufferLength; i++) {
            barHeight = (dataArrayFreq[i] / 255) * canvas.height;
            const r = 255 - (barHeight * 0.5); 
            const g = 0; 
            const b = 100 + (barHeight * 0.8); 
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
            x += barWidth + 1;
          }
        };
        draw();
      }
    },

    stopMonitors() {
        if (this.clipMonitorTimer) clearInterval(this.clipMonitorTimer);
        if (this.visReq) cancelAnimationFrame(this.visReq);
    },
    
    pushParams() {
      const time = window.__RaZeAudioCtx ? window.__RaZeAudioCtx.currentTime : 0;
      if (this.bassNode) this.bassNode.gain.setTargetAtTime(appState.bypassActive ? 0 : appState.bass, time, 0.04);
      if (this.trebleNode) this.trebleNode.gain.setTargetAtTime(appState.bypassActive ? 0 : appState.treble, time, 0.04);
      
      if (!this.workletNode) return;
      const p = this.workletNode.parameters;
      let pGain = appState.turboActive ? TURBO_GAIN : appState.masterGain;
      let pRage = appState.turboActive ? TURBO_RAGE : appState.rageBoost;
      
      if (appState.bypassActive) {
          p.get("gain").setTargetAtTime(1, time, 0.04); p.get("rage").setTargetAtTime(0, time, 0.04);
          p.get("distort").setTargetAtTime(0, time, 0.04); p.get("bitrate").setTargetAtTime(2500, time, 0.04);
          p.get("gate").setTargetAtTime(1, time, 0.04); p.get("mute").setTargetAtTime(0, time, 0.04);
          p.get("reverb").setTargetAtTime(0, time, 0.04); p.get("pitch").setTargetAtTime(0, time, 0.04);
          p.get("eightD").setTargetAtTime(0, time, 0.04); p.get("clipMode").setTargetAtTime(0, time, 0.04);
          uiManager.setStatus("BYPASS ON", "warn"); return;
      }
      
      p.get("gain").setTargetAtTime(pGain, time, 0.04);
      p.get("rage").setTargetAtTime(pRage, time, 0.04);
      p.get("distort").setTargetAtTime(appState.distortion, time, 0.04);
      p.get("bitrate").setTargetAtTime(appState.bitrate, time, 0.04);
      p.get("gate").setTargetAtTime(appState.noiseGate, time, 0.04);
      p.get("mute").setTargetAtTime(appState.muteActive ? 1 : 0, time, 0.04);
      p.get("reverb").setTargetAtTime(appState.reverb, time, 0.04);
      p.get("pitch").setTargetAtTime(appState.pitch, time, 0.04);
      p.get("eightD").setTargetAtTime(appState.eightD, time, 0.04);
      
      let clipVal = 0;
      if (appState.clippingMode === 'hard') clipVal = 1;
      else if (appState.clippingMode === 'voicelock') clipVal = 2;
      p.get("clipMode").setTargetAtTime(clipVal, time, 0.04);
      
      if (appState.muteActive) uiManager.setStatus("MUTED", "err");
      else if (appState.turboActive) uiManager.setStatus("TURBO MAX", "alert");
      else if (appState.clippingMode === 'voicelock') uiManager.setStatus("VOICE LOCKED", "alert");
      else uiManager.setStatus("ACTIVE", "ok");
    }
  };

  // RAW SDP FORCE (Bypass compression)
  function patchSDP(sdp) {
    const match = sdp.match(/a=rtpmap:(\d+) opus\/48000/);
    if (!match) return sdp;
    const pt = match[1];
    const fmtpRegex = new RegExp("a=fmtp:" + pt + " [^\\r\\n]+");
    
    let newFmtp = "", asBitrate = "";
    if (appState.netQuality === "max") {
        newFmtp = "a=fmtp:" + pt + " minptime=10;useinbandfec=1;usedtx=0;stereo=1;maxaveragebitrate=510000;maxplaybackrate=48000;sprop-maxcapturerate=48000;cbr=0";
        asBitrate = "b=AS:510";
    } else if (appState.netQuality === "low") {
        newFmtp = "a=fmtp:" + pt + " minptime=20;useinbandfec=0;usedtx=1;stereo=0;maxaveragebitrate=12000;maxplaybackrate=16000;cbr=1";
        asBitrate = "b=AS:12";
    } else {
        newFmtp = "a=fmtp:" + pt + " useinbandfec=1;stereo=1;maxaveragebitrate=64000";
        asBitrate = "b=AS:64";
    }

    if (fmtpRegex.test(sdp)) sdp = sdp.replace(fmtpRegex, newFmtp);
    else sdp = sdp.replace(new RegExp("(a=rtpmap:" + pt + " opus\\/48000\\/2)"), "$1\r\n" + newFmtp);
    sdp = sdp.replace(/b=AS:\d+/g, asBitrate);
    return sdp;
  }

  const BaseRTCPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends BaseRTCPeerConnection {
    async createOffer(options) { const offer = await super.createOffer(options); offer.sdp = patchSDP(offer.sdp); return offer; }
    async createAnswer(options) { const answer = await super.createAnswer(options); answer.sdp = patchSDP(answer.sdp); return answer; }
    async setLocalDescription(desc) { if (desc && desc.sdp) desc = new RTCSessionDescription({ type: desc.type, sdp: patchSDP(desc.sdp) }); return super.setLocalDescription(desc); }
    async setRemoteDescription(desc) { if (desc && desc.sdp) desc = new RTCSessionDescription({ type: desc.type, sdp: patchSDP(desc.sdp) }); return super.setRemoteDescription(desc); }
  };
  Object.defineProperty(window.RTCPeerConnection, "name", { value: "RTCPeerConnection" });

  const baseGetUserMedia = Object.getPrototypeOf(navigator.mediaDevices).getUserMedia;
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    if (constraints && constraints.audio) constraints.audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000, sampleSize: 16 };
    const stream = await baseGetUserMedia.call(navigator.mediaDevices, constraints);
    if (constraints && constraints.audio && stream.getAudioTracks().length > 0) return audioEngine.intercept(stream);
    return stream;
  };

  const uiManager = {
    init() {
      this.injectStyles(); this.build(); this.bind(); this.enableDrag(); this.applyFromState();
      this.setStatus("WAITING", "wait");
      document.querySelectorAll("#synth-panel input[type=\"range\"]").forEach(el => el.dispatchEvent(new Event("input", { bubbles: true })));
    },
    setStatus(text, type) {
      const label = document.getElementById("synth-status");
      if (label) {
        label.textContent = text;
        label.className = "synth-status-badge " + type;
      }
    },
    formatValue(param, val) {
      if (param === "masterGain") return val.toFixed(1) + "x";
      if (param === "rageBoost" || param === "distortion" || param === "reverb") return Math.round(val) + "%";
      if (param === "noiseGate" || param === "eightD") return val.toFixed(1);
      if (param === "pitch") return val > 0 ? "+" + val + "st" : val + "st";
      if (param === "bass" || param === "treble") return val > 0 ? "+" + val + "dB" : val + "dB";
      return String(val);
    },
    updateValueLabel(param) {
      const lbl = document.getElementById("lbl-" + param);
      if (lbl) lbl.textContent = this.formatValue(param, appState[param]);
    },
    applyProfile(profileName) {
      const conf = profilesConfig[profileName];
      if (!conf) return;
      appState.profile = profileName;
      Object.keys(conf).forEach(k => { appState[k] = conf[k]; });
      
      ["masterGain", "rageBoost", "bitrate", "distortion", "noiseGate", "reverb", "pitch", "bass", "treble", "eightD"].forEach(param => {
        const input = document.querySelector(`#synth-panel input[data-param="${param}"]`);
        if (input) { input.value = String(appState[param]); input.dispatchEvent(new Event("input", { bubbles: true })); }
        this.updateValueLabel(param);
      });
      
      const select = document.getElementById("synth-profile"); if (select) select.value = appState.profile;
      const netSelect = document.getElementById("synth-net"); if(netSelect) netSelect.value = appState.netQuality;
      
      const clipRadio = document.querySelector(`input[name="clipMode"][value="${appState.clippingMode}"]`);
      if (clipRadio) clipRadio.checked = true;

      saveToStorage(); audioEngine.pushParams();
    },
    applyFromState() {
      const panel = document.getElementById("synth-panel"), body = document.getElementById("synth-body");
      if (panel) { panel.style.left = appState.panelX + "px"; panel.style.top = appState.panelY + "px"; }
      if (body) body.style.display = appState.collapsed ? "none" : "";
      
      const setTgl = (id, state) => { const el = document.getElementById(id); if(el) el.checked = state; };
      setTgl("tgl-turbo", appState.turboActive);
      setTgl("tgl-bypass", appState.bypassActive);
      setTgl("tgl-mute", appState.muteActive);
      
      const netSelect = document.getElementById("synth-net"); if(netSelect) netSelect.value = appState.netQuality;
      const profSelect = document.getElementById("synth-profile"); if(profSelect) profSelect.value = appState.profile;
      
      const clipRadio = document.querySelector(`input[name="clipMode"][value="${appState.clippingMode}"]`);
      if (clipRadio) clipRadio.checked = true;

      ["masterGain", "rageBoost", "bitrate", "distortion", "noiseGate", "reverb", "pitch", "bass", "treble", "eightD"].forEach(param => {
        const input = document.querySelector(`#synth-panel input[data-param="${param}"]`);
        if (input) input.value = String(appState[param]); this.updateValueLabel(param);
      });

      // Init lock button state
      const lockBtn = document.getElementById("btn-lock");
      if (appState.panelLocked) {
          lockBtn.textContent = "ꗃꄗ LOCKED";
          lockBtn.classList.add("locked");
          document.getElementById("synth-header").style.cursor = "default";
      } else {
          lockBtn.textContent = "ꗃꄗ UNLOCK";
          lockBtn.classList.remove("locked");
          document.getElementById("synth-header").style.cursor = "move";
      }
    },
    build() {
      const panelEl = document.createElement("aside"); panelEl.id = "synth-panel";
      panelEl.innerHTML = `
        <header id="synth-header" class="synth-header">
            <div>
                <div class="synth-title gradient-text">zenCorD V1</div>
                <div class="synth-creator">By Zenbll (@unfoldedfaith / @fametalks)<br>& Modexà (@modexathegreat)</div>
            </div>
            <div class="synth-window-controls">
                <button id="btn-collapse" class="synth-icon-btn">−</button>
                <button id="btn-lock" class="synth-lock-btn glow-purple"> UNLOCK</button>
            </div>
        </header>
        <section id="synth-body" class="synth-body">
            
            <div class="synth-top-bar">
                <span id="synth-status" class="synth-status-badge wait">WAITING</span>
                <canvas id="synth-visualizer" width="160" height="24"></canvas>
            </div>

            <!-- MAIN OPTIONS -->
            <div class="synth-module">
                <div class="synth-module-title">✦ ------------------------------ ✦</div>
                
                <div class="synth-options-grid">
                    <label class="synth-master-btn"><input type="checkbox" id="tgl-turbo"> <span>TURBO MODE</span></label>
                    <label class="synth-master-btn bypass"><input type="checkbox" id="tgl-bypass"> <span>BYPASS ALL</span></label>
                    <label class="synth-master-btn alert"><input type="checkbox" id="tgl-mute"> <span>MUTE MIC</span></label>
                    <label class="synth-master-btn"><input type="button" onclick="document.getElementById('synth-net').value='max'; document.getElementById('synth-net').dispatchEvent(new Event('change'))"> <span>ANTI-COMPRESS</span></label>
                </div>

                <div class="synth-sys-row">
                    <select id="synth-profile" class="synth-dropdown">
                        <option value="normal">Profile: Normal</option>
                        <option value="broadcast">Profile: Broadcast</option>
                        <option value="max">Profile: Max Earrape</option>
                        <option value="RaZelock">Profile: RaZe Lock</option>
                        <option value="bassMonster">Profile: Bass Monster</option>
                        <option value="telephone">Profile: Glitchy Phone</option>
                        <option value="custom">Profile: Custom</option>
                    </select>
                    <select id="synth-net" class="synth-dropdown">
                        <option value="max">Net: 510 kbps</option>
                        <option value="std">Net: 64 kbps</option>
                        <option value="low">Net: 12 kbps</option>
                    </select>
                </div>
            </div>

            <!-- CLIPPING ENGINE SECTION -->
            <div class="synth-module">
                <div class="synth-module-title" style="color: #ff003c; text-shadow: 0 0 8px rgba(255,0,60,0.4);">✦ CLIPPING ENGINE ✦</div>
                <div class="synth-clip-group">
                    <label class="synth-clip-btn"><input type="radio" name="clipMode" value="soft"><span>SOFT CLIP</span></label>
                    <label class="synth-clip-btn"><input type="radio" name="clipMode" value="hard"><span>HARD CLIP</span></label>
                    <label class="synth-clip-btn extreme"><input type="radio" name="clipMode" value="voicelock"><span>VOICE LOCK</span></label>
                </div>
            </div>

            <!-- REAL-TIME SLIDERS -->
            <div class="synth-module">
                <div class="synth-module-title" style="margin-bottom: 12px; text-align: center; color: var(--neon-purple);">✦ REAL-TIME SLIDERS ✦</div>
                
                <div class="synth-control-group">
                    <div class="synth-lbl-row"><span>MASTER GAIN</span><span id="lbl-masterGain" class="synth-val">1.0x</span></div>
                    <input data-param="masterGain" type="range" min="1" max="36" step="1" value="1" class="synth-range">
                </div>
                <div class="synth-control-group">
                    <div class="synth-lbl-row"><span>RAGE MULTIPLIER</span><span id="lbl-rageBoost" class="synth-val">0%</span></div>
                    <input data-param="rageBoost" type="range" min="0" max="6" step="1" value="0" class="synth-range">
                </div>
                <div class="synth-control-group">
                    <div class="synth-lbl-row"><span>DISTORTION</span><span id="lbl-distortion" class="synth-val">0%</span></div>
                    <input data-param="distortion" type="range" min="0" max="500" step="1" value="0" class="synth-range">
                </div>
                <div class="synth-control-group">
                    <div class="synth-lbl-row"><span>BITRATE CRUSH</span><span id="lbl-bitrate" class="synth-val">2500</span></div>
                    <input data-param="bitrate" type="range" min="1" max="2500" step="1" value="2500" class="synth-range">
                </div>
                <div class="synth-control-group">
                    <div class="synth-lbl-row"><span>NOISE GATE</span><span id="lbl-noiseGate" class="synth-val">1.0</span></div>
                    <input data-param="noiseGate" type="range" min="0" max="50" step="0.1" value="1" class="synth-range">
                </div>
                <div class="synth-control-group">
                    <div class="synth-lbl-row"><span>BASS BOOST</span><span id="lbl-bass" class="synth-val">0dB</span></div>
                    <input data-param="bass" type="range" min="-20" max="50" step="1" value="0" class="synth-range">
                </div>
                <div class="synth-control-group">
                    <div class="synth-lbl-row"><span>TREBLE (HIGHS)</span><span id="lbl-treble" class="synth-val">0dB</span></div>
                    <input data-param="treble" type="range" min="-20" max="30" step="1" value="0" class="synth-range">
                </div>
                <div class="synth-control-group">
                    <div class="synth-lbl-row"><span>PITCH SHIFT</span><span id="lbl-pitch" class="synth-val">0st</span></div>
                    <input data-param="pitch" type="range" min="-12" max="12" step="1" value="0" class="synth-range">
                </div>
                <div class="synth-control-group">
                    <div class="synth-lbl-row"><span>REVERB</span><span id="lbl-reverb" class="synth-val">0%</span></div>
                    <input data-param="reverb" type="range" min="0" max="100" step="1" value="0" class="synth-range">
                </div>
                <div class="synth-control-group" style="margin-bottom:0;">
                    <div class="synth-lbl-row"><span>8D PAN SPEED</span><span id="lbl-eightD" class="synth-val">0.0</span></div>
                    <input data-param="eightD" type="range" min="0" max="10" step="0.1" value="0" class="synth-range">
                </div>
            </div>

        </section>
      `;
      document.body.appendChild(panelEl);
    },
    bind() {
      const body = document.getElementById("synth-body");
      
      document.getElementById("btn-collapse").addEventListener("click", e => {
        appState.collapsed = !appState.collapsed;
        body.style.display = appState.collapsed ? "none" : "";
        e.target.innerHTML = appState.collapsed ? "+" : "−";
        if (appState.collapsed) { audioEngine.stopMonitors(); } else { audioEngine.startMonitors(); }
        saveToStorage();
      });
      
      document.getElementById("btn-lock").addEventListener("click", e => {
        appState.panelLocked = !appState.panelLocked;
        const btn = e.target;
        if (appState.panelLocked) {
            btn.textContent = " LOCKED";
            btn.classList.add("locked");
            document.getElementById("synth-header").style.cursor = "default";
        } else {
            btn.textContent = " UNLOCK";
            btn.classList.remove("locked");
            document.getElementById("synth-header").style.cursor = "move";
        }
        saveToStorage();
      });
      
      const tglEvt = (id, stateKey, disableOthers) => {
        const el = document.getElementById(id);
        if(!el) return;
        el.addEventListener("change", e => {
            appState[stateKey] = e.target.checked;
            if(appState[stateKey] && disableOthers) {
                disableOthers.forEach(m => { 
                    appState[m] = false; 
                    const elem = document.getElementById("tgl-" + m.replace('Active','').toLowerCase());
                    if(elem) elem.checked = false;
                });
            }
            saveToStorage(); audioEngine.pushParams();
        });
      };
      
      tglEvt("tgl-turbo", "turboActive", ["bypassActive", "muteActive"]);
      tglEvt("tgl-bypass", "bypassActive", ["turboActive", "muteActive"]);
      tglEvt("tgl-mute", "muteActive", ["turboActive", "bypassActive"]);
      
      // Clipping mode radio listener
      document.querySelectorAll('input[name="clipMode"]').forEach(radio => {
          radio.addEventListener("change", e => {
              appState.clippingMode = e.target.value;
              appState.profile = "custom"; document.getElementById("synth-profile").value = "custom";
              saveToStorage(); audioEngine.pushParams();
          });
      });

      document.getElementById("synth-profile").addEventListener("change", e => this.applyProfile(e.target.value));
      document.getElementById("synth-net").addEventListener("change", e => {
          appState.netQuality = e.target.value; appState.profile = "custom";
          document.getElementById("synth-profile").value = "custom"; saveToStorage();
          audioEngine.pushParams();
      });
      
      document.querySelectorAll("#synth-panel input[type=\"range\"]").forEach(input => {
        input.addEventListener("input", e => {
          const p = e.target.dataset.param; appState[p] = parseFloat(e.target.value);
          appState.profile = "custom"; document.getElementById("synth-profile").value = "custom";
          this.updateValueLabel(p); debouncedSave(); audioEngine.pushParams();
        });
        input.addEventListener("dblclick", e => {
          const p = e.target.dataset.param; appState[p] = defaultState[p];
          e.target.value = String(defaultState[p]); e.target.dispatchEvent(new Event("input", { bubbles: true }));
        });
      });
    },
    enableDrag() {
      const panel = document.getElementById("synth-panel"), header = document.getElementById("synth-header"), doc = panel.ownerDocument;
      let isDragging = false, offsetX = 0, offsetY = 0;
      const startDrag = (clientX, clientY, e) => {
        if (appState.panelLocked || e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
        isDragging = true; offsetX = panel.offsetLeft - clientX; offsetY = panel.offsetTop - clientY; e.preventDefault();
      };
      const doDrag = (clientX, clientY) => {
        if (!isDragging) return;
        const newX = clampValue(clientX + offsetX, 0, Math.max(0, window.innerWidth - panel.offsetWidth));
        const newY = clampValue(clientY + offsetY, 0, Math.max(0, window.innerHeight - panel.offsetHeight));
        panel.style.left = newX + "px"; panel.style.top = newY + "px";
        appState.panelX = newX; appState.panelY = newY;
      };
      const stopDrag = () => { if(isDragging){ isDragging = false; saveToStorage(); } };
      header.addEventListener("mousedown", e => startDrag(e.clientX, e.clientY, e)); doc.addEventListener("mousemove", e => doDrag(e.clientX, e.clientY)); doc.addEventListener("mouseup", stopDrag);
      
      // Touch support for dragging
      header.addEventListener("touchstart", e => startDrag(e.touches[0].clientX, e.touches[0].clientY, e), {passive: false});
      doc.addEventListener("touchmove", e => doDrag(e.touches[0].clientX, e.touches[0].clientY), {passive: false});
      doc.addEventListener("touchend", stopDrag);
    },
    injectStyles() {
      if (document.getElementById("synth-styles")) return;
      const styleEl = document.createElement("style"); styleEl.id = "synth-styles";
      styleEl.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;700&display=swap');
        
        :root { 
            --bg-color: #030005;
            --module-bg: #0a010f;
            --neon-purple: #b026ff;
            --neon-red: #ff003c;
            --text-main: #ffffff;
            --text-muted: #6b527a;
        }

        #synth-panel { 
            position: fixed; width: 340px; 
            background: linear-gradient(180deg, #0d0115, var(--bg-color)); 
            border-radius: 12px; color: var(--text-main); 
            font-family: 'Rajdhani', sans-serif; user-select: none; z-index: 999999;
            border-left: 3px solid var(--neon-purple);
            border-right: 3px solid var(--neon-purple);
            border-top: 1px solid #1a0526;
            border-bottom: 1px solid #1a0526;
            box-shadow: -8px 0 25px rgba(176, 38, 255, 0.4), 8px 0 25px rgba(176, 38, 255, 0.4), 0 10px 30px rgba(0,0,0,0.9);
        }

        .synth-header { 
            display: flex; justify-content: space-between; align-items: center; 
            padding: 14px 20px; cursor: move; 
            border-bottom: 1px solid rgba(176, 38, 255, 0.2);
            background: rgba(0,0,0,0.4);
            border-radius: 12px 12px 0 0;
        }
        
        .gradient-text {
            background: linear-gradient(135deg, var(--neon-red), var(--neon-purple));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-shadow: none;
            filter: drop-shadow(0 0 8px rgba(176,38,255,0.6));
        }

        .synth-title { 
            font-size: 19px; font-weight: 700; letter-spacing: 2px;
            line-height: 1.1;
        }

        .synth-creator {
            font-size: 10px; color: var(--text-muted); font-weight: 700; letter-spacing: 0.5px; margin-top: 3px; line-height: 1.3;
        }

        .synth-window-controls { display: flex; gap: 8px; align-items: center; }

        .synth-icon-btn { 
            background: transparent; border: none; color: var(--text-muted); 
            font-size: 18px; cursor: pointer; font-family: monospace; font-weight: bold; transition: 0.2s;
        }
        .synth-icon-btn:hover { color: var(--neon-purple); text-shadow: 0 0 10px var(--neon-purple); }

        .synth-lock-btn {
            background: rgba(0,0,0,0.5); border: 1px solid var(--neon-purple); color: #fff;
            padding: 4px 8px; border-radius: 4px; cursor: pointer; font-family: inherit;
            font-weight: bold; font-size: 11px; text-shadow: 0 0 5px var(--neon-purple);
            box-shadow: inset 0 0 5px rgba(176,38,255,0.3); transition: 0.3s;
        }
        .synth-lock-btn:hover { background: rgba(176,38,255,0.1); }
        .synth-lock-btn.locked {
            border-color: var(--neon-red); text-shadow: 0 0 5px var(--neon-red);
            box-shadow: inset 0 0 5px rgba(255,0,60,0.3);
        }
        .synth-lock-btn.locked:hover { background: rgba(255,0,60,0.1); }

        .synth-body { padding: 15px; max-height: 80vh; overflow-y: auto; }
        .synth-body::-webkit-scrollbar { width: 4px; }
        .synth-body::-webkit-scrollbar-thumb { background: var(--neon-purple); border-radius: 4px; }

        .synth-top-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; }
        .synth-status-badge { 
            padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 700; 
            border: 1px solid; letter-spacing: 1px; text-transform: uppercase;
        }
        .synth-status-badge.wait { color: var(--text-muted); border-color: var(--text-muted); }
        .synth-status-badge.ok { color: var(--neon-purple); border-color: var(--neon-purple); box-shadow: 0 0 10px rgba(176, 38, 255, 0.4); }
        .synth-status-badge.warn { color: #ffaa00; border-color: #ffaa00; box-shadow: 0 0 10px rgba(255, 170, 0, 0.4); }
        .synth-status-badge.alert { color: var(--neon-red); border-color: var(--neon-red); box-shadow: 0 0 10px rgba(255, 0, 60, 0.5); background: rgba(255,0,60,0.1); }
        .synth-status-badge.err { color: var(--neon-red); border-color: var(--neon-red); box-shadow: 0 0 10px rgba(255, 0, 60, 0.5); background: rgba(255,0,60,0.1); }
        
        #synth-visualizer { background: var(--module-bg); border-radius: 4px; border: 1px solid rgba(176, 38, 255, 0.3); }

        .synth-module { 
            background: var(--module-bg); border: 1px solid rgba(176, 38, 255, 0.15); 
            border-radius: 8px; padding: 14px; margin-bottom: 15px;
            box-shadow: inset 0 0 15px rgba(0,0,0,0.8);
        }
        
        .synth-module-title { 
            font-weight: 700; font-size: 14px; color: var(--neon-purple); 
            letter-spacing: 1px; text-shadow: 0 0 8px rgba(176, 38, 255, 0.4); 
            margin-bottom: 12px; text-align: center; border-bottom: 1px solid rgba(176,38,255,0.2); padding-bottom: 6px;
        }

        .synth-options-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
        .synth-master-btn { 
            display: block; text-align: center; background: #000; 
            border: 1px solid rgba(176, 38, 255, 0.3); padding: 8px 0; border-radius: 4px; cursor: pointer; transition: 0.2s; 
        }
        .synth-master-btn input { display: none; }
        .synth-master-btn span { font-weight: 700; font-size: 12px; color: var(--text-muted); letter-spacing: 0.5px; }
        
        .synth-master-btn input:checked + span { color: #fff; text-shadow: 0 0 8px var(--neon-purple); }
        .synth-master-btn:has(input:checked) { background: rgba(176, 38, 255, 0.15); border-color: var(--neon-purple); box-shadow: inset 0 0 10px rgba(176, 38, 255, 0.3); }
        
        .synth-master-btn.alert input:checked + span { color: #fff; text-shadow: 0 0 8px var(--neon-red); }
        .synth-master-btn.alert:has(input:checked) { background: rgba(255, 0, 60, 0.15); border-color: var(--neon-red); box-shadow: inset 0 0 10px rgba(255, 0, 60, 0.3); }

        .synth-master-btn.bypass input:checked + span { color: #fff; text-shadow: 0 0 8px #fff; }
        .synth-master-btn.bypass:has(input:checked) { background: rgba(255, 255, 255, 0.1); border-color: #fff; box-shadow: inset 0 0 10px rgba(255, 255, 255, 0.2); }

        .synth-clip-group { display: flex; gap: 6px; background: #000; padding: 6px; border-radius: 6px; border: 1px solid rgba(176,38,255,0.2); }
        .synth-clip-btn { flex: 1; text-align: center; }
        .synth-clip-btn input { display: none; }
        .synth-clip-btn span { display: block; padding: 8px 0; font-size: 11px; font-weight: bold; color: var(--text-muted); cursor: pointer; border-radius: 4px; transition: 0.2s; letter-spacing: 0.5px; }
        .synth-clip-btn input:checked + span { background: rgba(176,38,255,0.2); color: #fff; text-shadow: 0 0 5px var(--neon-purple); box-shadow: inset 0 0 8px rgba(176,38,255,0.4); }
        .synth-clip-btn.extreme input:checked + span { background: rgba(255,0,60,0.2); color: #fff; text-shadow: 0 0 5px var(--neon-red); box-shadow: inset 0 0 8px rgba(255,0,60,0.4); }

        .synth-sys-row { display: flex; gap: 8px; }
        .synth-dropdown { 
            flex: 1; background: #000; color: var(--text-main); border: 1px solid rgba(176, 38, 255, 0.3); 
            padding: 6px 8px; border-radius: 4px; font-family: 'Rajdhani', sans-serif; font-weight: 600; font-size: 12px; outline: none; 
        }
        .synth-dropdown:focus { border-color: var(--neon-purple); box-shadow: 0 0 8px rgba(176, 38, 255, 0.4); }

        .synth-control-group { margin-bottom: 12px; }
        .synth-lbl-row { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; color: var(--text-muted); margin-bottom: 6px; letter-spacing: 0.5px; }
        .synth-val { color: var(--neon-red); font-family: monospace; font-size: 13px; text-shadow: 0 0 5px rgba(255,0,60,0.4); }

        /* RED & PURPLE GRADIENT SLIDER */
        input[type=range].synth-range { -webkit-appearance: none; width: 100%; background: transparent; }
        input[type=range].synth-range:focus { outline: none; }
        input[type=range].synth-range::-webkit-slider-runnable-track { 
            width: 100%; height: 6px; cursor: pointer; border-radius: 3px; background: #000; border: 1px solid rgba(176, 38, 255, 0.3); 
        }
        input[type=range].synth-range::-webkit-slider-thumb {
            height: 16px; width: 16px; border-radius: 50%; background: #fff; cursor: pointer; -webkit-appearance: none; margin-top: -6px;
            box-shadow: 0 0 12px var(--neon-red), 0 0 4px var(--neon-purple);
            border: 2px solid var(--neon-red);
        }

      `;
      document.head.appendChild(styleEl);

      const updateSliderFill = el => {
        const percent = (parseFloat(el.value) - parseFloat(el.min)) / (parseFloat(el.max) - parseFloat(el.min)) * 100;
        el.style.background = `linear-gradient(to right, var(--neon-red) 0%, var(--neon-purple) ${percent}%, #11001a ${percent}%, #11001a 100%)`;
        el.style.border = '1px solid rgba(176, 38, 255, 0.3)';
        el.style.borderRadius = '3px';
        el.style.height = '6px';
        el.style.appearance = 'none';
      };
      
      new MutationObserver((_, obs) => {
        const sliders = document.querySelectorAll("#synth-panel input[type=\"range\"]");
        if (sliders.length) { 
            sliders.forEach(s => { 
                updateSliderFill(s); 
                s.addEventListener("input", () => updateSliderFill(s)); 
            }); 
            obs.disconnect(); 
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  };

  if (document.body) uiManager.init(); else document.addEventListener("DOMContentLoaded", () => uiManager.init());
})();
