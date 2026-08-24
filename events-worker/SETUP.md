# CNL Events — setup

Three pieces: a Cloudflare Worker that holds the Luma key, static JS/CSS served
from GitHub, and a code block on the Squarespace page. Nothing about
cnliberalism.org's DNS changes.

---

## 1. Get the Luma calendar API key

Luma Plus must be active on the calendar first. Go to
`luma.com/calendar/manage/api-keys`, pick the national CNL calendar, and copy
the key.

The key grants **full** access to that calendar — read guests, create events,
send invites. It goes in one place only: a Cloudflare secret. Never in the repo,
never in a code block, never in Slack.

## 2. Verify the response shape before building on it

Before deploying anything, confirm what Luma actually returns — specifically
whether chapter tags appear on the list response. Everything else in the design
is settled; this is the one open question.

```bash
export LUMA_API_KEY="secret-..."

# Does the key work?
curl -s -H "x-luma-api-key: $LUMA_API_KEY" \
  https://public-api.luma.com/v1/users/get-self | jq

# What does one event entry look like?
curl -s -H "x-luma-api-key: $LUMA_API_KEY" \
  "https://public-api.luma.com/v1/calendar/list-events?pagination_limit=1" \
  | jq '.entries[0]'
```

Look for a `tags` array on the entry or the event. If it's there, chapter
filtering works as designed. If it isn't, the fallbacks are worse and we should
talk before you build 40 chapter pages on it.

If the second call returns a 400, the parameter names differ from what's in
`worker/src/index.js` — check `docs.luma.com` and adjust the `qs.set(...)` lines
in `fetchAllEvents`.

## 3. Deploy the Worker

```bash
cd worker
npm install -g wrangler        # or use npx below
npx wrangler login             # opens a browser, one time
npx wrangler deploy
npx wrangler secret put LUMA_API_KEY     # paste the key when prompted
npx wrangler secret put DEBUG_TOKEN      # optional: any random string
```

Deploy prints your URL, something like
`https://cnl-events.tobinstone.workers.dev`.

Test it:

```bash
curl -s https://cnl-events.YOURSUB.workers.dev/health
curl -s https://cnl-events.YOURSUB.workers.dev/events | jq '.count, .served'
curl -s "https://cnl-events.YOURSUB.workers.dev/events?chapter=ATL" | jq
```

`served` tells you where the response came from: `network` (fresh Luma call),
`cache` (within the 5-minute window), or `stale` (Luma failed, serving the
last-known-good copy).

To force a refresh during testing, redeploy — it clears the cache.

## 4. Host the widget files

Put `widget/cnl-events.js` and `widget/cnl-events.css` in your
`tobinjstone/chapter-dashboard` repo alongside the existing assets, then serve
them the same way you already do.

**Important:** jsDelivr caches branch references for up to 12 hours, so pin a
version when you change something:

```
https://cdn.jsdelivr.net/gh/tobinjstone/chapter-dashboard@v1.0.0/cnl-events.js
```

Tag a release, bump the tag when you edit. Using `@main` will have you staring
at stale CSS wondering why your change didn't take.

Before uploading, set the real endpoint in `cnl-events.js` — replace
`CHANGEME` in the `DEFAULTS.endpoint` line with your workers.dev subdomain.

## 5. Embed on Squarespace

National events page — add a Code Block:

```html
<link rel="stylesheet"
      href="https://cdn.jsdelivr.net/gh/tobinjstone/chapter-dashboard@v1.0.0/cnl-events.css">

<div data-cnl-events></div>

<script>
  window.CNL_EVENTS = {
    endpoint: "https://cnl-events.YOURSUB.workers.dev/events",
    calendarUrl: "https://luma.com/YOUR-CALENDAR-SLUG"
  };
</script>
<script src="https://cdn.jsdelivr.net/gh/tobinjstone/chapter-dashboard@v1.0.0/cnl-events.js"></script>
```

Chapter pages — the same block, plus the chapter code. If you fold this into the
existing shared chapter code block, read it off `window.CNL_SETTINGS.chapterCode`
rather than hardcoding:

```html
<div data-cnl-events data-limit="3"></div>
<script>
  window.CNL_EVENTS = {
    endpoint: "https://cnl-events.YOURSUB.workers.dev/events",
    chapter: (window.CNL_SETTINGS || {}).chapterCode || "",
    emptyText: "No upcoming events from this chapter yet."
  };
</script>
```

## 6. Branding

Everything lives in the token block at the top of `cnl-events.css`. The defaults
carry over from your email design — navy `#2C3659`, red `#9F3C39`, cream
`#FDFBE9`, Georgia display — including the offset-border card treatment
(navy rule with a red offset), so the calendar reads as the same family as the
emails.

`--cnl-font-body: inherit` means body text picks up whatever Squarespace is
already serving. If you'd rather pin it, set an explicit stack there.

---

## Notes and limits

- **Free tier:** 100,000 Worker requests/day. Caching means Luma sees roughly
  288 calls a day regardless of your traffic.
- **Timezones** render in the event's own zone with an explicit label, because
  chapters span five of them.
- **SEO:** this is client-rendered, so search engines won't index individual
  events. If that matters for the events archive, the Worker can serve
  server-rendered HTML instead — separate build.
- **The endpoint is public.** Anyone can hit it. That's fine: it only returns
  event data already public on luma.com. Don't add anything else to it.
- **Guest data never touches this path.** If you later want RSVP counts on the
  page, that's a deliberate decision with a privacy review, not a config change.
