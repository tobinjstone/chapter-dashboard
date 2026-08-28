/**
 * CNL Events — Luma proxy Worker
 *
 * Holds the Luma API key server-side and returns a slim, stable JSON feed
 * of upcoming events for the CNL website to render.
 *
 * Endpoints
 *   GET /events                    all upcoming events
 *   GET /events?chapter=ATL        only events tagged for that chapter
 *   GET /events?limit=6            cap the number returned
 *   GET /events?format=json        Squarespace-style feed for r/neoliberal's DT bot
 *   GET /events?debug=1            include Luma's raw first entry (see DEBUG_TOKEN)
 *   GET /health                    liveness check, no Luma call
 *
 * Secrets (wrangler secret put ...)
 *   LUMA_API_KEY   required
 *   DEBUG_TOKEN    optional; if set, ?debug=1 also requires &token=<value>
 */

const LUMA_BASE = "https://public-api.luma.com/v1";

const FRESH_TTL = 300; // 5 min — how long a good response is served from cache
const BACKUP_TTL = 86400; // 24 hr — last-known-good, served if Luma is down
const MAX_PAGES = 5; // safety valve on pagination
const PAGE_SIZE = 50;

const ALLOWED_ORIGINS = [
  "https://cnliberalism.org",
  "https://www.cnliberalism.org",
];

// Squarespace preview/staging domains, plus any cnliberalism.org subdomain, so
// embeds on microsites and campaign subdomains work without a redeploy.
const ALLOWED_ORIGIN_SUFFIXES = [".squarespace.com", ".cnliberalism.org"];

// Flip to true to serve any origin. The feed only ever returns event data that
// is already public on luma.com, and the Origin check below is not a security
// control (it is trivially spoofed) - it only stops other people's sites from
// casually embedding the feed. Set this if embeds land on domains that are not
// cnliberalism.org subdomains.
const ALLOW_ANY_ORIGIN = false;

// Chapter pages identify themselves by airport-style ChapterCode (DEN), but the
// Luma tags are human-readable (Denver) because they show in Luma's public
// calendar filter. This maps one to the other so ?chapter=DEN and
// ?chapter=Denver both work.
//
// Generated from the chapter roster sheet that chapter.js reads. Add a row here
// when a chapter is added, or its events page will silently show nothing.
const CHAPTER_ALIASES = {
  AMS: "Amsterdam",
  ARN: "Stockholm",
  ATL: "Atlanta",
  AUS: "Austin",
  BAA: "Buenos Aires",
  BDL: "Hartford",
  BER: "Berlin",
  BNA: "Nashville",
  BOS: "Boston",
  BRU: "Brussels",
  BWI: "Baltimore",
  CAL: "Calgary",
  CHI: "Chicago",
  CHO: "Charlottesville",
  CLT: "Charlotte",
  CLV: "Cleveland",
  CMH: "Columbus",
  CVG: "Cincinnati",
  DAC: "Dhaka",
  DAL: "Dallas",
  DCA: "DMV",
  DEN: "Denver",
  DSM: "Des Moines",
  DTW: "Detroit",
  DUB: "Dublin",
  EWR: "Jersey City",
  FIH: "DRC",
  GBE: "Botswana",
  HOU: "Houston",
  HRE: "Zimbabwe",
  HSV: "Huntsville",
  IND: "Indianapolis",
  JNB: "Johannesburg",
  KCM: "Kansas City",
  LAX: "Los Angeles",
  LEX: "Lexington",
  LON: "London (UK)",
  MCO: "Orlando",
  MEL: "Melbourne",
  MIA: "Miami",
  MKE: "Milwaukee",
  MNH: "Manchester (NH)",
  MSP: "Twin Cities",
  MSY: "New Orleans",
  NBO: "Kenya",
  NYC: "NYC",
  OMA: "Omaha",
  PDX: "Portland (Oregon)",
  PHL: "Philly",
  PHX: "Phoenix",
  PIT: "Pittsburgh",
  PVD: "Providence",
  RDU: "Raleigh-Durham",
  RVA: "Richmond",
  SAN: "San Diego",
  SAT: "San Antonio",
  SEA: "Seattle",
  SFO: "Bay Area",
  SJC: "Santa Cruz",
  SJU: "Puerto Rico",
  SLC: "Salt Lake City",
  STL: "St. Louis",
  TCL: "UofA",
  TOR: "Toronto",
  TPE: "Taipei",
  UOX: "Ole Miss",
  WAW: "Warsaw",
  YOW: "Ottawa",
  YVR: "Vancouver",
};

// A Luma tag is short ("Twin Cities"); the chapter's real name lives in the
// roster sheet ("Twin Cities New Liberals"). The widget shows the full name,
// so the mapping belongs here rather than in the browser.
const CHAPTER_FULL_NAMES = {
  "amsterdam"        : "Amsterdam New Liberals",
  "atlanta"          : "Atlanta New Liberals",
  "austin"           : "Austin New Liberals",
  "baltimore"        : "Baltimore New Liberals",
  "bay area"         : "Bay Area New Liberals",
  "berlin"           : "Neoliberal Berlin",
  "boston"           : "Boston New Liberals",
  "botswana"         : "Botswana New Liberals",
  "brussels"         : "Brussels New Liberals",
  "buenos aires"     : "Neoliberales Buenos Aires",
  "calgary"          : "Calgary New Liberals",
  "charlotte"        : "Charlotte New Liberals",
  "charlottesville"  : "Charlottesville New Liberals",
  "chicago"          : "Chicago New Liberals",
  "cincinnati"       : "Cincinnati New Liberals",
  "cleveland"        : "Cleveland New Liberals",
  "columbus"         : "Columbus New Liberals",
  "dallas"           : "Dallas New Liberals",
  "dmv"              : "DMV New Liberals",
  "denver"           : "Denver New Liberals",
  "des moines"       : "Des Moines New Liberals",
  "detroit"          : "Detroit New Liberals",
  "dhaka"            : "Dhaka New Liberals",
  "drc"              : "Democratic Republic of the Congo New Liberals",
  "dublin"           : "Dublin New Liberals",
  "hartford"         : "Hartford New Liberals",
  "houston"          : "Houston CNL",
  "huntsville"       : "Advance Huntsville",
  "indianapolis"     : "Indianapolis New Liberals",
  "jersey city"      : "Jersey City New Liberals",
  "johannesburg"     : "Johannesburg New Liberals",
  "kansas city"      : "Kansas City New Liberals",
  "kenya"            : "Kenya New Liberals",
  "lexington"        : "Lexington New Liberals",
  "london (uk)"      : "London New Liberals",
  "los angeles"      : "LA New Liberals",
  "manchester (nh)"  : "Manchester New Liberals",
  "melbourne"        : "Melbourne New Progressives",
  "miami"            : "Miami New Liberals",
  "milwaukee"        : "Milwaukee New Liberals",
  "nashville"        : "Nashville New Liberals",
  "new orleans"      : "New Orleans New Liberals",
  "nyc"              : "NYC New Liberals",
  "ole miss"         : "Ole Miss New Liberals",
  "omaha"            : "Omaha New Liberals",
  "orlando"          : "Orlando New Liberals",
  "ottawa"           : "Ottawa New Liberals",
  "philly"           : "Philly New Liberals",
  "phoenix"          : "Phoenix New Liberals",
  "pittsburgh"       : "Pittsburgh New Liberals",
  "portland (oregon)": "Portland New Liberals",
  "providence"       : "Providence New Liberals",
  "puerto rico"      : "Puerto Rico New Liberals",
  "raleigh-durham"   : "Raleigh-Durham New Liberals",
  "richmond"         : "Richmond Neoliberals",
  "salt lake city"   : "Salt Lake City New Liberals",
  "san antonio"      : "San Antonio New Liberals",
  "san diego"        : "San Diego New Liberals",
  "santa cruz"       : "Santa Cruz New Liberals",
  "seattle"          : "Seattle New Liberals",
  "st. louis"        : "St. Louis New Liberals",
  "stockholm"        : "Stockholm New Liberals",
  "taipei"           : "Taipei New Liberals",
  "toronto"          : "Toronto New Liberals",
  "twin cities"      : "Twin Cities New Liberals",
  "uofa"             : "University of Alabama New Liberals",
  "vancouver"        : "Vancouver New Liberals",
  "warsaw"           : "Warsaw Neoliberals",
  "zimbabwe"         : "Zimbabwe New Liberals",
};

// Luma has one flat tag namespace. Anything matching the chapter roster is a
// chapter; everything else ("Week of Action", "National") is a topic tag the
// filter bar can use. Without this split a topic tag would show in the chapter
// chip and match ?chapter=.
const CHAPTER_TAG_SET = new Set(Object.keys(CHAPTER_FULL_NAMES));

function isChapterTag(name) {
  return CHAPTER_TAG_SET.has(String(name).trim().toLowerCase());
}

function resolveChapter(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const alias = CHAPTER_ALIASES[trimmed.toUpperCase()];
  return (alias || trimmed).toLowerCase();
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_ORIGIN_SUFFIXES.some((s) => host.endsWith(s));
  } catch {
    return false;
  }
}

function corsHeaders(origin) {
  // An Origin check is not a security control — it is trivially spoofed. It is
  // here to keep other people's sites from casually embedding our feed. The
  // real reason this endpoint is safe to expose is that it only ever returns
  // event data that is already public on luma.com.
  return {
    "Access-Control-Allow-Origin": ALLOW_ANY_ORIGIN
      ? "*"
      : isAllowedOrigin(origin)
        ? origin
        : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, { status = 200, origin, maxAge = FRESH_TTL } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${maxAge}`,
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, { status: 405, origin });
    }
    if (url.pathname === "/health") {
      return json({ ok: true, time: new Date().toISOString() }, { origin, maxAge: 0 });
    }
    if (url.pathname !== "/events" && url.pathname !== "/") {
      return json({ error: "not_found" }, { status: 404, origin });
    }

    const chapterRaw = (url.searchParams.get("chapter") || "").trim();
    const chapter = resolveChapter(chapterRaw);
    // Topic tag, for embeds that show one strand of programming rather than
    // one chapter. Comma-separated values are OR-ed.
    const tagParam = (url.searchParams.get("tag") || "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "0", 10) || 0, 200);

    let debug = url.searchParams.get("debug") === "1";
    if (debug && env.DEBUG_TOKEN && url.searchParams.get("token") !== env.DEBUG_TOKEN) {
      debug = false;
    }

    // Cache key ignores chapter/limit: we fetch the full feed once and filter
    // in memory, so 40 chapter pages share a single upstream call.
    const cacheKey = new Request(new URL("/events", url.origin).toString(), {
      method: "GET",
    });
    const backupKey = new Request(new URL("/events__backup", url.origin).toString(), {
      method: "GET",
    });
    const cache = caches.default;

    let payload = null;
    let served = "network";

    const cached = await cache.match(cacheKey);
    if (cached && !debug) {
      payload = await cached.json();
      served = "cache";
    }

    if (!payload) {
      try {
        payload = await fetchAllEvents(env.LUMA_API_KEY, debug);
        const fresh = new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${FRESH_TTL}` },
        });
        const backup = new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${BACKUP_TTL}` },
        });
        ctx.waitUntil(cache.put(cacheKey, fresh));
        ctx.waitUntil(cache.put(backupKey, backup));
      } catch (err) {
        const backup = await cache.match(backupKey);
        if (backup) {
          payload = await backup.json();
          served = "stale";
        } else {
          // Return 200 with an empty list so the widget shows its empty state
          // instead of a broken page. The error field is for you, not visitors.
          return json(
            { events: [], count: 0, served: "error", error: String(err) },
            { origin, maxAge: 30 }
          );
        }
      }
    }

    let events = payload.events;
    const warnings = [...(payload.warnings || [])];

    if (chapter) {
      const matched = events.filter((e) =>
        e.chapters.some((c) => c.toLowerCase() === chapter)
      );
      if (matched.length === 0 && events.length > 0 && !payload.anyTags) {
        // No event anywhere carried tag data — the filter is not working, and
        // silently returning zero events would look like "no upcoming events".
        warnings.push(
          "No tag data present on any event. Chapter filtering is inactive; returning unfiltered feed."
        );
      } else {
        // A chapter that matches no tag in the feed renders exactly like a
        // chapter with nothing scheduled. Across 40 pages a misspelled tag
        // would stay invisible, so name the possibility out loud.
        const known = payload.known_chapters || [];
        const isKnown = known.some((c) => c.toLowerCase() === chapter);
        if (matched.length === 0 && known.length && !isKnown) {
          warnings.push(
            `Chapter "${chapterRaw}" matched no upcoming event. If this chapter ` +
              `should have events, check the tag spelling in Luma. Tags ` +
              `currently in use: ${known.join(", ")}.`
          );
        }
        events = matched;
      }
    }

    if (tagParam.length) {
      const before = events.length;
      events = events.filter((e) =>
        (e.tags || []).some((t) => tagParam.indexOf(t.toLowerCase()) !== -1)
      );
      const known = payload.known_tags || [];
      const unknown = tagParam.filter(
        (t) => !known.some((k) => k.toLowerCase() === t)
      );
      if (!events.length && before && unknown.length) {
        // Same trap as chapters: a misspelled tag looks exactly like a tag with
        // nothing scheduled. Say which ones matched nothing.
        warnings.push(
          `Tag(s) not found on any upcoming event: ${unknown.join(", ")}. ` +
            `Tags currently in use: ${known.length ? known.join(", ") : "(none)"}.`
        );
      }
    }

    if (limit) events = events.slice(0, limit);

    // r/neoliberal's discussion-thread bot used to read Squarespace's
    // /events?format=json feed, so this view keeps its shape: an `upcoming`
    // array with `title` and `startDate`/`endDate` in epoch milliseconds.
    // `url` is the absolute Luma link — the old feed's relative `fullUrl`
    // (which the bot prefixed with cnliberalism.org) has no equivalent here,
    // since events no longer have per-event pages on cnliberalism.org.
    if (url.searchParams.get("format") === "json") {
      return json(
        {
          upcoming: events.map((e) => ({
            title: e.name,
            startDate: Date.parse(e.start_at),
            endDate: e.end_at ? Date.parse(e.end_at) : null,
            url: e.url,
            timezone: e.timezone,
            chapters: e.chapter_names,
            location: e.location,
          })),
          count: events.length,
          generated_at: payload.generated_at,
        },
        { origin }
      );
    }

    return json(
      {
        events,
        count: events.length,
        served,
        generated_at: payload.generated_at,
        known_chapters: payload.known_chapters || [],
        known_tags: payload.known_tags || [],
        ...(warnings.length ? { warnings } : {}),
        ...(debug ? { raw_sample: payload.raw_sample } : {}),
      },
      { origin }
    );
  },
};

async function fetchAllEvents(apiKey, debug) {
  if (!apiKey) throw new Error("LUMA_API_KEY is not set");

  const events = [];
  let cursor = null;
  let rawSample = null;
  let anyTags = false;
  const knownChapters = new Set();
  const knownTags = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams();
    // NOTE: verify these param names against docs.luma.com once your key is
    // live. If Luma 400s, hit /events?debug=1 and read the error body — the
    // likely culprits are `after` and `pagination_limit`.
    qs.set("after", new Date().toISOString());
    qs.set("pagination_limit", String(PAGE_SIZE));
    qs.set("sort_column", "start_at");
    qs.set("sort_direction", "asc");
    if (cursor) qs.set("pagination_cursor", cursor);

    const res = await fetch(`${LUMA_BASE}/calendar/list-events?${qs}`, {
      headers: { "x-luma-api-key": apiKey, accept: "application/json" },
    });

    if (!res.ok) {
      throw new Error(`Luma ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data = await res.json();
    const entries = data.entries || data.events || [];

    if (debug && !rawSample && entries.length) rawSample = entries[0];

    for (const entry of entries) {
      const normalized = normalizeEvent(entry);
      if (!normalized) continue;
      if (normalized.chapters.length) anyTags = true;
      for (const c of normalized.chapters) knownChapters.add(c);
      for (const t of normalized.tags) knownTags.add(t);
      events.push(normalized);
    }

    if (!data.has_more) break;
    cursor = data.next_cursor;
    if (!cursor) break;
  }

  events.sort((a, b) => a.start_at.localeCompare(b.start_at));

  return {
    events,
    anyTags,
    known_chapters: [...knownChapters].sort(),
    known_tags: [...knownTags].sort(),
    generated_at: new Date().toISOString(),
    ...(rawSample ? { raw_sample: rawSample } : {}),
  };
}

function normalizeEvent(entry) {
  // Luma nests the event under `event` on list responses; tolerate both shapes.
  const e = entry.event || entry;
  if (!e || !e.start_at) return null;

  const geo = e.geo_address_info || e.geo_address_json || {};

  // Tags may arrive on the entry or the event, as objects or strings.
  const rawTags = entry.tags || e.tags || entry.event_tags || [];
  const tagNames = rawTags
    .map((t) => (typeof t === "string" ? t : t.name || t.slug || ""))
    .filter(Boolean);

  const chapters = tagNames.filter(isChapterTag);
  const topics = tagNames.filter((t) => !isChapterTag(t));

  const slug = e.url || e.slug || "";
  const eventUrl = slug.startsWith("http") ? slug : `https://luma.com/${slug}`;

  const isOnline = (e.location_type || "").toLowerCase() === "online" || Boolean(e.meeting_url);

  const chapterNames = chapters.map((c) => CHAPTER_FULL_NAMES[c.toLowerCase()] || c);

  return {
    id: e.api_id || entry.api_id || eventUrl,
    name: e.name || "Untitled event",
    url: eventUrl,
    start_at: e.start_at,
    end_at: e.end_at || null,
    timezone: e.timezone || "America/New_York",
    cover_url: e.cover_url || null,
    chapters,
    chapter_names: chapterNames,
    tags: topics,
    location: {
      type: isOnline ? "online" : "offline",
      venue: geo.address || geo.name || null,
      city_state: geo.city_state || [geo.city, geo.region].filter(Boolean).join(", ") || null,
    },
  };
}
