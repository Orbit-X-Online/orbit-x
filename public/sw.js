/* Orbit-X service worker. It does two things: wake up when the server sends an alert, and show it.
   The push itself carries no health details. We ask the server what to say, using this phone's own private id. */
var PID = new URL(self.location.href).searchParams.get('p') || '';
function hex(buf){ return Array.prototype.map.call(new Uint8Array(buf), function(b){ return ('0' + b.toString(16)).slice(-2); }).join(''); }
function mine(){
  return self.registration.pushManager.getSubscription().then(function(s){
    if (!s) return null;
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.endpoint)).then(hex);
  });
}
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function(e){
  var eh = null;
  e.waitUntil(mine().then(function(h){
    eh = h;
    var fallback = { title: 'Orbit-X', body: 'Open Orbit-X to see what is new.', tag: 'orbit', urgent: false };
    if (!eh || !PID) return fallback;
    return fetch('/api/push/msg/' + PID + '?e=' + eh, { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(j){ return j && j.title ? j : fallback; }).catch(function(){ return fallback; });
  }).then(function(m){
    return self.registration.showNotification(m.title, {
      body: m.body, tag: m.tag || 'orbit', renotify: true, requireInteraction: !!m.urgent,
      vibrate: m.urgent ? [400, 150, 400, 150, 400, 150, 400] : [200], icon: '/icon-192.png', badge: '/icon-192.png', data: { url: '/?guardian=1' }
    });
  }).then(function(){
    // Tell the server this phone really displayed it. This is the only real "shown on the device" evidence we can get.
    if (!eh || !PID) return;
    return fetch('/api/push/ack/' + PID + '?e=' + eh, { method: 'POST', cache: 'no-store' }).catch(function(){});
  }));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    return self.clients.openWindow('/?guardian=1');
  }));
});
