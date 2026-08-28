/* ============================================================
   CNL CHAPTER PAGE — design "2a"
   Renders the full chapter page into the Squarespace embed.
   Works with both the legacy embed skeleton (#cnl-dashboard-container,
   whose inner markup is replaced) and a bare <div id="cnl-chapter">.
   Per-chapter content comes from the registry sheet; only
   window.CNL_SETTINGS ({chapterCode, category, eventsEndpoint?,
   signupJs?/signupEndpoint?/signupSitekey?}) is page-local. Events come
   from the Luma feed (cnl-events Worker) keyed by chapterCode; `category`
   is the legacy Squarespace-events key, kept so existing code blocks stay
   valid.

   Also exposes window.CNLChapter.render(mount, row, opts) so the chapter
   page editor (tools.cnlhq.org/tools/chapter-page) can render a registry
   row it is editing, with the exact same code the live page uses.
   ============================================================ */
(function () {
  var userConfig = window.CNL_SETTINGS || {};

  var CONFIG = {
    CHAPTER_CODE: userConfig.chapterCode || 'CLT',
    CHAPTER_CATEGORY: userConfig.category || 'Austin',
    CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ0wq0Bm6gQrgX_Th252L2h9B1GzPQS_SeWg-_JrNi6ynm7CHGcuLw-RjmWC4M5Yg-KMXjvNN0d8ZVe/pub?gid=0&single=true&output=csv',
    /* Luma feed via the cnl-events Worker (events-automation). It resolves
       ChapterCode -> Luma chapter tag server-side, so we just pass the code.
       Overridable (the local preview proxies it to dodge CORS). */
    EVENTS_ENDPOINT: userConfig.eventsEndpoint || 'https://luma.cnlhq.org/events',
    MAX_EVENTS: 6
  };

  /* Google fallback faces for the Adobe fonts (Archivo ~ Pragmatica
     Extended, Bitter ~ Tisa). Loaded lazily by the browser only if the
     Adobe kit fails, since the Adobe faces lead the font stacks. */
  if (!document.querySelector('link[href*="family=Archivo"]')) {
    var fl = document.createElement('link');
    fl.rel = 'stylesheet';
    fl.href = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Bitter:ital,wght@0,300..800;1,300..800&display=swap';
    document.head.appendChild(fl);
  }

  /* Approved accent set. `text` is the contrast-safe variant for accent
     TEXT on cream (harvest/slate darken); `ink` is text ON accent fills. */
  var ACCENTS = {
    brick:   { acc: '#9F3C39', ink: '#FDFBE9', text: '#9F3C39' },
    marine:  { acc: '#2E6E63', ink: '#FDFBE9', text: '#2E6E63' },
    harvest: { acc: '#B9822E', ink: '#2C3659', text: '#8F6316' },
    plum:    { acc: '#6E4A7E', ink: '#FDFBE9', text: '#6E4A7E' },
    slate:   { acc: '#4A6FA5', ink: '#FDFBE9', text: '#41618F' }
  };

  /* Registry column -> icon, in display order. */
  var SOCIAL = [
    { col: 'Twitter',   icon: 'fa-brands fa-x-twitter',    label: 'X / Twitter' },
    { col: 'Instagram', icon: 'fa-brands fa-instagram',    label: 'Instagram' },
    { col: 'BlueSky',   icon: 'fa-brands fa-bluesky',      label: 'Bluesky' },
    { col: 'Facebook',  icon: 'fa-brands fa-facebook-f',   label: 'Facebook' },
    { col: 'Email',     icon: 'fa-solid fa-envelope',      label: 'Email' },
    { col: 'Slack',     icon: 'fa-brands fa-slack',        label: 'Slack' },
    { col: 'WhatsApp',  icon: 'fa-brands fa-whatsapp',     label: 'WhatsApp' },
    { col: 'GroupMe',   icon: 'fa-solid fa-comment-dots',  label: 'GroupMe' },
    { col: 'Discord',   icon: 'fa-brands fa-discord',      label: 'Discord' }
  ];
  var LINK_ICON = 'fa-solid fa-arrow-up-right-from-square';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cleanStr(str) { return str ? str.toLowerCase().replace(/[^a-z0-9]/g, '') : ''; }
  function col(row, name) { return (row[name] || '').trim(); }
  function extUrl(link) {
    link = (link || '').trim();
    if (!link) return '';
    if (link.indexOf('mailto:') === 0 || link.indexOf('http') === 0) return link;
    if (link.indexOf('@') > 0 && link.indexOf('/') < 0) return 'mailto:' + link;
    return 'https://' + link;
  }

  /* ---------- config from a registry row ---------- */
  function buildConfig(row) {
    var links = [], officers = [], i;
    for (i = 1; i <= 4; i++) {
      var ll = col(row, 'Link' + i + 'Label'), lu = col(row, 'Link' + i + 'URL');
      if (ll && lu) links.push({ label: ll, url: extUrl(lu) });
      var on = col(row, 'Officer' + i + 'Name'), or = col(row, 'Officer' + i + 'Role');
      if (on) officers.push({ name: on, role: or });
    }
    var social = [];
    SOCIAL.forEach(function (s) {
      var v = col(row, s.col);
      if (v) social.push({ icon: s.icon, label: s.label, url: s.col === 'Email' ? ('mailto:' + v.replace(/^mailto:/, '')) : extUrl(v) });
    });
    return {
      code: col(row, 'ChapterCode') || CONFIG.CHAPTER_CODE,
      name: col(row, 'ChapterName') || ('Chapter ' + (col(row, 'ChapterCode') || CONFIG.CHAPTER_CODE)),
      accent: ACCENTS[cleanStr(col(row, 'Accent'))] || ACCENTS.brick,
      tagline: col(row, 'Tagline'),
      about: col(row, 'About'),
      meeting: col(row, 'Meeting'),
      photo: { src: col(row, 'PhotoURL'), caption: col(row, 'PhotoCaption') },
      tz: col(row, 'Timezone'),
      eaLink: col(row, 'EveryAction Link'),
      social: social, links: links, officers: officers
    };
  }

  /* ---------- date formatting (chapter timezone when available) ---------- */
  function fmtEvent(ms, tz) {
    var d = new Date(ms);
    function part(opts) {
      try {
        return new Intl.DateTimeFormat('en-US', tz ? Object.assign({}, opts, { timeZone: tz }) : opts).format(d);
      } catch (e) {
        return new Intl.DateTimeFormat('en-US', opts).format(d);
      }
    }
    return {
      weekday: part({ weekday: 'short' }),
      month: part({ month: 'short' }),
      day: part({ day: '2-digit' }),
      year: part({ year: 'numeric' }),
      time: part({ hour: 'numeric', minute: '2-digit' }),
      zone: part({ timeZoneName: 'short' }).split(' ').pop()
    };
  }

  /* ---------- render: page shell ---------- */
  function renderPage(mount, c) {
    var social = c.social.map(function (s) {
      return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener" aria-label="' + esc(s.label) + '"><i class="' + esc(s.icon) + '"></i></a>';
    }).join('');

    var photo = c.photo.src ? (
      '<div class="cnl-photo"><div class="cnl-photo-frame">' +
      '<img src="' + esc(c.photo.src) + '" alt="' + esc(c.photo.caption || c.name) + '"></div>' +
      (c.photo.caption ? '<div class="cnl-photo-cap">' + esc(c.photo.caption) + '</div>' : '') +
      '</div>') : '';

    var officers = c.officers.length ? (
      '<div><div class="cnl-h3row"><h3 class="cnl-h3">Chapter officers</h3><span class="cnl-h3fill"></span></div>' +
      '<div class="cnl-officers">' + c.officers.map(function (o) {
        return '<div class="cnl-officer"><span class="n">' + esc(o.name) + '</span><span class="dots"></span><span class="r">' + esc(o.role) + '</span></div>';
      }).join('') + '</div></div>') : '';

    var links = c.links.length ? (
      '<div><div class="cnl-h3row"><h3 class="cnl-h3">Chapter links</h3><span class="cnl-h3fill"></span></div>' +
      '<div class="cnl-links">' + c.links.map(function (l) {
        return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + ' <i class="' + LINK_ICON + '"></i></a>';
      }).join('') + '</div></div>') : '';

    mount.innerHTML =
      '<div class="cnl-page" style="--acc:' + c.accent.acc + ';--acc-ink:' + c.accent.ink + ';--acc-text:' + c.accent.text + '">' +
        '<div class="cnl-mast">' +
          '<h1 class="cnl-h1">' + esc(c.name) + '</h1>' +
          (c.tagline ? '<p class="cnl-tagline">' + esc(c.tagline) + '</p>' : '<div class="cnl-tagline-spacer"></div>') +
          '<div class="cnl-rule"></div><div class="cnl-rule-thin"></div>' +
          '<div class="cnl-meta">' +
            /* Meeting cadence is opt-in: only shown when the registry has one. */
            (c.meeting ? '<div><i class="fa-regular fa-calendar"></i>Meets ' + esc(c.meeting) + '</div>' : '') +
            '<div class="cnl-meta-right">' +
              '<div class="is-dim cnl-meta-note">Free to join · Everyone welcome</div>' +
              (social ? '<div class="cnl-social">' + social + '</div>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="cnl-main">' +
          '<div class="cnl-main-col">' +
            (c.about ? '<p class="cnl-about"><span class="cnl-dropcap">' + esc(c.about.charAt(0)) + '</span>' + esc(c.about.slice(1)) + '</p>' : '') +
            photo +
            '<div class="cnl-h2row"><h2 class="cnl-h2">Upcoming events</h2><span class="cnl-h2fill"></span><span class="cnl-h2tag" id="cnl-events-tag"></span></div>' +
            '<div id="cnl-events-slot"><div class="cnl-events-note">Checking for events…</div></div>' +
            ((officers || links) ? '<div class="cnl-two">' + officers + links + '</div>' : '') +
          '</div>' +
          '<div class="cnl-rail">' +
            '<div class="cnl-form-card">' +
              '<div class="cnl-form-head"><div class="t">Join the chapter</div><div class="s">Get the newsletter. Hear about every meetup.</div></div>' +
              '<div class="cnl-form-body"><div class="cnl-signup-mount"><div class="cnl-form-note">Loading…</div></div></div>' +
              '<div class="cnl-form-fine">Powered by Action Network · Unsubscribe anytime</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="cnl-foot">' +
          '<div class="cnl-rule"></div><div class="cnl-rule-thin"></div>' +
          '<div class="cnl-foot-row"><span>' + esc(c.name) + '</span><span>A chapter of the Center for New Liberalism · cnliberalism.org</span></div>' +
        '</div>' +
      '</div>';
  }

  /* ---------- render: events (Luma feed from the cnl-events Worker) ----------
     Feed shape per event: { id, name, url, start_at (ISO), end_at, timezone,
     cover_url, chapters[], chapter_names[], tags[], location: {type, venue,
     city_state} }. The Worker already filtered by chapter and sorted by
     start, so this is display only. Times render in the EVENT's timezone
     (a virtual event hosted from another zone must not shift). */
  function renderEvents(mount, c, data) {
    var slot = mount.querySelector('#cnl-events-slot');
    var tag = mount.querySelector('#cnl-events-tag');
    if (!slot) return;

    if (data.warnings) console.warn('[cnl-chapter events]', data.warnings.join(' | '));
    if (data.served === 'error') {
      console.error('[cnl-chapter events]', data.error);
      slot.innerHTML = '<div class="cnl-events-note">Unable to load events right now.</div>';
      return;
    }

    var now = Date.now();
    var valid = (data.events || []).filter(function (e) {
      return e && e.start_at && Date.parse(e.start_at) >= now;
    }).slice(0, CONFIG.MAX_EVENTS);

    if (!valid.length) {
      slot.innerHTML =
        '<div class="cnl-empty">' +
          '<div class="cnl-empty-h">Nothing on the calendar — yet.</div>' +
          '<p>New meetups land every month. Join the newsletter and you’ll be the first to hear when the next one does. ' +
          '<em class="cnl-aside-d">(The form is right there. →)</em>' +
          '<em class="cnl-aside-m">(The form is right above.)</em></p>' +
        '</div>';
      return;
    }

    var months = [];
    var cards = valid.map(function (item) {
      var tz = item.timezone || c.tz;
      var f = fmtEvent(Date.parse(item.start_at), tz);
      if (months.indexOf(f.month) < 0) months.push(f.month);
      var loc = item.location || {};
      var venue;
      if (loc.type === 'online') venue = 'Online';
      else if (loc.venue && loc.city_state && loc.venue !== loc.city_state) venue = loc.venue + ' · ' + loc.city_state;
      else venue = loc.venue || loc.city_state || 'Location TBD';
      /* Show the zone only when it differs from the chapter's own. */
      var when = f.time + (c.tz && tz !== c.tz ? ' ' + f.zone : '');
      return (
        '<div class="cnl-event">' +
          '<div><div class="cnl-event-when">' + f.weekday + ' · ' + f.month + '</div><div class="cnl-event-day">' + f.day + '</div></div>' +
          '<div><div class="cnl-event-title"><a href="' + esc(item.url) + '" target="_blank" rel="noopener">' + esc(item.name) + '</a></div>' +
          '<div class="cnl-event-meta">' + esc(when) + ' · ' + esc(venue) + '</div></div>' +
          '<a class="cnl-btn-line" href="' + esc(item.url) + '" target="_blank" rel="noopener">RSVP <i class="' + LINK_ICON + '"></i></a>' +
        '</div>');
    });
    slot.innerHTML = '<div class="cnl-events">' + cards.join('') + '</div>';

    if (tag) {
      var lastEv = valid[valid.length - 1];
      var last = fmtEvent(Date.parse(lastEv.start_at), lastEv.timezone || c.tz);
      tag.textContent = (months.length > 1
        ? months[0] + '–' + months[months.length - 1]
        : months[0]) + ' ' + last.year;
    }

    var els = slot.querySelectorAll('.cnl-event');
    els.forEach(function (el, i) {
      setTimeout(function () { el.classList.add('cnl-in'); }, 40 + i * 60);
    });
  }

  /* ---------- Action Network sign-up form ----------
     Reuses the shared sign-up component (cnl-action-network-forms/signup.js,
     hosted on assets.cnlhq.org) via its CNLSignup.render() API, pointed at
     the sign-up Worker with this page's chapter code. The Worker routes the
     submission to the chapter's own Action Network form + group key.
     Styling comes from chapter.css (.cnl-form-body .cnl-su-*) — signup.css
     is the homepage's white-on-dark treatment and is NOT loaded here. */
  var SIGNUP = {
    js: userConfig.signupJs || 'https://assets.cnlhq.org/web/signup/v5/signup.js',
    endpoint: userConfig.signupEndpoint || 'https://signup.cnlhq.org',
    sitekey: userConfig.signupSitekey || '0x4AAAAAAEeIhZR5FuR93fzw',
    turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
  };

  function loadScript(src, match) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src*="' + match + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function initForm(mount, c) {
    var wrap = mount.querySelector('.cnl-signup-mount');
    if (!wrap) return;
    /* Turnstile loads in parallel; signup.js polls for window.turnstile. */
    loadScript(SIGNUP.turnstile, 'challenges.cloudflare.com/turnstile').catch(function (e) { console.warn(e); });
    loadScript(SIGNUP.js, 'signup.js').then(function () {
      if (!window.CNLSignup || !window.CNLSignup.render) throw new Error('CNLSignup.render missing');
      wrap.innerHTML = '';
      window.CNLSignup.render(wrap, {
        endpoint: SIGNUP.endpoint,
        sitekey: SIGNUP.sitekey,
        chapter: c.code,
        source: 'chapter-page',
        heading: '',
        subheading: '',
        showNames: true,
        showLastName: false,   /* chapter AN forms: first name, email, mobile, ZIP */
        showPhone: true,
        showZip: true,
        buttonLabel: 'Join the chapter',
        buttonLoadingLabel: 'Joining…',
        successHeading: 'You’re in.',
        successBody: 'Welcome to ' + c.name + '. Watch your inbox — you’ll hear about the next meetup.'
      });
    }).catch(function (err) {
      console.error(err);
      wrap.innerHTML = '<div class="cnl-form-note">The sign-up form couldn’t load. Please refresh, or email <a href="mailto:hello@cnliberalism.org">hello@cnliberalism.org</a>.</div>';
    });
  }

  /* ---------- events feed (cached per chapter so editor re-renders are free) ---------- */
  var eventsCache = {};
  function fetchEvents(code) {
    if (!eventsCache[code]) {
      var url = CONFIG.EVENTS_ENDPOINT +
        (CONFIG.EVENTS_ENDPOINT.indexOf('?') < 0 ? '?' : '&') +
        'chapter=' + encodeURIComponent(code) + '&limit=' + CONFIG.MAX_EVENTS;
      eventsCache[code] = fetch(url, { credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('events HTTP ' + r.status);
        return r.json();
      });
      eventsCache[code].catch(function () { delete eventsCache[code]; });
    }
    return eventsCache[code];
  }

  /* ---------- public render API ----------
     render(mount, row, opts): row is a registry row (sheet header -> value).
     opts.events (default true) loads the Luma feed; opts.form (default true)
     mounts the live sign-up form — the editor turns it off and gets a static
     stand-in so Turnstile isn't rendered on every keystroke. */
  function render(mount, row, opts) {
    opts = opts || {};
    var cfg = buildConfig(row);
    renderPage(mount, cfg);
    if (opts.form === false) {
      var wrap = mount.querySelector('.cnl-signup-mount');
      if (wrap) wrap.innerHTML = '<div class="cnl-form-note">Sign-up form appears here on the live page.</div>';
    } else {
      initForm(mount, cfg);
    }
    if (opts.events === false) {
      var slot = mount.querySelector('#cnl-events-slot');
      if (slot) slot.innerHTML = '<div class="cnl-events-note">Upcoming events load here on the live page.</div>';
    } else {
      fetchEvents(cfg.code).then(function (data) { renderEvents(mount, cfg, data); })
        .catch(function (err) {
          console.error(err);
          var slot2 = mount.querySelector('#cnl-events-slot');
          if (slot2) slot2.innerHTML = '<div class="cnl-events-note">Unable to load events right now.</div>';
        });
    }
    return cfg;
  }

  window.CNLChapter = { render: render, ACCENTS: ACCENTS, SOCIAL: SOCIAL };

  /* ---------- boot (live page) ---------- */
  function boot() {
    var mount = document.getElementById('cnl-chapter') || document.getElementById('cnl-dashboard-container');
    if (!mount || mount.hasAttribute('data-cnl-manual')) return;
    if (typeof Papa === 'undefined') { console.error('chapter.js needs PapaParse'); return; }

    fetchEvents(CONFIG.CHAPTER_CODE); // start early; render() reuses the cached promise

    Papa.parse(CONFIG.CSV_URL, {
      download: true,
      header: true,
      complete: function (results) {
        var row = results.data.find(function (r) {
          return r['ChapterCode'] && r['ChapterCode'].trim() === CONFIG.CHAPTER_CODE;
        });
        if (!row) {
          mount.innerHTML = '<div class="cnl-fatal"><div class="t">Chapter not found</div>Code “' + esc(CONFIG.CHAPTER_CODE) + '” isn’t in the chapter registry.</div>';
          return;
        }
        render(mount, row);
      },
      error: function (err) {
        console.error(err);
        mount.innerHTML = '<div class="cnl-fatal"><div class="t">Something went wrong</div>Couldn’t load chapter data. Please refresh.</div>';
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
