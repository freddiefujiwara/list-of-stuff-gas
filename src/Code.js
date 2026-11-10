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
const ITEMS_CACHE_KEY_PREFIX = 'items-response:v2:';
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

// Read every item sheet and build the response data. Each item gains
// a shortTitle (just the product name) and props (the property-like
// remainder of the title), split by splitTitle, so card and article
// surfaces can show the short name and put the properties in the
// card description. The original title is left untouched.
const fetchAllItems = () => {
  const ss = SpreadsheetApp.openById(spreadsheetId_());
  const sheetNames = ["room", "workman", "variety", "others"];

  return sheetNames.flatMap(name => {
    const sheet = ss.getSheetByName(name);
    const values = sheet.getDataRange().getValues();
    return sheetValuesToObjects(values).map(item => {
      const { name: shortTitle, props } = splitTitle(item.title);
      return { ...item, shortTitle, props };
    });
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

// ---------------------------------------------------------------------------
// Title splitting: shop titles (Rakuten's especially) bury the product
// name under promotional brackets and property-like tails (model
// numbers, sizes, colours, compatibility lists). splitTitle separates
// the two so surfaces can show just the name and move the rest into
// the card description. The split is heuristic and deliberately
// conservative: a title it cannot split comes back whole as the name.
// ---------------------------------------------------------------------------

// Bracketed segments whose content matches this are pure promotion
// and are dropped; other bracketed segments (【新品】, 【Office 2019
// H&B】...) count as properties.
const TITLE_PROMO_PATTERN =
  /オフ|%|倍|クーポン|1位|送料無料|セール|ポイント|特典|獲得|応援|最大|割引|半額|入荷|SALE/i;

const TITLE_COLOR_TOKENS = new Set([
  'ホワイト', 'ブラック', 'ブルー', 'レッド', 'グリーン', 'ピンク',
  'グレー', 'シルバー', 'ゴールド', 'ネイビー', 'ベージュ', 'ブラウン',
  'イエロー', 'パープル', 'オレンジ', 'クリア', 'アイボリー', 'カーキ',
]);

const TITLE_PROPERTY_TOKENS = new Set([
  '特大', '大サイズ', '中サイズ', '小サイズ', '本体', '単品', '専用', '兼用',
]);

// A token is property-like when it carries a spec: a model number or
// a number with a unit (digits mixed with anything else), a colour, a
// size/state word, or a compatibility marker. A bare number stays in
// the name — it is usually part of a model name (Anker 543).
const isPropertyToken = token => {
  if (/\d/.test(token)) {
    if (/^\d+$/.test(token)) {
      return false;
    }
    // A number with Japanese counter words (3色ボールペン, 12個セット)
    // reads as part of the product name, not as a spec.
    if (
      !/[A-Za-z]/.test(token) &&
      /(色|個セット|本セット|枚セット|個入り|本入り|枚入り)/.test(token)
    ) {
      return false;
    }
    return true;
  }
  if (TITLE_COLOR_TOKENS.has(token) || TITLE_PROPERTY_TOKENS.has(token)) {
    return true;
  }
  return /対応|向け|専用/.test(token);
};

const TITLE_NAME_SOFT_LIMIT = 30;

const splitTitle = rawTitle => {
  const title = String(rawTitle ?? '').trim();
  if (!title) {
    return { name: '', props: '' };
  }
  const bracketProps = [];
  const withoutBrackets = title.replace(
    /【([^】]*)】|\[([^\]]*)\]/g,
    (_, g1, g2) => {
      const content = String(g1 ?? g2 ?? '').trim();
      if (content && !TITLE_PROMO_PATTERN.test(content)) {
        bracketProps.push(content);
      }
      return ' ';
    }
  );
  const tokens = withoutBrackets
    .split(/[\s　]+/)
    // Standalone '&' separators and a bare 送料無料 token are noise,
    // not name or properties.
    .filter(token => token !== '' && token !== '&' && token !== '＆' && token !== '送料無料');

  const nameTokens = [];
  const propTokens = [];
  let inProps = false;
  tokens.forEach(token => {
    if (!inProps && isPropertyToken(token)) {
      inProps = true;
    }
    if (!inProps && nameTokens.join(' ').length >= TITLE_NAME_SOFT_LIMIT) {
      inProps = true;
    }
    (inProps ? propTokens : nameTokens).push(token);
  });
  // A title that starts with a property token keeps its first token
  // as the name rather than ending up nameless.
  if (nameTokens.length === 0 && propTokens.length > 0) {
    nameTokens.push(propTokens.shift());
  }
  return {
    name: nameTokens.join(' '),
    props: [...bracketProps, ...propTokens].join(' '),
  };
};

// Build the whole article as a flat list of blocks:
// { type: 'heading1' | 'heading2' | 'text' | 'link' | 'toc', text }.
// Items from all tabs are merged and grouped by genre; genres appear in
// first-seen order and items keep sheet order within each genre. An
// item with a URL renders as a link card, so only its comment follows
// as text; an item without a URL falls back to the full text line.
// The subscriptions section comes last: names and their purpose
// notes, plus a link card for services whose sheet row carries a
// URL. Amounts never appear.
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
      const { name: title } = splitTitle(item.title);
      const url = String(item.url ?? '').trim();
      if (!url) {
        push('text', `${idx + 1}. ${buildItemLine({ ...item, title })}`);
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
  (subscriptions || []).forEach(({ name, purpose, url }) => {
    push('text', name);
    const note = String(purpose ?? '').trim();
    if (note) {
      push('text', note);
    }
    const clean = String(url ?? '').trim();
    if (clean) {
      push('link', normalizeArticleUrl(clean));
    }
  });
  return blocks;
};

// Services from the subscriptions sheet's raw values (header row
// included), as { name, purpose, url } entries. Amounts are never
// read into the output. Header, blank, total and school rows are
// skipped: the draft is public-facing.
const extractSubscriptions = values => {
  const objects = sheetValuesToObjects(values.slice());
  return objects
    .map(obj => ({
      name: String(obj.Service ?? '').trim(),
      purpose: String(obj.Purpose ?? '').trim(),
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
  // The Doc's file name is the article's public title. A regeneration
  // rewrites only the body and must never change the name: the Doc
  // was created as 持ち物リスト（試作） and renamed for publication,
  // and a save once restored the creation name over the published
  // one (2026-11-07). Capture the current name and put it back if
  // the save changed it.
  const file = DriveApp.getFileById(doc.getId());
  const nameBefore = file.getName();
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
  if (file.getName() !== nameBefore) {
    file.setName(nameBefore);
  }
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

// ---------------------------------------------------------------------------
// Admin API (doPost) for the list-of-stuff-admin site.
//
// The room sheet is rewritten by crawlRoom() from Rakuten ROOM, so the
// admin API manages the hand-edited sheets: the item sheets (workman,
// variety, others) and the subscriptions sheet. Authentication mirrors the other private sites (alarm,
// health, tweet): the owner's Google ID token, verified against the
// AVAILABLE_GMAILS allowlist, or a temporary share token issued by the
// owner (owner-equivalent; sessions are stored hashed in a
// share_sessions sheet in this spreadsheet). Actions:
//   { action: "list_items", sheet }             -> the sheet's items
//   { action: "create_item", sheet, item }      -> append one row
//   { action: "update_item", sheet, row, item } -> rewrite one data row
//   { action: "delete_item", sheet, row }       -> delete one data row
//   { action: "issue_share" }                   -> owner only
//   { action: "revoke_share" }                  -> owner only
// Every mutation clears the doGet response cache, so the public items
// API and everything built on it reflects the edit right away.
// ---------------------------------------------------------------------------

const ADMIN_SHEETS = ['workman', 'variety', 'others'];

const scriptProperty_ = name =>
  PropertiesService.getScriptProperties().getProperty(name);

const allowedEmails_ = () =>
  (scriptProperty_('AVAILABLE_GMAILS') || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(v => v.length > 0);

// Throws an Error when the token is missing, invalid, or not allowed.
const verifyIdToken_ = idToken => {
  if (!idToken) throw new Error('missing id token');
  const clientId = scriptProperty_('GOOGLE_OAUTH_CLIENT_ID');
  const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  let res;
  try {
    res = UrlFetchApp.fetch(tokenInfoUrl, { muteHttpExceptions: true });
  } catch (err) {
    // A transport-level failure (DNS, connection) is transient;
    // retry once before giving up. HTTP-level failures arrive as a
    // response (muteHttpExceptions) and are not retried.
    res = UrlFetchApp.fetch(tokenInfoUrl, { muteHttpExceptions: true });
  }
  if (res.getResponseCode() !== 200) throw new Error('token verification failed');
  const payload = JSON.parse(res.getContentText());
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new Error('invalid iss');
  }
  if (payload.aud !== clientId) throw new Error('invalid aud');
  const exp = Number(payload.exp || 0);
  if (!exp || exp * 1000 <= Date.now()) throw new Error('token expired');
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new Error('email not verified');
  }
  const email = String(payload.email || '').toLowerCase();
  if (!email) throw new Error('missing email');
  if (!allowedEmails_().includes(email)) throw new Error('forbidden email');
  return email;
};

// --- Temporary share sessions (same scheme as the alarm site) ---
const SHARE_SHEET_NAME = 'share_sessions';
// One month, so the owner can hand the link over well in advance.
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SHARE_HEADERS = [
  'token_hash',
  'issued_at',
  'expires_at',
  'revoked_at',
  'access_count',
  'last_accessed_at',
];

const getShareSheet_ = () => {
  const ss = SpreadsheetApp.openById(spreadsheetId_());
  let sheet = ss.getSheetByName(SHARE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHARE_SHEET_NAME);
    sheet.appendRow(SHARE_HEADERS);
  }
  return sheet;
};

const hashShareToken_ = token =>
  Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token))
    .map(byte => ((byte % 256) + 256) % 256)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

const readShareRows_ = () => {
  const sheet = getShareSheet_();
  const values = sheet.getDataRange().getValues();
  return { sheet, values };
};

const shareCellIso_ = value => {
  if (!value) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
};

const revokeActiveShareSessions_ = nowIso => {
  const { sheet, values } = readShareRows_();
  values.forEach((row, index) => {
    if (index === 0) {
      return;
    }
    const revokedAt = shareCellIso_(row[3]);
    const expiresAt = shareCellIso_(row[2]);
    if (!revokedAt && expiresAt && expiresAt > nowIso) {
      sheet.getRange(index + 1, 4).setValue(nowIso);
    }
  });
};

const issueShareSession_ = () => {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + SHARE_TTL_SECONDS * 1000).toISOString();
  revokeActiveShareSessions_(nowIso);
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  getShareSheet_().appendRow([hashShareToken_(token), nowIso, expiresIso, '', 0, '']);
  return {
    share_token: token,
    issued_at: nowIso,
    expires_at: expiresIso,
    ttl_seconds: SHARE_TTL_SECONDS,
  };
};

const revokeShareSession_ = () => {
  revokeActiveShareSessions_(new Date().toISOString());
  return { revoked: true };
};

const validateShareToken_ = token => {
  if (!token) {
    return null;
  }
  const hash = hashShareToken_(token);
  const { sheet, values } = readShareRows_();
  const nowIso = new Date().toISOString();
  for (let index = 1; index < values.length; index += 1) {
    const row = values[index];
    if (row[0] !== hash) {
      continue;
    }
    if (shareCellIso_(row[3])) {
      return null;
    }
    const expiresAt = shareCellIso_(row[2]);
    if (!expiresAt || expiresAt <= nowIso) {
      return null;
    }
    sheet.getRange(index + 1, 5).setValue(Number(row[4] || 0) + 1);
    sheet.getRange(index + 1, 6).setValue(nowIso);
    return { expires_at: expiresAt };
  }
  return null;
};

// --- Item CRUD on the hand-edited sheets ---

// Only the hand-edited item sheets may be touched through the item
// actions; the room sheet is owned by crawlRoom(). The subscriptions
// sheet has its own shape and its own functions below.
const adminSheet_ = name => {
  if (!ADMIN_SHEETS.includes(name)) {
    throw new Error(`sheet is not editable: ${name}`);
  }
  return getSheet(name);
};

const readAdminItems_ = name => {
  const sheet = adminSheet_(name);
  const values = sheet.getDataRange().getValues();
  return values.slice(1).map((row, index) => ({
    row: index + 2,
    title: row[0] ?? '',
    image: row[1] ?? '',
    url: row[2] ?? '',
    price: row[3] ?? '',
    unit: row[4] ?? '',
    genre: row[5] ?? '',
    comment: row[6] ?? '',
  }));
};

// Coerce one item payload into a sheet row in the fixed column order
// (title, image, url, price, unit, genre, comment). Price and unit are
// stored as numbers when they parse as one, blank otherwise.
const normalizeItemRow_ = item => {
  const src = item || {};
  const text = v => (v === null || v === undefined ? '' : String(v));
  const number = v => {
    if (v === null || v === undefined || String(v).trim() === '') return '';
    const n = Number(v);
    return isFinite(n) ? n : '';
  };
  return [
    text(src.title),
    text(src.image),
    text(src.url),
    number(src.price),
    number(src.unit),
    text(src.genre),
    text(src.comment),
  ];
};

const checkedRow_ = (sheet, row) => {
  const n = Number(row);
  if (!Number.isInteger(n) || n < 2 || n > sheet.getLastRow()) {
    throw new Error(`row out of range: ${row}`);
  }
  return n;
};

const createItem_ = (name, item) => {
  const sheet = adminSheet_(name);
  sheet.appendRow(normalizeItemRow_(item));
  clearItemsCache();
  return { row: sheet.getLastRow() };
};

const updateItem_ = (name, row, item) => {
  const sheet = adminSheet_(name);
  const n = checkedRow_(sheet, row);
  sheet.getRange(n, 1, 1, 7).setValues([normalizeItemRow_(item)]);
  clearItemsCache();
  return { row: n };
};

const deleteItem_ = (name, row) => {
  const sheet = adminSheet_(name);
  const n = checkedRow_(sheet, row);
  sheet.deleteRow(n);
  clearItemsCache();
  return { row: n };
};

// The distinct genre values across all item sheets (room included:
// the genres are shared by every item), in first-appearance order.
// The admin form offers them as a dropdown.
const listGenres_ = () => {
  const seen = [];
  ['room', 'workman', 'variety', 'others'].forEach(name => {
    const values = getSheet(name).getDataRange().getValues();
    values.slice(1).forEach(row => {
      const genre = row[5];
      if (genre && !seen.includes(genre)) {
        seen.push(genre);
      }
    });
  });
  return seen;
};

// --- Subscriptions ---
// Columns: Service, Purpose, Yearly Cost, Monthly Cost, Ratio, URL.
// The sheet's own convention is kept: exactly one of the cost cells
// holds the entered amount and the other derives it by formula
// (monthly = yearly / 12, or yearly = monthly * 12). The row's basis
// says which side is entered. The Ratio cell is a formula against the
// totals row's monthly sum; structural inserts/deletes shift it like
// the sheet does, so the admin only writes it for new rows. The totals
// row (the one with =SUM(...) in a cost column) is never editable,
// and new rows are inserted just above it so the SUM ranges and the
// ratio references keep covering every subscription.
const SUBSCRIPTION_SHEET = 'subscriptions';

const findTotalsRow_ = sheet => {
  const formulas = sheet.getDataRange().getFormulas();
  for (let i = 1; i < formulas.length; i++) {
    if (/^=SUM\(/i.test(formulas[i][2] || '') || /^=SUM\(/i.test(formulas[i][3] || '')) {
      return i + 1;
    }
  }
  return 0;
};

const subscriptionBasis_ = (cFormula, dFormula) => {
  if (/^=C\d+\/12/.test(dFormula || '')) return 'yearly';
  if (/^=D\d+\*12/.test(cFormula || '')) return 'monthly';
  return 'yearly';
};

const readSubscriptions_ = () => {
  const sheet = getSheet(SUBSCRIPTION_SHEET);
  const values = sheet.getDataRange().getValues();
  const formulas = sheet.getDataRange().getFormulas();
  const totalsRow = findTotalsRow_(sheet);
  return values
    .slice(1)
    .map((row, index) => ({
      row: index + 2,
      service: row[0] ?? '',
      purpose: row[1] ?? '',
      yearly: row[2] ?? '',
      monthly: row[3] ?? '',
      ratio: row[4] ?? '',
      url: row[5] ?? '',
      basis: subscriptionBasis_(formulas[index + 1][2], formulas[index + 1][3]),
    }))
    .filter(sub => sub.row !== totalsRow);
};

// Build the A:F cells for one subscription at a given row. amounts:
// sub.amount is the entered cost on the sub.basis side; the other
// side becomes the deriving formula, like the sheet's own rows.
const subscriptionCells_ = (sub, row, ratioFormula) => {
  const src = sub || {};
  const text = v => (v === null || v === undefined ? '' : String(v));
  const amount =
    src.amount === null || src.amount === undefined || String(src.amount).trim() === ''
      ? ''
      : isFinite(Number(src.amount))
        ? Number(src.amount)
        : '';
  let yearly = '';
  let monthly = '';
  if (amount !== '') {
    if (src.basis === 'monthly') {
      monthly = amount;
      yearly = `=D${row}*12`;
    } else {
      yearly = amount;
      monthly = `=C${row}/12`;
    }
  }
  return [text(src.service), text(src.purpose), yearly, monthly, ratioFormula, text(src.url)];
};

const createSubscription_ = sub => {
  const sheet = getSheet(SUBSCRIPTION_SHEET);
  const totalsRow = findTotalsRow_(sheet);
  let row;
  let newTotalsRow = totalsRow;
  if (totalsRow > 0) {
    sheet.insertRowsBefore(totalsRow);
    row = totalsRow;
    newTotalsRow = totalsRow + 1;
  } else {
    row = sheet.getLastRow() + 1;
  }
  const cells = subscriptionCells_(sub, row, '');
  if ((cells[2] !== '' || cells[3] !== '') && newTotalsRow > 0) {
    cells[4] = `=D${row}/$D$${newTotalsRow}`;
  }
  sheet.getRange(row, 1, 1, 6).setValues([cells]);
  return { row };
};

const checkedSubscriptionRow_ = (sheet, row) => {
  const n = checkedRow_(sheet, row);
  if (n === findTotalsRow_(sheet)) {
    throw new Error('the totals row is not editable');
  }
  return n;
};

const updateSubscription_ = (row, sub) => {
  const sheet = getSheet(SUBSCRIPTION_SHEET);
  const n = checkedSubscriptionRow_(sheet, row);
  const cells = subscriptionCells_(sub, n, '');
  // The Ratio cell (E) is left untouched: its formula keeps pointing
  // at the totals row, exactly as the sheet maintains it.
  sheet.getRange(n, 1, 1, 4).setValues([cells.slice(0, 4)]);
  sheet.getRange(n, 6).setValue(cells[5]);
  return { row: n };
};

const deleteSubscription_ = row => {
  const sheet = getSheet(SUBSCRIPTION_SHEET);
  const n = checkedSubscriptionRow_(sheet, row);
  sheet.deleteRow(n);
  return { row: n };
};

const jsonOut_ = payload => {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  output.setContent(JSON.stringify(payload));
  return output;
};

const authError_ = err => {
  const message = (err && err.message) || 'unauthorized';
  return jsonOut_({ ok: false, status: message === 'forbidden email' ? 403 : 401, error: message });
};

export function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'invalid JSON body' });
  }

  // Issuing and revoking access links always requires the owner's
  // Google ID token; a share token cannot mint more share tokens.
  if (body.action === 'issue_share' || body.action === 'revoke_share') {
    try {
      verifyIdToken_(body.idToken);
    } catch (err) {
      return authError_(err);
    }
    try {
      const result = body.action === 'issue_share' ? issueShareSession_() : revokeShareSession_();
      return jsonOut_({ ok: true, ...result });
    } catch (err) {
      return jsonOut_({ ok: false, error: err.message });
    }
  }

  // The remaining actions accept the owner's ID token or a share token
  // from an issued access link (owner-equivalent).
  let shareSession = null;
  if (body.share_token) {
    try {
      shareSession = validateShareToken_(body.share_token);
    } catch (err) {
      return jsonOut_({ ok: false, error: err.message });
    }
    if (!shareSession) {
      return jsonOut_({ ok: false, status: 401, error: 'share session expired or invalid' });
    }
  } else {
    try {
      verifyIdToken_(body.idToken);
    } catch (err) {
      return authError_(err);
    }
  }
  const out = payload =>
    shareSession ? { ...payload, _share: { expires_at: shareSession.expires_at } } : payload;

  try {
    if (body.action === 'list_genres') {
      return jsonOut_(out({ ok: true, genres: listGenres_() }));
    }
    if (body.sheet === SUBSCRIPTION_SHEET) {
      if (body.action === 'list_items') {
        return jsonOut_(out({ ok: true, sheet: body.sheet, subscriptions: readSubscriptions_() }));
      }
      if (body.action === 'create_item') {
        return jsonOut_(out({ ok: true, ...createSubscription_(body.item) }));
      }
      if (body.action === 'update_item') {
        return jsonOut_(out({ ok: true, ...updateSubscription_(body.row, body.item) }));
      }
      if (body.action === 'delete_item') {
        return jsonOut_(out({ ok: true, ...deleteSubscription_(body.row) }));
      }
      return jsonOut_({ ok: false, error: 'unknown action' });
    }
    if (body.action === 'list_items') {
      return jsonOut_(out({ ok: true, sheet: body.sheet, items: readAdminItems_(body.sheet) }));
    }
    if (body.action === 'create_item') {
      return jsonOut_(out({ ok: true, ...createItem_(body.sheet, body.item) }));
    }
    if (body.action === 'update_item') {
      return jsonOut_(out({ ok: true, ...updateItem_(body.sheet, body.row, body.item) }));
    }
    if (body.action === 'delete_item') {
      return jsonOut_(out({ ok: true, ...deleteItem_(body.sheet, body.row) }));
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: err.message });
  }
  return jsonOut_({ ok: false, error: 'unknown action' });
}

export { buildItemLine, buildListArticleBlocks, createSubscription_, deleteSubscription_, doPost, extractSubscriptions, issueShareSession_, listGenres_, normalizeArticleUrl, normalizeItemRow_, readAdminItems_, readSubscriptions_, revokeShareSession_, splitTitle, subscriptionCells_, updateSubscription_, validateShareToken_, verifyIdToken_ };
