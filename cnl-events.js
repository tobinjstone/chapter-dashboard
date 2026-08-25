/**
 * CNL Events widget
 *
 * Renders upcoming Luma events into any element carrying [data-cnl-events].
 * No dependencies. Safe to load twice.
 *
 * Page config (optional — every value has a default):
 *   <script>
 *     window.CNL_EVENTS = {
 *       endpoint: "https://cnl-events.tobin-dc4.workers.dev/events",
 *       chapter: "Denver",   // must match the Luma tag; omit on the national page
 *       limit: 6,
 *       emptyText: "No upcoming events right now.",
 *       calendarUrl: "https://luma.com/cnl"
 *     };
 *   </script>
 *
 * Per-element config wins over the page config:
 *   <div data-cnl-events data-chapter="Denver" data-limit="3"></div>
 */
(function () {
  "use strict";

  if (window.__cnlEventsLoaded) return;
  window.__cnlEventsLoaded = true;

  var DEFAULTS = {
    endpoint: "https://cnl-events.tobin-dc4.workers.dev/events",
    chapter: "",
    tag: "",
    limit: 0,
    filters: null,          // null = off; "auto" = derive from the feed's tags
    hideEmptyFilters: true, // drop chips that match no event in the feed
    search: false,
    searchText: "Search chapters or events",
    allText: "All",
    noMatchText: "No events match that filter.",
    emptyText: "No upcoming events right now. Check back soon.",
    errorText: "Events couldn't load right now.",
    calendarUrl: "",
  };

  function config(el) {
    var page = window.CNL_EVENTS || {};
    var d = el.dataset;
    return {
      endpoint: d.endpoint || page.endpoint || DEFAULTS.endpoint,
      chapter: d.chapter || page.chapter || DEFAULTS.chapter,
      tag: d.tag || page.tag || DEFAULTS.tag,
      limit: parseInt(d.limit || page.limit || DEFAULTS.limit, 10) || 0,
      filters: page.filters !== undefined ? page.filters : DEFAULTS.filters,
      hideEmptyFilters:
        page.hideEmptyFilters !== undefined
          ? page.hideEmptyFilters
          : DEFAULTS.hideEmptyFilters,
      search:
        d.search !== undefined ? d.search !== "false" : page.search || DEFAULTS.search,
      searchText: page.searchText || DEFAULTS.searchText,
      allText: page.allText || DEFAULTS.allText,
      noMatchText: page.noMatchText || DEFAULTS.noMatchText,
      emptyText: d.emptyText || page.emptyText || DEFAULTS.emptyText,
      errorText: page.errorText || DEFAULTS.errorText,
      calendarUrl: d.calendarUrl || page.calendarUrl || DEFAULTS.calendarUrl,
    };
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * Format in the EVENT's timezone, not the visitor's. A Raleigh happy hour
   * must not render as 4:00 PM for someone reading in Denver.
   */
  function parts(iso, tz) {
    var date = new Date(iso);
    function fmt(opts) {
      try {
        return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: tz }, opts)).format(date);
      } catch (e) {
        return new Intl.DateTimeFormat("en-US", opts).format(date);
      }
    }
    return {
      month: fmt({ month: "short" }).toUpperCase(),
      day: fmt({ day: "numeric" }),
      weekday: fmt({ weekday: "short" }).toUpperCase(),
      full: fmt({ month: "long", day: "numeric", year: "numeric" }),
      time: fmt({ hour: "numeric", minute: "2-digit" }),
      zone: fmt({ timeZoneName: "short" }).split(" ").pop(),
    };
  }

  // Built without escape sequences so the separator survives any encoding.
  var DOT = " " + String.fromCharCode(183) + " ";

  function card(event) {
    var p = parts(event.start_at, event.timezone);

    var a = el("a", "cnl-event");
    a.href = event.url;
    a.target = "_blank";
    a.rel = "noopener";

    // --- media: Luma cover image, with the date floated over it ---
    var media = el("div", "cnl-event__media");

    if (event.cover_url) {
      var img = el("img", "cnl-event__img");
      img.src = event.cover_url;
      img.alt = "";            // decorative; the title carries the meaning
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", function () {
        // A dead image URL should degrade to the placeholder, not a broken icon.
        img.remove();
        media.classList.add("cnl-event__media--empty");
      });
      media.appendChild(img);
    } else {
      media.classList.add("cnl-event__media--empty");
    }

    // Full chapter name ("Twin Cities New Liberals"), resolved by the Worker
    // from the short Luma tag. Falls back to the tag if the Worker is older.
    var chapterLabel =
      (event.chapter_names && event.chapter_names[0]) ||
      (event.chapters && event.chapters[0]) ||
      "";
    if (chapterLabel) {
      media.appendChild(el("span", "cnl-event__chip", chapterLabel));
    }

    var dateBlock = el("div", "cnl-event__date");
    dateBlock.appendChild(el("span", "cnl-event__month", p.month));
    dateBlock.appendChild(el("span", "cnl-event__day", p.day));
    media.appendChild(dateBlock);

    // --- body ---
    var body = el("div", "cnl-event__body");
    body.appendChild(el("h3", "cnl-event__title", event.name));

    var meta = el("p", "cnl-event__meta");
    meta.appendChild(el("span", null, p.full + DOT + p.time + " " + p.zone));

    // The chapter has moved to the chip, so this line is now where the event
    // actually is: venue first, then the city it sits in.
    var loc = event.location || {};
    var where;
    if (loc.type === "online") {
      where = "Online";
    } else if (loc.venue && loc.city_state && loc.venue !== loc.city_state) {
      where = loc.venue + DOT + loc.city_state;
    } else {
      where = loc.venue || loc.city_state || "";
    }
    if (where) meta.appendChild(el("span", null, where));

    body.appendChild(meta);

    a.appendChild(media);
    a.appendChild(body);

    var label =
      event.name + ", " + p.weekday + " " + p.month + " " + p.day + ", " + p.time + " " + p.zone;
    a.setAttribute("aria-label", label);

    return a;
  }

  function message(container, text, cfg) {
    container.replaceChildren(messageNode(cfg, text));
  }

  function messageNode(cfg, text) {
    var box = el("div", "cnl-events__message", text);
    if (cfg.calendarUrl) {
      box.appendChild(document.createTextNode(" "));
      var link = el("a", null, "See the full calendar");
      link.href = cfg.calendarUrl;
      link.target = "_blank";
      link.rel = "noopener";
      box.appendChild(link);
    }
    return box;
  }

  function skeleton(container, n) {
    container.replaceChildren();
    for (var i = 0; i < n; i++) container.appendChild(el("div", "cnl-skeleton"));
  }

  // --- filtering -----------------------------------------------------------

  // A filter is a plain string (matched against the event's topic tags), or an
  // object: {label, tag} for a tag match, or {label, is} for a built-in
  // predicate. Built-ins need nothing tagged in Luma.
  var PREDICATES = {
    virtual: function (e) {
      return (e.location || {}).type === "online";
    },
    inperson: function (e) {
      return (e.location || {}).type !== "online";
    },
    chapter: function (e) {
      return (e.chapters || []).length > 0;
    },
    national: function (e) {
      return (e.chapters || []).length === 0;
    },
  };

  function normalizeFilters(cfg, knownTags) {
    var raw = cfg.filters;
    if (!raw) return [];
    if (raw === "auto") raw = knownTags || [];
    if (!isArray(raw)) return [];
    return raw
      .map(function (f) {
        if (typeof f === "string") return { label: f, tag: f };
        return f && f.label ? f : null;
      })
      .filter(Boolean)
      .filter(function (f) {
        // Drop an unknown built-in rather than rendering a chip that does nothing.
        if (!f.is) return true;
        if (PREDICATES[String(f.is).toLowerCase()]) return true;
        console.warn('[cnl-events] unknown filter predicate "' + f.is + '"');
        return false;
      });
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  function matchesFilter(event, f) {
    if (!f) return true;
    if (f.is) return PREDICATES[String(f.is).toLowerCase()](event);
    var want = String(f.tag || f.label).toLowerCase();
    return (event.tags || []).some(function (t) {
      return t.toLowerCase() === want;
    });
  }

  function matchesSearch(event, q) {
    if (!q) return true;
    var loc = event.location || {};
    var hay = [event.name]
      .concat(event.chapters || [], event.chapter_names || [], event.tags || [])
      .concat([loc.city_state, loc.venue])
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  var uid = 0;

  function toolbar(cfg, filters, state, onChange) {
    var bar = el("div", "cnl-events__bar");

    if (filters.length) {
      var group = el("div", "cnl-events__filters");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Filter events");

      [{ label: cfg.allText, all: true }].concat(filters).forEach(function (f, i) {
        var b = el("button", "cnl-events__filter", f.label);
        b.type = "button";
        b.setAttribute("aria-pressed", i === 0 ? "true" : "false");
        b.addEventListener("click", function () {
          state.filter = f.all ? null : f;
          for (var j = 0; j < group.children.length; j++) {
            group.children[j].setAttribute("aria-pressed", j === i ? "true" : "false");
          }
          onChange();
        });
        group.appendChild(b);
      });
      bar.appendChild(group);
    }

    if (cfg.search) {
      uid++;
      var id = "cnl-events-search-" + uid;
      var wrap = el("div", "cnl-events__search");
      var lab = el("label", "cnl-events__search-label", cfg.searchText);
      lab.setAttribute("for", id);
      var input = el("input", "cnl-events__input");
      input.type = "search";
      input.id = id;
      input.placeholder = cfg.searchText;
      input.addEventListener("input", function () {
        state.q = input.value.trim().toLowerCase();
        onChange();
      });
      wrap.appendChild(lab);
      wrap.appendChild(input);
      bar.appendChild(wrap);
    }

    return bar;
  }

  function render(container) {
    var cfg = config(container);
    container.classList.add("cnl-events");
    container.setAttribute("aria-busy", "true");
    skeleton(container, Math.min(cfg.limit || 3, 4));

    var url = new URL(cfg.endpoint);
    if (cfg.chapter) url.searchParams.set("chapter", cfg.chapter);
    if (cfg.tag) url.searchParams.set("tag", cfg.tag);
    if (cfg.limit) url.searchParams.set("limit", String(cfg.limit));

    fetch(url.toString(), { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        container.setAttribute("aria-busy", "false");

        if (data.warnings) console.warn("[cnl-events]", data.warnings.join(" | "));
        if (data.served === "error") {
          console.error("[cnl-events]", data.error);
          message(container, cfg.errorText, cfg);
          return;
        }
        if (!data.events || !data.events.length) {
          message(container, cfg.emptyText, cfg);
          return;
        }

        var state = { filter: null, q: "" };
        var filters = normalizeFilters(cfg, data.known_tags);

        // A chip that can never match anything looks broken rather than
        // informative, so drop it. As tags get applied in Luma the chips
        // reappear on their own.
        if (cfg.hideEmptyFilters) {
          filters = filters.filter(function (f) {
            return data.events.some(function (event) {
              return matchesFilter(event, f);
            });
          });
        }
        var bar =
          filters.length || cfg.search ? toolbar(cfg, filters, state, draw) : null;

        // The container is the grid, so the toolbar is a full-width grid item
        // rather than a wrapper. Redrawing removes the cards and leaves it in
        // place, which keeps focus and the typed query intact.
        function draw() {
          var kids = [].slice.call(container.children);
          for (var i = 0; i < kids.length; i++) {
            if (kids[i] !== bar) container.removeChild(kids[i]);
          }

          var shown = data.events.filter(function (event) {
            return matchesFilter(event, state.filter) && matchesSearch(event, state.q);
          });

          if (!shown.length) {
            container.appendChild(messageNode(cfg, cfg.noMatchText));
            return;
          }

          var frag = document.createDocumentFragment();
          shown.forEach(function (event) {
            frag.appendChild(card(event));
          });
          container.appendChild(frag);
        }

        container.replaceChildren();
        if (bar) container.appendChild(bar);
        draw();
      })
      .catch(function (err) {
        container.setAttribute("aria-busy", "false");
        console.error("[cnl-events]", err);
        message(container, cfg.errorText, cfg);
      });
  }

  function init() {
    document.querySelectorAll("[data-cnl-events]").forEach(render);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
