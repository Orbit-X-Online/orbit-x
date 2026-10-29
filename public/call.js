/* Orbit-X live voice call (WebRTC audio). Plain JS, no libraries.
   The caregiver who answers an alert is the "caller"; the person in trouble is the "callee" and connects automatically.
   Signalling goes through the Orbit-X server (the 'rtc' action). Audio itself goes phone to phone (or through TURN if configured).
   opts: { rtc(op, extra) -> Promise<json>, ice() -> Promise<json>, audio: <audio>, onStatus(text, kind), onEnd() } */
window.OXCall = (function () {
  var pc = null, stream = null, poll = null, role = null, opts = null, handled = 0, gotAnswer = false, running = false, startedAt = 0, ended = false;

  function status(t, k) { try { opts && opts.onStatus && opts.onStatus(t, k || ''); } catch (e) {} }
  function supported() { return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
  function micError(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Microphone is blocked. Allow the microphone for this site in your browser settings, then tap Try again.';
    if (n === 'NotFoundError') return 'No microphone was found on this phone.';
    return 'Could not start the microphone. Tap Try again.';
  }
  function getMic() { return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
  function gather(p) {
    return new Promise(function (res) {
      if (p.iceGatheringState === 'complete') return res();
      var done = false, t = setTimeout(fin, 3500);
      function fin() { if (done) return; done = true; clearTimeout(t); p.removeEventListener('icegatheringstatechange', chk); res(); }
      function chk() { if (p.iceGatheringState === 'complete') fin(); }
      p.addEventListener('icegatheringstatechange', chk);
    });
  }
  function newPC(servers) {
    var p = new RTCPeerConnection({ iceServers: servers && servers.length ? servers : [{ urls: 'stun:stun.l.google.com:19302' }] });
    p.ontrack = function (e) {
      var a = opts.audio; if (!a) return;
      a.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      var pr = a.play(); if (pr && pr.catch) pr.catch(function () { status('Connected. Tap here to hear the other person.', 'tap'); });
    };
    p.onconnectionstatechange = function () {
      var s = p.connectionState;
      if (s === 'connected') { status('Connected. You can talk now.', 'ok'); }
      else if (s === 'disconnected') status('Connection is unstable...', 'warn');
      else if (s === 'failed') { status('The voice connection could not be made on this network. Use the Call buttons instead.', 'bad'); }
    };
    return p;
  }
  function cleanup() {
    if (poll) { clearInterval(poll); poll = null; }
    try { if (pc) pc.close(); } catch (e) {}
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (opts && opts.audio) opts.audio.srcObject = null; } catch (e) {}
    pc = null; stream = null; running = false;
  }
  function endLocal(sendEnd, msg) {
    if (!running && !pc) return;
    var o = opts; cleanup();
    if (sendEnd && o) { try { o.rtc('end'); } catch (e) {} }
    status(msg || 'Call ended.', 'end'); try { o && o.onEnd && o.onEnd(); } catch (e) {}
  }

  function startCaller(o) {
    opts = o; role = 'caller'; running = true; gotAnswer = false; ended = false; startedAt = Date.now();
    if (!supported()) { running = false; status('This browser cannot make voice calls. Use the Call buttons.', 'bad'); return Promise.resolve(false); }
    status('Starting the microphone...', 'wait');
    return getMic().then(function (s) {
      stream = s; status('Calling...', 'wait');
      return opts.ice();
    }).then(function (ice) {
      pc = newPC(ice && ice.iceServers);
      stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
      return pc.createOffer({ offerToReceiveAudio: true });
    }).then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { return gather(pc); })
      .then(function () { return opts.rtc('offer', { sdp: pc.localDescription.sdp }); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error('offer_failed');
        status('Ringing ' + (opts.otherName || 'them') + '... waiting for them to connect.', 'wait');
        poll = setInterval(function () {
          if (!running) return;
          opts.rtc('poll').then(function (r) {
            if (!running || !r) return;
            if (r.ok === false && r.error === 'no_call') { endLocal(false, 'The alert is closed. Call ended.'); return; }
            var x = r.rtc; if (!x) return;
            if (x.ended) { endLocal(false, 'The other person ended the call.'); return; }
            if (x.answer && !gotAnswer) {
              gotAnswer = true; status('Connecting...', 'wait');
              pc.setRemoteDescription({ type: 'answer', sdp: x.answer }).catch(function () { status('Could not connect. Tap Try again.', 'bad'); });
            } else if (!gotAnswer && Date.now() - startedAt > 45000) { status('They have not connected yet. Use the Call buttons, or tap Try again.', 'warn'); }
          });
        }, 1000);
        return true;
      }).catch(function (e) {
        cleanup(); status(e && e.name ? micError(e) : 'Could not start the call. Tap Try again.', 'bad'); return false;
      });
  }

  // The person's phone: waits for an offer from the caregiver who answered, then answers automatically.
  function startCallee(o) {
    if (running) return;
    opts = o; role = 'callee'; running = true; handled = handled || 0; ended = false;
    if (!supported()) { running = false; status('This browser cannot make voice calls. Use the Call buttons.', 'bad'); return; }
    status('Waiting for the caregiver to connect...', 'wait');
    var busy = false;
    poll = setInterval(function () {
      if (!running || busy) return;
      opts.rtc('poll').then(function (r) {
        if (!running || !r) return;
        if (r.ok === false && r.error === 'no_call') { endLocal(false, 'The alert is closed. Call ended.'); return; }
        var x = r.rtc; if (!x) return;
        if (x.ended && x.offerId === handled) { // keep waiting: the caregiver may call again
          if (pc || stream) {
            try { if (pc) pc.close(); } catch (e) {} try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
            pc = null; stream = null; try { if (opts.audio) opts.audio.srcObject = null; } catch (e) {}
            status('The call ended. Waiting in case the caregiver calls again.', 'end');
          }
          return;
        }
        if (x.offer && !x.ended && x.offerId !== handled && !busy) {
          busy = true; handled = x.offerId; status('Connecting...', 'wait');
          answerOffer(x).catch(function (e) { busy = false; handled = 0; try { if (pc) pc.close(); } catch (er) {} pc = null; status(e && e.name ? micError(e) : 'Could not connect. Waiting for the caregiver to try again.', 'bad'); });
        }
      });
    }, 1200);
  }
  function answerOffer(x) {
    return getMic().then(function (s) {
      stream = s; return opts.ice();
    }).then(function (ice) {
      try { if (pc) pc.close(); } catch (e) {}
      pc = newPC(ice && ice.iceServers);
      stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
      return pc.setRemoteDescription({ type: 'offer', sdp: x.offer });
    }).then(function () { return pc.createAnswer(); })
      .then(function (ans) { return pc.setLocalDescription(ans); })
      .then(function () { return gather(pc); })
      .then(function () { return opts.rtc('answer', { sdp: pc.localDescription.sdp, offerId: x.offerId }); })
      .then(function (j) { if (!j || !j.ok) throw new Error('answer_failed'); status('Connecting...', 'wait'); });
  }

  function setMuted(m) { if (stream) stream.getAudioTracks().forEach(function (t) { t.enabled = !m; }); return !!m; }
  function playNow() { try { var a = opts && opts.audio; if (a) { a.muted = false; a.play(); } } catch (e) {} }
  return {
    supported: supported,
    startCaller: startCaller, startCallee: startCallee,
    end: function (msg) { endLocal(true, msg); },
    stopQuiet: function () { var o = opts; cleanup(); },
    setMuted: setMuted, playNow: playNow,
    isRunning: function () { return running; }, role: function () { return role; }
  };
})();
