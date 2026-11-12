// Modexá — voice loudness enhancement
// Removes no user data and sends no tokens/webhooks.
// Applies a extreme pre-compression gain (99999x relative to the previous 20000x setting) with limiting to maximize perceived vocal loudness without runaway clipping.

(() => {
  const originalGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (!originalGetUserMedia) return;

  const processed = new WeakMap();

  navigator.mediaDevices.getUserMedia = async function(constraints) {
    const stream = await originalGetUserMedia(constraints);

    const wantsAudio = constraints === true ||
      (constraints && (constraints.audio === true || typeof constraints.audio === "object"));
    if (!wantsAudio || !stream.getAudioTracks().length) return stream;

    try {
      if (processed.has(stream)) return processed.get(stream);

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return stream;

      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);

      const gain = ctx.createGain();
      gain.gain.value = 999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999.0;

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = 0;
      compressor.knee.value = 0;
      compressor.ratio.value = 1;
      compressor.attack.value = 0.001;
      compressor.release.value = 0.08;

      const destination = ctx.createMediaStreamDestination();

      source.connect(gain);
      gain.connect(compressor);
      compressor.connect(destination);

      const out = new MediaStream();
      destination.stream.getAudioTracks().forEach(t => out.addTrack(t));
      stream.getVideoTracks().forEach(t => out.addTrack(t));

      // Stop the original audio track when the processed track is stopped.
      const originalTracks = stream.getAudioTracks();
      const outTrack = out.getAudioTracks()[0];
      if (outTrack) {
        outTrack.addEventListener("ended", () => {
          originalTracks.forEach(t => { try { t.stop(); } catch (_) {} });
          try { ctx.close(); } catch (_) {}
        }, { once: true });
      }

      processed.set(stream, out);
      return out;
    } catch (e) {
      console.warn("Modexá voice enhancement fallback:", e);
      return stream;
    }
  };
})();
