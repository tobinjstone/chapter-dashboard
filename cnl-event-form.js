/**
 * CNL event intake form — self-contained embeddable widget.
 *
 * Drop into a page with:
 *   <div data-cnl-event-form></div>
 *   <script>
 *     window.CNL_EVENT_FORM = {
 *       endpoint: "https://cnl-event-intake.YOURSUB.workers.dev",
 *       placesApiKey: "AIza...",        // optional; manual address if absent
 *       turnstileSiteKey: "0x4AAA..."   // optional; no bot check if absent
 *     };
 *   </script>
 *   <script src=".../cnl-event-form.js"></script>
 *
 * Chapter comes from window.CNL_SETTINGS.chapterCode when the page sets it;
 * otherwise a dropdown is built from the Worker's /chapters endpoint.
 * No framework, no build step. All state lives in this closure.
 */
(function () {
  "use strict";

  var cfg = window.CNL_EVENT_FORM || {};
  var endpoint = (cfg.endpoint || "").replace(/\/$/, "");
  var presetChapter =
    ((window.CNL_SETTINGS || {}).chapterCode || "").toUpperCase();

  var root = document.querySelector("[data-cnl-event-form]");
  if (!root) return;
  root.classList.add("cnl-event-form");
  if (!endpoint) {
    root.innerHTML =
      '<p class="cnl-ef-error-banner">Event form is not configured (missing endpoint).</p>';
    return;
  }

  // ---------- state ----------
  var chapters = []; // [{code,name,timezone,lat,lng}]
  var passcodeRequired = false;
  var placesSession = null; // AutocompleteSessionToken, one per interaction
  var placesLib = null; // google.maps.places module once loaded
  var placesLoading = null; // promise while the Maps JS loads
  var selectedPlace = null; // {placeId, venueName, formattedAddress, lat, lng}
  var crop = null; // {img, canvas, box:{x,y,size}, scale, isPng, hasAlpha}
  var submitting = false;

  // Step 2 (announcement email) state — see the email module further down.
  var formEl = null; // the step-1 <form>, kept in the DOM (hidden) during step 2
  var step2Wrap = null; // the email editor container, built on first entry
  var lastCtx = null; // {manualMode, currentFormat} captured when entering step 2
  var emailState = null; // {chapterCode, event, email, P, rolesByTpl, logoChosen, templateId, mobilePreview}
  var brandRows = null; // parsed roster-sheet rows (brand colours, logos, socials)
  var coverPreviewUrl = ""; // 600px JPEG data URL of the crop, preview only
  var tsWidgetId = null; // Turnstile widget id (rendered in step 2)

  // Placeholder URLs baked into the submitted email HTML; the Worker swaps
  // them for the real Luma CDN cover URL (at /submit) and the real lu.ma
  // event URL (at /email-draft, after approval). MUST match the Worker's
  // COVER_SENTINEL / EVENT_URL_SENTINEL.
  var EMAIL_COVER_SENTINEL = "https://images.lumacdn.com/cover-image-pending";
  var EMAIL_EVENT_URL_SENTINEL = "https://lu.ma/event-link-pending";

  // Published roster sheet CSV — brand colours / logos / social links for the
  // email step. Same sheet the Worker reads; override with cfg.sheetCsvUrl.
  var SHEET_CSV_URL = cfg.sheetCsvUrl ||
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ0wq0Bm6gQrgX_Th252L2h9B1GzPQS_SeWg-_JrNi6ynm7CHGcuLw-RjmWC4M5Yg-KMXjvNN0d8ZVe/pub?gid=0&single=true&output=csv";

  // ---------- tiny DOM helpers ----------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      node.appendChild(c);
    });
    return node;
  }

  function field(id, labelText, input, hint) {
    var wrap = el("div", { class: "cnl-ef-field", "data-field": id });
    var label = el("label", { class: "cnl-ef-label", for: "cnl-ef-" + id, text: labelText });
    input.id = "cnl-ef-" + id;
    wrap.appendChild(label);
    if (hint) wrap.appendChild(el("p", { class: "cnl-ef-hint", text: hint }));
    wrap.appendChild(input);
    wrap.appendChild(el("p", { class: "cnl-ef-inline-error", role: "alert", "aria-live": "polite" }));
    return wrap;
  }

  function setError(fieldId, message) {
    var wrap = root.querySelector('[data-field="' + fieldId + '"]');
    if (!wrap) return false;
    wrap.classList.toggle("cnl-ef-has-error", !!message);
    wrap.querySelector(".cnl-ef-inline-error").textContent = message || "";
    return true;
  }

  function clearErrors() {
    root.querySelectorAll(".cnl-ef-has-error").forEach(function (w) {
      w.classList.remove("cnl-ef-has-error");
      w.querySelector(".cnl-ef-inline-error").textContent = "";
    });
    banner("");
  }

  function banner(message) {
    // One banner per step; write both — only the visible step's shows.
    root.querySelectorAll(".cnl-ef-banner").forEach(function (b) {
      b.textContent = message || "";
      b.style.display = message ? "block" : "none";
    });
  }

  function val(name) {
    var input = root.querySelector('[name="' + name + '"]');
    return input ? input.value.trim() : "";
  }

  /**
   * Custom time picker: hour / minute / AM-PM selects, minutes limited to
   * 15-minute stops. Native <input type=time> can't constrain its minute
   * wheel, so we own the control. composeTime() turns the trio back into
   * the "HH:MM" (24h) string the Worker expects.
   */
  function timeField(idPrefix, labelText) {
    var wrap = el("div", { class: "cnl-ef-field", "data-field": idPrefix });
    wrap.appendChild(el("span", { class: "cnl-ef-label", text: labelText }));
    var group = el("div", { class: "cnl-ef-timegroup" });
    var hour = el("select", { name: idPrefix + "_hour", class: "cnl-ef-input", "aria-label": labelText + " hour" });
    hour.appendChild(el("option", { value: "", text: "--" }));
    for (var h = 1; h <= 12; h++) {
      hour.appendChild(el("option", { value: String(h), text: String(h) }));
    }
    var minute = el("select", { name: idPrefix + "_minute", class: "cnl-ef-input", "aria-label": labelText + " minutes" });
    ["00", "15", "30", "45"].forEach(function (m) {
      minute.appendChild(el("option", { value: m, text: ":" + m }));
    });
    var ampm = el("select", { name: idPrefix + "_ampm", class: "cnl-ef-input", "aria-label": labelText + " AM or PM" });
    ampm.appendChild(el("option", { value: "", text: "--" }));
    ampm.appendChild(el("option", { value: "AM", text: "AM" }));
    ampm.appendChild(el("option", { value: "PM", text: "PM" }));
    group.appendChild(hour);
    group.appendChild(minute);
    group.appendChild(ampm);
    wrap.appendChild(group);
    wrap.appendChild(el("p", { class: "cnl-ef-inline-error", role: "alert", "aria-live": "polite" }));
    return wrap;
  }

  /** "HH:MM" in 24h from a timeField trio, or "" if hour/AM-PM unchosen. */
  function composeTime(idPrefix) {
    var h = val(idPrefix + "_hour");
    var ap = val(idPrefix + "_ampm");
    if (!h || !ap) return "";
    var hh = (Number(h) % 12) + (ap === "PM" ? 12 : 0);
    return String(hh).padStart(2, "0") + ":" + (val(idPrefix + "_minute") || "00");
  }

  // ---------- build the form ----------
  function build() {
    var form = el("form", { class: "cnl-ef-form", novalidate: "novalidate" });

    form.appendChild(el("div", { class: "cnl-ef-banner", role: "alert", style: "display:none" }));

    // Honeypot: visually removed via CSS, not type=hidden, so naive bots fill it.
    var honeypot = el("input", {
      type: "text",
      name: "website_url",
      class: "cnl-ef-hp",
      tabindex: "-1",
      autocomplete: "off",
      "aria-hidden": "true",
    });
    form.appendChild(honeypot);

    // Two fixed columns on desktop (see CSS media query): A holds everything
    // through the location/meeting fields, B the rest. They stack on mobile.
    var colA = el("div", { class: "cnl-ef-col" });
    var colB = el("div", { class: "cnl-ef-col" });
    form.appendChild(colA);
    form.appendChild(colB);

    // Chapter
    if (presetChapter && chapters.some(function (c) { return c.code === presetChapter; })) {
      var hidden = el("input", { type: "hidden", name: "chapter_code", value: presetChapter });
      form.appendChild(hidden);
    } else {
      // Searchable combobox: type-to-filter over the 69 chapters. The real
      // value lives in the hidden chapter_code input; the visible input is
      // display only.
      form.appendChild(el("input", { type: "hidden", name: "chapter_code" }));
      var chSearchInput = el("input", {
        type: "text", name: "chapter_search", class: "cnl-ef-input",
        placeholder: "Start typing your chapter…", autocomplete: "off",
        role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list",
      });
      var chField = field("chapter_code", "Chapter", chSearchInput);
      var chSuggBox = el("ul", { class: "cnl-ef-suggestions", role: "listbox", style: "display:none" });
      chField.insertBefore(chSuggBox, chField.querySelector(".cnl-ef-inline-error"));
      colA.appendChild(chField);
    }

    // Submitter
    colA.appendChild(el("h3", { class: "cnl-ef-section", text: "About you" }));
    colA.appendChild(field("submitter_name", "Your name",
      el("input", { type: "text", name: "submitter_name", class: "cnl-ef-input", autocomplete: "name", required: "" })));
    colA.appendChild(field("submitter_email", "Your email",
      el("input", { type: "email", name: "submitter_email", class: "cnl-ef-input", autocomplete: "email", required: "" }),
      "You'll be added as a host and can manage the event in Luma. We strongly recommend submitting from your chapter email address, then adding your personal email as a co-host below so you can still access the event if chapter leadership changes."));

    // Event basics
    colA.appendChild(el("h3", { class: "cnl-ef-section", text: "The event" }));
    colA.appendChild(field("event_name", "Event name",
      el("input", { type: "text", name: "event_name", class: "cnl-ef-input", maxlength: "100", required: "" })));
    colA.appendChild(field("description", "Description",
      el("textarea", { name: "description", class: "cnl-ef-input", rows: "6", required: "" }),
      "This is the public event page text. Plain text; basic Markdown like **bold** works."));

    var today = new Date();
    var minDate = today.getFullYear() + "-" +
      String(today.getMonth() + 1).padStart(2, "0") + "-" +
      String(today.getDate()).padStart(2, "0");
    var dateRow = el("div", { class: "cnl-ef-row" });
    dateRow.appendChild(field("start_date", "Start date",
      el("input", { type: "date", name: "start_date", class: "cnl-ef-input", min: minDate, required: "" })));
    dateRow.appendChild(timeField("start_time", "Start time"));
    colA.appendChild(dateRow);
    var endRow = el("div", { class: "cnl-ef-row" });
    endRow.appendChild(field("end_date", "End date",
      el("input", { type: "date", name: "end_date", class: "cnl-ef-input", min: minDate, required: "" })));
    endRow.appendChild(timeField("end_time", "End time"));
    colA.appendChild(endRow);
    colA.appendChild(el("p", { class: "cnl-ef-hint cnl-ef-tz-hint" }));

    // Format
    var fmtWrap = el("div", { class: "cnl-ef-field", "data-field": "event_format" });
    fmtWrap.appendChild(el("span", { class: "cnl-ef-label", text: "Format" }));
    var fmtGroup = el("div", { class: "cnl-ef-radio-row", role: "radiogroup", "aria-label": "Event format" });
    [["in_person", "In person"], ["online", "Online"], ["hybrid", "Hybrid"]].forEach(function (pair, i) {
      var lab = el("label", { class: "cnl-ef-radio" });
      var radio = el("input", { type: "radio", name: "event_format", value: pair[0] });
      if (i === 0) radio.checked = true;
      lab.appendChild(radio);
      lab.appendChild(document.createTextNode(" " + pair[1]));
      fmtGroup.appendChild(lab);
    });
    fmtWrap.appendChild(fmtGroup);
    fmtWrap.appendChild(el("p", { class: "cnl-ef-inline-error", role: "alert" }));
    colA.appendChild(fmtWrap);

    // Location (in_person / hybrid)
    var locBlock = el("div", { class: "cnl-ef-location" });
    var locInput = el("input", {
      type: "text", name: "location_search", class: "cnl-ef-input",
      placeholder: "Start typing the venue or address…", autocomplete: "off",
      role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list",
    });
    var locField = field("location", "Where is it?", locInput);
    var suggBox = el("ul", { class: "cnl-ef-suggestions", role: "listbox", style: "display:none" });
    locField.insertBefore(suggBox, locField.querySelector(".cnl-ef-inline-error"));
    var picked = el("p", { class: "cnl-ef-picked", style: "display:none" });
    locField.insertBefore(picked, locField.querySelector(".cnl-ef-inline-error"));
    locBlock.appendChild(locField);

    var manualToggle = el("button", { type: "button", class: "cnl-ef-linklike", text: "Can't find it? Enter the address manually" });
    locBlock.appendChild(manualToggle);

    var manualBlock = el("div", { class: "cnl-ef-manual", style: "display:none" });
    manualBlock.appendChild(field("venue_name", "Venue name (optional)",
      el("input", { type: "text", name: "venue_name", class: "cnl-ef-input" })));
    manualBlock.appendChild(field("manual_address", "Street address",
      el("textarea", { name: "manual_address", class: "cnl-ef-input", rows: "2" }),
      "Include city, state, and ZIP."));
    locBlock.appendChild(manualBlock);

    locBlock.appendChild(field("location_note", "Location notes (optional)",
      el("input", { type: "text", name: "location_note", class: "cnl-ef-input", placeholder: "e.g. enter through the side door" })));
    colA.appendChild(locBlock);

    // Meeting URL (online / hybrid)
    var meetBlock = field("meeting_url", "Meeting link",
      el("input", { type: "url", name: "meeting_url", class: "cnl-ef-input", placeholder: "https://…" }));
    colA.appendChild(meetBlock);

    // Event type
    var typeSelect = el("select", { name: "event_type", class: "cnl-ef-input" });
    [["action", "Action"], ["community", "Community"], ["policy", "Policy"], ["social", "Social"]].forEach(function (pair) {
      typeSelect.appendChild(el("option", { value: pair[0], text: pair[1] }));
    });
    colB.appendChild(el("h3", { class: "cnl-ef-section", text: "Details" }));
    colB.appendChild(field("event_type", "Event type", typeSelect));

    colB.appendChild(field("max_capacity", "Max capacity (optional)",
      el("input", { type: "number", name: "max_capacity", class: "cnl-ef-input", min: "1", step: "1" }),
      "Leave blank for no cap."));

    // Cover image + crop
    colB.appendChild(el("h3", { class: "cnl-ef-section", text: "Cover image" }));
    var fileInput = el("input", { type: "file", name: "cover_file", accept: "image/jpeg,image/png", class: "cnl-ef-input cnl-ef-file" });
    colB.appendChild(field("cover_image", "Upload a cover (JPEG or PNG, under 10 MB)",
      fileInput, "Covers are square. Drag the box to choose the crop."));
    var cropWrap = el("div", { class: "cnl-ef-crop", style: "display:none" });
    colB.appendChild(cropWrap);

    // Co-hosts
    colB.appendChild(el("h3", { class: "cnl-ef-section", text: "Hosts" }));
    colB.appendChild(el("p", { class: "cnl-ef-hint", text: "You're the first host. Add up to two more; they'll get a Luma invite once the event is approved." }));
    for (var i = 1; i <= 3; i++) {
      var row = el("div", { class: "cnl-ef-cohost", "data-cohost": String(i) });
      if (i > 1) row.style.display = "none";
      var pair = el("div", { class: "cnl-ef-row" });
      pair.appendChild(field("cohost_" + i + "_name", i === 1 ? "Host name" : "Co-host " + i + " name",
        el("input", { type: "text", name: "cohost_" + i + "_name", class: "cnl-ef-input" })));
      pair.appendChild(field("cohost_" + i + "_email", i === 1 ? "Host email" : "Co-host " + i + " email",
        el("input", { type: "email", name: "cohost_" + i + "_email", class: "cnl-ef-input" })));
      row.appendChild(pair);
      var showLab = el("label", { class: "cnl-ef-check" });
      var showBox = el("input", { type: "checkbox", name: "cohost_" + i + "_show_on_page" });
      showBox.checked = true;
      showLab.appendChild(showBox);
      showLab.appendChild(document.createTextNode(" Show on the public event page"));
      row.appendChild(showLab);
      colB.appendChild(row);
    }
    var addCohost = el("button", { type: "button", class: "cnl-ef-btn-small", text: "+ Add a co-host" });
    colB.appendChild(addCohost);

    // Reviewer notes + passcode
    colB.appendChild(field("reviewer_notes", "Notes for the reviewer (optional)",
      el("textarea", { name: "reviewer_notes", class: "cnl-ef-input", rows: "3" }),
      "Only CNL staff see this. Feel free to add any details such as estimated cost, speakers, etc."));
    if (passcodeRequired) {
      colB.appendChild(field("passcode", "Submission passcode",
        el("input", { type: "password", name: "passcode", class: "cnl-ef-input", autocomplete: "off" }),
        "Provided to chapter leads."));
    }

    // Turnstile renders in step 2 (the email editor), next to the real submit
    // buttons — a token minted here would expire while the email is built.

    var submitBtn = el("button", { type: "submit", class: "cnl-ef-submit", text: "Next: announcement email →" });
    colB.appendChild(submitBtn);
    colB.appendChild(el("p", { class: "cnl-ef-hint", text: "Next you'll build the announcement email (or skip it), then submit. CNL staff review every event before it goes live." }));

    root.innerHTML = "";
    root.appendChild(form);
    formEl = form;

    // ---- wiring ----
    function currentFormat() {
      var checked = form.querySelector('[name="event_format"]:checked');
      return checked ? checked.value : "in_person";
    }
    function refreshFormat() {
      var f = currentFormat();
      locBlock.style.display = f === "online" ? "none" : "";
      meetBlock.style.display = f === "in_person" ? "none" : "";
    }
    form.querySelectorAll('[name="event_format"]').forEach(function (r) {
      r.addEventListener("change", refreshFormat);
    });
    refreshFormat();

    function refreshTzHint() {
      var code = presetChapter || val("chapter_code");
      var ch = chapters.filter(function (c) { return c.code === code; })[0];
      form.querySelector(".cnl-ef-tz-hint").textContent = ch
        ? "Times are in the chapter's local timezone (" + ch.timezone + ")."
        : "";
    }
    var chSearch = form.querySelector('[name="chapter_search"]');
    if (chSearch) {
      var chHidden = form.querySelector('[name="chapter_code"]');
      var chSugg = form.querySelector('[data-field="chapter_code"] .cnl-ef-suggestions');
      var chActive = -1;
      var closeCh = function () {
        chSugg.style.display = "none";
        chSugg.innerHTML = "";
        chActive = -1;
        chSearch.setAttribute("aria-expanded", "false");
      };
      var pickCh = function (c) {
        chHidden.value = c.code;
        chSearch.value = c.name;
        closeCh();
        setError("chapter_code", "");
        refreshTzHint();
      };
      chSearch.addEventListener("input", function () {
        chHidden.value = "";
        refreshTzHint();
        var q = chSearch.value.trim().toLowerCase();
        if (!q) { closeCh(); return; }
        var hits = chapters.filter(function (c) {
          return c.name.toLowerCase().indexOf(q) >= 0 || c.code.toLowerCase() === q;
        }).slice(0, 8);
        chSugg.innerHTML = "";
        if (!hits.length) { closeCh(); return; }
        hits.forEach(function (c, idx) {
          var li = el("li", { class: "cnl-ef-suggestion", role: "option", id: "cnl-ef-ch-" + idx, text: c.name });
          li.addEventListener("mousedown", function (e) {
            e.preventDefault();
            pickCh(c);
          });
          chSugg.appendChild(li);
        });
        chSugg.style.display = "";
        chSearch.setAttribute("aria-expanded", "true");
        chActive = -1;
      });
      chSearch.addEventListener("keydown", function (e) {
        var items = chSugg.querySelectorAll(".cnl-ef-suggestion");
        if (!items.length) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          chActive = e.key === "ArrowDown"
            ? Math.min(chActive + 1, items.length - 1)
            : Math.max(chActive - 1, 0);
          items.forEach(function (li, idx) {
            li.classList.toggle("cnl-ef-active", idx === chActive);
          });
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (chActive >= 0) items[chActive].dispatchEvent(new MouseEvent("mousedown"));
          else if (items.length === 1) items[0].dispatchEvent(new MouseEvent("mousedown"));
        } else if (e.key === "Escape") {
          closeCh();
        }
      });
      chSearch.addEventListener("blur", function () { setTimeout(closeCh, 150); });
    }
    refreshTzHint();

    // End date follows the start date until someone edits it deliberately —
    // most chapter events are single-day.
    var startDateInput = form.querySelector('[name="start_date"]');
    var endDateInput = form.querySelector('[name="end_date"]');
    var endDateTouched = false;
    endDateInput.addEventListener("input", function () { endDateTouched = true; });
    startDateInput.addEventListener("input", function () {
      if (!endDateTouched || !endDateInput.value) endDateInput.value = startDateInput.value;
    });

    // Submitter -> host row 1 prefill (until the host fields are edited)
    var hostNameTouched = false, hostEmailTouched = false;
    var hostName = form.querySelector('[name="cohost_1_name"]');
    var hostEmail = form.querySelector('[name="cohost_1_email"]');
    hostName.addEventListener("input", function () { hostNameTouched = true; });
    hostEmail.addEventListener("input", function () { hostEmailTouched = true; });
    form.querySelector('[name="submitter_name"]').addEventListener("input", function (e) {
      if (!hostNameTouched) hostName.value = e.target.value;
    });
    form.querySelector('[name="submitter_email"]').addEventListener("input", function (e) {
      if (!hostEmailTouched) hostEmail.value = e.target.value;
    });

    addCohost.addEventListener("click", function () {
      var hiddenRow = form.querySelector('.cnl-ef-cohost[style*="none"]');
      if (hiddenRow) hiddenRow.style.display = "";
      if (!form.querySelector('.cnl-ef-cohost[style*="none"]')) addCohost.style.display = "none";
    });

    // Manual address toggle
    var manualMode = !cfg.placesApiKey; // no key -> manual is the only mode
    function refreshManual() {
      manualBlock.style.display = manualMode ? "" : "none";
      locField.style.display = manualMode ? "none" : "";
      manualToggle.textContent = manualMode
        ? "Search for the venue instead"
        : "Can't find it? Enter the address manually";
      if (!cfg.placesApiKey) manualToggle.style.display = "none";
    }
    manualToggle.addEventListener("click", function () {
      manualMode = !manualMode;
      refreshManual();
    });
    refreshManual();

    wirePlaces(locInput, suggBox, picked);
    wireCrop(fileInput, cropWrap);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearErrors();
      var ctx = { manualMode: manualMode, currentFormat: currentFormat };
      var errors = clientValidate(ctx);
      if (Object.keys(errors).length) {
        renderErrors(errors);
        return;
      }
      enterEmailStep(ctx);
    });
  }

  // ---------- Google Places Autocomplete (New), lazy-loaded ----------
  function loadPlaces() {
    if (placesLib) return Promise.resolve(placesLib);
    if (placesLoading) return placesLoading;
    placesLoading = new Promise(function (resolve, reject) {
      var cb = "__cnlEfMaps" + Math.floor(Math.random() * 1e9);
      window[cb] = function () {
        delete window[cb];
        window.google.maps.importLibrary("places").then(function (lib) {
          placesLib = lib;
          resolve(lib);
        }, reject);
      };
      var s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?key=" +
        encodeURIComponent(cfg.placesApiKey) + "&loading=async&v=weekly&callback=" + cb;
      s.async = true;
      s.onerror = function () { reject(new Error("Maps JS failed to load")); };
      document.head.appendChild(s);
    });
    return placesLoading;
  }

  function wirePlaces(input, suggBox, picked) {
    if (!cfg.placesApiKey) return;
    var debounce = null;
    var activeIndex = -1;

    function closeSuggestions() {
      suggBox.style.display = "none";
      suggBox.innerHTML = "";
      input.setAttribute("aria-expanded", "false");
      activeIndex = -1;
    }

    function choose(suggestion) {
      closeSuggestions();
      var prediction = suggestion.placePrediction;
      var place = prediction.toPlace();
      place
        .fetchFields({ fields: ["id", "displayName", "formattedAddress", "location"] })
        .then(function () {
          selectedPlace = {
            placeId: place.id,
            venueName: place.displayName || "",
            formattedAddress: place.formattedAddress || "",
            lat: place.location ? place.location.lat() : null,
            lng: place.location ? place.location.lng() : null,
          };
          placesSession = null; // session ends at selection
          input.value = "";
          picked.style.display = "";
          picked.innerHTML = "";
          picked.appendChild(el("strong", { text: selectedPlace.venueName }));
          picked.appendChild(document.createTextNode(" — " + selectedPlace.formattedAddress + " "));
          var change = el("button", { type: "button", class: "cnl-ef-linklike", text: "change" });
          change.addEventListener("click", function () {
            selectedPlace = null;
            picked.style.display = "none";
            input.focus();
          });
          picked.appendChild(change);
          setError("location", "");
        })
        .catch(function () {
          setError("location", "Couldn't load that place — try again or enter it manually.");
        });
    }

    input.addEventListener("focus", function () {
      loadPlaces().catch(function () {
        setError("location", "Location search is unavailable — enter the address manually.");
      });
    });

    input.addEventListener("input", function () {
      var text = input.value.trim();
      clearTimeout(debounce);
      if (text.length < 3) { closeSuggestions(); return; }
      debounce = setTimeout(function () {
        loadPlaces().then(function (lib) {
          if (!placesSession) placesSession = new lib.AutocompleteSessionToken();
          var reqBody = { input: text, sessionToken: placesSession };
          lib.AutocompleteSuggestion.fetchAutocompleteSuggestions(reqBody).then(function (res) {
            var suggestions = res.suggestions || [];
            suggBox.innerHTML = "";
            if (!suggestions.length) { closeSuggestions(); return; }
            suggestions.slice(0, 5).forEach(function (s, idx) {
              var li = el("li", {
                class: "cnl-ef-suggestion", role: "option", id: "cnl-ef-sugg-" + idx,
                text: s.placePrediction.text.toString(),
              });
              li.addEventListener("mousedown", function (e) {
                e.preventDefault(); // beat the input blur
                choose(s);
              });
              suggBox.appendChild(li);
            });
            suggBox.style.display = "";
            input.setAttribute("aria-expanded", "true");
          }).catch(function () { closeSuggestions(); });
        }).catch(function () { /* focus handler already surfaced it */ });
      }, 250);
    });

    input.addEventListener("keydown", function (e) {
      var items = suggBox.querySelectorAll(".cnl-ef-suggestion");
      if (!items.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = e.key === "ArrowDown"
          ? Math.min(activeIndex + 1, items.length - 1)
          : Math.max(activeIndex - 1, 0);
        items.forEach(function (li, idx) {
          li.classList.toggle("cnl-ef-active", idx === activeIndex);
        });
        input.setAttribute("aria-activedescendant", "cnl-ef-sugg-" + activeIndex);
      } else if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault();
        items[activeIndex].dispatchEvent(new MouseEvent("mousedown"));
      } else if (e.key === "Escape") {
        closeSuggestions();
      }
    });

    input.addEventListener("blur", function () {
      setTimeout(closeSuggestions, 150);
    });
  }

  // ---------- square crop (pan only) ----------
  function wireCrop(fileInput, cropWrap) {
    fileInput.addEventListener("change", function () {
      crop = null;
      cropWrap.style.display = "none";
      cropWrap.innerHTML = "";
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.type !== "image/jpeg" && file.type !== "image/png") {
        setError("cover_image", "Use a JPEG or PNG image."); fileInput.value = ""; return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError("cover_image", "That file is over 10 MB — resize it first."); fileInput.value = ""; return;
      }
      setError("cover_image", "");
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        buildCropUi(img, file.type === "image/png", cropWrap);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        setError("cover_image", "Couldn't read that image file.");
      };
      img.src = url;
    });
  }

  function buildCropUi(img, isPng, cropWrap) {
    var maxW = Math.min(root.clientWidth - 20, 440);
    var scale = Math.min(maxW / img.naturalWidth, 320 / img.naturalHeight, 1);
    var dispW = Math.round(img.naturalWidth * scale);
    var dispH = Math.round(img.naturalHeight * scale);
    var boxSize = Math.min(dispW, dispH);
    var box = { x: Math.round((dispW - boxSize) / 2), y: Math.round((dispH - boxSize) / 2), size: boxSize };

    var canvas = el("canvas", { class: "cnl-ef-crop-canvas" });
    canvas.width = dispW; canvas.height = dispH;
    canvas.style.touchAction = "none";
    cropWrap.appendChild(canvas);
    cropWrap.appendChild(el("p", { class: "cnl-ef-hint", text: "Drag to position the square crop." }));
    cropWrap.style.display = "";
    crop = { img: img, box: box, scale: scale, isPng: isPng, canvas: canvas };

    var ctx = canvas.getContext("2d");
    function draw() {
      ctx.drawImage(img, 0, 0, dispW, dispH);
      ctx.fillStyle = "rgba(44,54,89,0.55)";
      ctx.fillRect(0, 0, dispW, box.y);
      ctx.fillRect(0, box.y + box.size, dispW, dispH - box.y - box.size);
      ctx.fillRect(0, box.y, box.x, box.size);
      ctx.fillRect(box.x + box.size, box.y, dispW - box.x - box.size, box.size);
      ctx.strokeStyle = "#9F3C39";
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x + 1, box.y + 1, box.size - 2, box.size - 2);
    }
    draw();

    var dragging = null;
    canvas.addEventListener("pointerdown", function (e) {
      canvas.setPointerCapture(e.pointerId);
      dragging = { startX: e.offsetX - box.x, startY: e.offsetY - box.y };
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      box.x = Math.max(0, Math.min(dispW - box.size, e.offsetX - dragging.startX));
      box.y = Math.max(0, Math.min(dispH - box.size, e.offsetY - dragging.startY));
      draw();
    });
    canvas.addEventListener("pointerup", function () { dragging = null; });
  }

  /** Export the cropped square at 1200x1200. Resolves {blob, type}. */
  function exportCrop() {
    return new Promise(function (resolve, reject) {
      if (!crop) { reject(new Error("no-crop")); return; }
      var out = document.createElement("canvas");
      out.width = 1200; out.height = 1200;
      var ctx = out.getContext("2d");
      var srcX = crop.box.x / crop.scale;
      var srcY = crop.box.y / crop.scale;
      var srcSize = crop.box.size / crop.scale;
      ctx.drawImage(crop.img, srcX, srcY, srcSize, srcSize, 0, 0, 1200, 1200);

      var type = "image/jpeg";
      if (crop.isPng) {
        // Keep PNG only when transparency would actually be lost.
        var sample = ctx.getImageData(0, 0, 1200, 1200).data;
        for (var i = 3; i < sample.length; i += 4 * 997) {
          if (sample[i] < 255) { type = "image/png"; break; }
        }
      }
      out.toBlob(function (blob) {
        if (blob) resolve({ blob: blob, type: type });
        else reject(new Error("export-failed"));
      }, type, 0.9);
    });
  }

  // ---------- Turnstile (rendered in the step-2 actions area) ----------
  function renderTurnstile(slot) {
    if (!cfg.turnstileSiteKey) return;
    function doRender() {
      tsWidgetId = window.turnstile.render(slot, { sitekey: cfg.turnstileSiteKey });
    }
    if (window.turnstile) {
      // Re-entering step 2: the widget survives in the kept DOM — refresh its
      // token rather than rendering a duplicate.
      if (tsWidgetId !== null && slot.childNodes.length) window.turnstile.reset(tsWidgetId);
      else doRender();
      return;
    }
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__cnlEfTs";
    s.async = true;
    window.__cnlEfTs = doRender;
    document.head.appendChild(s);
  }

  // ---------- client-side validation (UX pass; the Worker re-checks all of it) ----------
  function clientValidate(ctx) {
    var errors = {};
    if (!presetChapter && !val("chapter_code")) errors.chapter_code = "Start typing and pick your chapter from the list.";
    if (!val("submitter_name")) errors.submitter_name = "Your name is required.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val("submitter_email"))) errors.submitter_email = "Enter a valid email.";
    var name = val("event_name");
    if (name.length < 3 || name.length > 100) errors.event_name = "Event name must be 3–100 characters.";
    if (!val("description")) errors.description = "A description is required.";
    var startTime = composeTime("start_time");
    var endTime = composeTime("end_time");
    if (!val("start_date")) errors.start_date = "A start date is required.";
    if (!startTime) errors.start_time = "Pick an hour and AM/PM.";
    if (!val("end_date")) errors.end_date = "An end date is required.";
    if (!endTime) errors.end_time = "Pick an hour and AM/PM.";
    if (val("start_date") && val("end_date") && startTime && endTime) {
      var s = val("start_date") + "T" + startTime;
      var e = val("end_date") + "T" + endTime;
      if (e <= s) errors.end_date = "The event must end after it starts.";
    }
    var fmt = ctx.currentFormat();
    if (fmt !== "online") {
      if (ctx.manualMode) {
        if (!val("manual_address")) errors.manual_address = "Enter the venue's address.";
      } else if (!selectedPlace) {
        errors.location = "Pick a location from the suggestions (or enter it manually).";
      }
    }
    if (fmt !== "in_person" && !/^https?:\/\//.test(val("meeting_url"))) {
      errors.meeting_url = "A meeting link is required for online events.";
    }
    if (!crop) errors.cover_image = "A cover image is required.";
    for (var i = 2; i <= 3; i++) {
      if ((val("cohost_" + i + "_name") || val("cohost_" + i + "_email")) &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val("cohost_" + i + "_email"))) {
        errors["cohost_" + i + "_email"] = "Co-host email is missing or invalid.";
      }
    }
    if (passcodeRequired && !val("passcode")) errors.passcode = "The passcode is required.";
    return errors;
  }

  // ---------- submit (called from the step-2 buttons) ----------
  function submit(form, submitBtn, ctx, includeEmail) {
    if (submitting) return;
    clearErrors();
    var errors = clientValidate(ctx);
    if (Object.keys(errors).length) {
      renderErrors(errors);
      return;
    }

    submitting = true;
    var btnLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    form.classList.add("cnl-ef-busy");

    exportCrop()
      .then(function (cropped) {
        var fd = new FormData();
        var fmt = ctx.currentFormat();
        fd.append("chapter_code", presetChapter || val("chapter_code"));
        ["submitter_name", "submitter_email", "event_name", "description",
          "start_date", "end_date",
          "location_note", "meeting_url", "max_capacity", "reviewer_notes",
          "passcode", "website_url"].forEach(function (n) {
            fd.append(n, val(n));
          });
        fd.append("start_time", composeTime("start_time"));
        fd.append("end_time", composeTime("end_time"));
        fd.append("event_format", fmt);
        fd.append("event_type", val("event_type"));
        if (fmt !== "online") {
          if (ctx.manualMode) {
            fd.append("address_source", "manual");
            fd.append("place_id", "");
            fd.append("venue_name", val("venue_name"));
            fd.append("formatted_address", val("manual_address"));
            fd.append("latitude", "");
            fd.append("longitude", "");
          } else {
            fd.append("address_source", "google");
            fd.append("place_id", selectedPlace.placeId);
            fd.append("venue_name", selectedPlace.venueName);
            fd.append("formatted_address", selectedPlace.formattedAddress);
            fd.append("latitude", selectedPlace.lat === null ? "" : String(selectedPlace.lat));
            fd.append("longitude", selectedPlace.lng === null ? "" : String(selectedPlace.lng));
          }
        } else {
          fd.append("address_source", "");
        }
        for (var i = 1; i <= 3; i++) {
          fd.append("cohost_" + i + "_name", val("cohost_" + i + "_name"));
          fd.append("cohost_" + i + "_email", val("cohost_" + i + "_email"));
          var box = form.querySelector('[name="cohost_' + i + '_show_on_page"]');
          fd.append("cohost_" + i + "_show_on_page", box && box.checked ? "true" : "false");
        }
        var ext = cropped.type === "image/png" ? "png" : "jpg";
        fd.append("cover_image", cropped.blob, "cover." + ext);

        // Announcement email — every key always present (Zapier field-mapping
        // contract), empty when the submitter skipped the email.
        var withEmail = includeEmail && emailState;
        fd.append("email_enabled", withEmail ? "true" : "false");
        fd.append("email_template", withEmail ? emailState.templateId : "");
        fd.append("email_subject", withEmail ? emailState.email.subject : "");
        fd.append("email_preheader", withEmail ? emailState.email.preheader : "");
        fd.append("email_body_html", withEmail ? renderEmailBody(true) : "");
        fd.append("email_canvas", withEmail ? emailState.canvas : "");

        // The Turnstile widget lives in step 2, outside the <form>.
        var ts = root.querySelector('[name="cf-turnstile-response"]');
        if (ts) fd.append("cf-turnstile-response", ts.value);
        return fetch(endpoint + "/submit", { method: "POST", body: fd });
      })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.body.ok) {
          showSuccess(includeEmail);
          return;
        }
        if (r.body && r.body.errors) {
          renderErrors(r.body.errors);
        } else {
          banner((r.body && r.body.message) || "Something went wrong — please try again.");
        }
        resetSubmitState(form, submitBtn, btnLabel);
      })
      .catch(function () {
        banner("Couldn't reach the server — check your connection and try again.");
        resetSubmitState(form, submitBtn, btnLabel);
      });
  }

  function resetSubmitState(form, submitBtn, btnLabel) {
    submitting = false;
    submitBtn.disabled = false;
    submitBtn.textContent = btnLabel;
    form.classList.remove("cnl-ef-busy");
    if (window.turnstile && tsWidgetId !== null) window.turnstile.reset(tsWidgetId);
  }

  function renderErrors(errors) {
    // Server errors can land while step 2 is showing; form-field errors mean
    // going back to step 1 so the submitter can see and fix them.
    var keys = Object.keys(errors);
    var hasFormError = keys.some(function (k) { return k.indexOf("email_") !== 0; });
    if (hasFormError && step2Wrap && step2Wrap.style.display !== "none") showStep(1);
    var firstField = null;
    var unplaced = [];
    keys.forEach(function (key) {
      var mapped = key === "manual_address" ? "manual_address" : key;
      if (setError(mapped, errors[key])) {
        if (!firstField) firstField = mapped;
      } else {
        unplaced.push(errors[key]);
      }
    });
    if (unplaced.length) banner(unplaced.join(" "));
    var target = firstField && root.querySelector('[data-field="' + firstField + '"]');
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function showSuccess(includeEmail) {
    root.innerHTML = "";
    step2Wrap = null;
    var panel = el("div", { class: "cnl-ef-success", role: "status" });
    panel.appendChild(el("h3", { text: "Submitted!" }));
    panel.appendChild(el("p", {
      text: "Your event is with CNL staff for review. Once it's approved it will " +
        "appear on the Luma calendar and you'll get a host invite at the email you provided." +
        (includeEmail
          ? " Your announcement email will land as a draft in your chapter's Action Network " +
            "account, with the RSVP button linked to the new event — review it there, send " +
            "yourself a test, and send it to your list."
          : ""),
    }));
    root.appendChild(panel);
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* =====================================================================
     STEP 2 — announcement email
     Ported from the tools-site "event + email trial" (event-email-trial),
     now wired to the real pipeline: the rendered body HTML is submitted
     with the event; the Worker swaps the cover placeholder for the Luma
     CDN URL at /submit and the RSVP-link placeholder for the real lu.ma
     URL after approval (/email-draft), then files the email as a draft in
     the chapter's Action Network group.
     ===================================================================== */

  function showStep(n) {
    if (n === 1) {
      if (step2Wrap) step2Wrap.style.display = "none";
      formEl.style.display = "";
    } else {
      formEl.style.display = "none";
      if (step2Wrap) step2Wrap.style.display = "";
    }
    var top = root.getBoundingClientRect().top + window.pageYOffset - 16;
    window.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
  }

  // ---------- roster-sheet brand data (colours, logos, socials) ----------
  function parseSheetCsv(text) {
    var rows = [], row = [], cell = "", i = 0, q = false;
    text = text.replace(/^﻿/, "");
    while (i < text.length) {
      var ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        cell += ch; i++; continue;
      }
      if (ch === '"') { q = true; i++; continue; }
      if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
      cell += ch; i++;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function brandRowsFromCsv(text) {
    var rows = parseSheetCsv(text);
    var head = rows.shift().map(function (h) { return h.trim(); });
    var idx = {};
    head.forEach(function (h, i) { idx[h] = i; });
    function get(r, k) { var i = idx[k]; return i == null ? "" : (r[i] || "").trim(); }
    function color(r, k) { var v = get(r, k); return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : ""; }
    // "name:url;name:url" (or bare urls) -> [{name, url}]
    function variants(s) {
      return s.split(";").map(function (p) {
        p = p.trim(); if (!p) return null;
        var m = /^([a-z0-9_-]+):(https?:\/\/.+)$/i.exec(p);
        if (m) return { name: m[1], url: m[2] };
        return /^https?:\/\//.test(p) ? { name: "", url: p } : null;
      }).filter(Boolean);
    }
    return rows.filter(function (r) { return get(r, "ChapterCode"); }).map(function (r) {
      return {
        code: get(r, "ChapterCode").toUpperCase(),
        name: get(r, "ChapterName"),
        website: get(r, "Website"), email: get(r, "Email"),
        twitter: get(r, "Twitter"), instagram: get(r, "Instagram"), bluesky: get(r, "BlueSky"),
        discord: get(r, "Discord"), slack: get(r, "Slack"), everyaction: get(r, "EveryAction Link"),
        facebook: get(r, "Facebook"), whatsapp: get(r, "WhatsApp"), groupme: get(r, "GroupMe"),
        logoSquare: get(r, "SquareLogo"), logoIcon: get(r, "LogoIcon"),
        logoPrimary: get(r, "LogoPrimary"), logoTransparent: get(r, "LogoTransparent"),
        logoVariants: variants(get(r, "LogoVariants")),
        banner: get(r, "Banner"), bannerTransparent: get(r, "BannerTransparent"),
        bannerVariants: variants(get(r, "BannerVariants")),
        colors: {
          background: color(r, "ColorBackground"), primary: color(r, "ColorPrimary"),
          secondary: color(r, "ColorSecondary"), accent: color(r, "ColorAccent"),
          text: color(r, "ColorText"), textOnLight: color(r, "ColorTextOnLight"),
          light: color(r, "ColorLight"),
          extra: get(r, "ColorExtra").split(";").map(function (s) { return s.trim().toLowerCase(); })
            .filter(function (s) { return /^#[0-9a-f]{6}$/.test(s); })
        }
      };
    });
  }

  function loadBrandRows() {
    if (brandRows) return Promise.resolve(brandRows);
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctl && setTimeout(function () { ctl.abort(); }, 20000);
    return fetch(SHEET_CSV_URL, ctl ? { signal: ctl.signal } : {})
      .then(function (r) {
        if (!r.ok) throw new Error("sheet " + r.status);
        return r.text();
      })
      .then(function (text) {
        if (!/ChapterCode/.test(text.slice(0, 2000))) throw new Error("not the roster CSV");
        brandRows = brandRowsFromCsv(text);
        return brandRows;
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function emptyBrand(code) {
    var listed = chapters.filter(function (c) { return c.code === code; })[0];
    return {
      code: code, name: listed ? listed.name : code,
      website: "", email: "", twitter: "", instagram: "", bluesky: "", discord: "",
      slack: "", everyaction: "", facebook: "", whatsapp: "", groupme: "",
      logoSquare: "", logoIcon: "", logoPrimary: "", logoTransparent: "", logoVariants: [],
      banner: "", bannerTransparent: "", bannerVariants: [],
      colors: { background: "", primary: "", secondary: "", accent: "", text: "", textOnLight: "", light: "", extra: [] }
    };
  }

  // ---------- colour maths ----------
  function hexToRgb(h) { var n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function rgbToHex(r) { return "#" + r.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? "0" : "") + v.toString(16); }).join(""); }
  function lum(h) {
    var c = hexToRgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrastRatio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function mixColor(h, target, t) { var a = hexToRgb(h), b = hexToRgb(target); return rgbToHex(a.map(function (v, i) { return v + (b[i] - v) * t; })); }
  function darkenColor(h, t) { return mixColor(h, "#000000", t); }
  function onColor(bg, prefer) {
    // Prefer the chapter's own text colour if it reads on bg (the poster type
    // is large and bold, so 2.5:1 is enough), else white unless the block is
    // genuinely pale.
    if (prefer && contrastRatio(prefer, bg) >= 2.5) return prefer;
    return contrastRatio("#ffffff", bg) >= 2.2 ? "#ffffff" : "#1a1a1a";
  }

  /* The chapter's base palette from its sheet row. Templates map this onto
     their own roles in defaultRoles(P). */
  function basePalette(ch) {
    var c = ch.colors;
    var primary = c.primary || c.background || "#2c3659";
    if (lum(primary) > 0.6 && c.secondary) primary = c.secondary;
    var dark = [c.secondary, c.textOnLight, c.primary, c.accent].filter(function (h) { return h && lum(h) < 0.12; })
      .sort(function (a, b) { return lum(a) - lum(b); })[0] ||
      (lum(primary) < 0.15 ? primary : darkenColor(primary, 0.55));
    var light = (c.light && lum(c.light) < 0.85) ? c.light : mixColor(primary, "#ffffff", 0.6);
    var pal = [];
    ["primary", "secondary", "accent", "background", "text", "textOnLight", "light"].forEach(function (k) { if (c[k]) pal.push(c[k]); });
    c.extra.forEach(function (h) { pal.push(h); });
    pal.push("#ffffff", "#1a1a1a");
    return {
      primary: primary, secondary: c.secondary || "", accent: c.accent || "", light: light,
      text: c.text || "", dark: dark,
      palette: pal.filter(function (h, i) { return pal.indexOf(h) === i; }),
      mix: mixColor, on: onColor, contrast: contrastRatio
    };
  }

  /* Header artwork choices from the sheet row. mode 'banner' = one wide image
     (wordmark included); 'square' = square/icon image + typed chapter name;
     'text' = typed name only. */
  function logoOptions(ch) {
    var out = [];
    function add(id, label, url, mode) { if (url && !out.some(function (o) { return o.url === url; })) out.push({ id: id, label: label, url: url, mode: mode }); }
    add("banner-transparent", "Banner · transparent", ch.bannerTransparent, "banner");
    ch.bannerVariants.forEach(function (v, i) { add("banner-v" + i, "Banner · " + (v.name || "variant " + (i + 1)).replace(/-/g, " "), v.url, "banner"); });
    add("banner", "Banner · solid", ch.banner, "banner");
    add("square", "Square logo + wordmark", ch.logoSquare, "square");
    add("icon", "Icon + wordmark", ch.logoIcon, "square");
    add("logo-transparent", "Logo (transparent) + wordmark", ch.logoTransparent, "square");
    add("logo", "Logo + wordmark", ch.logoPrimary, "square");
    ch.logoVariants.forEach(function (v, i) { add("logo-v" + i, "Logo · " + (v.name || "variant " + (i + 1)).replace(/-/g, " ") + " + wordmark", v.url, "square"); });
    out.push({ id: "text", label: "Wordmark only (no image)", url: "", mode: "text" });
    return out;
  }

  /* Footer links from the sheet's contact columns, in display order. */
  function socialOptions(ch) {
    var defs = [
      ["website", "Website", ch.website], ["twitter", "Twitter/X", ch.twitter], ["instagram", "Instagram", ch.instagram],
      ["bluesky", "Bluesky", ch.bluesky], ["facebook", "Facebook", ch.facebook], ["discord", "Discord", ch.discord],
      ["slack", "Slack", ch.slack], ["whatsapp", "WhatsApp", ch.whatsapp], ["groupme", "GroupMe", ch.groupme],
      ["email", "Email us", ch.email ? "mailto:" + ch.email : ""]
    ];
    return defs.filter(function (d) { return d[2]; }).map(function (d) { return { key: d[0], label: d[1], url: d[2], on: true }; });
  }

  /* ---------- email templates (the three official CNL event designs) ----------
     Each is { id, name, blurb, paper, logoPref, roles, defaultRoles(P), render(d) }.
     render(d) emits an HTML BODY FRAGMENT only — Action Network wraps mass
     emails in its own boilerplate and appends the mandatory unsubscribe
     footer, so no <html>/<head>/<body> and no unsubscribe link here.
     Every user-supplied string is escaped — never trust d to be safe. */
  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function nl2br(s) { return escHtml(s).replace(/\n/g, "<br>"); }
  function safeUrl(u) {
    u = String(u || "").trim();
    return /^https?:\/\//i.test(u) || /^mailto:/i.test(u) ? escHtml(u) : "#";
  }
  function emailParagraphs(s) {
    var ps = String(s || "").split(/\n\s*\n/).filter(function (p) { return p.trim(); });
    return ps.map(function (p, i) {
      return '<p style="margin: 0px 0px ' + (i === ps.length - 1 ? "0" : "14") + 'px 0px;">' + nl2br(p.trim()) + "</p>";
    }).join("\n");
  }
  function socialLinksHtml(socials, style) {
    return (socials || []).map(function (s) {
      return '<a target="_blank" href="' + safeUrl(s.url) + '" style="' + style + '">' + escHtml(s.label) + "</a>";
    }).join(" &middot; ");
  }
  /* Standard CNL org footer — identical in every email; only the chapter
     name changes. (No unsubscribe link: Action Network appends its own.) */
  function orgFooter(ch, linkColor) {
    return escHtml(ch.name) + ' is a chapter of the <a href="https://cnliberalism.org" target="_blank" style="color: ' + linkColor + '; text-decoration: underline;">Center for New Liberalism</a>, a project of New Democracy.<br>\n' +
      "Paid for by New Democracy<br>\n" +
      "1919 M St NW, Suite 300, Washington, DC 20036";
  }
  /* Fixed "between events" membership ask — the same in every template. */
  function membershipCopy(ch, linkStyle) {
    return "Like what " + escHtml(ch.name) + ' is doing? <a href="https://cnliberalism.org/join" target="_blank" style="' + linkStyle + '">Become a member of the Center for New Liberalism</a> &mdash; dues start at $5 a month and keep chapters like ours running.';
  }
  function preheaderDiv(d) { return '<div style="display: none; max-height: 0px; overflow: hidden;">' + escHtml(d.preheader) + "</div>\n"; }
  var MSO_OPEN = '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->\n';
  var MSO_CLOSE = "<!--[if mso]></td></tr></table><![endif]-->\n";
  /* The canvas behind the 600px card comes from an Action Network WRAPPER
     ("CNL Canvas - …", one per color in every group; the Worker attaches the
     picked one to the draft via the API). The body itself stays transparent
     so nothing double-paints; the picker's key is submitted as email_canvas
     and drives the preview color. */
  var CANVAS_DEFAULT_KEY = "navy";
  var CANVAS_OPTIONS = [
    ["navy", "Navy tint", "#E6E8EF"],
    ["greige", "Warm greige", "#EAE7E0"],
    ["cool", "Cool grey", "#EDF1F2"],
    ["putty", "Deep putty", "#E0DCD2"],
    ["white", "White", "#FFFFFF"]
  ];
  function canvasHex(key) {
    var hit = CANVAS_OPTIONS.filter(function (c) { return c[0] === key; })[0];
    return (hit || CANVAS_OPTIONS[0])[2];
  }
  function outerOpen() {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n<tr><td align="center" style="padding: 0;">\n' + MSO_OPEN;
  }
  function outerClose() { return MSO_CLOSE + "</td></tr>\n</table>\n"; }
  function coverRowHtml(d, tdStyle) {
    if (!(d.includeCover && d.coverSrc)) return "";
    return '<tr><td class="mob-pad" style="' + tdStyle + '"><img src="' + d.coverSrc + '" width="528" alt="" style="display: block; width: 100%; max-width: 528px; height: auto; border-radius: 6px;"></td></tr>\n';
  }

  var F_IMPACT = "Impact, Haettenschweiler, 'Arial Black', 'Trebuchet MS', Arial, sans-serif";
  var F_TREB = "'Trebuchet MS', Tahoma, Verdana, Arial, sans-serif";
  var F_HELV = "Helvetica, Arial, sans-serif";
  var F_GEORGIA = "Georgia, 'Times New Roman', Times, serif";

  function logoLink(ch, inner) {
    var url = ch.website || "https://cnliberalism.org";
    return '<a href="' + safeUrl(url) + '" target="_blank" style="text-decoration: none;">' + inner + "</a>";
  }

  function logoAndName(d, opts) {
    var ch = d.chapter, logo = d.logo || { mode: "text" };
    var words = ch.name.toUpperCase().split(/\s+/);
    var nameHtml = (opts.breakName && words.length > 2) ? escHtml(words.slice(0, -2).join(" ")) + "<br>" + escHtml(words.slice(-2).join(" ")) : escHtml(words.join(" "));
    var imgCell = (logo.mode === "square" && logo.url)
      ? '<td width="56" valign="middle">' + logoLink(ch, '<img src="' + escHtml(logo.url) + '" width="52" height="52" alt="' + escHtml(ch.name) + ' logo" style="display: block; width: 52px; height: 52px;">') + "</td>\n"
      : "";
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n<tr>\n' + imgCell +
      '<td valign="middle" style="padding-left: ' + (imgCell ? "12" : "0") + "px; font-family: " + opts.font + "; font-size: 16px; font-weight: " + (opts.weight || "normal") + "; letter-spacing: " + (opts.tracking || "2.5px") + ';">' + logoLink(ch, '<span style="color: ' + opts.color + ';">' + nameHtml + "</span>") + "</td>\n</tr>\n</table>";
  }

  var EMAIL_TEMPLATES = [
    /* ---- 1a · Gig poster ---- */
    {
      id: "gig-poster", name: "1a · Gig poster", paper: "dark",
      blurb: "Big all-caps headline on a solid brand block, white RSVP button, darker band for the copy.",
      logoPref: ["banner-transparent", "banner-darktext", "banner", "square"],
      roles: [["bg", "Header"], ["band", "Body"], ["between", "Between-events band"], ["footer", "Footer"], ["ink", "Header text"], ["inkSoft", "Soft text"], ["cta", "Button text"], ["footerInk", "Footer links"], ["muted", "Footer text"]],
      defaultRoles: function (P) {
        var bg = P.primary;
        var footer = (P.secondary && P.secondary !== bg) ? P.secondary : P.mix(bg, "#000000", 0.55);
        var ink = P.on(bg, P.text);
        var inkSoft = (P.light && P.light !== ink && P.contrast(P.light, bg) >= 2.5) ? P.light : P.mix(ink, bg, 0.18);
        var footerInk = P.on(footer);
        return { bg: bg, band: "#FFFFFF", between: P.mix(bg, "#ffffff", 0.85), footer: footer, ink: ink, inkSoft: inkSoft, cta: P.contrast(bg, "#ffffff") >= 2.5 ? bg : P.mix(bg, "#000000", 0.28), footerInk: footerInk, muted: P.mix(footerInk, footer, 0.35) };
      },
      render: function (d) {
        var c = d.colors, ch = d.chapter, logo = d.logo || { mode: "text" };
        var h = preheaderDiv(d) +
          "<style data-roadie-ignore>\n@media only screen and (max-width: 480px) {\n  .mob-pad { padding-left: 22px !important; padding-right: 22px !important; }\n  .mob-h1 { font-size: 46px !important; line-height: 48px !important; }\n  .mob-h2 { font-size: 20px !important; line-height: 26px !important; }\n}\n</style>\n" +
          outerOpen() +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px;">\n';
        var bg = 'bgcolor="' + c.bg + '" class="mob-pad" style="background-color: ' + c.bg + "; ";
        var art = (logo.mode === "banner" && logo.url)
          ? logoLink(ch, '<img src="' + escHtml(logo.url) + '" width="220" alt="' + escHtml(ch.name) + '" style="display: block; width: 220px; max-width: 100%; height: auto; border: 0;">')
          : logoAndName(d, { font: F_IMPACT, color: c.ink, breakName: true });
        h += "<tr><td " + bg + 'padding: 24px 36px 0px 36px;">\n' + art + "\n</td></tr>\n";
        h += "<tr><td " + bg + "padding: 40px 36px 0px 36px; font-family: " + F_IMPACT + "; font-size: 14px; font-weight: normal; letter-spacing: 3px; color: " + c.inkSoft + ';">' + escHtml(d.kicker.toUpperCase()) + "</td></tr>\n";
        h += '<tr><td bgcolor="' + c.bg + '" class="mob-pad mob-h1" style="background-color: ' + c.bg + "; padding: 10px 36px 28px 36px; font-family: " + F_IMPACT + "; font-size: 64px; font-weight: normal; letter-spacing: 1px; color: " + c.ink + '; mso-line-height-rule: exactly; line-height: 66px;">' + escHtml(d.headline1.toUpperCase()) + (d.headline2 ? "<br>" + escHtml(d.headline2.toUpperCase()) : "") + "</td></tr>\n";
        h += "<tr><td " + bg + 'padding: 0px 36px;"><div style="border-top: 4px solid ' + c.ink + '; font-size: 0px; line-height: 0px;">&nbsp;</div></td></tr>\n';
        h += coverRowHtml(d, "background-color: " + c.bg + "; padding: 24px 36px 0px 36px;");
        h += '<tr><td bgcolor="' + c.bg + '" class="mob-pad mob-h2" style="background-color: ' + c.bg + "; padding: 18px 36px 6px 36px; font-family: " + F_IMPACT + "; font-size: 26px; font-weight: normal; letter-spacing: 1px; color: " + c.ink + '; mso-line-height-rule: exactly; line-height: 32px;">' + escHtml(d.when.toUpperCase()) + "</td></tr>\n";
        h += "<tr><td " + bg + "padding: 0px 36px 32px 36px; font-family: " + F_TREB + "; font-size: 17px; font-weight: bold; letter-spacing: 1px; color: " + c.inkSoft + '; mso-line-height-rule: exactly; line-height: 26px;">' + escHtml(d.where1.toUpperCase()) + (d.where2 ? "<br>" + escHtml(d.where2.toUpperCase()) : "") + "</td></tr>\n";
        h += "<tr><td " + bg + 'padding: 0px 36px 40px 36px;">\n<table role="presentation" cellpadding="0" cellspacing="0" border="0">\n<tr><td bgcolor="#FFFFFF" style="background-color: #FFFFFF;">\n' +
          '<a target="_blank" href="' + safeUrl(d.ctaUrl) + '" style="display: block; padding: 16px 44px; font-family: ' + F_IMPACT + "; font-size: 17px; font-weight: normal; letter-spacing: 2px; color: " + c.cta + '; text-decoration: none;">' + escHtml(d.ctaLabel.toUpperCase()) + "</a>\n</td></tr>\n</table>\n</td></tr>\n";
        var bandInk = d.P.on(c.band, d.P.dark);
        h += '<tr><td bgcolor="' + c.band + '" class="mob-pad" style="background-color: ' + c.band + "; padding: 26px 36px; font-family: " + F_HELV + "; font-size: 15px; color: " + bandInk + '; mso-line-height-rule: exactly; line-height: 24px;">' + emailParagraphs(d.body) + "</td></tr>\n";
        var btwInk = d.P.on(c.between, d.P.dark), btwLabel = d.P.mix(btwInk, c.between, 0.35);
        h += '<tr><td bgcolor="' + c.between + '" class="mob-pad" style="background-color: ' + c.between + "; padding: 22px 36px 4px 36px; font-family: " + F_IMPACT + "; font-size: 13px; font-weight: normal; letter-spacing: 3px; color: " + btwLabel + ';">BETWEEN EVENTS</td></tr>\n';
        h += '<tr><td bgcolor="' + c.between + '" class="mob-pad" style="background-color: ' + c.between + "; padding: 0px 36px 24px 36px; font-family: " + F_HELV + "; font-size: 15px; color: " + btwInk + '; mso-line-height-rule: exactly; line-height: 24px;">' + membershipCopy(ch, "color: " + btwInk + "; font-weight: bold; text-decoration: underline;") + "</td></tr>\n";
        var soc = socialLinksHtml(d.socials, "color: " + c.footerInk + "; text-decoration: none; font-weight: bold;");
        h += '<tr><td bgcolor="' + c.footer + '" class="mob-pad" style="background-color: ' + c.footer + "; padding: 22px 36px 26px 36px; font-family: " + F_HELV + "; font-size: 12px; color: " + c.muted + '; mso-line-height-rule: exactly; line-height: 19px;">\n' +
          (soc ? soc + "<br><br>\n" : "") + orgFooter(ch, c.muted) + "\n</td></tr>\n";
        h += "</table>\n" + outerClose();
        return h;
      }
    },
    /* ---- 1b · Civic bulletin ---- */
    {
      id: "civic-bulletin", name: "1b · Civic bulletin", paper: "light",
      logoPref: ["banner-darktext", "square", "banner-transparent"],
      blurb: "Serif newsletter on cream paper: ruled masthead, centred title, when/where columns, dark button.",
      roles: [["paper", "Paper"], ["ink", "Ink"], ["label", "Labels"], ["link", "Links"], ["footerBg", "Footer"]],
      defaultRoles: function (P) {
        return { paper: "#FCFBF7", ink: P.dark, label: P.primary, link: P.mix(P.primary, "#000000", 0.3), footerBg: "#F1EFE8" };
      },
      render: function (d) {
        var c = d.colors, ch = d.chapter, logo = d.logo || { mode: "text" };
        var muted = "#6B6875", body = "#3A3644", footerInk = "#55515F", footerText = "#8A8792";
        var h = preheaderDiv(d) +
          "<style data-roadie-ignore>\n@media only screen and (max-width: 480px) {\n  .mob-pad { padding-left: 24px !important; padding-right: 24px !important; }\n  .mob-h1 { font-size: 30px !important; line-height: 36px !important; }\n}\n</style>\n" +
          outerOpen() +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px; background-color: ' + c.paper + ';">\n';
        var mast = (logo.mode === "banner" && logo.url)
          ? '<div style="border-top: 3px solid ' + c.ink + "; border-bottom: 1px solid " + c.ink + '; padding: 12px 0px; text-align: center;">' + logoLink(ch, '<img src="' + escHtml(logo.url) + '" width="220" alt="' + escHtml(ch.name) + '" style="display: inline-block; width: 220px; max-width: 100%; height: auto; border: 0;">') + "</div>"
          : '<div style="border-top: 3px solid ' + c.ink + "; border-bottom: 1px solid " + c.ink + "; padding: 12px 0px; text-align: center; font-family: " + F_TREB + '; font-size: 16px; font-weight: bold; letter-spacing: 4px;">' + logoLink(ch, '<span style="color: ' + c.ink + ';">' + escHtml(ch.name.toUpperCase()) + "</span>") + "</div>";
        h += '<tr><td class="mob-pad" style="padding: 30px 48px 0px 48px;">\n' + mast + "\n" +
          '<div style="text-align: center; padding-top: 10px; font-family: ' + F_GEORGIA + "; font-style: italic; font-size: 14px; color: " + muted + ';">' + escHtml(d.kicker) + "</div>\n</td></tr>\n";
        h += '<tr><td align="center" class="mob-pad mob-h1" style="padding: 34px 48px 0px 48px; font-family: ' + F_GEORGIA + "; font-size: 36px; color: " + c.ink + '; mso-line-height-rule: exactly; line-height: 42px;">' + escHtml(d.headline1) + (d.headline2 ? " " + escHtml(d.headline2) : "") + "</td></tr>\n";
        if (d.tagline) h += '<tr><td align="center" class="mob-pad" style="padding: 10px 48px 0px 48px; font-family: ' + F_GEORGIA + '; font-style: italic; font-size: 16px; color: #55515F; mso-line-height-rule: exactly; line-height: 24px;">' + escHtml(d.tagline) + "</td></tr>\n";
        h += coverRowHtml(d, "padding: 24px 48px 0px 48px;");
        function col(label, text, rightPad) {
          return '<div style="display: inline-block; width: 100%; max-width: 250px; vertical-align: top;">\n<div style="border-top: 1px solid ' + c.ink + "; padding: 10px " + rightPad + ' 14px 0px;">\n' +
            '<div style="font-family: ' + F_TREB + "; font-size: 10px; font-weight: bold; letter-spacing: 2px; color: " + c.label + ';">' + label + "</div>\n" +
            '<div style="font-family: ' + F_GEORGIA + "; font-size: 16px; color: " + c.ink + '; padding-top: 4px; mso-line-height-rule: exactly; line-height: 23px;">' + text + "</div>\n</div>\n</div>\n";
        }
        h += '<tr><td class="mob-pad" style="padding: 28px 48px 0px 48px; font-size: 0px; text-align: left;">\n' +
          '<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="50%" valign="top"><![endif]-->\n' +
          col("WHEN", escHtml(d.dateLong) + "<br>" + escHtml(d.timeRange), "16px") +
          '<!--[if mso]></td><td width="50%" valign="top"><![endif]-->\n' +
          col("WHERE", escHtml(d.where1) + (d.where2 ? "<br>" + escHtml(d.where2) : ""), "0px") +
          "<!--[if mso]></td></tr></table><![endif]-->\n</td></tr>\n";
        h += '<tr><td class="mob-pad" style="padding: 20px 48px 0px 48px; font-family: ' + F_GEORGIA + "; font-size: 16px; color: " + body + '; mso-line-height-rule: exactly; line-height: 26px;">\n' + emailParagraphs(d.body) + "\n</td></tr>\n";
        h += '<tr><td align="center" class="mob-pad" style="padding: 30px 48px 8px 48px;">\n<table role="presentation" cellpadding="0" cellspacing="0" border="0">\n<tr><td bgcolor="' + c.ink + '" style="background-color: ' + c.ink + '; border-radius: 2px;">\n' +
          '<a target="_blank" href="' + safeUrl(d.ctaUrl) + '" style="display: block; padding: 14px 40px; font-family: ' + F_TREB + "; font-size: 13px; font-weight: bold; letter-spacing: 2.5px; color: " + d.P.on(c.ink) + '; text-decoration: none;">' + escHtml(d.ctaLabel.toUpperCase()) + "</a>\n</td></tr>\n</table>\n</td></tr>\n";
        h += '<tr><td align="center" class="mob-pad" style="padding: 0px 48px 26px 48px; font-family: ' + F_GEORGIA + "; font-style: italic; font-size: 13px; color: " + muted + ';">' + escHtml(d.ctaHint || "") + "</td></tr>\n";
        h += '<tr><td class="mob-pad" style="padding: 0px 48px;"><div style="border-top: 1px solid #D8D5CC; font-size: 0px; line-height: 0px;">&nbsp;</div></td></tr>\n';
        h += '<tr><td class="mob-pad" style="padding: 22px 48px 30px 48px;">\n<div style="font-family: ' + F_TREB + "; font-size: 10px; font-weight: bold; letter-spacing: 2px; color: " + c.label + ';">BETWEEN EVENTS</div>\n' +
          '<div style="font-family: ' + F_GEORGIA + "; font-size: 15px; color: " + body + '; padding-top: 8px; mso-line-height-rule: exactly; line-height: 24px;">' + membershipCopy(ch, "color: " + c.link + ";") + "</div>\n</td></tr>\n";
        var soc = socialLinksHtml(d.socials, "color: " + footerInk + "; font-weight: bold; text-decoration: none;");
        h += '<tr><td align="center" bgcolor="' + c.footerBg + '" class="mob-pad" style="background-color: ' + c.footerBg + "; padding: 18px 48px 22px 48px; font-family: " + F_HELV + "; font-size: 12px; color: " + footerText + '; mso-line-height-rule: exactly; line-height: 19px;">\n' +
          (soc ? soc + "<br><br>\n" : "") + orgFooter(ch, footerInk) + "\n</td></tr>\n";
        h += "</table>\n" + outerClose();
        return h;
      }
    },
    /* ---- 1c · Horizon ---- */
    {
      id: "horizon", name: "1c · Horizon", paper: "light",
      logoPref: ["banner", "banner-darktext", "banner-transparent", "square"],
      blurb: "Full-width banner over colour stripes, date tile beside the details, rounded button, dark \"between events\" band.",
      roles: [["paper", "Paper"], ["ink", "Ink"], ["accent", "Accent / button"], ["dateBg", "Date tile"], ["band", "Between-events band"], ["stripe1", "Stripe 1"], ["stripe2", "Stripe 2"], ["stripe3", "Stripe 3"], ["stripe4", "Stripe 4"]],
      defaultRoles: function (P) {
        var pool = P.palette.filter(function (x) { return x !== "#ffffff" && x !== "#1a1a1a"; });
        var pick = [P.accent, P.light, P.secondary, P.primary].map(function (x, i) { return x || pool[i % Math.max(pool.length, 1)] || P.primary; });
        var accent = P.accent && P.contrast(P.accent, "#ffffff") >= 2.5 ? P.accent : P.primary;
        return { paper: "#FAF6EC", ink: P.dark, accent: accent, dateBg: P.secondary || P.dark, band: P.dark, stripe1: pick[0], stripe2: pick[1], stripe3: pick[2], stripe4: pick[3] };
      },
      render: function (d) {
        var c = d.colors, ch = d.chapter, logo = d.logo || { mode: "text" }, P = d.P;
        var body = "#3A3644";
        var dateInk = P.on(c.dateBg), dateSoft = P.mix(dateInk, c.dateBg, 0.3);
        var bandInk = P.on(c.band), bandText = P.mix(bandInk, c.band, 0.15), bandLabel = P.mix(bandInk, c.band, 0.4);
        var accentInk = P.on(c.accent);
        var h = preheaderDiv(d) +
          "<style data-roadie-ignore>\n@media only screen and (max-width: 480px) {\n  .mob-pad { padding-left: 24px !important; padding-right: 24px !important; }\n  .mob-h1 { font-size: 25px !important; line-height: 31px !important; }\n}\n</style>\n" +
          outerOpen() +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px; background-color: ' + c.paper + ';">\n';
        if (logo.mode === "banner" && logo.url) {
          h += "<tr><td>" + logoLink(ch, '<img src="' + escHtml(logo.url) + '" width="600" alt="' + escHtml(ch.name) + ' banner" style="display: block; width: 100%; max-width: 600px; height: auto; border: 0;">') + "</td></tr>\n";
        } else {
          h += '<tr><td class="mob-pad" style="padding: 28px 44px 20px 44px;">\n' + logoAndName(d, { font: F_TREB, color: c.ink, weight: "bold", tracking: "3px" }) + "\n</td></tr>\n";
        }
        [c.stripe1, c.stripe2, c.stripe3, c.stripe4].forEach(function (s) {
          h += '<tr><td bgcolor="' + s + '" style="background-color: ' + s + '; font-size: 0px; line-height: 5px; height: 5px;">&nbsp;</td></tr>\n';
        });
        h += '<tr><td class="mob-pad" style="padding: 36px 44px 0px 44px; font-family: ' + F_TREB + "; font-size: 12px; font-weight: bold; letter-spacing: 2.4px; color: " + c.accent + ';">' + escHtml(d.kicker.toUpperCase()) + "</td></tr>\n";
        h += '<tr><td class="mob-pad mob-h1" style="padding: 8px 44px 0px 44px; font-family: ' + F_TREB + "; font-size: 30px; font-weight: bold; color: " + c.ink + '; mso-line-height-rule: exactly; line-height: 36px;">' + escHtml((d.headline1 + " " + d.headline2).trim().toUpperCase()) + "</td></tr>\n";
        h += '<tr><td class="mob-pad" style="padding: 24px 44px 0px 44px;">\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #FFFFFF; border: 1px solid #E2DCC8;">\n<tr><td style="font-size: 0px; text-align: left;">\n' +
          '<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="120" valign="middle"><![endif]-->\n' +
          '<div style="display: inline-block; width: 120px; vertical-align: middle;">\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n<tr><td align="center" bgcolor="' + c.dateBg + '" style="background-color: ' + c.dateBg + '; padding: 18px 10px;">\n' +
          '<div style="font-family: ' + F_TREB + "; font-size: 13px; font-weight: bold; letter-spacing: 2px; color: " + dateSoft + ';">' + escHtml(d.monthShort) + "</div>\n" +
          '<div style="font-family: ' + F_TREB + "; font-size: 44px; font-weight: bold; color: " + dateInk + '; mso-line-height-rule: exactly; line-height: 46px;">' + escHtml(d.day) + "</div>\n" +
          '<div style="font-family: ' + F_TREB + "; font-size: 12px; font-weight: bold; color: " + dateSoft + ';">' + escHtml(d.weekday) + "</div>\n</td></tr>\n</table>\n</div>\n" +
          '<!--[if mso]></td><td valign="middle"><![endif]-->\n' +
          '<div style="display: inline-block; width: 100%; max-width: 386px; vertical-align: middle;">\n<div style="padding: 16px 22px;">\n' +
          '<div style="font-family: ' + F_HELV + "; font-size: 15px; font-weight: bold; color: " + c.ink + '; mso-line-height-rule: exactly; line-height: 22px;">' + escHtml(d.timeRange) + "</div>\n" +
          '<div style="font-family: ' + F_HELV + "; font-size: 15px; color: " + body + '; padding-top: 4px; mso-line-height-rule: exactly; line-height: 22px;">' + escHtml(d.where1) + (d.where2 ? "<br>" + escHtml(d.where2) : "") + "</div>\n</div>\n</div>\n" +
          "<!--[if mso]></td></tr></table><![endif]-->\n</td></tr>\n</table>\n</td></tr>\n";
        h += coverRowHtml(d, "padding: 24px 44px 0px 44px;");
        h += '<tr><td class="mob-pad" style="padding: 24px 44px 0px 44px; font-family: ' + F_HELV + "; font-size: 15px; color: " + body + '; mso-line-height-rule: exactly; line-height: 24px;">' + emailParagraphs(d.body) + "</td></tr>\n";
        h += '<tr><td align="center" class="mob-pad" style="padding: 28px 44px 34px 44px;">\n<table role="presentation" cellpadding="0" cellspacing="0" border="0">\n<tr><td bgcolor="' + c.accent + '" style="background-color: ' + c.accent + '; border-radius: 6px;">\n' +
          '<a target="_blank" href="' + safeUrl(d.ctaUrl) + '" style="display: block; padding: 15px 40px; font-family: ' + F_TREB + "; font-size: 15px; font-weight: bold; letter-spacing: 1.2px; color: " + accentInk + '; text-decoration: none;">' + escHtml(d.ctaLabel.toUpperCase()) + "</a>\n</td></tr>\n</table>\n</td></tr>\n";
        h += '<tr><td bgcolor="' + c.band + '" class="mob-pad" style="background-color: ' + c.band + "; padding: 24px 44px 6px 44px; font-family: " + F_TREB + "; font-size: 12px; font-weight: bold; letter-spacing: 2.4px; color: " + bandLabel + ';">BETWEEN EVENTS</td></tr>\n';
        h += '<tr><td bgcolor="' + c.band + '" class="mob-pad" style="background-color: ' + c.band + "; padding: 0px 44px 24px 44px; font-family: " + F_HELV + "; font-size: 15px; color: " + bandText + '; mso-line-height-rule: exactly; line-height: 24px;">' + membershipCopy(ch, "color: " + bandInk + "; font-weight: bold;") + "</td></tr>\n";
        var soc = socialLinksHtml(d.socials, "color: " + c.accent + "; font-weight: bold; text-decoration: none;");
        h += '<tr><td align="center" class="mob-pad" style="padding: 20px 44px 26px 44px; font-family: ' + F_HELV + '; font-size: 12px; color: #8A8792; mso-line-height-rule: exactly; line-height: 19px;">\n' +
          (soc ? soc + "<br><br>\n" : "") + orgFooter(ch, "#55515F") + "\n</td></tr>\n";
        h += "</table>\n" + outerClose();
        return h;
      }
    }
  ];

  /* Wrap a body fragment in a document for the preview iframe / download. */
  /* Preview/download document. The body's padding + background simulate the
     canvas wrapper AN applies at send time. */
  function wrapEmail(bodyHtml, title, canvasKey) {
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<meta name="color-scheme" content="light dark">\n<meta name="supported-color-schemes" content="light dark">\n<title>' + escHtml(title) + "</title>\n</head>\n" +
      '<body style="margin: 0; padding: 28px 12px; background-color: ' + canvasHex(canvasKey || CANVAS_DEFAULT_KEY) + ';">\n' + bodyHtml + "\n</body>\n</html>\n";
  }

  // ---------- default copy from the event details ----------
  var DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  var DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  var MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function evDate(ev) { var p = ev.start_date.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function fmtTime(hhmm, withAp) {
    var t = hhmm.split(":").map(Number);
    var h12 = ((t[0] + 11) % 12) + 1, apm = t[0] >= 12 ? "PM" : "AM";
    return h12 + (t[1] ? ":" + String(t[1]).padStart(2, "0") : "") + (withAp ? " " + apm : "");
  }
  function ampmOf(hhmm) { return Number(hhmm.split(":")[0]) >= 12 ? "PM" : "AM"; }
  function fmtWhen(ev) { var d = evDate(ev); return DOW[d.getDay()] + " " + MON[d.getMonth()] + " " + d.getDate() + " · " + fmtTime(ev.start_time, true); }
  function fmtDateLong(ev) { var d = evDate(ev); return DOW_LONG[d.getDay()] + ", " + MON_LONG[d.getMonth()] + " " + d.getDate(); }
  function fmtTimeRange(ev) {
    if (!ev.end_time || ev.end_date !== ev.start_date) return fmtTime(ev.start_time, true);
    return ampmOf(ev.start_time) === ampmOf(ev.end_time)
      ? fmtTime(ev.start_time, false) + "–" + fmtTime(ev.end_time, true)
      : fmtTime(ev.start_time, true) + "–" + fmtTime(ev.end_time, true);
  }
  function splitHeadline(name) {
    var words = name.trim().split(/\s+/);
    if (words.length < 2 || name.length <= 12) return [name, ""];
    var best = 1, bestDiff = Infinity;
    for (var i = 1; i < words.length; i++) {
      var a = words.slice(0, i).join(" ").length, b = words.slice(i).join(" ").length;
      if (Math.abs(a - b) < bestDiff) { bestDiff = Math.abs(a - b); best = i; }
    }
    return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
  }
  function defaultEmail(ev, brand) {
    var hl = splitHeadline(ev.event_name);
    var where1 = ev.event_format === "online" ? "Online" : (ev.venue_name || (ev.formatted_address.split("\n")[0] || "TBA"));
    var addr = ev.formatted_address.replace(/\s+/g, " ").trim();
    var where2 = ev.event_format === "online" ? (ev.meeting_url ? "Link in your RSVP confirmation" : "") : (ev.venue_name ? addr : "");
    var typeWord = { action: "Action", community: "Community event", policy: "Policy talk", social: "Social" }[ev.event_type] || "Event";
    var kicker = MON_LONG[evDate(ev).getMonth()] + " " + typeWord + " · You're invited";
    return {
      subject: ev.event_name + " — " + fmtWhen(ev).replace(" · ", ", "),
      preheader: (ev.description.split(/\n/)[0] || "").slice(0, 110),
      kicker: kicker,
      headline1: hl[0], headline2: hl[1],
      tagline: "",
      when: fmtWhen(ev),
      dateLong: fmtDateLong(ev), timeRange: fmtTimeRange(ev),
      where1: where1, where2: where2,
      body: ev.description,
      ctaLabel: "RSVP · Save my spot",
      ctaHint: "Takes ten seconds · bring a friend",
      includeCover: false,
      socials: socialOptions(brand)
    };
  }
  function tplById(id) { return EMAIL_TEMPLATES.filter(function (x) { return x.id === id; })[0] || EMAIL_TEMPLATES[0]; }
  function defaultLogoId(brand, tpl) {
    var opts = logoOptions(brand);
    var match = {
      "banner-transparent": function (o) { return o.id === "banner-transparent"; },
      "banner-darktext": function (o) { return /^banner-v/.test(o.id) && /text|dark/i.test(o.label) && !/white/i.test(o.label); },
      "banner": function (o) { return o.id === "banner"; },
      "square": function (o) { return o.mode === "square"; }
    };
    var prefs = tpl.logoPref || ["banner-transparent", "banner", "square"];
    for (var i = 0; i < prefs.length; i++) {
      var hit = opts.filter(match[prefs[i]] || function () { return false; })[0];
      if (hit) return hit.id;
    }
    return opts[opts.length - 1].id; // wordmark only
  }
  function logoIdFor(tplId) { return emailState.logoChosen[tplId] || defaultLogoId(emailState.brand, tplById(tplId)); }
  function rolesFor(id) {
    if (!emailState.rolesByTpl[id]) emailState.rolesByTpl[id] = tplById(id).defaultRoles(emailState.P);
    return emailState.rolesByTpl[id];
  }

  function collectEventData(ctx) {
    var fmt = ctx.currentFormat();
    var venueName = "", formattedAddress = "";
    if (fmt !== "online") {
      if (ctx.manualMode) {
        venueName = val("venue_name");
        formattedAddress = val("manual_address");
      } else if (selectedPlace) {
        venueName = selectedPlace.venueName;
        formattedAddress = selectedPlace.formattedAddress;
      }
    }
    return {
      event_name: val("event_name"), description: val("description"),
      start_date: val("start_date"), start_time: composeTime("start_time"),
      end_date: val("end_date"), end_time: composeTime("end_time"),
      event_format: fmt, event_type: val("event_type"),
      venue_name: venueName, formatted_address: formattedAddress,
      meeting_url: fmt === "in_person" ? "" : val("meeting_url")
    };
  }

  /* 600px square JPEG data URL for the preview only. The submitted HTML uses
     the cover placeholder; the Worker swaps in the Luma CDN URL of the same
     1200px crop it uploads. */
  function exportCoverPreview() {
    if (!crop) return "";
    var out = document.createElement("canvas");
    out.width = 600; out.height = 600;
    var ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 600, 600);
    ctx.drawImage(crop.img, crop.box.x / crop.scale, crop.box.y / crop.scale, crop.box.size / crop.scale, crop.box.size / crop.scale, 0, 0, 600, 600);
    return out.toDataURL("image/jpeg", 0.82);
  }

  function emailTemplateData(forSubmit) {
    var e = emailState.email, ev = emailState.event, d = evDate(ev);
    var brand = emailState.brand;
    var logo = logoOptions(brand).filter(function (o) { return o.id === logoIdFor(emailState.templateId); })[0] || { mode: "text", url: "" };
    return Object.assign({}, e, {
      chapter: { name: brand.name || emailState.chapterCode, code: brand.code, email: brand.email, website: brand.website, everyaction: brand.everyaction },
      logo: { mode: logo.mode, url: logo.url },
      socials: e.socials.filter(function (s) { return s.on; }),
      colors: rolesFor(emailState.templateId),
      canvas: emailState.canvas,
      P: emailState.P,
      monthShort: MON[d.getMonth()], day: String(d.getDate()), weekday: DOW_LONG[d.getDay()].toUpperCase(),
      ctaUrl: EMAIL_EVENT_URL_SENTINEL,
      coverSrc: forSubmit ? EMAIL_COVER_SENTINEL : coverPreviewUrl
    });
  }
  function renderEmailBody(forSubmit) {
    return tplById(emailState.templateId).render(emailTemplateData(forSubmit));
  }

  // ---------- entering / leaving the email step ----------
  function enterEmailStep(ctx) {
    lastCtx = ctx;
    var code = presetChapter || val("chapter_code");
    coverPreviewUrl = exportCoverPreview();

    // Same chapter, editor already built: refresh the event snapshot and show.
    if (step2Wrap && emailState && emailState.chapterCode === code) {
      emailState.event = collectEventData(ctx);
      showStep(2);
      if (emailState.render) emailState.render();
      renderTurnstile(root.querySelector(".cnl-ee-turnstile"));
      return;
    }

    // First entry, or the chapter changed: rebuild from scratch.
    if (step2Wrap) {
      if (window.turnstile && tsWidgetId !== null) {
        try { window.turnstile.remove(tsWidgetId); } catch (err) { /* stale id */ }
        tsWidgetId = null;
      }
      if (step2Wrap.parentNode) step2Wrap.parentNode.removeChild(step2Wrap);
      step2Wrap = null;
      emailState = null;
    }
    step2Wrap = el("div", { class: "cnl-ee" });
    step2Wrap.appendChild(el("p", { class: "cnl-ef-loading", text: "Loading your chapter's branding…" }));
    root.appendChild(step2Wrap);
    showStep(2);

    loadBrandRows()
      .then(function (rows) {
        var brand = rows.filter(function (r) { return r.code === code; })[0] || emptyBrand(code);
        emailState = {
          chapterCode: code,
          brand: brand,
          event: collectEventData(ctx),
          email: null, P: null,
          canvas: CANVAS_DEFAULT_KEY,
          rolesByTpl: {}, logoChosen: {},
          templateId: EMAIL_TEMPLATES[0].id,
          mobilePreview: false,
          render: null
        };
        emailState.email = defaultEmail(emailState.event, brand);
        emailState.P = basePalette(brand);
        buildEmailEditor();
      })
      .catch(function () {
        step2Wrap.innerHTML = "";
        step2Wrap.appendChild(el("p", {
          class: "cnl-ef-error-banner",
          text: "Couldn't load your chapter's branding — check your connection and try again.",
        }));
        var row = el("div", { class: "cnl-ee-actions" });
        var back = el("button", { type: "button", class: "cnl-ef-btn-small", text: "← Back to event details" });
        back.addEventListener("click", function () { showStep(1); });
        var retry = el("button", { type: "button", class: "cnl-ef-btn-small", text: "Try again" });
        retry.addEventListener("click", function () {
          if (step2Wrap.parentNode) step2Wrap.parentNode.removeChild(step2Wrap);
          step2Wrap = null;
          enterEmailStep(ctx);
        });
        row.appendChild(back);
        row.appendChild(retry);
        step2Wrap.appendChild(row);
      });
  }

  // ---------- the email editor UI ----------
  function buildEmailEditor() {
    var brand = emailState.brand;
    step2Wrap.innerHTML = "";
    step2Wrap.appendChild(el("div", { class: "cnl-ef-banner", role: "alert", style: "display:none" }));

    var head = el("div", { class: "cnl-ee-head" });
    head.appendChild(el("h3", { class: "cnl-ef-section", text: "Announcement email" }));
    head.appendChild(el("p", {
      class: "cnl-ef-hint",
      text: "Built from your event details in " + (brand.name || emailState.chapterCode) + "'s colors. " +
        "After the event is approved, this lands as a DRAFT in your chapter's Action Network account " +
        "with the RSVP button linked to the new Luma event — nothing sends until you send it there.",
    }));
    step2Wrap.appendChild(head);

    var editor = el("div", { class: "cnl-ee-editor" });
    var left = el("div", { class: "cnl-ee-pane" });
    var right = el("div", { class: "cnl-ee-pane cnl-ee-pane--preview" });
    editor.appendChild(left);
    editor.appendChild(right);
    step2Wrap.appendChild(editor);

    /* --- template picker --- */
    left.appendChild(el("h4", { class: "cnl-ee-h", text: "Template" }));
    var tplList = el("div", { class: "cnl-ee-templates", role: "group", "aria-label": "Email template" });
    EMAIL_TEMPLATES.forEach(function (t) {
      var b = el("button", { type: "button", class: "cnl-ee-tpl", "aria-pressed": String(t.id === emailState.templateId), "data-tpl": t.id }, [
        el("span", { class: "cnl-ee-tpl__dot", "aria-hidden": "true" }),
        el("span", {}, [el("span", { class: "cnl-ee-tpl__name", text: t.name }), el("p", { class: "cnl-ee-tpl__blurb", text: t.blurb })])
      ]);
      b.addEventListener("click", function () {
        emailState.templateId = t.id;
        tplList.querySelectorAll(".cnl-ee-tpl").forEach(function (x) { x.setAttribute("aria-pressed", String(x.getAttribute("data-tpl") === t.id)); });
        buildLogo(); buildColors(); render();
      });
      tplList.appendChild(b);
    });
    left.appendChild(tplList);

    /* --- logo (rebuilt per template: thumbnails sit on that template's header colour) --- */
    left.appendChild(el("h4", { class: "cnl-ee-h", text: "Logo" }));
    var logoHost = el("div");
    left.appendChild(logoHost);
    function buildLogo() {
      var roles = rolesFor(emailState.templateId);
      var bg = roles.bg || roles.paper || "#ffffff";
      var ink = roles.ink || "#1a1a1a";
      logoHost.innerHTML = "";
      var logoList = el("div", { class: "cnl-ee-logos", role: "group", "aria-label": "Header logo" });
      logoOptions(brand).forEach(function (o) {
        var thumb = el("span", { class: "cnl-ee-logo__thumb", style: "background:" + bg });
        if (o.url) thumb.appendChild(el("img", { src: o.url, alt: "", loading: "lazy" }));
        else thumb.appendChild(el("span", { class: "cnl-ee-logo__text", text: "Aa", style: "color:" + ink }));
        var b = el("button", { type: "button", class: "cnl-ee-logo", title: o.label, "aria-pressed": String(o.id === logoIdFor(emailState.templateId)), "data-logo": o.id }, [
          thumb, el("span", { class: "cnl-ee-logo__label", text: o.label })
        ]);
        b.addEventListener("click", function () {
          emailState.logoChosen[emailState.templateId] = o.id;
          logoList.querySelectorAll(".cnl-ee-logo").forEach(function (x) { x.setAttribute("aria-pressed", String(x.getAttribute("data-logo") === o.id)); });
          render();
        });
        logoList.appendChild(b);
      });
      logoHost.appendChild(logoList);
    }

    /* --- copy --- */
    left.appendChild(el("h4", { class: "cnl-ee-h", text: "Copy" }));
    var g = el("div", { class: "cnl-ee-group" });
    left.appendChild(g);
    function tf(key, label, opts) {
      opts = opts || {};
      var input = opts.multi
        ? el("textarea", { id: "cnl-ee-" + key, class: "cnl-ef-input" })
        : el("input", { type: "text", id: "cnl-ee-" + key, class: "cnl-ef-input" });
      if (opts.rows) input.setAttribute("rows", opts.rows);
      input.value = emailState.email[key] || "";
      input.addEventListener("input", function () { emailState.email[key] = input.value; render(); });
      var attrs = { class: "cnl-ee-field" };
      if (opts.fieldKey) { attrs.class += " cnl-ef-field"; attrs["data-field"] = opts.fieldKey; }
      var wrap = el("div", attrs, [el("label", { class: "cnl-ef-label", for: "cnl-ee-" + key, text: label }), input]);
      if (opts.hint) wrap.appendChild(el("p", { class: "cnl-ef-hint", text: opts.hint }));
      if (opts.fieldKey) wrap.appendChild(el("p", { class: "cnl-ef-inline-error", role: "alert", "aria-live": "polite" }));
      return wrap;
    }
    function pairRow(a, b) { var r = el("div", { class: "cnl-ee-row" }); r.appendChild(a); r.appendChild(b); return r; }
    g.appendChild(tf("subject", "Subject line", { fieldKey: "email_subject" }));
    g.appendChild(tf("preheader", "Preheader", { fieldKey: "email_preheader", hint: "The grey preview text under the subject in most inboxes. ~85 characters." }));
    g.appendChild(tf("kicker", "Kicker", { hint: "Small line above the title." }));
    g.appendChild(pairRow(tf("headline1", "Headline line 1"), tf("headline2", "Headline line 2")));
    g.appendChild(tf("tagline", "Tagline (1b only)", { hint: "Italic line under the title in the Civic bulletin. Leave blank to omit." }));
    g.appendChild(tf("when", "When (1a, one line)"));
    g.appendChild(pairRow(tf("dateLong", "Date (1b)"), tf("timeRange", "Time range (1b, 1c)")));
    g.appendChild(pairRow(tf("where1", "Where"), tf("where2", "Address")));
    g.appendChild(tf("body", "Body", { multi: true, rows: "7", hint: "Blank line = new paragraph. Prefilled from the event description." }));
    g.appendChild(pairRow(
      tf("ctaLabel", "Button label"),
      tf("ctaHint", "Under the button (1b)")
    ));
    g.appendChild(el("p", { class: "cnl-ef-hint", text: "The RSVP button links to the Luma event automatically once it's created. The \"Between events\" membership line and the CNL org footer are fixed text in every template." }));

    // Footer links: every contact column the sheet has for this chapter, each toggleable.
    var socWrap = el("div", { class: "cnl-ee-field" }, [el("span", { class: "cnl-ef-label", text: "Footer links" })]);
    if (!emailState.email.socials.length) socWrap.appendChild(el("p", { class: "cnl-ef-hint", text: "The chapter sheet has no website, social or contact links for this chapter." }));
    var socList = el("div", { class: "cnl-ee-socials" });
    emailState.email.socials.forEach(function (s) {
      var lab = el("label", { class: "cnl-ee-social", title: s.url });
      var box = el("input", { type: "checkbox" });
      box.checked = s.on;
      box.addEventListener("change", function () { s.on = box.checked; render(); });
      lab.appendChild(box);
      lab.appendChild(document.createTextNode(" " + s.label));
      socList.appendChild(lab);
    });
    socWrap.appendChild(socList);
    socWrap.appendChild(el("p", { class: "cnl-ef-hint", text: "From the chapter sheet — fix a wrong link there, not here." }));
    g.appendChild(socWrap);

    var coverLab = el("label", { class: "cnl-ef-check" });
    var coverBox = el("input", { type: "checkbox" });
    coverBox.checked = !!emailState.email.includeCover;
    if (!coverPreviewUrl) coverBox.disabled = true;
    coverBox.addEventListener("change", function () { emailState.email.includeCover = coverBox.checked; render(); });
    coverLab.appendChild(coverBox);
    coverLab.appendChild(document.createTextNode(" Include the cover image"));
    g.appendChild(coverLab);

    /* --- colours (per template) --- */
    left.appendChild(el("h4", { class: "cnl-ee-h", text: "Colors" }));
    left.appendChild(el("p", { class: "cnl-ef-hint", text: "From " + (brand.name || emailState.chapterCode) + "'s brand row in the chapter sheet. Click a swatch to reassign a role, or pick any color." }));
    var colorsHost = el("div");
    left.appendChild(colorsHost);
    var pal = emailState.P.palette;
    function buildColors() {
      var tpl = tplById(emailState.templateId), roles = rolesFor(tpl.id);
      colorsHost.innerHTML = "";
      var colorsWrap = el("div", { class: "cnl-ee-colors" });
      tpl.roles.forEach(function (r) {
        var key = r[0];
        var pick = el("input", { type: "color", id: "cnl-ee-c-" + key, value: roles[key] });
        var code = el("code", { text: roles[key] });
        pick.addEventListener("input", function () { roles[key] = pick.value; code.textContent = pick.value; render(); });
        var sw = el("div", { class: "cnl-ee-swatches" });
        pal.forEach(function (x) {
          var b = el("button", { type: "button", class: "cnl-ee-swatch", style: "background:" + x, title: x, "aria-label": r[1] + " = " + x });
          b.addEventListener("click", function () { roles[key] = x; pick.value = x; code.textContent = x; render(); });
          sw.appendChild(b);
        });
        colorsWrap.appendChild(el("div", { class: "cnl-ee-color" }, [
          el("label", { class: "cnl-ef-label", for: "cnl-ee-c-" + key, text: r[1] }),
          el("div", { class: "cnl-ee-color__row" }, [pick, code]),
          sw
        ]));
      });
      colorsHost.appendChild(colorsWrap);
      var resetBtn = el("button", { type: "button", class: "cnl-ef-btn-small", text: "Reset to chapter colors" });
      resetBtn.style.marginTop = "12px";
      resetBtn.addEventListener("click", function () { delete emailState.rolesByTpl[tpl.id]; buildColors(); buildLogo(); render(); });
      colorsHost.appendChild(resetBtn);
    }
    buildLogo();
    buildColors();

    /* --- background canvas (global, not per template) --- */
    left.appendChild(el("h4", { class: "cnl-ee-h", text: "Background" }));
    left.appendChild(el("p", { class: "cnl-ef-hint", text: "The page color behind the email card — the same in every template. Applied by Action Network when the draft is created." }));
    var canvasRow = el("div", { role: "group", "aria-label": "Background color" });
    left.appendChild(canvasRow);
    function syncCanvas() {
      canvasRow.querySelectorAll("button").forEach(function (x) {
        var on = x.getAttribute("data-canvas") === emailState.canvas;
        x.setAttribute("aria-pressed", String(on));
        x.style.borderColor = on ? "#2c3659" : "#d5d5d5";
      });
    }
    CANVAS_OPTIONS.forEach(function (c) {
      var sw = el("span", { "aria-hidden": "true", style: "display:inline-block;width:18px;height:18px;border-radius:50%;border:1px solid rgba(0,0,0,0.25);background:" + c[2] });
      var b = el("button", { type: "button", "data-canvas": c[0], title: c[1] + " · " + c[2],
        style: "display:inline-flex;align-items:center;gap:6px;margin:0 8px 8px 0;padding:5px 10px;border:2px solid #d5d5d5;border-radius:999px;background:#fff;cursor:pointer;font-size:12px;line-height:1;" },
        [sw, el("span", { text: c[1] })]);
      b.addEventListener("click", function () { emailState.canvas = c[0]; syncCanvas(); render(); });
      canvasRow.appendChild(b);
    });
    syncCanvas();

    /* --- preview --- */
    var bar = el("div", { class: "cnl-ee-preview-bar" });
    bar.appendChild(el("h4", { class: "cnl-ee-h cnl-ee-h--bare", text: "Preview" }));
    var seg = el("div", { class: "cnl-ee-seg", role: "group", "aria-label": "Preview width" });
    var deskBtn = el("button", { type: "button", text: "Desktop", "aria-pressed": String(!emailState.mobilePreview) });
    var mobBtn = el("button", { type: "button", text: "Mobile", "aria-pressed": String(emailState.mobilePreview) });
    seg.appendChild(deskBtn);
    seg.appendChild(mobBtn);
    bar.appendChild(seg);
    right.appendChild(bar);
    var subjLine = el("p", { class: "cnl-ee-subject" });
    right.appendChild(subjLine);
    var frame = el("iframe", { class: "cnl-ee-preview-frame" + (emailState.mobilePreview ? " is-mobile" : ""), title: "Email preview", sandbox: "" });
    right.appendChild(frame);
    function setMobile(m) {
      emailState.mobilePreview = m;
      frame.classList.toggle("is-mobile", m);
      deskBtn.setAttribute("aria-pressed", String(!m));
      mobBtn.setAttribute("aria-pressed", String(m));
    }
    deskBtn.addEventListener("click", function () { setMobile(false); });
    mobBtn.addEventListener("click", function () { setMobile(true); });

    var dlBtn = el("button", { type: "button", class: "cnl-ef-btn-small", text: "Download a browser preview" });
    dlBtn.addEventListener("click", function () {
      var blob = new Blob([wrapEmail(renderEmailBody(false), emailState.email.subject, emailState.canvas)], { type: "text/html" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (emailState.chapterCode + "-" + emailState.event.event_name + "-" + emailState.templateId)
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".html";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    var dlRow = el("div", { class: "cnl-ee-dl" });
    dlRow.appendChild(dlBtn);
    right.appendChild(dlRow);

    /* --- turnstile + actions --- */
    var tsSlot = el("div", { class: "cnl-ef-turnstile cnl-ee-turnstile" });
    right.appendChild(tsSlot);

    var actions = el("div", { class: "cnl-ee-actions" });
    var backBtn = el("button", { type: "button", class: "cnl-ef-btn-small", text: "← Back to event details" });
    backBtn.addEventListener("click", function () { showStep(1); });
    actions.appendChild(backBtn);
    right.appendChild(actions);

    // Email is the default: the primary action submits event + email. Opting
    // out is the quiet link underneath, for chapters that don't want one.
    var submitBtn = el("button", { type: "button", class: "cnl-ef-submit", text: "Submit event + email for approval" });
    submitBtn.addEventListener("click", function () { submit(formEl, submitBtn, lastCtx, true); });
    right.appendChild(submitBtn);
    var skipBtn = el("button", { type: "button", class: "cnl-ef-linklike", text: "Don't want an announcement email? Submit the event without one" });
    skipBtn.addEventListener("click", function () { submit(formEl, skipBtn, lastCtx, false); });
    var skipRow = el("p", { class: "cnl-ee-skip" });
    skipRow.appendChild(skipBtn);
    right.appendChild(skipRow);
    right.appendChild(el("p", { class: "cnl-ef-hint", text: "CNL staff review the event before anything goes live. The email never sends on its own — it waits as a draft in Action Network for you to test and send." }));

    renderTurnstile(tsSlot);

    var pending = null;
    function render() {
      if (pending) return;
      pending = requestAnimationFrame(function () {
        pending = null;
        subjLine.innerHTML = "";
        subjLine.appendChild(el("strong", { text: "Subject" }));
        subjLine.appendChild(document.createTextNode(" " + emailState.email.subject + " "));
        subjLine.appendChild(el("span", { class: "cnl-ee-pre", text: "— " + emailState.email.preheader }));
        frame.srcdoc = wrapEmail(renderEmailBody(false), emailState.email.subject, emailState.canvas);
      });
    }
    emailState.render = render;
    render();
  }

  // ---------- boot ----------
  root.innerHTML = '<p class="cnl-ef-loading">Loading the event form…</p>';
  fetch(endpoint + "/chapters")
    .then(function (res) {
      if (!res.ok) throw new Error("chapters " + res.status);
      return res.json();
    })
    .then(function (data) {
      chapters = data.chapters || [];
      passcodeRequired = Boolean(data.passcode_required);
      build();
    })
    .catch(function () {
      root.innerHTML =
        '<p class="cnl-ef-error-banner">The event form couldn\'t load. Refresh the page to try again.</p>';
    });
})();
