/**
 * Scripts evaluated inside the analysed page. They are plain JavaScript strings (not TS
 * functions) so bundlers/transpilers cannot inject helpers that don't exist in the page.
 * They only READ the DOM; nothing is submitted or changed on the target site.
 */

/** Installed before any page script runs: lab LCP / CLS / long-task observers. */
export const OBSERVER_INIT_SCRIPT = `(() => {
  const s = (window.__aios = { lcp: null, lcpEl: null, cls: 0, clsEntries: [], longTasks: 0, longTaskTime: 0 });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        s.lcp = e.startTime;
        s.lcpEl = e.element ? e.element.tagName.toLowerCase() + (e.element.id ? '#' + e.element.id : '') : e.url || null;
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        s.cls += e.value;
        if (s.clsEntries.length < 8) {
          s.clsEntries.push({
            value: Math.round(e.value * 1000) / 1000,
            sources: (e.sources || []).slice(0, 3).map((x) => {
              const n = x.node;
              if (!n || n.nodeType !== 1) return null;
              const cls = typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/)[0] : '';
              return n.nodeName.toLowerCase() + (n.id ? '#' + n.id : '') + cls;
            }),
          });
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { s.longTasks++; s.longTaskTime += e.duration; }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
})();`;

/**
 * Collects a structured snapshot of the page. Call as `(${COLLECT_SCRIPT})(opts)`.
 * opts: { mobile: boolean, contrast: boolean, light: boolean }
 */
export const COLLECT_SCRIPT = `function (opts) {
  opts = opts || {};
  const vw = window.innerWidth, vh = window.innerHeight;
  const de = document.documentElement, body = document.body || de;
  const clean = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n || 200);
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05;
  };
  const cssPath = (el) => {
    const parts = [];
    let e = el, depth = 0;
    while (e && e.nodeType === 1 && depth < 4) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(p + '#' + e.id); break; }
      const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) p += '.' + cls.join('.');
      parts.unshift(p);
      e = e.parentElement; depth++;
    }
    return parts.join(' > ').slice(0, 160);
  };
  const absTop = (el) => el.getBoundingClientRect().top + window.scrollY;
  const accName = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria && aria.trim()) return aria.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(' ').trim();
      if (t) return t;
    }
    const t = clean(el.innerText || el.textContent || '', 120); if (t) return t;
    if (el.tagName === 'INPUT') { const v = el.value || el.getAttribute('value'); if (v) return v; }
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img && (img.getAttribute('alt') || '').trim()) return img.getAttribute('alt').trim();
    const svgTitle = el.querySelector && el.querySelector('svg title');
    if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent.trim();
    const title = el.getAttribute('title'); if (title && title.trim()) return title.trim();
    return '';
  };
  const q = (s) => document.querySelector(s);
  const metaContent = (sel) => { const m = q(sel); return m ? (m.getAttribute('content') || '').trim() : null; };
  const host = (u) => { try { return new URL(u, location.href).hostname.replace(/^www\\./, ''); } catch (e) { return ''; } };
  const selfHost = host(location.href);

  const meta = {
    title: clean(document.title, 300),
    description: metaContent('meta[name="description" i]'),
    canonical: (q('link[rel="canonical" i]') || {}).href || null,
    robots: metaContent('meta[name="robots" i]'),
    viewport: metaContent('meta[name="viewport" i]'),
    lang: de.getAttribute('lang'),
    generator: metaContent('meta[name="generator" i]'),
    ogTitle: metaContent('meta[property="og:title" i]'),
    ogDescription: metaContent('meta[property="og:description" i]'),
    ogImage: metaContent('meta[property="og:image" i]'),
    twitterCard: metaContent('meta[name="twitter:card" i]'),
    favicon: !!q('link[rel~="icon" i]'),
    hreflangs: document.querySelectorAll('link[rel="alternate" i][hreflang]').length,
    charset: document.characterSet,
    doctype: document.doctype ? (document.doctype.name + (document.doctype.publicId ? ' ' + document.doctype.publicId : '')) : null,
  };

  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 120).map((h) => ({
    level: Number(h.tagName[1]), text: clean(h.textContent, 140), visible: isVisible(h), top: Math.round(absTop(h)),
  }));

  const ldTypes = [], ldPhones = [], ldEmails = [];
  let ldInvalid = 0;
  document.querySelectorAll('script[type="application/ld+json" i]').forEach((s) => {
    try {
      const walk = (d, depth) => {
        if (!d || depth > 6) return;
        if (Array.isArray(d)) { d.forEach((x) => walk(x, depth + 1)); return; }
        if (typeof d === 'object') {
          if (d['@type']) [].concat(d['@type']).forEach((t) => ldTypes.push(String(t)));
          if (typeof d.telephone === 'string') ldPhones.push(d.telephone.slice(0, 40));
          if (typeof d.email === 'string') ldEmails.push(d.email.replace(/^mailto:/i, '').slice(0, 120));
          Object.keys(d).forEach((k) => { if (d[k] && typeof d[k] === 'object') walk(d[k], depth + 1); });
        }
      };
      walk(JSON.parse(s.textContent || ''), 0);
    } catch (e) { ldInvalid++; }
  });

  const anchors = Array.from(document.querySelectorAll('a[href]'));
  const links = anchors.slice(0, 800).map((a) => {
    const raw = a.getAttribute('href') || '';
    let abs = null; try { abs = new URL(raw, location.href).href; } catch (e) {}
    const h = abs ? host(abs) : '';
    return {
      href: abs || raw, text: clean(accName(a), 100),
      inNav: !!a.closest('nav,header,[role="navigation"],[role="banner"]'),
      inFooter: !!a.closest('footer,[role="contentinfo"]'),
      visible: isVisible(a), top: Math.round(absTop(a)),
      internal: !!abs && /^https?:/.test(abs) && h === selfHost,
    };
  });

  const images = Array.from(document.images).slice(0, 300).map((img) => {
    const r = img.getBoundingClientRect();
    return {
      src: String(img.currentSrc || img.src || '').slice(0, 400), alt: img.getAttribute('alt'), hasAlt: img.hasAttribute('alt'),
      decorative: img.getAttribute('role') === 'presentation' || img.getAttribute('aria-hidden') === 'true',
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, width: Math.round(r.width), height: Math.round(r.height),
      loading: img.getAttribute('loading'), visible: isVisible(img), aboveFold: r.top + window.scrollY < vh,
    };
  });

  const labelled = (el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return true;
    if (el.id) { try { if (document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true; } catch (e) {} }
    return !!el.closest('label');
  };
  const fieldFilter = (e) => !['hidden', 'submit', 'button', 'image', 'reset'].includes((e.getAttribute('type') || '').toLowerCase());
  const forms = Array.from(document.querySelectorAll('form')).slice(0, 20).map((f) => {
    const fields = Array.from(f.querySelectorAll('input,select,textarea')).filter(fieldFilter);
    return {
      action: f.getAttribute('action'), method: (f.getAttribute('method') || 'get').toLowerCase(), visible: isVisible(f),
      fieldCount: fields.length,
      unlabeled: fields.filter((e) => !labelled(e) && !e.getAttribute('placeholder')).length,
      placeholderOnly: fields.filter((e) => !labelled(e) && e.getAttribute('placeholder')).length,
      hasEmail: fields.some((e) => e.type === 'email' || /mail/i.test(e.name || '')),
      hasTextarea: fields.some((e) => e.tagName === 'TEXTAREA'),
      hasPhone: fields.some((e) => e.type === 'tel' || /phone|tel/i.test(e.name || '')),
      isSearch: f.getAttribute('role') === 'search' || fields.some((e) => e.type === 'search') || /search|szukaj|suche|поиск/i.test((f.getAttribute('action') || '') + ' ' + (f.className || '')),
      hasSubmit: !!f.querySelector('button,input[type="submit"],input[type="image"]'),
      captcha: !!f.querySelector('.g-recaptcha,[data-sitekey],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],.cf-turnstile'),
    };
  });
  const unlabeledInputs = Array.from(document.querySelectorAll('input,select,textarea')).filter((e) => fieldFilter(e) && isVisible(e) && !labelled(e) && !e.getAttribute('placeholder')).length;

  const CTA_RE = /(book|booking|appointment|schedule|reserve|reservation|get (a )?quote|request a|contact us|call (us|now)|order now|buy|shop now|sign up|get started|consultation|enquire|inquire|umów|umow|zarezerwuj|rezerwac|rezerwuj|zapisz|zapisy|wizyt|kontakt|zadzwoń|zadzwon|wycen|zamów|zamow|konsultac|napisz do|termin|записат|запис на|связат|зв.язат|позвон|зателефон|заказат|замовит|консультац|заброн|buchen|reservieren|anfrage|anrufen|kontaktieren|objednat|rezervac|zavolejte|poptávk|reserva|pide cita|llamar|contacta|réserver|rendez-vous|devis|appeler|contactez|prenota|appuntamento|chiama|contatta|preventivo)/i;
  const clickables = Array.from(document.querySelectorAll('a[href],button,[role="button"],input[type="submit"],input[type="button"]')).slice(0, 1200);
  let unnamed = 0; const unnamedExamples = [];
  const ctas = [], tapSmall = [];
  let tapChecked = 0, toggleIdx = 0;
  const toggles = [];
  for (const el of clickables) {
    const vis = isVisible(el);
    const name = accName(el);
    if (vis && !name) { unnamed++; if (unnamedExamples.length < 5) unnamedExamples.push(cssPath(el)); }
    if (!vis) continue;
    const r = el.getBoundingClientRect();
    const top = r.top + window.scrollY;
    const href = el.getAttribute('href') || '';
    const isTel = /^tel:/i.test(href);
    if (CTA_RE.test(name) || isTel) {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      const hasBg = !!bg && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg);
      if (ctas.length < 30) ctas.push({
        text: clean(name, 80), top: Math.round(top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height),
        buttonLike: hasBg || el.tagName === 'BUTTON' || (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'),
        inFirstViewport: top < vh, tel: isTel, fontSize: parseFloat(cs.fontSize), inNav: !!el.closest('nav,header'),
      });
    }
    const sig = ((typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
    if (toggles.length < 3 && r.width < 140 && (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls') || /(burger|hamburger|menu-toggle|nav-toggle|navbar-toggler|menu-btn|menu-button|mobile-menu|toggle-menu|menu-icon|open-menu)/.test(sig))) {
      el.setAttribute('data-aios-toggle', String(toggleIdx));
      toggles.push({ id: toggleIdx++, path: cssPath(el), expanded: el.getAttribute('aria-expanded') });
    }
    if (opts.mobile) {
      tapChecked++;
      if ((r.width < 24 || r.height < 24) && !el.closest('p')) {
        if (tapSmall.length < 200) tapSmall.push({ path: cssPath(el), w: Math.round(r.width), h: Math.round(r.height), text: clean(name, 40) });
      }
    }
  }
  const telLinks = anchors.filter((a) => /^tel:/i.test(a.getAttribute('href') || '')).slice(0, 20).map((a) => ({ href: a.getAttribute('href').slice(0, 60), visible: isVisible(a), inHeader: !!a.closest('header,nav,[role="banner"]') }));
  const mailtoLinks = anchors.filter((a) => /^mailto:/i.test(a.getAttribute('href') || '')).slice(0, 20).map((a) => a.getAttribute('href').slice(0, 200));

  const navLinks = links.filter((l) => l.inNav);
  const landmarks = {
    header: document.querySelectorAll('header,[role="banner"]').length,
    nav: document.querySelectorAll('nav,[role="navigation"]').length,
    main: document.querySelectorAll('main,[role="main"]').length,
    footer: document.querySelectorAll('footer,[role="contentinfo"]').length,
  };
  const legacy = {
    font: document.getElementsByTagName('font').length,
    center: document.getElementsByTagName('center').length,
    marquee: document.getElementsByTagName('marquee').length,
    frames: document.querySelectorAll('frameset,frame').length,
    flash: document.querySelectorAll('object[type*="flash" i],embed[type*="flash" i],embed[src$=".swf" i],object[data$=".swf" i]').length,
    layoutTables: Array.from(document.querySelectorAll('table')).filter((t) => !t.querySelector('th') && t.querySelectorAll('table').length > 0).length,
    inlineStyles: document.querySelectorAll('[style]').length,
  };
  const ariaHiddenFocusable = document.querySelectorAll('[aria-hidden="true"] a[href],[aria-hidden="true"] button,[aria-hidden="true"] input,[aria-hidden="true"] [tabindex]:not([tabindex="-1"])').length;
  let brokenAriaRefs = 0;
  document.querySelectorAll('[aria-labelledby],[aria-describedby]').forEach((el) => {
    ['aria-labelledby', 'aria-describedby'].forEach((attr) => {
      const v = el.getAttribute(attr);
      if (v) v.split(/\\s+/).forEach((id) => { if (id && !document.getElementById(id)) brokenAriaRefs++; });
    });
  });

  const bodyText = clean(body.innerText || '', 80000);
  const wordCount = bodyText ? bodyText.split(/\\s+/).length : 0;
  const footer = q('footer,[role="contentinfo"]');
  const footerText = footer ? clean(footer.innerText, 3000) : bodyText.slice(-3000);
  const years = [];
  (footerText.match(/(©|copyright|\\(c\\))[^0-9]{0,40}((19|20)\\d{2})(\\s*[-–]\\s*((19|20)\\d{2}))?/gi) || []).forEach((m) => {
    (m.match(/(19|20)\\d{2}/g) || []).forEach((y) => years.push(Number(y)));
  });
  const TRUST_RE = /(testimonial|reviews?|opinie|opinii|recenzj|referencj|rekomendacj|certyfikat|certificat|award|nagrod|our partners|partnerzy|our clients|nasi klienci|case stud|portfolio|realizacj|years of experience|lat doświadczenia|lat doswiadczenia|google reviews|trustpilot|bewertungen|kundenstimmen|отзыв|відгук|сертифікат|сертификат|recenze|reference|reseñas|témoignages|avis clients|recensioni)/gi;
  const trustSignals = Array.from(new Set((bodyText.match(TRUST_RE) || []).slice(0, 30).map((m) => m.toLowerCase())));
  const trustWidgets = document.querySelectorAll('[class*="testimonial" i],[id*="testimonial" i],[class*="review" i],[class*="opinie" i],[class*="rating" i]').length;

  const h1s = headings.filter((h) => h.level === 1);
  const firstScreenText = clean(Array.from(document.querySelectorAll('h1,h2,h3,p,a,button,li')).filter((e) => isVisible(e) && e.getBoundingClientRect().top + window.scrollY < vh).slice(0, 40).map((e) => e.innerText).join(' | '), 1500);

  const scrollWidth = Math.max(de.scrollWidth, body.scrollWidth);
  const overflowEls = [];
  if (scrollWidth > vw + 2) {
    const all = body.getElementsByTagName('*');
    for (let i = 0; i < all.length && i < 5000 && overflowEls.length < 8; i++) {
      const el = all[i];
      const r = el.getBoundingClientRect();
      if (r.right > vw + 2 && r.width > 2 && r.height > 2 && getComputedStyle(el).position !== 'fixed' && isVisible(el)) {
        const pr = el.parentElement ? el.parentElement.getBoundingClientRect().right : 0;
        if (pr <= vw + 2) overflowEls.push({ path: cssPath(el), right: Math.round(r.right), width: Math.round(r.width) });
      }
    }
  }

  let textEls = 0, smallText = 0;
  if (opts.mobile) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const seen = new Set(); let n, guard = 0;
    while ((n = walker.nextNode()) && guard < 4000) {
      guard++;
      if (!n.textContent || n.textContent.trim().length < 3) continue;
      const p = n.parentElement;
      if (!p || seen.has(p)) continue;
      seen.add(p);
      if (!isVisible(p)) continue;
      textEls++;
      if (parseFloat(getComputedStyle(p).fontSize) < 12) smallText++;
    }
  }

  const parseColor = (c) => {
    const m = c && c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const effectiveBg = (el) => {
    let e = el;
    while (e && e.nodeType === 1) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a >= 0.95) return c;
      if (c && c.a > 0.05) return null;
      e = e.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const contrast = { sampled: 0, failing: 0, unknown: 0, examples: [] };
  if (opts.contrast) {
    const cands = Array.from(document.querySelectorAll('p,li,a,span,h1,h2,h3,h4,button,label,td')).filter((e) => e.childElementCount === 0 && (e.textContent || '').trim().length >= 3 && isVisible(e)).slice(0, 220);
    for (const el of cands) {
      const cs = getComputedStyle(el);
      const fg = parseColor(cs.color), bg = effectiveBg(el);
      if (!fg || !bg || fg.a < 0.95) { contrast.unknown++; continue; }
      contrast.sampled++;
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < need) {
        contrast.failing++;
        if (contrast.examples.length < 6) contrast.examples.push({ text: clean(el.textContent, 50), ratio: Math.round(ratio * 100) / 100, required: need, fg: cs.color, bg: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')', path: cssPath(el) });
      }
    }
  }

  const overlaps = [];
  if (opts.mobile) {
    const blocks = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,a,button,li,span'))
      .filter((e) => e.childElementCount === 0 && (e.textContent || '').trim().length >= 2 && isVisible(e))
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter((x) => x.r.width > 4 && x.r.height > 4 && x.r.top < vh * 1.5 && x.r.bottom > 0)
      .slice(0, 160);
    for (let i = 0; i < blocks.length && overlaps.length < 5; i++) {
      for (let j = i + 1; j < blocks.length && overlaps.length < 5; j++) {
        const a = blocks[i], b = blocks[j];
        if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
        const x = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left));
        const y = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top));
        const minArea = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
        if (minArea > 0 && (x * y) / minArea > 0.3) {
          overlaps.push({ a: clean(a.e.textContent, 40), b: clean(b.e.textContent, 40), pathA: cssPath(a.e), pathB: cssPath(b.e), ratio: Math.round(((x * y) / minArea) * 100) / 100 });
        }
      }
    }
  }

  let fixedHeader = null;
  const overlays = [];
  const allEls = Array.from(body.querySelectorAll('*')).slice(0, 3500);
  for (const el of allEls) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top <= 5 && r.width >= vw * 0.9 && r.height > 20 && r.height < vh * 0.6) {
      if (!fixedHeader || r.height > fixedHeader.height) fixedHeader = { height: Math.round(r.height), path: cssPath(el) };
    }
    if (cs.position === 'fixed' && overlays.length < 4) {
      const cover = ((Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh);
      if (cover > 0.3) {
        const t = clean(el.innerText, 200);
        overlays.push({ path: cssPath(el), cover: Math.round(cover * 100) / 100, cookie: /cookie|rodo|gdpr|privacy|prywatno|datenschutz|конфиденц|souhlas|consent|zgod/i.test(t), text: t.slice(0, 80) });
      }
    }
  }

  const scripts = Array.from(document.scripts).slice(0, 250).map((s) => ({ src: s.src ? s.src.slice(0, 300) : null, async: s.async, defer: s.defer, module: s.type === 'module', inHead: !!s.closest('head'), inlineSize: s.src ? 0 : (s.textContent || '').length }));
  const stylesheets = Array.from(document.querySelectorAll('link[rel~="stylesheet" i]')).slice(0, 100).map((l) => ({ href: String(l.href).slice(0, 300), media: l.media || 'all', inHead: !!l.closest('head') }));
  let fonts = [];
  try { document.fonts.forEach((f) => fonts.push(f.family.replace(/["']/g, '') + ':' + f.status)); } catch (e) {}
  fonts = Array.from(new Set(fonts)).slice(0, 30);
  const animations = { total: 0, infinite: 0 };
  try {
    const an = document.getAnimations();
    animations.total = an.length;
    animations.infinite = an.filter((a) => { const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null; return t && t.iterations === Infinity; }).length;
  } catch (e) {}

  const w = window;
  const htmlStr = de.outerHTML.slice(0, 400000);
  const gen = meta.generator || '';
  const tech = {
    wordpress: /wordpress/i.test(gen) || /\\/wp-(content|includes)\\//i.test(htmlStr),
    wpVersion: (gen.match(/WordPress\\s+([\\d.]+)/i) || [])[1] || null,
    tilda: /tildacdn|tilda\\.ws|t-records/i.test(htmlStr),
    webflow: !!de.getAttribute('data-wf-site') || /webflow/i.test(gen),
    wix: /wixstatic|parastorage|wix\\.com/i.test(htmlStr) || /wix/i.test(gen),
    squarespace: /squarespace/i.test(htmlStr),
    shopify: !!w.Shopify || /cdn\\.shopify\\.com/i.test(htmlStr),
    bitrix: !!w.BX || /\\/bitrix\\//i.test(htmlStr),
    joomla: /joomla/i.test(gen) || /\\/media\\/jui\\//i.test(htmlStr),
    drupal: !!w.Drupal || /drupal/i.test(gen),
    jquery: (w.jQuery && w.jQuery.fn && w.jQuery.fn.jquery) || null,
    nextjs: !!w.__NEXT_DATA__ || !!document.querySelector('#__next'),
    vue: !!w.__VUE__ || !!document.querySelector('[data-v-app]'),
    angular: !!document.querySelector('[ng-version]'),
    elementor: /elementor/i.test(htmlStr),
    divi: /et_pb_/i.test(htmlStr),
    bootstrap: /bootstrap(\\.min)?\\.(css|js)/i.test(htmlStr),
    gtm: /googletagmanager\\.com\\/gtm\\.js/i.test(htmlStr),
    ga: /google-analytics\\.com|gtag\\(/i.test(htmlStr),
    fbPixel: /connect\\.facebook\\.net[^"']*fbevents/i.test(htmlStr),
  };

  const socialLinks = Array.from(new Set(links.filter((l) => /(facebook\\.com|instagram\\.com|linkedin\\.com|youtube\\.com|tiktok\\.com|twitter\\.com|x\\.com\\/|pinterest\\.)/i.test(l.href)).map((l) => l.href))).slice(0, 20);

  const nav = performance.getEntriesByType('navigation')[0];
  const resources = opts.light ? [] : performance.getEntriesByType('resource').slice(0, 600).map((r) => ({
    name: r.name.slice(0, 300), type: r.initiatorType, transfer: r.transferSize || 0, encoded: r.encodedBodySize || 0,
    decoded: r.decodedBodySize || 0, duration: Math.round(r.duration), blocking: r.renderBlockingStatus || null,
  }));
  const a = w.__aios || {};
  const perf = {
    ttfb: nav ? Math.round(nav.responseStart - nav.requestStart) : null,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav ? Math.round(nav.loadEventEnd) : null,
    documentTransfer: nav ? nav.transferSize : null,
    lcp: a.lcp != null ? Math.round(a.lcp) : null, lcpElement: a.lcpEl || null,
    cls: a.cls != null ? Math.round(a.cls * 1000) / 1000 : null, clsSources: a.clsEntries || [],
    longTasks: a.longTasks != null ? a.longTasks : null, longTaskTime: a.longTaskTime != null ? Math.round(a.longTaskTime) : null,
    scrollHeight: Math.max(de.scrollHeight, body.scrollHeight),
  };

  return {
    url: location.href, viewport: { width: vw, height: vh }, meta, headings,
    ld: { types: Array.from(new Set(ldTypes)).slice(0, 30), invalid: ldInvalid, phones: ldPhones.slice(0, 5), emails: ldEmails.slice(0, 5), microdata: document.querySelectorAll('[itemscope][itemtype]').length },
    links, images, forms, unlabeledInputs, clickableCount: clickables.length, unnamed, unnamedExamples, ctas, tapSmall, tapChecked,
    telLinks, mailtoLinks,
    nav: { hasNav: landmarks.nav > 0, hasHeader: landmarks.header > 0, navLinks: navLinks.length, visibleNavLinks: navLinks.filter((l) => l.visible).length, toggles },
    landmarks, legacy, ariaHiddenFocusable, brokenAriaRefs,
    bodyText: opts.light ? bodyText.slice(0, 30000) : bodyText, wordCount, footerText, copyrightYears: years,
    trustSignals, trustWidgets,
    firstScreen: { h1InFirstScreen: h1s.some((h) => h.visible && h.top < vh), headingInFirstScreen: headings.some((h) => h.visible && h.top < vh), text: firstScreenText },
    h1Count: h1s.length,
    scroll: { scrollWidth, clientWidth: de.clientWidth, overflowHidden: /hidden|clip/.test(getComputedStyle(body).overflowX + getComputedStyle(de).overflowX), overflowEls },
    text: { textEls, smallText }, contrast, overlaps, fixedHeader, overlays,
    scripts, stylesheets, fonts, animations, tech, socialLinks, perf, resources,
  };
}`;

/** Focus probe after a Tab keypress: does the focused element show a visible indicator? */
export const FOCUS_PROBE_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const snap = () => { const cs = getComputedStyle(el); return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.backgroundColor, cs.borderColor, cs.textDecorationLine, cs.color].join('|'); };
  const focused = snap();
  el.blur();
  const blurred = snap();
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  return {
    tag: el.tagName.toLowerCase(),
    text: String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 40),
    indicator: focused !== blurred || outline,
    onScreen: r.width > 0 && r.height > 0,
    href: (el.getAttribute('href') || '').slice(0, 80),
  };
})()`;

export const VISIBLE_NAV_LINKS_SCRIPT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05; };
  return Array.from(document.querySelectorAll('nav a[href], header a[href], [role="navigation"] a[href], [role="dialog"] a[href], [class*="menu" i] a[href]')).filter(vis).length;
})()`;
