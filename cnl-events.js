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
    limit: 0,
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
      limit: parseInt(d.limit || page.limit || DEFAULTS.limit, 10) || 0,
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

    var dateBlock = el("div", "cnl-event__date");
    dateBlock.appendChild(el("span", "cnl-event__month", p.month));
    dateBlock.appendChild(el("span", "cnl-event__day", p.day));
    media.appendChild(dateBlock);

    // --- body ---
    var body = el("div", "cnl-event__body");
    body.appendChild(el("h3", "cnl-event__title", event.name));

    var meta = el("p", "cnl-event__meta");
    meta.appendChild(el("span", null, p.full + DOT + p.time + " " + p.zone));

    var place =
      event.location.type === "online"
        ? "Online"
        : event.location.city_state || event.location.venue;
    var chapter = event.chapters && event.chapters.length ? event.chapters[0] : "";
    // Chapter and place are often the same idea said twice ("Denver" /
    // "Denver, CO"). Show both only when neither contains the other, and
    // prefer the more specific string when one does.
    var where;
    if (chapter && place) {
      var c = chapter.toLowerCase();
      var q = place.toLowerCase();
      if (c.indexOf(q) !== -1 || q.indexOf(c) !== -1) {
        where = chapter.length >= place.length ? chapter : place;
      } else {
        where = chapter + DOT + place;
      }
    } else {
      where = chapter || place;
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
    container.replaceChildren();
    var box = el("div", "cnl-events__message", text);
    if (cfg.calendarUrl) {
      box.appendChild(document.createTextNode(" "));
      var link = el("a", null, "See the full calendar");
      link.href = cfg.calendarUrl;
      link.target = "_blank";
      link.rel = "noopener";
      box.appendChild(link);
    }
    container.appendChild(box);
  }

  function skeleton(container, n) {
    container.replaceChildren();
    for (var i = 0; i < n; i++) container.appendChild(el("div", "cnl-skeleton"));
  }

  function render(container) {
    var cfg = config(container);
    container.classList.add("cnl-events");
    container.setAttribute("aria-busy", "true");
    skeleton(container, Math.min(cfg.limit || 3, 4));

    var url = new URL(cfg.endpoint);
    if (cfg.chapter) url.searchParams.set("chapter", cfg.chapter);
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

        var frag = document.createDocumentFragment();
        data.events.forEach(function (event) {
          frag.appendChild(card(event));
        });
        container.replaceChildren(frag);
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
