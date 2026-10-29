"""Optional real-browser smoke test (not part of `npm test`). Needs: pip install playwright && playwright install chromium.
Serves ./public with a plain static server and checks that every page loads on a phone-sized screen with no
script errors and no sideways scrolling. The API is NOT running, so this does not test sign-up or notifications."""
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '--directory', 'public'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); bad = 0
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 780}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        for u in ['/', '/guide.html', '/demo.html', '/workspace.html', '/developer.html', '/studio.html', '/docs.html']:
            pg.goto('http://localhost:8765' + u); pg.wait_for_timeout(500)
            over = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
            print(u, 'overflow', over); bad += 1 if over > 0 else 0
        print('script errors:', errs); bad += len(errs); b.close()
finally: srv.terminate()
sys.exit(1 if bad else 0)
