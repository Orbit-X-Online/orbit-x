/* Orbit-X offline help channels. Plain JS, no libraries.
   1) Text messages (SMS): work with no internet, over the phone's own SIM. Multi-recipient links for Android and iPhone.
   2) Bluetooth panic button: any Bluetooth LE button/wearable that sends notifications triggers help (Chrome on Android).
   3) Radio (LoRa) bridge: a Meshtastic radio paired by Bluetooth sends the help text over radio, no internet and no SIM needed.
   Browsers cannot talk to cellular or radio hardware directly. Items 2 and 3 need a Bluetooth device and Chrome/Edge on Android or desktop.
   Item 3 has not been tested on real radios by the author of this code: treat it as experimental and test before relying on it. */
window.OXRadio = (function () {
  var MESH_SVC = '6ba1b218-15a8-461f-9fa8-5dcae273eafd', TO_RADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7', FROM_RADIO = '2c55e69e-4993-11ed-b878-0242ac120002';
  var panic = { dev: null, on: false, last: 0, cb: null, status: 'Not paired' };
  var mesh = { dev: null, to: null, from: null, status: 'Not connected' };
  var listeners = [];
  function note() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }
  function onChange(f) { listeners.push(f); }
  function btSupported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; }

  /* ---------- SMS ---------- */
  function smsHref(numbers, body) {
    var list = (numbers || []).filter(Boolean).map(function (n) { return String(n).replace(/[^\d+]/g, ''); });
    if (!list.length) return '#';
    var b = encodeURIComponent(body || '');
    return isIOS() ? 'sms:/open?addresses=' + list.join(',') + '&body=' + b : 'sms:' + list.join(',') + '?body=' + b;
  }
  function helpText(name, why, loc) {
    return 'Orbit-X EMERGENCY: ' + (name || 'Someone') + ' needs help now' + (why ? ' (' + String(why).slice(0, 60) + ')' : '') + '. Please call straight away.' + (loc ? ' Location: ' + loc : '');
  }
  function locate(cb) {
    var done = false; function fin(v) { if (!done) { done = true; cb(v); } }
    try { if (navigator.geolocation) navigator.geolocation.getCurrentPosition(function (p) { fin('https://maps.google.com/?q=' + p.coords.latitude.toFixed(5) + ',' + p.coords.longitude.toFixed(5)); }, function () { fin(''); }, { timeout: 8000, maximumAge: 120000 }); else fin(''); } catch (e) { fin(''); }
    setTimeout(function () { fin(''); }, 8500);
  }

  /* ---------- Bluetooth panic button ---------- */
  function pairPanic(onPress) {
    panic.cb = onPress || panic.cb;
    if (!btSupported()) { panic.status = 'This browser has no Bluetooth access. Use Chrome on Android.'; note(); return Promise.resolve(false); }
    return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['battery_service', 'device_information', 0x1812, 0x1802, 0x1809, 0xffe0, 0xfff0, 0xfee0, 0xfe59] })
      .then(function (d) { panic.dev = d; d.addEventListener('gattserverdisconnected', function () { panic.on = false; panic.status = 'Disconnected. Reconnecting...'; note(); setTimeout(function () { connectPanic(); }, 3000); }); return connectPanic(); })
      .catch(function (e) { panic.status = e && e.name === 'NotFoundError' ? 'No device chosen.' : 'Could not pair (' + ((e && e.message) || 'error').slice(0, 60) + ').'; note(); return false; });
  }
  function connectPanic() {
    if (!panic.dev) return Promise.resolve(false);
    return panic.dev.gatt.connect().then(function (srv) { return srv.getPrimaryServices(); }).then(function (svcs) {
      var jobs = [];
      svcs.forEach(function (s) { jobs.push(s.getCharacteristics().then(function (chs) { return Promise.all(chs.map(function (c) {
        if (!(c.properties.notify || c.properties.indicate) || /2a19/i.test(c.uuid)) return null; // ignore battery level updates
        c.addEventListener('characteristicvaluechanged', function () { press(); });
        return c.startNotifications().catch(function () {});
      })); }).catch(function () {})); });
      return Promise.all(jobs);
    }).then(function () { panic.on = true; panic.status = 'Connected to ' + (panic.dev.name || 'your button') + '. Press it to ask for help.'; note(); return true; })
      .catch(function () { panic.on = false; panic.status = 'Could not connect. Move closer and try again.'; note(); return false; });
  }
  function press() { var t = Date.now(); if (t - panic.last < 5000) return; panic.last = t; try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {} if (panic.cb) panic.cb(); }
  function unpairPanic() { try { if (panic.dev && panic.dev.gatt.connected) panic.dev.gatt.disconnect(); } catch (e) {} panic.dev = null; panic.on = false; panic.status = 'Not paired'; note(); }

  /* ---------- Radio (Meshtastic over Bluetooth LE) ---------- */
  function varint(n) { var o = []; n = n >>> 0; while (n > 127) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); return o; }
  function lenField(tag, bytes) { return [tag].concat(varint(bytes.length), Array.prototype.slice.call(bytes)); }
  function encodeText(text) {
    var payload = new TextEncoder().encode(String(text).slice(0, 190));
    var data = [0x08, 0x01].concat(lenField(0x12, payload));                       // Data{portnum=TEXT_MESSAGE_APP, payload}
    var id = (Math.random() * 0xffffffff) >>> 0;
    var pkt = [0x15, 0xff, 0xff, 0xff, 0xff].concat(lenField(0x22, data), [0x35, id & 255, (id >>> 8) & 255, (id >>> 16) & 255, (id >>> 24) & 255], [0x48, 0x03]); // to=broadcast, decoded, id, hop_limit=3
    return new Uint8Array(lenField(0x0a, pkt));                                    // ToRadio{packet}
  }
  function connectMesh() {
    if (!btSupported()) { mesh.status = 'This browser has no Bluetooth access. Use Chrome on Android.'; note(); return Promise.resolve(false); }
    return navigator.bluetooth.requestDevice({ filters: [{ services: [MESH_SVC] }] }).then(function (d) {
      mesh.dev = d; d.addEventListener('gattserverdisconnected', function () { mesh.to = null; mesh.status = 'Radio disconnected'; note(); });
      return d.gatt.connect();
    }).then(function (srv) { return srv.getPrimaryService(MESH_SVC); }).then(function (svc) {
      return Promise.all([svc.getCharacteristic(TO_RADIO), svc.getCharacteristic(FROM_RADIO)]);
    }).then(function (cs) {
      mesh.to = cs[0]; mesh.from = cs[1];
      return mesh.to.writeValueWithResponse(new Uint8Array([0x18].concat(varint(((Math.random() * 0x7fffffff) | 0) || 1))));  // want_config_id: starts the radio's session
    }).then(function () {
      var n = 0; function drain() { return mesh.from.readValue().then(function (v) { if (v.byteLength > 0 && n++ < 400) return drain(); }); }
      return drain();
    }).then(function () { mesh.status = 'Radio ready: ' + (mesh.dev.name || 'Meshtastic'); note(); return true; })
      .catch(function (e) { mesh.to = null; mesh.status = e && e.name === 'NotFoundError' ? 'No radio chosen.' : 'Could not connect to the radio (' + ((e && e.message) || 'error').slice(0, 60) + ').'; note(); return false; });
  }
  function radioReady() { return !!(mesh.to && mesh.dev && mesh.dev.gatt.connected); }
  function sendRadio(text) {
    if (!radioReady()) return Promise.resolve(false);
    return mesh.to.writeValueWithResponse(encodeText(text)).then(function () { return true; }, function () { return false; });
  }
  function disconnectMesh() { try { if (mesh.dev && mesh.dev.gatt.connected) mesh.dev.gatt.disconnect(); } catch (e) {} mesh.dev = null; mesh.to = null; mesh.status = 'Not connected'; note(); }

  // Everything that can send, in one call, used when help is pressed.
  function broadcast(name, why, caregivers) {
    return new Promise(function (res) {
      locate(function (loc) {
        var text = helpText(name, why, loc), out = { radio: false };
        sendRadio(text.slice(0, 190)).then(function (ok) { out.radio = ok; out.text = text; out.loc = loc; res(out); });
      });
    });
  }

  /* ---------- UI blocks (HTML strings + binders, styled with the page's own classes) ---------- */
  function settingsHtml() {
    var sup = btSupported();
    return '<label class="l">Panic button and radio (works without internet)</label>' +
      '<div class="small">Text messages work with no internet. A Bluetooth panic button or a Meshtastic radio lets you ask for help from across the room or with no phone signal. Needs Chrome on Android.</div>' +
      '<div class="cg"><b>Bluetooth panic button</b><div class="small" id="oxpst">' + esc(panic.status) + '</div><div class="acts"><button id="oxpp"' + (sup ? '' : ' disabled') + '>' + (panic.on ? 'Pair another' : 'Pair a button') + '</button>' + (panic.dev ? '<button id="oxpu">Remove</button>' : '') + '</div></div>' +
      '<div class="cg"><b>Radio (LoRa, Meshtastic)</b><div class="small" id="oxmst">' + esc(mesh.status) + ' (experimental)</div><div class="acts"><button id="oxmp"' + (sup ? '' : ' disabled') + '>' + (radioReady() ? 'Pair another' : 'Connect a radio') + '</button>' + (mesh.dev ? '<button id="oxmu">Disconnect</button>' : '') + '</div></div>' +
      (sup ? '' : '<div class="small">This browser cannot use Bluetooth here, so only text messages are available.</div>');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function bindSettings(onPress) {
    var q = function (i) { return document.getElementById(i); }, b;
    if ((b = q('oxpp'))) b.onclick = function () { pairPanic(onPress); };
    if ((b = q('oxpu'))) b.onclick = unpairPanic;
    if ((b = q('oxmp'))) b.onclick = connectMesh;
    if ((b = q('oxmu'))) b.onclick = disconnectMesh;
    listeners = listeners.filter(function (f) { return !f.__s; });
    var f = function () { var a = q('oxpst'), m = q('oxmst'); if (a) a.textContent = panic.status; if (m) m.textContent = mesh.status + ' (experimental)'; }; f.__s = 1; listeners.push(f);
  }
  return { smsHref: smsHref, helpText: helpText, locate: locate, pairPanic: pairPanic, setPanicHandler: function (f) { panic.cb = f; }, connectMesh: connectMesh, sendRadio: sendRadio, radioReady: radioReady, broadcast: broadcast, settingsHtml: settingsHtml, bindSettings: bindSettings, onChange: onChange, supported: btSupported, panicOn: function () { return panic.on; }, _encodeText: encodeText };
})();
