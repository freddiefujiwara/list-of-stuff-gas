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

// ---------------------------------------------------------------------------
// Blog article draft generation (prototype).
//
// generateListArticleDraft() turns the item sheets into a Google Doc, so
// blog-gas can render it as an article: items from every tab are merged
// and grouped under one heading per genre, and for each item the URL
// comes first as its own standalone paragraph (the shape blog-gas turns
// into a link card), followed by the item's comment as plain text below
// the card. The output is one fixed dummy document (a staging
// dummy article) whose ID is kept in the script property
// LIST_ARTICLE_DUMMY_DOC_ID; every run replaces its body. The generator
// is manual-run: setupListArticleTrigger() installs the every-6-hours
// trigger, and is itself run manually, only after the dummy output has
// been verified.
//
// Privacy rules for this public-facing draft: per-item prices are fine,
// but no grand total or sum is ever written, and the subscriptions
// section lists service names and official-site URLs only (no amounts,
// no school names).
// ---------------------------------------------------------------------------

const LIST_ARTICLE_DRAFT_FOLDER_ID = '1tTl57xXMEYIqKmo8L0EbtRj7N1VfrNAC';
const LIST_ARTICLE_DUMMY_DOC_PROPERTY = 'LIST_ARTICLE_DUMMY_DOC_ID';

const LIST_ARTICLE_SHEETS = ['room', 'workman', 'variety', 'others'];

// Format a price cell ("2029", 2029, "¥4,380") for display; blank or
// non-numeric cells produce no price text.
const formatItemPrice = value => {
  if (value === null || value === undefined || String(value).trim() === '') {
    return '';
  }
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  if (!isFinite(n)) {
    return '';
  }
  return `¥${Math.round(n).toLocaleString('en-US')}`;
};

// One display line for an item: title, price, unit (only when > 1) and
// comment. Never any total.
const buildItemLine = item => {
  const title = String(item.title ?? '').trim();
  const details = [];
  const price = formatItemPrice(item.price);
  if (price) {
    details.push(price);
  }
  const unit = Number(item.unit);
  if (isFinite(unit) && unit > 1) {
    details.push(`×${unit}`);
  }
  const head = details.length ? `${title}（${details.join(' ')}）` : title;
  const comment = String(item.comment ?? '').trim();
  return comment ? `${head} ${comment}` : head;
};

// URLs in the sheet can contain raw Japanese text and spaces (Google
// search links). Written into the Doc as-is they are not recognised as
// standalone URL paragraphs, so they never become link cards. Encode
// exactly the characters that break URL recognition — spaces and
// non-ASCII — and leave everything else (including existing %XX
// sequences) untouched.
const normalizeArticleUrl = url =>
  String(url).replace(/ |[^\x00-\x7F]/g, ch =>
    ch === ' ' ? '%20' : encodeURIComponent(ch)
  );

// Build the whole article as a flat list of blocks:
// { type: 'heading1' | 'heading2' | 'text' | 'link' | 'toc', text }.
// Items from all tabs are merged and grouped by genre; genres appear in
// first-seen order and items keep sheet order within each genre. An
// item with a URL renders as a link card, so only its comment follows
// as text; an item without a URL falls back to the full text line.
// The subscriptions section comes last: names, plus a link card for
// services whose sheet row carries a URL. Amounts never appear.
const buildListArticleBlocks = (itemsByTab, subscriptions) => {
  const blocks = [];
  const push = (type, text) => blocks.push({ type, text });

  const genreOrder = [];
  const byGenre = new Map();
  LIST_ARTICLE_SHEETS.forEach(sheet => {
    (itemsByTab[sheet] || [])
      .filter(item => String(item.title ?? '').trim() !== '')
      .forEach(item => {
        const genre = String(item.genre ?? '').trim() || 'その他';
        if (!byGenre.has(genre)) {
          byGenre.set(genre, []);
          genreOrder.push(genre);
        }
        byGenre.get(genre).push(item);
      });
  });

  genreOrder.forEach(genre => {
    push('heading2', genre);
    push('toc');
    // Each item's name, numbered within the genre, sits directly above
    // its card as plain text — deliberately NOT a heading, so the
    // article's [[目次]] TOCs (one per genre, from the 'toc' block
    // above) list the genres only, not every item. The comment
    // follows below the card.
    byGenre.get(genre).forEach((item, idx) => {
      const title = String(item.title ?? '').trim();
      const url = String(item.url ?? '').trim();
      if (!url) {
        push('text', `${idx + 1}. ${buildItemLine(item)}`);
        return;
      }
      push('text', `${idx + 1}. ${title}`);
      push('link', normalizeArticleUrl(url));
      const comment = String(item.comment ?? '').trim();
      if (comment) {
        push('text', comment);
      }
    });
  });

  push('heading2', 'サブスクリプション');
  push('toc');
  (subscriptions || []).forEach(({ name, url }) => {
    push('text', name);
    const clean = String(url ?? '').trim();
    if (clean) {
      push('link', normalizeArticleUrl(clean));
    }
  });
  return blocks;
};

// Services from the subscriptions sheet's raw values (header row
// included), as { name, url } pairs. Amounts are never read into the
// output. Header, blank, total and school rows are skipped: the draft
// is public-facing.
const extractSubscriptions = values => {
  const objects = sheetValuesToObjects(values.slice());
  return objects
    .map(obj => ({
      name: String(obj.Service ?? '').trim(),
      url: String(obj.URL ?? '').trim(),
    }))
    .filter(
      ({ name }) =>
        name !== '' &&
        !/合計|total/i.test(name) &&
        !/学校|中学校|高等学校/.test(name)
    );
};

// Read every source sheet up front, so the Doc body is only replaced
// once the full content exists (fetch-before-clear, same pattern as
// crawlRoom).
const readListArticleSource = () => {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const itemsByTab = {};
  LIST_ARTICLE_SHEETS.forEach(sheet => {
    const values = ss.getSheetByName(sheet).getDataRange().getValues();
    itemsByTab[sheet] = sheetValuesToObjects(values.slice());
  });
  const subscriptionValues = ss
    .getSheetByName('subscriptions')
    .getDataRange()
    .getValues();
  return {
    itemsByTab,
    subscriptions: extractSubscriptions(subscriptionValues),
  };
};

// The one fixed dummy document the generator writes into. Created in
// the blog drafts folder on first use; its ID is stored in a script
// property so every later run reuses (and replaces) the same Doc.
const getListArticleDoc = () => {
  const properties = PropertiesService.getScriptProperties();
  const docId = properties.getProperty(LIST_ARTICLE_DUMMY_DOC_PROPERTY);
  if (docId) {
    return DocumentApp.openById(docId);
  }
  const doc = DocumentApp.create('持ち物リスト（試作）');
  DriveApp.getFileById(doc.getId()).moveTo(
    DriveApp.getFolderById(LIST_ARTICLE_DRAFT_FOLDER_ID)
  );
  properties.setProperty(LIST_ARTICLE_DUMMY_DOC_PROPERTY, doc.getId());
  return doc;
};

export function generateListArticleDraft() {
  // Build the entire content in memory before touching the Doc, so a
  // failed read can never leave a half-written document behind.
  const { itemsByTab, subscriptions } = readListArticleSource();
  const blocks = buildListArticleBlocks(itemsByTab, subscriptions);

  const doc = getListArticleDoc();
  const body = doc.getBody();
  body.clear();
  blocks.forEach(block => {
    const { type, text } = block;
    const paragraph = body.appendParagraph(type === 'toc' ? '[[目次]]' : text);
    if (type === 'heading1') {
      paragraph.setHeading(DocumentApp.ParagraphHeading.HEADING1);
    } else if (type === 'heading2') {
      paragraph.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    }
  });
  doc.saveAndClose();
  Logger.log(`Updated list article draft: ${doc.getUrl()}`);
  return doc.getUrl();
}

// Install the every-6-hours trigger for generateListArticleDraft().
// Idempotent: all existing triggers for the handler are deleted first,
// so re-running this can never stack duplicates. Run manually, and only
// after the dummy document's output has been verified — nothing calls
// this automatically.
export function setupListArticleTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'generateListArticleDraft')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('generateListArticleDraft')
    .timeBased()
    .everyHours(6)
    .create();
}

export { buildItemLine, buildListArticleBlocks, extractSubscriptions, normalizeArticleUrl };
