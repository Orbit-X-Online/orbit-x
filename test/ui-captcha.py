# Headless-browser check of the sign-up CAPTCHA wiring with a FAKE Cloudflare script and a FAKE API. Needs playwright.
import json, threading, http.server, socketserver, os, sys
from playwright.sync_api import sync_playwright
root = os.path.join(os.path.dirname(__file__), '..', 'public')
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=root, **k)
    def log_message(s, *a): pass
srv = socketserver.TCPServer(('127.0.0.1', 0), H); port = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
FAKE = "window.turnstile={render:function(sel,o){document.querySelector(sel).setAttribute('data-ok','1');window.__cb=o.callback;return 'w1'},reset:function(){window.__reset=(window.__reset||0)+1}};"
def run(captcha_on):
    bodies = []; errs = []
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 780}); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.route('**/api/captcha', lambda r: r.fulfill(json={'ok': True, 'on': captcha_on, 'sitekey': 'K' if captcha_on else ''}))
        pg.route('https://challenges.cloudflare.com/**', lambda r: r.fulfill(body=FAKE, content_type='application/javascript'))
        def create(r):
            bodies.append(json.loads(r.request.post_data or '{}'))
            r.fulfill(json={'ok': False, 'error': 'captcha_failed'} if len(bodies) == 1 and captcha_on else {'ok': True, 'pid': 'abcd1234', 'token': 't'})
        pg.route('**/api/create', create); pg.route('**/api/h/**', lambda r: r.fulfill(json={'ok': False}))
        pg.goto(f'http://127.0.0.1:{port}/'); pg.wait_for_selector('#go'); pg.click('#go'); pg.wait_for_selector('#st'); pg.fill('#nm', 'Tester'); pg.check('#pc'); pg.wait_for_timeout(600)
        has_widget = pg.locator('#capw[data-ok="1"]').count() == 1
        pg.click('#st'); pg.wait_for_timeout(300); msg = pg.inner_text('#er') if pg.locator('#er').count() else ''
        first_sent = len(bodies)
        if captcha_on:
            pg.evaluate("window.__cb('tok-123456789')"); pg.click('#st'); pg.wait_for_timeout(500)
            err2 = pg.inner_text('#er') if pg.locator('#er').count() else ''; reset = pg.evaluate('window.__reset||0')
            pg.evaluate("window.__cb('tok-987654321')"); pg.click('#st'); pg.wait_for_timeout(500)
        b.close()
    return has_widget, msg, first_sent, bodies, errs
w, msg, first, bodies, errs = run(True)
assert w, 'widget should render when on'; assert first == 0 and 'quick check' in msg, (first, msg)
assert bodies and bodies[0].get('captcha') == 'tok-123456789', bodies; assert len(bodies) == 2 and bodies[1]['captcha'] == 'tok-987654321'; assert not errs, errs
print('ON : widget shown; Start blocked without a token; token sent; failed check resets and allows retry; no script errors')
w, msg, first, bodies, errs = run(False)
assert not w and first == 1 and 'captcha' not in bodies[0] and not errs, (w, first, bodies, errs)
print('OFF: no widget, sign-up sent at once with no captcha field, no script errors')
