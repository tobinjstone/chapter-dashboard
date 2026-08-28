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
    var b = root.querySelector(".cnl-ef-banner");
    b.textContent = message || "";
    b.style.display = message ? "block" : "none";
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

    // Turnstile
    var tsSlot = el("div", { class: "cnl-ef-turnstile" });
    colB.appendChild(tsSlot);

    var submitBtn = el("button", { type: "submit", class: "cnl-ef-submit", text: "Submit for approval" });
    colB.appendChild(submitBtn);
    colB.appendChild(el("p", { class: "cnl-ef-hint", text: "Submissions are reviewed by CNL staff before the event goes live." }));

    root.innerHTML = "";
    root.appendChild(form);

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
    wireTurnstile(tsSlot);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      submit(form, submitBtn, { manualMode: manualMode, currentFormat: currentFormat });
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

  // ---------- Turnstile ----------
  function wireTurnstile(slot) {
    if (!cfg.turnstileSiteKey) return;
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__cnlEfTs";
    s.async = true;
    window.__cnlEfTs = function () {
      window.turnstile.render(slot, { sitekey: cfg.turnstileSiteKey });
    };
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

  // ---------- submit ----------
  function submit(form, submitBtn, ctx) {
    if (submitting) return;
    clearErrors();
    var errors = clientValidate(ctx);
    if (Object.keys(errors).length) {
      renderErrors(errors);
      return;
    }

    submitting = true;
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
        var ts = form.querySelector('[name="cf-turnstile-response"]');
        if (ts) fd.append("cf-turnstile-response", ts.value);
        return fetch(endpoint + "/submit", { method: "POST", body: fd });
      })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.body.ok) {
          showSuccess();
          return;
        }
        if (r.body && r.body.errors) {
          renderErrors(r.body.errors);
        } else {
          banner((r.body && r.body.message) || "Something went wrong — please try again.");
        }
        resetSubmitState(form, submitBtn);
      })
      .catch(function () {
        banner("Couldn't reach the server — check your connection and try again.");
        resetSubmitState(form, submitBtn);
      });
  }

  function resetSubmitState(form, submitBtn) {
    submitting = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit for approval";
    form.classList.remove("cnl-ef-busy");
    if (window.turnstile) window.turnstile.reset();
  }

  function renderErrors(errors) {
    var firstField = null;
    var unplaced = [];
    Object.keys(errors).forEach(function (key) {
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

  function showSuccess() {
    root.innerHTML = "";
    var panel = el("div", { class: "cnl-ef-success", role: "status" });
    panel.appendChild(el("h3", { text: "Submitted!" }));
    panel.appendChild(el("p", {
      text: "Your event is with CNL staff for review. Once it's approved it will " +
        "appear on the Luma calendar and you'll get a host invite at the email you provided.",
    }));
    root.appendChild(panel);
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
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
