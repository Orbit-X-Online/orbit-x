/* Orbit-X file reader. Turns a PDF, photo, Word file or text file into plain text, ON THE PHONE (the file itself is never uploaded).
   Libraries (pdf.js, Tesseract OCR, mammoth) are loaded from cdnjs only when a file of that kind is chosen. */
window.OXRead = (function () {
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFW = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var TESS = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js';
  var MAM = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
  var MAXCHARS = 40000, loaded = {};

  function load(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = function () { delete loaded[src]; rej(new Error('Could not load the file reader. Check your internet and try again.')); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }
  function tidy(t) { return String(t || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); }
  function readAs(file, how) {
    return new Promise(function (res, rej) {
      var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(new Error('Could not open that file.')); };
      how === 'buf' ? r.readAsArrayBuffer(file) : r.readAsText(file);
    });
  }
  function bitmapCanvas(file, max) { // shrink big phone photos so OCR is fast
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var sc = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
        var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); res(c);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Could not open that picture.')); };
      img.src = url;
    });
  }
  function ocr(sources, progress) {
    return load(TESS).then(function () {
      return Tesseract.createWorker('eng', 1, { logger: function (m) { if (m && m.status === 'recognizing text' && progress) progress('Reading the picture... ' + Math.round((m.progress || 0) * 100) + '%'); } });
    }).then(function (w) {
      var out = [], chain = Promise.resolve();
      sources.forEach(function (src, i) {
        chain = chain.then(function () { if (progress && sources.length > 1) progress('Reading page ' + (i + 1) + ' of ' + sources.length + '...'); return w.recognize(src); })
          .then(function (r) { out.push(r && r.data ? r.data.text : ''); });
      });
      return chain.then(function () { return w.terminate(); }).then(function () { return out.join('\n\n'); }, function (e) { try { w.terminate(); } catch (x) {} throw e; });
    });
  }
  function readPdf(file, progress) {
    progress && progress('Opening the PDF...');
    return Promise.all([load(PDFJS), readAs(file, 'buf')]).then(function (r) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFW;
      return pdfjsLib.getDocument({ data: r[1] }).promise;
    }).then(function (pdf) {
      var n = Math.min(pdf.numPages, 15), pages = [], chain = Promise.resolve();
      for (var i = 1; i <= n; i++) (function (i) {
        chain = chain.then(function () { return pdf.getPage(i); }).then(function (p) { return p.getTextContent(); })
          .then(function (tc) { pages.push(tc.items.map(function (it) { return it.str; }).join(' ')); });
      })(i);
      return chain.then(function () {
        var text = tidy(pages.join('\n\n'));
        if (text.length >= 40) return text;
        // scanned PDF (pictures of pages): render pages and read them with OCR
        progress && progress('This PDF is a scan. Reading it with OCR (can take a minute)...');
        var m = Math.min(pdf.numPages, 5), canv = [], c2 = Promise.resolve();
        for (var k = 1; k <= m; k++) (function (k) {
          c2 = c2.then(function () { return pdf.getPage(k); }).then(function (p) {
            var vp = p.getViewport({ scale: 2 }), c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
            return p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.then(function () { canv.push(c); });
          });
        })(k);
        return c2.then(function () { return ocr(canv, progress); });
      });
    });
  }
  // Shrink a photo to a small JPEG so it uploads fast on mobile data (about 150-500 KB).
  function jpegOf(c) { var q = 0.72, u = c.toDataURL('image/jpeg', q); while (u.length > 1400000 && q > 0.3) { q -= 0.12; u = c.toDataURL('image/jpeg', q); } return u; }
  function read(file, progress, opts) {
    read.last = null;
    var name = (file.name || '').toLowerCase(), type = file.type || '';
    if (file.size > 15 * 1024 * 1024) return Promise.reject(new Error('That file is too large (limit 15 MB).'));
    var p;
    if (type === 'application/pdf' || /\.pdf$/.test(name)) p = readPdf(file, progress);
    else if (/^image\//.test(type) || /\.(png|jpe?g|webp|bmp|gif|heic)$/.test(name)) {
      progress && progress('Opening the picture...');
      var viaAI = false, note = '';
      var onPhone = function () { return bitmapCanvas(file, 2200).then(function (c) { return ocr([c], progress); }); };
      p = (opts && opts.ai)
        ? bitmapCanvas(file, 1600).then(function (c) {
            progress && progress('The AI is reading the photo...');
            return opts.ai(jpegOf(c)).then(function (t) { viaAI = true; return t; }, function (e) {
              note = (e && e.message) || ''; progress && progress('The AI could not read this photo, so it is being read on this phone instead...'); return onPhone();
            });
          })
        : onPhone();
      p = p.then(function (t) { read.last = { via: viaAI ? 'ai' : 'phone', note: note }; return t; });
    }
    else if (/\.docx$/.test(name) || type.indexOf('wordprocessingml') > -1) { progress && progress('Opening the Word file...'); p = Promise.all([load(MAM), readAs(file, 'buf')]).then(function (r) { return mammoth.extractRawText({ arrayBuffer: r[1] }); }).then(function (r) { return r.value; }); }
    else if (/\.doc$/.test(name)) return Promise.reject(new Error('Old .doc files are not supported. Save it as .docx or PDF, or paste the text.'));
    else p = readAs(file, 'text');
    return p.then(function (t) {
      t = tidy(t); var cut = t.length > MAXCHARS; if (cut) t = t.slice(0, MAXCHARS);
      if (t.length < 20) throw new Error('I could not find readable text in that file. Try a clearer photo, or paste the text instead.');
      return { text: t, truncated: cut, via: (read.last && read.last.via) || 'file', note: (read.last && read.last.note) || '' };
    });
  }
  return { read: read };
})();
