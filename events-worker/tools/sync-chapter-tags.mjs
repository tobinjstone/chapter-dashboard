#!/usr/bin/env node
/**
 * sync-chapter-tags.mjs - reconcile CNL chapter tags on the Luma calendar.
 *
 * Compares the 69 chapter names below against the tags that actually exist on
 * the calendar, prints the difference, and (only with --create) creates the
 * ones that are missing.
 *
 * This script never deletes, renames, unapplies, or modifies events. The only
 * write it can perform is POST /v1/calendars/event-tags/create.
 *
 *   node tools/sync-chapter-tags.mjs            # dry run - show the diff
 *   node tools/sync-chapter-tags.mjs --create   # create the missing tags
 *
 * The Luma key is read from LUMA_API_KEY if set; otherwise you are prompted,
 * which keeps it out of your shell history.
 */

import readline from "node:readline";

const BASE = "https://public-api.luma.com/v1";

// Chapter names matching the Squarespace chapter list. These appear in Luma's
// public calendar filter, so they are human-readable rather than the
// airport-style ChapterCode. The Worker maps codes to these names.
const CHAPTERS = [
  "Cincinnati",
  "Huntsville",
  "Atlanta",
  "Austin",
  "Bay Area",
  "Boston",
  "Charlotte",
  "Charlottesville",
  "Chicago",
  "Cleveland",
  "Columbus",
  "Dallas",
  "DMV",
  "Denver",
  "Des Moines",
  "Detroit",
  "Hartford",
  "Houston",
  "Indianapolis",
  "Kansas City",
  "Los Angeles",
  "Lexington",
  "Manchester (NH)",
  "Miami",
  "Milwaukee",
  "Nashville",
  "New Orleans",
  "NYC",
  "Ole Miss",
  "Orlando",
  "Philly",
  "Phoenix",
  "Pittsburgh",
  "Portland (Oregon)",
  "Providence",
  "Puerto Rico",
  "Raleigh-Durham",
  "Richmond",
  "Salt Lake City",
  "San Antonio",
  "San Diego",
  "Seattle",
  "St. Louis",
  "Twin Cities",
  "UofA",
  "Vancouver",
  "Amsterdam",
  "Brussels",
  "Calgary",
  "Dhaka",
  "Dublin",
  "Johannesburg",
  "London (UK)",
  "Melbourne",
  "Berlin",
  "Buenos Aires",
  "Ottawa",
  "Stockholm",
  "Taipei",
  "Toronto",
  "Warsaw",
  "Zimbabwe",
  "Baltimore",
  "Botswana",
  "Omaha",
  "Kenya",
  "DRC",
  "Jersey City",
  "Santa Cruz",
];

const CREATE = process.argv.includes("--create");

function fail(msg) {
  console.error("");
  console.error("  " + msg);
  console.error("");
  process.exit(1);
}

async function readKey() {
  if (process.env.LUMA_API_KEY) return process.env.LUMA_API_KEY.trim();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  let muted = false;
  rl._writeToOutput = function (s) {
    if (!muted) rl.output.write(s);
  };
  const key = await new Promise((resolve) => {
    rl.question("Paste the Luma API key (input stays hidden): ", (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
  console.log("");
  return key.trim();
}

async function luma(key, path, options) {
  const opts = options || {};
  const headers = { "x-luma-api-key": key, accept: "application/json" };
  if (opts.body) headers["content-type"] = "application/json";

  const init = { method: opts.method || "GET", headers: headers };
  if (opts.body) init.body = JSON.stringify(opts.body);

  const res = await fetch(BASE + path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error("Luma " + res.status + " on " + path + ": " + text.slice(0, 300));
  }
  return text ? JSON.parse(text) : {};
}

const norm = (s) => s.trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = await readKey();
  if (!key) fail("No key provided. Aborted; nothing was changed.");

  console.log("Reading existing tags from Luma...");
  const listed = await luma(key, "/calendars/event-tags/list");
  const existing = listed.entries || [];
  if (listed.has_more) {
    console.log("  NOTE: Luma reports more tags than one page returned.");
    console.log("  Treat the list of missing tags below as provisional.");
  }

  const haveByNorm = new Map(existing.map((t) => [norm(t.name), t]));
  const wantNorm = new Set(CHAPTERS.map(norm));

  const missing = CHAPTERS.filter((n) => !haveByNorm.has(norm(n)));
  const present = CHAPTERS.filter((n) => haveByNorm.has(norm(n)));
  const extra = existing.filter((t) => !wantNorm.has(norm(t.name)));

  console.log("");
  console.log("  chapters in list : " + CHAPTERS.length);
  console.log("  already in Luma  : " + present.length);
  console.log("  missing from Luma: " + missing.length);
  console.log("  in Luma but not in the list: " + extra.length);

  if (extra.length) {
    console.log("");
    console.log("  Not in your chapter list (left alone, never deleted):");
    for (const t of extra) console.log("    - " + t.name + "  [" + t.id + "]");
    console.log("  If any of these are misspellings of a real chapter, fix them");
    console.log("  in the Luma UI first, or you will end up with both.");
  }

  if (!missing.length) {
    console.log("");
    console.log("  Nothing to create. Luma already has every chapter tag.");
    console.log("");
    return;
  }

  console.log("");
  console.log("  Would create " + missing.length + " tag(s):");
  for (const n of missing) console.log("    + " + n);

  if (!CREATE) {
    console.log("");
    console.log("  Dry run. Nothing was changed.");
    console.log("  Re-run with --create to create the tags above.");
    console.log("");
    return;
  }

  console.log("");
  console.log("  Creating...");
  console.log("");

  let ok = 0;
  const failed = [];
  for (const name of missing) {
    try {
      const r = await luma(key, "/calendars/event-tags/create", {
        method: "POST",
        body: { name: name },
      });
      ok++;
      console.log("    created  " + name + "  -> " + (r.id || "(no id returned)"));
    } catch (err) {
      failed.push(name);
      console.log("    FAILED   " + name + "  -> " + err.message);
    }
    await sleep(200); // stay well under the 200 req/min limit
  }

  console.log("");
  console.log("  Created " + ok + " of " + missing.length + ".");
  if (failed.length) {
    console.log("  Failed: " + failed.join(", "));
    console.log("  Re-running is safe - anything already created is skipped.");
  }
  console.log("");
}

main().catch((err) => fail(err.message));
