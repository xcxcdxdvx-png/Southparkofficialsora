/* ==========================================================================
 * Sora module for https://www.southpark.de/en/seasons/south-park (English)
 * --------------------------------------------------------------------------
 * Async JS mode (asyncJS: true)
 *   searchResults(keyword)      -> JSON string: [{ title, image, href }]
 *   extractDetails(url)         -> JSON string: [{ description, aliases, airdate }]
 *   extractEpisodes(url)        -> JSON string: [{ href, number }]   (number = Int!)
 *   extractStreamUrl(url)       -> JSON string: { streams: [{ streamUrl, title, headers }] }
 *
 * Only fetchv2 / atob / btoa / console are available in JavaScriptCore.
 * There is no DOM, no Node API and no WebCrypto.
 *
 * Full episodes only:
 *   The site exposes the complete series through
 *   /en/api/context/<seriesMgid>/episode/1/1000
 *   which returns every *episode* (not the "All Videos" / clips bucket).
 *   Entries whose heading does not look like "S1 • E1" are discarded, so
 *   extras such as the 25th anniversary concert never show up.
 *
 * Unavailable episodes are skipped:
 *   The API still lists some episodes that cannot be played (lockedLabel set,
 *   duration "00:00"). Those are dropped so Sora does not offer dead links.
 *   A season that is locked as a whole is kept, because Sora numbers seasons
 *   by their position in the returned list.
 * ========================================================================== */

var SP_ORIGIN = "https://www.southpark.de";
var SP_SITE_REFERER = "https://www.southpark.de/en/";
var SP_SERIES_URL = "https://www.southpark.de/en/seasons/south-park";
var SP_API_PREFIX = "/en/api";
var SP_SERIES_MGID_FALLBACK = "mgid:arc:series:southpark.intl:27964d3c-ecfd-11e0-aca6-0026b9414f30";
var SP_SHARED_MGID_PREFIX = "shared.southpark.gsa.en";

var SP_POSTER = "https://images.paramount.tech/uri/mgid:arc:imageassetref:shared.southpark.us.en:88778738-b9f9-42b7-8fcb-f2066aeb940f?format=jpg&width=1200&height=630&crop=true";
var SP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var SP_ACCEPT_LANGUAGE = "en-US,en;q=0.9,de;q=0.6";

var SP_SHOW_TITLE = "South Park";
var SP_DESCRIPTION_FALLBACK = "Join Stan, Kyle, Eric, and Kenny down in South Park for a dose of crude language and dark, surreal humor!";
var SP_ALIASES = "Comedy \u00b7 Adult Animation";
var SP_AIRDATE = "1997\u2013present";
var SP_STREAM_TITLE = "South Park (English)";

/* ------------------------------------------------------------------ utils */

function spLog(message) {
  try { console.log("[SouthParkEN] " + message); } catch (error) { /* ignore */ }
}

async function spRequest(url, headers, method, body) {
  var verb = method || "GET";

  if (typeof fetchv2 === "function") {
    var response = await fetchv2(url, headers || {}, verb, body || null, true);
    if (response == null) throw new Error(verb + " " + url + " returned nothing");
    if (typeof response === "string") return response;
    if (response.error) throw new Error(verb + " " + url + " failed: " + response.error);
    if (response._data != null) return String(response._data);
    if (typeof response.text === "function") return String(await response.text());
    if (typeof response.text === "string") return response.text;
    if (response.data != null) return typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    return String(response);
  }

  /* Very old Sora builds only expose fetch(). */
  if (typeof fetch === "function") {
    if (verb !== "GET") throw new Error("POST requires fetchv2, which this Sora build does not provide");
    var legacy = await fetch(url, headers || {});
    return legacy == null ? "" : String(legacy);
  }

  throw new Error("no fetch implementation available");
}

async function spGetHtml(url, referer) {
  return spRequest(url, {
    "User-Agent": SP_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": SP_ACCEPT_LANGUAGE,
    "Referer": referer || SP_SITE_REFERER
  }, "GET", null);
}

async function spGetJson(url, referer) {
  return spRequest(url, {
    "User-Agent": SP_UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": SP_ACCEPT_LANGUAGE,
    "Referer": referer || SP_SERIES_URL
  }, "GET", null);
}

function spParseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    spLog(label + ": JSON parse failed: " + error);
    return null;
  }
}

function spDecodeEntities(text) {
  if (!text) return "";
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/&#(\d+);/g, function (_, dec) {
      return String.fromCharCode(parseInt(dec, 10));
    })
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014");
}

function spCleanText(text) {
  return spDecodeEntities(String(text || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

function spMetaContent(html, key) {
  var escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var patterns = [
    new RegExp("<meta[^>]+(?:name|property)\\s*=\\s*[\"']" + escaped + "[\"'][^>]*content\\s*=\\s*[\"']([^\"']*)[\"']", "i"),
    new RegExp("<meta[^>]+content\\s*=\\s*[\"']([^\"']*)[\"'][^>]*(?:name|property)\\s*=\\s*[\"']" + escaped + "[\"']", "i")
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = patterns[i].exec(html || "");
    if (match) return match[1];
  }
  return "";
}

function spAbsolute(href) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  if (href.charAt(0) === "/") return SP_ORIGIN + href;
  return SP_ORIGIN + "/" + href;
}

function spFindSeriesMgid(html) {
  var match = /mgid:arc:series:southpark\.intl:[0-9a-f-]+/i.exec(html || "");
  return match ? match[0] : SP_SERIES_MGID_FALLBACK;
}

/* --------------------------------------------------------------- search */

async function searchResults(keyword) {
  spLog("searchResults(" + keyword + ")");

  /* This is a single-show module: the show itself is always the result. */
  var results = [{
    title: SP_SHOW_TITLE,
    image: SP_POSTER,
    href: SP_SERIES_URL
  }];

  return JSON.stringify(results);
}

/* -------------------------------------------------------------- details */

async function extractDetails(url) {
  var pageUrl = url || SP_SERIES_URL;
  spLog("extractDetails(" + pageUrl + ")");

  var description = "";

  try {
    var html = await spGetHtml(pageUrl, SP_SITE_REFERER);
    description = spCleanText(spMetaContent(html, "description"));
    if (!description) description = spCleanText(spMetaContent(html, "og:description"));
  } catch (error) {
    spLog("details fetch failed: " + error);
  }

  if (!description) description = SP_DESCRIPTION_FALLBACK;

  return JSON.stringify([{
    description: description,
    aliases: SP_ALIASES,
    airdate: SP_AIRDATE
  }]);
}

/* ------------------------------------------------------------- episodes */

async function extractEpisodes(url) {
  var pageUrl = url || SP_SERIES_URL;
  spLog("extractEpisodes(" + pageUrl + ")");

  var html = await spGetHtml(pageUrl, SP_SITE_REFERER);
  var seriesMgid = spFindSeriesMgid(html);
  var apiUrl = SP_ORIGIN + SP_API_PREFIX + "/context/" +
    encodeURIComponent(seriesMgid) + "/episode/1/1000";

  spLog("episode api: " + apiUrl);

  var body = await spGetJson(apiUrl, pageUrl);
  var data = spParseJson(body, "episodes");
  if (!data) throw new Error("Could not parse the episode API response");

  var items = data.items;
  if (!items && data.response) items = data.response.items;
  if (!items || !items.length) throw new Error("The episode API returned no items");

  var all = [];
  var seen = {};

  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    var header = item.meta && item.meta.header && item.meta.header.title;
    var label = "";

    if (typeof header === "string") label = header;
    else if (header && typeof header.text === "string") label = header.text;

    /* English headings look like "S1 • E1"; German ones use "S1 • F1".
     * Discard anything else (clips, concerts, promos). */
    var match = /S\s*(\d+)\s*[\u2022\u00b7\-\u2013]\s*(?:E|F|EP)\s*\.?\s*(\d+)/i.exec(label);
    if (!match) {
      if (label) spLog("skip non-episode item: " + label);
      continue;
    }

    var season = parseInt(match[1], 10);
    var number = parseInt(match[2], 10);
    if (!season || !number) continue;

    var href = spAbsolute(item.url || "");
    if (!href || seen[href]) continue;

    seen[href] = true;

    /* Episodes that cannot be played still show up in the API: lockedLabel
     * is set and the duration is "00:00". */
    var media = item.media || {};
    var locked = !!(media.lockedLabel || media.duration === "00:00");

    all.push({ season: season, number: number, href: href, locked: locked });
  }

  var playableSeasons = {};
  for (var k = 0; k < all.length; k++) {
    if (!all[k].locked) playableSeasons[all[k].season] = true;
  }

  /* Drop unavailable episodes, but never drop a whole season: Sora derives
   * the season numbers from the order of the returned episodes, so a missing
   * season would shift every later season by one. Seasons that are locked as
   * a whole (licensing, region) therefore stay listed. */
  var collected = [];
  var skipped = 0;
  for (var m = 0; m < all.length; m++) {
    var entry = all[m];
    if (entry.locked && playableSeasons[entry.season]) {
      skipped++;
      continue;
    }
    collected.push(entry);
  }

  if (skipped) spLog("unavailable episodes skipped: " + skipped);

  collected.sort(function (a, b) {
    if (a.season !== b.season) return a.season - b.season;
    return a.number - b.number;
  });

  var episodes = [];
  for (var j = 0; j < collected.length; j++) {
    episodes.push({ href: collected[j].href, number: collected[j].number });
  }

  spLog("episodes found: " + episodes.length);
  return JSON.stringify(episodes);
}

/* --------------------------------------------------------------- stream */

function spUnescapeJsonString(value) {
  try {
    return JSON.parse('"' + value + '"');
  } catch (error) {
    return String(value)
      .replace(/\\u002F/gi, "/")
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&");
  }
}

function spFindVideoServiceUrl(html) {
  /* The server-rendered JSON escapes slashes as \u002F, so the raw value is
   * unescaped as a JSON string instead of matching "https://" directly. */
  var match = /"videoServiceUrl"\s*:\s*"([^"]+)"/i.exec(html || "");
  if (match) {
    var url = spUnescapeJsonString(match[1]);
    if (/^https?:\/\//i.test(url)) return url;
  }

  var decoded = String(html || "")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/");

  var fallback = /https:\/\/topaz\.paramount\.tech\/topaz\/api\/[^"'\s\\]+\/mica\.json\?[^"'\s\\]+/i.exec(decoded);
  return fallback ? fallback[0] : null;
}

function spFillMicaTemplate(template, platform) {
  var replacements = {
    "{clientPlatform}": platform,
    "{advertisingid}": "",
    "{advertId}": "",
    "{ssus}": "false",
    "{bundle}": "southpark",
    "{idfv}": "",
    "{deviceType}": platform === "mobile" ? "mobile" : "desktop",
    "{gppstring}": "",
    "{gppsid}": "",
    "{client}": "web",
    "{tveprovider}": ""
  };

  var url = template;
  for (var key in replacements) {
    if (Object.prototype.hasOwnProperty.call(replacements, key)) {
      url = url.split(key).join(replacements[key]);
    }
  }

  return url.replace(/\{[^}]+\}/g, "");
}

async function spFetchMica(template, referer) {
  var platforms = ["desktop", "mobile"];
  var lastError = "";

  for (var i = 0; i < platforms.length; i++) {
    var platform = platforms[i];
    var url = spFillMicaTemplate(template, platform);
    spLog("mica request (" + platform + "): " + url);

    try {
      var body = await spGetJson(url, referer);
      var data = spParseJson(body, "mica");
      if (!data) {
        lastError = "unparseable mica response";
        continue;
      }

      if (data.stitchedstream && typeof data.stitchedstream.source === "string" && data.stitchedstream.source) {
        return data.stitchedstream.source;
      }
      if (data.stream && typeof data.stream.source === "string" && data.stream.source) {
        return data.stream.source;
      }
      if (typeof data.source === "string" && data.source) {
        return data.source;
      }

      if (data.error) {
        lastError = String(data.error.errormessage || data.error.diagnostics || JSON.stringify(data.error));
        spLog("mica error: " + lastError);
      } else {
        lastError = "no stream in mica response";
      }
    } catch (error) {
      lastError = String(error);
      spLog("mica request failed: " + error);
    }
  }

  throw new Error("Could not resolve a stream: " + lastError);
}

async function extractStreamUrl(url) {
  spLog("extractStreamUrl(" + url + ")");

  var episodeUrl = url || "";
  if (!episodeUrl) throw new Error("No episode URL was provided");

  var html = await spGetHtml(episodeUrl, SP_SERIES_URL);
  var template = spFindVideoServiceUrl(html);

  if (!template) {
    var mgidMatch = /mgid:arc:episode:southpark\.intl:[0-9a-f-]+/i.exec(html);
    if (mgidMatch) {
      var sharedMgid = mgidMatch[0].replace("southpark.intl", SP_SHARED_MGID_PREFIX);
      template = "https://topaz.paramount.tech/topaz/api/" + sharedMgid +
        "/mica.json?clientPlatform={clientPlatform}&advertId=&ssus=false&bundle=southpark&idfv=&deviceType={deviceType}&gppString=&gppSid=";
      spLog("using fallback mica template");
    }
  }

  if (!template) throw new Error("Could not find the video service URL on the episode page");

  var streamUrl = await spFetchMica(template, episodeUrl);
  spLog("stream resolved");

  return JSON.stringify({
    streams: [{
      streamUrl: streamUrl,
      title: SP_STREAM_TITLE,
      headers: {
        "User-Agent": SP_UA,
        "Referer": SP_SITE_REFERER
      }
    }]
  });
}
