const SPREADSHEET_ID = '1yxnHhfAT2cEF50hvajHoLMsW_sf7JlxnjFKeDFLNAkc';

// Environment separation (staging): when the SPREADSHEET_ID script
// property is set, it overrides the built-in production spreadsheet ID
// above. When the property is unset, behavior is identical to
// production.
const spreadsheetId_ = () =>
  PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') ||
  SPREADSHEET_ID;

// Simple fetch JSON helper
const fetchJson = url => JSON.parse(UrlFetchApp.fetch(url).getContentText());

const getSheet = name => SpreadsheetApp.openById(spreadsheetId_()).getSheetByName(name);

const clearSheet = (sh = getSheet('room')) => {
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, 7).clearContent();
  }
};

// Rakuten's image servers resize on the fly via an _ex=WxH query, so
// the sheet stores the resized URL: card thumbnails (a few hundred px
// wide) stop downloading the full-size product photo, and readers of
// the sheet — the list-of-stuff front-end included — need no
// host-specific handling of their own. URLs on other hosts, and URLs
// that already carry a query string, are stored unchanged.
const rakutenThumbnailUrl = url => {
  if (
    typeof url !== 'string' ||
    !/^https:\/\/(?:tshop|shop)\.r10s\.jp\//.test(url) ||
    url.includes('?')
  ) {
    return url;
  }
  return `${url}?_ex=400x400`;
};

const createRow = (item, c, x) => {
  Logger.log(item.name);
  return [
    item.name || '',
    rakutenThumbnailUrl(item.picture?.url || ''),
    item.url || '',
    item.price || '',
    1,
    c.name || '',
    x.content || '',
  ];
};

// The home data server base URL lives in the script property
// DATA_BASE_URL, not in this public source code.
const dataBaseUrl_ = () => {
  const value = PropertiesService.getScriptProperties().getProperty('DATA_BASE_URL');
  if (!value) {
    throw new Error('script property DATA_BASE_URL is not set');
  }
  return value;
};

export function crawlRoom() {
  // Fetch everything before touching the sheet: if a fetch fails, the
  // previous data stays in place instead of leaving an emptied sheet
  // behind (observed 2026-11-03, when one collects fetch returned a
  // plain-text "OK" and the cleared sheet was never rewritten).
  const collections = fetchJson(`${dataBaseUrl_()}/collections.json`).data || [];
  const rows = collections.flatMap(c => {
    Logger.log(c.name);
    const collects = fetchJson(`${dataBaseUrl_()}/collects_${c.id}.json`).data || [];
    return collects.map(x => createRow(x.item || {}, c, x));
  });

  Logger.log(`Fetched ${rows.length} items.`);
  clearSheet();
  if (rows.length) {
    getSheet('room').getRange(2, 1, rows.length, 7).setValues(rows);
  }

  // The room sheet was just rewritten, so drop the cached doGet response
  // instead of letting it age out via its TTL.
  clearItemsCache();
}

// Helper to convert 2D array from a sheet to an array of objects
const sheetValuesToObjects = values => {
  const headers = values.shift();
  return values.map(row =>
    headers.reduce((obj, header, index) => {
      obj[header] = row[index];
      return obj;
    }, {})
  );
};

// Helper to create the final output for doGet
const createJsonpOutput = (data, callback) => {
  const output = ContentService.createTextOutput();
  if (callback) {
    output.setMimeType(ContentService.MimeType.JAVASCRIPT);
    output.setContent(`${callback}&&${callback}(${JSON.stringify(data)});`);
  } else {
    output.setMimeType(ContentService.MimeType.JSON);
    output.setContent(JSON.stringify(data));
  }
  return output;
};

// Response cache for doGet, kept in the script cache so it is shared
// across all visitors and survives cold starts.
//
// The built response is about 101 KB of JSON, which exceeds the
// CacheService limit of 100 KB per value, so the JSON string is split
// into chunks stored under separate keys. A small manifest key records
// the chunk count and the total length, and a cached entry is only
// trusted when every chunk is present, the joined length matches, and
// the result parses as JSON; anything else falls back to the sheets.
//
// Freshness is TTL-based: a cache entry lives for
// ITEMS_CACHE_TTL_SECONDS, so sheet edits show up within that window
// at the latest. crawlRoom clears the cache immediately after it
// rewrites the room sheet. The TTL is the CacheService maximum (6h):
// a full sheet read takes seconds, and with this site's traffic a
// 10-minute TTL left most visits on the slow uncached path.
const ITEMS_CACHE_KEY_PREFIX = 'items-response:v1:';
const ITEMS_CACHE_META_KEY = `${ITEMS_CACHE_KEY_PREFIX}meta`;
const ITEMS_CACHE_TTL_SECONDS = 21600;
const ITEMS_CACHE_CHUNK_CHARS = 20000;

// Split a string into chunks of at most chunkSize characters, without
// splitting a surrogate pair across a chunk boundary.
const chunkString = (str, chunkSize) => {
  const chunks = [];
  let start = 0;
  while (start < str.length) {
    let end = Math.min(start + chunkSize, str.length);
    if (end < str.length) {
      const code = str.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        end += 1;
      }
    }
    chunks.push(str.slice(start, end));
    start = end;
  }
  return chunks;
};

const readItemsCache = () => {
  try {
    const cache = CacheService.getScriptCache();
    const metaText = cache.get(ITEMS_CACHE_META_KEY);
    if (!metaText) {
      return null;
    }
    const meta = JSON.parse(metaText);
    const keys = [];
    for (let i = 0; i < meta.chunks; i++) {
      keys.push(`${ITEMS_CACHE_KEY_PREFIX}${i}`);
    }
    const values = cache.getAll(keys);
    const parts = keys.map(key => values[key]);
    if (parts.some(part => typeof part !== 'string')) {
      return null;
    }
    const json = parts.join('');
    if (json.length !== meta.length) {
      return null;
    }
    return JSON.parse(json);
  } catch (e) {
    // A broken cache must never break the response.
    return null;
  }
};

const writeItemsCache = data => {
  try {
    const cache = CacheService.getScriptCache();
    const json = JSON.stringify(data);
    const chunks = chunkString(json, ITEMS_CACHE_CHUNK_CHARS);
    const entries = {
      [ITEMS_CACHE_META_KEY]: JSON.stringify({
        chunks: chunks.length,
        length: json.length,
      }),
    };
    chunks.forEach((chunk, index) => {
      entries[`${ITEMS_CACHE_KEY_PREFIX}${index}`] = chunk;
    });
    cache.putAll(entries, ITEMS_CACHE_TTL_SECONDS);
  } catch (e) {
    // Caching is best-effort: the response is served either way.
  }
};

const clearItemsCache = () => {
  try {
    const cache = CacheService.getScriptCache();
    const metaText = cache.get(ITEMS_CACHE_META_KEY);
    const keys = [ITEMS_CACHE_META_KEY];
    if (metaText) {
      const meta = JSON.parse(metaText);
      for (let i = 0; i < meta.chunks; i++) {
        keys.push(`${ITEMS_CACHE_KEY_PREFIX}${i}`);
      }
    }
    cache.removeAll(keys);
  } catch (e) {
    // Best-effort: a leftover entry expires on its own via the TTL.
  }
};

// Read every item sheet and build the response data.
const fetchAllItems = () => {
  const ss = SpreadsheetApp.openById(spreadsheetId_());
  const sheetNames = ["room", "workman", "variety", "others"];

  return sheetNames.flatMap(name => {
    const sheet = ss.getSheetByName(name);
    const values = sheet.getDataRange().getValues();
    return sheetValuesToObjects(values);
  });
};

export function doGet(e) {
  const cached = readItemsCache();
  if (cached !== null) {
    return createJsonpOutput(cached, e.parameter.callback);
  }

  const result = fetchAllItems();
  writeItemsCache(result);
  return createJsonpOutput(result, e.parameter.callback);
}
