import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  doPost,
  issueOwnerSession_,
  issueShareSession_,
  normalizeItemRow_,
  readAdminItems_,
  revokeShareSession_,
  validateOwnerToken_,
  validateShareToken_,
  verifyIdToken_,
} from "../src/Code.js";

const HEADER = ["title", "image", "url", "price", "unit", "genre", "comment"];
const SHARE_HEADER = [
  "token_hash",
  "issued_at",
  "expires_at",
  "revoked_at",
  "access_count",
  "last_accessed_at",
];

const makeSheet = (rows, formulas) => {
  const state = {
    rows: rows.map((r) => [...r]),
    formulas: (formulas || rows.map((r) => r.map(() => ""))).map((r) => [...r]),
  };
  const writeCell = (r, c, v) => {
    if (typeof v === "string" && v.startsWith("=")) {
      state.formulas[r][c] = v;
      state.rows[r][c] = "";
    } else {
      state.rows[r][c] = v;
      state.formulas[r][c] = "";
    }
  };
  return {
    state,
    getRange: vi.fn((r, c, nr = 1, nc = 1) => ({
      setValue: vi.fn((v) => writeCell(r - 1, c - 1, v)),
      setValues: vi.fn((vv) => {
        vv.forEach((rowVals, i) =>
          rowVals.forEach((v, j) => {
            if (!state.rows[r - 1 + i]) state.rows[r - 1 + i] = [];
            if (!state.formulas[r - 1 + i]) state.formulas[r - 1 + i] = [];
            writeCell(r - 1 + i, c - 1 + j, v);
          })
        );
      }),
      getValues: vi.fn(() =>
        state.rows.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc))
      ),
      getFormulas: vi.fn(() =>
        state.formulas.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc))
      ),
      clearContent: vi.fn(),
    })),
    getDataRange: vi.fn(() => ({
      getValues: () => state.rows.map((r) => [...r]),
      getFormulas: () => state.formulas.map((r) => [...r]),
    })),
    getLastRow: vi.fn(() => state.rows.length),
    appendRow: vi.fn((row) => {
      state.rows.push([...row]);
      state.formulas.push(row.map(() => ""));
    }),
    deleteRow: vi.fn((n) => {
      state.rows.splice(n - 1, 1);
      state.formulas.splice(n - 1, 1);
    }),
    insertRowsBefore: vi.fn((n) => {
      state.rows.splice(n - 1, 0, []);
      state.formulas.splice(n - 1, 0, []);
    }),
  };
};

let sheets;
let spreadsheet;
let outputs;
let tokenPayload;
let tokenHttpCode;
let cacheRemoveAll;
let uuidCounter;

const validPayload = () => ({
  iss: "https://accounts.google.com",
  aud: "client-123",
  exp: Math.floor(Date.now() / 1000) + 3600,
  email_verified: "true",
  email: "owner@example.com",
});

const post = (body) =>
  doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } });

const lastJson = () => JSON.parse(outputs[outputs.length - 1].content);

beforeEach(() => {
  sheets = {
    workman: makeSheet([
      HEADER,
      ["Item A", "a.jpg", "https://example.com/a", 1000, 2, "GenreA", "note A"],
      ["Item B", "", "", "", "", "", ""],
    ]),
    variety: makeSheet([HEADER]),
    others: makeSheet([HEADER, ["Item C", "c.jpg", "", 500, 1, "GenreC", ""]]),
    room: makeSheet([HEADER, ["Room item", "", "", 100, 1, "GenreR", ""]]),
    subscriptions: makeSheet([["Service"], ["Netflix"]]),
  };
  spreadsheet = {
    getSheetByName: vi.fn((name) => sheets[name] || null),
    insertSheet: vi.fn((name) => {
      sheets[name] = makeSheet([]);
      return sheets[name];
    }),
  };
  outputs = [];
  tokenPayload = validPayload();
  tokenHttpCode = 200;
  cacheRemoveAll = vi.fn();
  uuidCounter = 0;

  global.SpreadsheetApp = { openById: vi.fn(() => spreadsheet) };
  global.ContentService = {
    createTextOutput: vi.fn(() => {
      const o = {
        content: "",
        setMimeType: vi.fn(() => o),
        setContent: vi.fn((c) => {
          o.content = c;
          return o;
        }),
      };
      outputs.push(o);
      return o;
    }),
    MimeType: { JSON: "JSON", JAVASCRIPT: "JAVASCRIPT" },
  };
  global.UrlFetchApp = {
    fetch: vi.fn(() => ({
      getResponseCode: () => tokenHttpCode,
      getContentText: () => JSON.stringify(tokenPayload),
    })),
  };
  global.PropertiesService = {
    getScriptProperties: vi.fn(() => ({
      getProperty: vi.fn(
        (name) =>
          ({
            AVAILABLE_GMAILS: "owner@example.com, second@example.com",
            GOOGLE_OAUTH_CLIENT_ID: "client-123",
            DATA_BASE_URL: "http://home-api.example",
          })[name] || null
      ),
    })),
  };
  global.Utilities = {
    DigestAlgorithm: { SHA_256: "SHA_256" },
    computeDigest: vi.fn((algo, input) => {
      const s = String(input);
      return Array.from({ length: 32 }, (_, i) => s.charCodeAt(i % s.length) || 0);
    }),
    getUuid: vi.fn(
      () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`
    ),
  };
  global.CacheService = {
    getScriptCache: vi.fn(() => ({
      get: vi.fn(() => null),
      getAll: vi.fn(() => ({})),
      putAll: vi.fn(),
      removeAll: cacheRemoveAll,
    })),
  };
  global.Logger = { log: vi.fn() };
});

describe("doPost body parsing and auth", () => {
  it("rejects an invalid JSON body", () => {
    post("{not json");
    expect(lastJson()).toEqual({ ok: false, error: "invalid JSON body" });
  });

  it("rejects a missing ID token", () => {
    post({ action: "list_items", sheet: "workman" });
    expect(lastJson()).toMatchObject({ ok: false, status: 401, error: "missing id token" });
  });

  it("rejects a token the verifier endpoint refuses", () => {
    tokenHttpCode = 400;
    post({ action: "list_items", sheet: "workman", idToken: "bad" });
    expect(lastJson()).toMatchObject({ ok: false, status: 401, error: "token verification failed" });
  });

  it("rejects a token for another audience", () => {
    tokenPayload = { ...validPayload(), aud: "someone-else" };
    post({ action: "list_items", sheet: "workman", idToken: "x" });
    expect(lastJson()).toMatchObject({ ok: false, error: "invalid aud" });
  });

  it("rejects an expired token", () => {
    tokenPayload = { ...validPayload(), exp: Math.floor(Date.now() / 1000) - 10 };
    post({ action: "list_items", sheet: "workman", idToken: "x" });
    expect(lastJson()).toMatchObject({ ok: false, error: "token expired" });
  });

  it("rejects an unverified email", () => {
    tokenPayload = { ...validPayload(), email_verified: false };
    post({ action: "list_items", sheet: "workman", idToken: "x" });
    expect(lastJson()).toMatchObject({ ok: false, error: "email not verified" });
  });

  it("rejects a valid token for a non-allowlisted email with 403", () => {
    tokenPayload = { ...validPayload(), email: "stranger@example.com" };
    post({ action: "list_items", sheet: "workman", idToken: "x" });
    expect(lastJson()).toMatchObject({ ok: false, status: 403, error: "forbidden email" });
  });

  it("rejects an unknown action for an authorized owner", () => {
    post({ action: "nuke", idToken: "x" });
    expect(lastJson()).toEqual({ ok: false, error: "unknown action" });
  });

  it("verifyIdToken_ returns the allowlisted email", () => {
    expect(verifyIdToken_("token")).toBe("owner@example.com");
  });
});

describe("item CRUD", () => {
  it("lists items with their sheet row numbers", () => {
    post({ action: "list_items", sheet: "workman", idToken: "x" });
    const res = lastJson();
    expect(res.ok).toBe(true);
    expect(res.items).toEqual([
      { row: 2, title: "Item A", image: "a.jpg", url: "https://example.com/a", price: 1000, unit: 2, genre: "GenreA", comment: "note A", flag: "" },
      { row: 3, title: "Item B", image: "", url: "", price: "", unit: "", genre: "", comment: "", flag: "" },
    ]);
  });

  it("refuses to create on the room sheet (owned by the ROOM sync)", () => {
    post({ action: "create_item", sheet: "room", item: { title: "x" }, idToken: "x" });
    expect(lastJson()).toEqual({ ok: false, error: "sheet is not editable: room" });
  });

  it("refuses a sheet that is neither an item sheet nor subscriptions", () => {
    post({ action: "create_item", sheet: "summary", item: { title: "x" }, idToken: "x" });
    expect(lastJson()).toEqual({ ok: false, error: "sheet is not editable: summary" });
  });

  it("creates an item, normalizing numbers, and clears the items cache", () => {
    post({
      action: "create_item",
      sheet: "variety",
      item: { title: "New", price: "2500", unit: "3", genre: "G" },
      idToken: "x",
    });
    expect(lastJson()).toEqual({ ok: true, row: 2 });
    expect(sheets.variety.state.rows[1]).toEqual(["New", "", "", 2500, 3, "G", "", ""]);
    expect(cacheRemoveAll).toHaveBeenCalled();
  });

  it("updates one row in place", () => {
    post({
      action: "update_item",
      sheet: "workman",
      row: 3,
      item: { title: "Item B2", price: 700, unit: 1, genre: "GenreB", comment: "c" },
      idToken: "x",
    });
    expect(lastJson()).toEqual({ ok: true, row: 3 });
    expect(sheets.workman.state.rows[2]).toEqual(["Item B2", "", "", 700, 1, "GenreB", "c", ""]);
  });

  it("rejects updates to the header row and beyond the last row", () => {
    post({ action: "update_item", sheet: "workman", row: 1, item: {}, idToken: "x" });
    expect(lastJson()).toEqual({ ok: false, error: "row out of range: 1" });
    post({ action: "delete_item", sheet: "workman", row: 99, idToken: "x" });
    expect(lastJson()).toEqual({ ok: false, error: "row out of range: 99" });
  });

  it("deletes a row so later rows shift up", () => {
    post({ action: "delete_item", sheet: "workman", row: 2, idToken: "x" });
    expect(lastJson()).toEqual({ ok: true, row: 2 });
    expect(sheets.workman.state.rows).toHaveLength(2);
    expect(readAdminItems_("workman")[0]).toMatchObject({ row: 2, title: "Item B" });
  });

  it("normalizeItemRow_ coerces types and tolerates a missing item", () => {
    expect(normalizeItemRow_(null)).toEqual(["", "", "", "", "", "", "", ""]);
    expect(
      normalizeItemRow_({ title: 42, price: "abc", unit: "2", comment: null })
    ).toEqual(["42", "", "", "", 2, "", "", ""]);
  });
});

describe("tidy-up flags", () => {
  it("sets and clears an item flag in the H column", () => {
    post({ action: "set_flag", sheet: "workman", row: 2, flagged: true, idToken: "x" });
    expect(lastJson()).toEqual({ ok: true, row: 2, flag: "整理対象" });
    expect(sheets.workman.state.rows[1][7]).toBe("整理対象");
    post({ action: "list_items", sheet: "workman", idToken: "x" });
    expect(lastJson().items[0].flag).toBe("整理対象");
    post({ action: "set_flag", sheet: "workman", row: 2, flagged: false, idToken: "x" });
    expect(lastJson()).toEqual({ ok: true, row: 2, flag: "" });
    expect(sheets.workman.state.rows[1][7]).toBe("");
  });

  it("keeps the flag when an item is edited without one", () => {
    post({ action: "set_flag", sheet: "workman", row: 2, flagged: true, idToken: "x" });
    post({
      action: "update_item",
      sheet: "workman",
      row: 2,
      item: { title: "Item A+", price: 1200, unit: 2, genre: "GenreA", comment: "note A" },
      idToken: "x",
    });
    expect(lastJson()).toEqual({ ok: true, row: 2 });
    expect(sheets.workman.state.rows[1][7]).toBe("整理対象");
  });

  it("lists room items read-only and flags them by URL in the flags sheet", () => {
    sheets.room = makeSheet([
      HEADER,
      ["Lamp", "l.jpg", "https://room.rakuten.co.jp/freddiefujiwara/111", 3000, 1, "家電にまつわる物", ""],
      ["Bag", "", "https://room.rakuten.co.jp/freddiefujiwara/222", 500, 1, "暮らしにまつわる物", ""],
    ]);
    post({ action: "list_items", sheet: "room", idToken: "x" });
    let res = lastJson();
    expect(res.ok).toBe(true);
    expect(res.items.map((i) => i.flag)).toEqual(["", ""]);

    post({ action: "set_flag", sheet: "room", url: "https://room.rakuten.co.jp/freddiefujiwara/111", flagged: true, idToken: "x" });
    expect(lastJson()).toEqual({ ok: true, url: "https://room.rakuten.co.jp/freddiefujiwara/111", flag: "整理対象" });
    expect(sheets.flags.state.rows).toEqual([["url"], ["https://room.rakuten.co.jp/freddiefujiwara/111"]]);

    // flagging twice does not duplicate the row
    post({ action: "set_flag", sheet: "room", url: "https://room.rakuten.co.jp/freddiefujiwara/111", flagged: true, idToken: "x" });
    expect(sheets.flags.state.rows).toHaveLength(2);

    post({ action: "list_items", sheet: "room", idToken: "x" });
    res = lastJson();
    expect(res.items.map((i) => i.flag)).toEqual(["整理対象", ""]);

    post({ action: "set_flag", sheet: "room", url: "https://room.rakuten.co.jp/freddiefujiwara/111", flagged: false, idToken: "x" });
    expect(lastJson().flag).toBe("");
    expect(sheets.flags.state.rows).toEqual([["url"]]);
  });

  it("refuses to flag a room item without a URL", () => {
    post({ action: "set_flag", sheet: "room", url: "", flagged: true, idToken: "x" });
    expect(lastJson().ok).toBe(false);
    expect(lastJson().error).toContain("url is required");
  });
});

describe("share sessions", () => {
  it("issues a token, accepts it for CRUD, then revokes it", () => {
    post({ action: "issue_share", idToken: "x" });
    const issued = lastJson();
    expect(issued.ok).toBe(true);
    expect(issued.share_token).toHaveLength(64);
    expect(sheets.share_sessions.state.rows[0]).toEqual(SHARE_HEADER);

    post({ action: "list_items", sheet: "others", share_token: issued.share_token });
    const listed = lastJson();
    expect(listed.ok).toBe(true);
    expect(listed._share.expires_at).toBe(issued.expires_at);
    expect(listed.items[0]).toMatchObject({ title: "Item C" });

    post({ action: "revoke_share", idToken: "x" });
    expect(lastJson()).toEqual({ ok: true, revoked: true });

    post({ action: "list_items", sheet: "others", share_token: issued.share_token });
    expect(lastJson()).toMatchObject({ ok: false, status: 401, error: "share session expired or invalid" });
  });

  it("never lets a share token mint another share token", () => {
    const issued = issueShareSession_();
    post({ action: "issue_share", share_token: issued.share_token });
    expect(lastJson()).toMatchObject({ ok: false, status: 401, error: "missing id token" });
  });

  it("rejects unknown and expired share tokens", () => {
    expect(validateShareToken_("")).toBeNull();
    expect(validateShareToken_("nope")).toBeNull();
    const issued = issueShareSession_();
    const sheet = sheets.share_sessions;
    sheet.state.rows[1][2] = new Date(Date.now() - 1000).toISOString();
    expect(validateShareToken_(issued.share_token)).toBeNull();
    // Cells read back as Date objects are compared as ISO strings too.
    sheet.state.rows[1][2] = new Date(Date.now() + 3600_000);
    expect(validateShareToken_(issued.share_token)).not.toBeNull();
  });

  it("issuing a new link revokes the previous one", () => {
    const first = issueShareSession_();
    const second = issueShareSession_();
    expect(validateShareToken_(first.share_token)).toBeNull();
    expect(validateShareToken_(second.share_token)).not.toBeNull();
    revokeShareSession_();
    expect(validateShareToken_(second.share_token)).toBeNull();
  });
});


describe("owner sessions", () => {
  const exchange = () => {
    post({ action: "exchange_session", idToken: "x" });
    return lastJson();
  };

  it("exchanges a Google ID token for a 30-day owner session", () => {
    const before = Date.now();
    const issued = exchange();
    expect(issued.ok).toBe(true);
    expect(issued.session_token).toHaveLength(64);
    expect(Date.parse(issued.expires_at) - before).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(sheets.owner_sessions.state.rows[0]).toEqual(SHARE_HEADER);
    expect(sheets.owner_sessions.state.rows[1][0]).not.toBe(issued.session_token);
  });

  it("rejects the exchange when the ID token is invalid", () => {
    tokenHttpCode = 400;
    post({ action: "exchange_session", idToken: "bad" });
    expect(lastJson().ok).toBe(false);
  });

  it("lets the owner session run admin actions", () => {
    const { session_token } = exchange();
    post({ action: "list_items", sheet: "others", session_token });
    const listed = lastJson();
    expect(listed.ok).toBe(true);
    expect(listed.items[0]).toMatchObject({ title: "Item C" });
    expect(sheets.owner_sessions.state.rows[1][4]).toBe(1);
  });

  it("rejects an unknown session token", () => {
    post({ action: "list_items", sheet: "others", session_token: "nope" });
    expect(lastJson()).toEqual({ ok: false, status: 401, error: "session expired or invalid" });
  });

  it("issuing a new owner session keeps the previous one valid", () => {
    const first = issueOwnerSession_();
    const second = issueOwnerSession_();
    expect(validateOwnerToken_(first.session_token)).not.toBeNull();
    expect(validateOwnerToken_(second.session_token)).not.toBeNull();
  });

  it("revokes the session on revoke_session (logout)", () => {
    const { session_token } = exchange();
    post({ action: "revoke_session", session_token });
    expect(lastJson()).toEqual({ ok: true, revoked: true });
    post({ action: "list_items", sheet: "others", session_token });
    expect(lastJson().ok).toBe(false);
  });

  it("lets an owner session issue share links, but never a share token", () => {
    const { session_token } = exchange();
    post({ action: "issue_share", session_token });
    const issued = lastJson();
    expect(issued.ok).toBe(true);
    expect(issued.share_token).toHaveLength(64);
    post({ action: "issue_share", share_token: issued.share_token });
    expect(lastJson()).toMatchObject({ ok: false, status: 401, error: "missing id token" });
  });
});

describe("list_genres", () => {
  it("collects distinct genres across the item sheets in first-appearance order", () => {
    post({ action: "list_genres", idToken: "x" });
    const res = lastJson();
    expect(res.ok).toBe(true);
    expect(res.genres).toEqual(["GenreR", "GenreA", "GenreC"]);
  });
});

describe("subscriptions admin", () => {
  const SUB_HEADER = ["Service", "Purpose", "Yearly Cost", "Monthly Cost", "Ratio", "URL"];
  beforeEach(() => {
    sheets.subscriptions = makeSheet(
      [
        SUB_HEADER,
        ["NHK", "tv", 21765, 1813.75, 0.015, "https://www.nhk.or.jp/"],
        ["DAZN", "baseball", 27600, 2300, 0.019, "https://www.dazn.com/"],
        ["", "", 49365, 4113.75, "", ""],
      ],
      [
        SUB_HEADER.map(() => ""),
        ["", "", "", "=C2/12", "=D2/$D$4", ""],
        ["", "", "=D3*12", "", "=D3/$D$4", ""],
        ["", "", "=SUM(C2:C3)", "=SUM(D2:D3)", "", ""],
      ]
    );
  });

  it("lists subscriptions without the totals row, with the basis detected", () => {
    post({ action: "list_items", sheet: "subscriptions", idToken: "x" });
    const res = lastJson();
    expect(res.ok).toBe(true);
    expect(res.subscriptions).toHaveLength(2);
    expect(res.subscriptions[0]).toMatchObject({ row: 2, service: "NHK", yearly: 21765, basis: "yearly" });
    expect(res.subscriptions[1]).toMatchObject({ row: 3, service: "DAZN", monthly: 2300, basis: "monthly" });
  });

  it("creates a yearly-based row above the totals row with deriving formulas", () => {
    post({ action: "create_item", sheet: "subscriptions", item: { service: "New", purpose: "p", basis: "yearly", amount: 12000, url: "https://x.example" }, idToken: "x" });
    expect(lastJson()).toMatchObject({ ok: true, row: 4 });
    expect(sheets.subscriptions.insertRowsBefore).toHaveBeenCalledWith(4);
    expect(sheets.subscriptions.state.rows[3].slice(0, 3)).toEqual(["New", "p", 12000]);
    expect(sheets.subscriptions.state.formulas[3][3]).toBe("=C4/12");
    expect(sheets.subscriptions.state.formulas[3][4]).toBe("=D4/$D$5");
  });

  it("creates a monthly-based row with the yearly side derived", () => {
    post({ action: "create_item", sheet: "subscriptions", item: { service: "M", purpose: "", basis: "monthly", amount: 500, url: "" }, idToken: "x" });
    expect(lastJson()).toMatchObject({ ok: true, row: 4 });
    expect(sheets.subscriptions.state.rows[3][3]).toBe(500);
    expect(sheets.subscriptions.state.formulas[3][2]).toBe("=D4*12");
  });

  it("updates amounts and the URL while leaving the ratio formula untouched", () => {
    post({ action: "update_item", sheet: "subscriptions", row: 3, item: { service: "DAZN", purpose: "baseball", basis: "monthly", amount: 2600, url: "https://www.dazn.com/" }, idToken: "x" });
    expect(lastJson()).toEqual({ ok: true, row: 3 });
    expect(sheets.subscriptions.state.rows[2][3]).toBe(2600);
    expect(sheets.subscriptions.state.formulas[2][2]).toBe("=D3*12");
    expect(sheets.subscriptions.state.formulas[2][4]).toBe("=D3/$D$4");
  });

  it("refuses to update or delete the totals row", () => {
    post({ action: "update_item", sheet: "subscriptions", row: 4, item: { service: "x" }, idToken: "x" });
    expect(lastJson().error).toContain("totals");
    post({ action: "delete_item", sheet: "subscriptions", row: 4, idToken: "x" });
    expect(lastJson().error).toContain("totals");
    expect(sheets.subscriptions.state.rows).toHaveLength(4);
  });

  it("deletes a data row", () => {
    post({ action: "delete_item", sheet: "subscriptions", row: 2, idToken: "x" });
    expect(lastJson()).toEqual({ ok: true, row: 2 });
    expect(sheets.subscriptions.state.rows.map((r) => r[0])).toEqual(["Service", "DAZN", ""]);
  });

  it("sets and clears a flag in the G column, and lists it", () => {
    post({ action: "set_flag", sheet: "subscriptions", row: 2, flagged: true, idToken: "x" });
    expect(lastJson()).toEqual({ ok: true, row: 2, flag: "整理対象" });
    expect(sheets.subscriptions.state.rows[1][6]).toBe("整理対象");
    post({ action: "list_items", sheet: "subscriptions", idToken: "x" });
    expect(lastJson().subscriptions[0].flag).toBe("整理対象");
    post({ action: "set_flag", sheet: "subscriptions", row: 2, flagged: false, idToken: "x" });
    expect(sheets.subscriptions.state.rows[1][6]).toBe("");
  });

  it("keeps the flag when a subscription is edited without one", () => {
    post({ action: "set_flag", sheet: "subscriptions", row: 3, flagged: true, idToken: "x" });
    post({ action: "update_item", sheet: "subscriptions", row: 3, item: { service: "DAZN", purpose: "baseball", basis: "monthly", amount: 2600, url: "https://www.dazn.com/" }, idToken: "x" });
    expect(lastJson()).toEqual({ ok: true, row: 3 });
    expect(sheets.subscriptions.state.rows[2][6]).toBe("整理対象");
  });

  it("refuses to flag the totals row", () => {
    post({ action: "set_flag", sheet: "subscriptions", row: 4, flagged: true, idToken: "x" });
    expect(lastJson().ok).toBe(false);
    expect(lastJson().error).toContain("totals");
  });
});

describe("resilience of the auth and share plumbing", () => {
  it("retries the tokeninfo fetch once after a transport failure", () => {
    const okResponse = {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify(validPayload()),
    };
    global.UrlFetchApp.fetch = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("DNS error");
      })
      .mockImplementation(() => okResponse);
    expect(verifyIdToken_("token")).toBe("owner@example.com");
    expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up when the tokeninfo fetch keeps failing", () => {
    global.UrlFetchApp.fetch = vi.fn(() => {
      throw new Error("DNS error");
    });
    expect(() => verifyIdToken_("token")).toThrow("DNS error");
    expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(2);
  });

  it("answers JSON when share validation hits a backend error", () => {
    global.SpreadsheetApp = {
      openById: vi.fn(() => {
        throw new Error("backend error");
      }),
    };
    post({ action: "list_items", sheet: "workman", share_token: "sometoken" });
    expect(lastJson()).toEqual({ ok: false, error: "backend error" });
  });

  it("answers JSON when issuing a share link hits a backend error", () => {
    global.SpreadsheetApp = {
      openById: vi.fn(() => {
        throw new Error("backend error");
      }),
    };
    post({ action: "issue_share", idToken: "x" });
    expect(lastJson()).toEqual({ ok: false, error: "backend error" });
  });
});
