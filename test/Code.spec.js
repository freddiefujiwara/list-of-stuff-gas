import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crawlRoom, doGet } from "../src/Code.js";

// Mockup of Google Apps Script global objects
const mockRange = {
  clearContent: vi.fn(),
  setValues: vi.fn(),
  getValues: vi.fn().mockImplementation(() => [
    ["header1", "header2"],
    ["value1", "value2"],
  ]),
};

const mockSheet = {
  getRange: vi.fn().mockReturnValue(mockRange),
  getLastRow: vi.fn().mockReturnValue(1),
  getDataRange: vi.fn().mockReturnValue(mockRange),
};

const mockSpreadsheet = {
  getSheetByName: vi.fn().mockReturnValue(mockSheet),
};

const mockContentService = {
  createTextOutput: vi.fn().mockReturnThis(),
  setMimeType: vi.fn().mockReturnThis(),
  setContent: vi.fn(),
  MimeType: {
    JSON: "JSON",
    JAVASCRIPT: "JAVASCRIPT",
  },
};

const mockUrlFetchApp = {
  fetch: vi.fn().mockReturnValue({
    getContentText: vi.fn(),
  }),
};

// Assign mocks to global scope
global.SpreadsheetApp = {
  openById: vi.fn().mockReturnValue(mockSpreadsheet),
};
global.ContentService = mockContentService;
global.UrlFetchApp = mockUrlFetchApp;
global.Logger = {
  log: vi.fn(),
};
global.PropertiesService = {
  getScriptProperties: vi.fn(() => ({
    getProperty: vi.fn(
      (name) => ({ DATA_BASE_URL: "http://home-api.example" })[name] || null
    ),
  })),
};

// In-memory stand-in for the script cache used by the doGet response cache
const createMockCache = () => {
  const store = new Map();
  return {
    store,
    get: vi.fn((key) => (store.has(key) ? store.get(key) : null)),
    getAll: vi.fn((keys) => {
      const values = {};
      keys.forEach((key) => {
        if (store.has(key)) {
          values[key] = store.get(key);
        }
      });
      return values;
    }),
    putAll: vi.fn((entries) => {
      Object.entries(entries).forEach(([key, value]) => store.set(key, value));
    }),
    removeAll: vi.fn((keys) => {
      keys.forEach((key) => store.delete(key));
    }),
  };
};

let mockCache;
global.CacheService = {
  getScriptCache: vi.fn(() => mockCache),
};

beforeEach(() => {
  mockCache = createMockCache();
});

describe("doGet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpreadsheet.getSheetByName.mockImplementation(sheetName => {
      if (sheetName === "room") {
        return {
          ...mockSheet,
          getDataRange: () => ({
            getValues: () => [
              ["header1", "header2"],
              ["value1", "value2"],
            ],
          }),
        };
      }
      return {
        ...mockSheet,
        getDataRange: () => ({
          getValues: () => [["header1", "header2"]], // Empty data for other sheets
        }),
      };
    });
  });

  it("should return JSON when no callback is provided", () => {
    const e = { parameter: {} };
    doGet(e);
    expect(mockContentService.setMimeType).toHaveBeenCalledWith("JSON");
    expect(mockContentService.setContent).toHaveBeenCalledWith(
      JSON.stringify([{ header1: "value1", header2: "value2" }])
    );
  });

  it("should return JSONP when a callback is provided", () => {
    const e = { parameter: { callback: "myCallback" } };
    doGet(e);
    expect(mockContentService.setMimeType).toHaveBeenCalledWith("JAVASCRIPT");
    expect(mockContentService.setContent).toHaveBeenCalledWith(
      'myCallback&&myCallback(' +
        JSON.stringify([{ header1: "value1", header2: "value2" }]) +
        ');'
    );
  });
});

describe("doGet response cache", () => {
  const META_KEY = "items-response:v1:meta";
  const CHUNK_KEY = (index) => `items-response:v1:${index}`;

  const stubSheetValues = (roomValues) => {
    mockSpreadsheet.getSheetByName.mockImplementation((sheetName) => ({
      ...mockSheet,
      getDataRange: () => ({
        getValues: () => (sheetName === "room" ? roomValues : [["h"]]),
      }),
    }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubSheetValues([["h"], ["v"]]);
  });

  it("serves the second request from the cache without reopening the spreadsheet", () => {
    const e = { parameter: {} };
    doGet(e);
    doGet(e);
    expect(global.SpreadsheetApp.openById).toHaveBeenCalledTimes(1);
    expect(mockContentService.setContent).toHaveBeenLastCalledWith(
      JSON.stringify([{ h: "v" }])
    );
  });

  it("wraps cached data as JSONP when a callback is provided", () => {
    doGet({ parameter: {} });
    doGet({ parameter: { callback: "cb" } });
    expect(global.SpreadsheetApp.openById).toHaveBeenCalledTimes(1);
    expect(mockContentService.setContent).toHaveBeenLastCalledWith(
      "cb&&cb(" + JSON.stringify([{ h: "v" }]) + ");"
    );
  });

  it("splits a large response into multiple cache chunks", () => {
    const big = "x".repeat(45000);
    stubSheetValues([["h"], [big]]);
    doGet({ parameter: {} });

    const json = JSON.stringify([{ h: big }]);
    const meta = JSON.parse(mockCache.store.get(META_KEY));
    expect(meta).toEqual({ chunks: 3, length: json.length });
    const parts = [0, 1, 2].map((i) => mockCache.store.get(CHUNK_KEY(i)));
    parts.forEach((part) => expect(part.length).toBeLessThanOrEqual(20000));
    expect(parts.join("")).toBe(json);
  });

  it("does not split a surrogate pair across a chunk boundary", () => {
    // The JSON prefix `[{"h":"` is 7 chars, so 19992 filler chars place
    // the emoji's high surrogate exactly at the end of the first chunk.
    const value = "a".repeat(19992) + "😀" + "b".repeat(10);
    stubSheetValues([["h"], [value]]);
    doGet({ parameter: {} });

    const json = JSON.stringify([{ h: value }]);
    const meta = JSON.parse(mockCache.store.get(META_KEY));
    expect(meta.chunks).toBe(2);
    expect(mockCache.store.get(CHUNK_KEY(0)).length).toBe(20001);
    const parts = [0, 1].map((i) => mockCache.store.get(CHUNK_KEY(i)));
    expect(parts.join("")).toBe(json);

    doGet({ parameter: {} });
    expect(mockContentService.setContent).toHaveBeenLastCalledWith(json);
  });

  it("rebuilds from the sheets when a cache chunk is missing", () => {
    doGet({ parameter: {} });
    mockCache.store.delete(CHUNK_KEY(0));
    stubSheetValues([["h"], ["changed"]]);

    doGet({ parameter: {} });
    expect(global.SpreadsheetApp.openById).toHaveBeenCalledTimes(2);
    expect(mockContentService.setContent).toHaveBeenLastCalledWith(
      JSON.stringify([{ h: "changed" }])
    );
  });

  it("rebuilds from the sheets when the cache manifest is corrupt", () => {
    mockCache.store.set(META_KEY, "not-json");
    doGet({ parameter: {} });
    expect(global.SpreadsheetApp.openById).toHaveBeenCalledTimes(1);
    expect(mockContentService.setContent).toHaveBeenLastCalledWith(
      JSON.stringify([{ h: "v" }])
    );
  });

  it("rebuilds from the sheets when the cached length does not match", () => {
    doGet({ parameter: {} });
    const meta = JSON.parse(mockCache.store.get(META_KEY));
    mockCache.store.set(
      META_KEY,
      JSON.stringify({ chunks: meta.chunks, length: meta.length + 1 })
    );
    stubSheetValues([["h"], ["changed"]]);

    doGet({ parameter: {} });
    expect(global.SpreadsheetApp.openById).toHaveBeenCalledTimes(2);
    expect(mockContentService.setContent).toHaveBeenLastCalledWith(
      JSON.stringify([{ h: "changed" }])
    );
  });

  it("still serves the response when reading the cache throws", () => {
    mockCache.get.mockImplementationOnce(() => {
      throw new Error("cache read failed");
    });
    doGet({ parameter: {} });
    expect(mockContentService.setContent).toHaveBeenLastCalledWith(
      JSON.stringify([{ h: "v" }])
    );
  });

  it("still serves the response when writing the cache throws", () => {
    mockCache.putAll.mockImplementationOnce(() => {
      throw new Error("cache write failed");
    });
    doGet({ parameter: {} });
    expect(mockContentService.setContent).toHaveBeenLastCalledWith(
      JSON.stringify([{ h: "v" }])
    );
  });
});

describe("crawlRoom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSheet.getLastRow.mockReturnValue(1);
    mockSpreadsheet.getSheetByName.mockReturnValue(mockSheet);
  });

  it("should fetch data and write to the sheet", () => {
    mockUrlFetchApp.fetch
      .mockReturnValueOnce({
        getContentText: () => JSON.stringify({ data: [{ id: 1, name: "collection1" }] }),
      })
      .mockReturnValueOnce({
        getContentText: () =>
          JSON.stringify({
            data: [
              {
                item: {
                  key: "test-item;123",
                  name: "Test Item",
                  picture: { url: "http://example.com/test.jpg" },
                  url: "http://example.com/item",
                  price: 1000,
                },
                content: "Test comment",
              },
            ],
          }),
      });

    crawlRoom();
    const expectedRow = [
      "Test Item",
      "http://example.com/test.jpg",
      "http://example.com/item",
      1000,
      1,
      "collection1",
      "Test comment",
    ];
    expect(mockRange.setValues).toHaveBeenCalledWith([expectedRow]);
    expect(Logger.log).toHaveBeenCalledWith("collection1");
    expect(Logger.log).toHaveBeenCalledWith("Test Item");
    expect(Logger.log).toHaveBeenCalledWith("Fetched 1 items.");
  });

  it("should clear the doGet response cache after rewriting the room sheet", () => {
    mockCache.store.set(
      "items-response:v1:meta",
      JSON.stringify({ chunks: 1, length: 2 })
    );
    mockCache.store.set("items-response:v1:0", "[]");
    mockUrlFetchApp.fetch
      .mockReturnValueOnce({
        getContentText: () => JSON.stringify({ data: [{ id: 1, name: "collection1" }] }),
      })
      .mockReturnValueOnce({
        getContentText: () => JSON.stringify({ data: [] }),
      });

    crawlRoom();

    expect(mockCache.store.has("items-response:v1:meta")).toBe(false);
    expect(mockCache.store.has("items-response:v1:0")).toBe(false);
  });

  it("should not fail when clearing the response cache throws", () => {
    mockCache.removeAll.mockImplementationOnce(() => {
      throw new Error("cache remove failed");
    });
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ data: [] }),
    });

    expect(() => crawlRoom()).not.toThrow();
  });

  it("should handle empty collections", () => {
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ data: [] }),
    });

    crawlRoom();

    expect(mockRange.clearContent).not.toHaveBeenCalled();
    expect(mockRange.setValues).not.toHaveBeenCalled();
  });

  it("should handle empty collects", () => {
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () =>
        JSON.stringify({
          data: [{ id: 1, name: "collection1" }],
        }),
    });
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ data: [] }),
    });

    crawlRoom();

    expect(mockRange.clearContent).not.toHaveBeenCalled();
    expect(mockRange.setValues).not.toHaveBeenCalled();
  });

  it("should handle items with no key", () => {
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () =>
        JSON.stringify({
          data: [{ id: 1, name: "collection1" }],
        }),
    });
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () =>
        JSON.stringify({
          data: [
            {
              item: {
                name: "Test Item",
                picture: { url: "http://example.com/test.jpg" },
                url: "http://example.com/item",
                price: 1000,
              },
              content: "Test comment",
            },
          ],
        }),
    });

    crawlRoom();

    expect(mockRange.clearContent).not.toHaveBeenCalled();
    expect(mockRange.setValues).toHaveBeenCalledWith([
      [
        "Test Item",
        "http://example.com/test.jpg",
        "http://example.com/item",
        1000,
        1,
        "collection1",
        "Test comment",
      ],
    ]);
  });

  it("should handle collections API with no data property", () => {
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ message: "error" }),
    });
    crawlRoom();
    expect(mockRange.setValues).not.toHaveBeenCalled();
  });

  it("should handle collects API with no data property", () => {
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ data: [{ id: 1, name: "c1" }] }),
    });
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ message: "error" }),
    });
    crawlRoom();
    expect(mockRange.setValues).not.toHaveBeenCalled();
  });

  it("should handle collect with no item property", () => {
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ data: [{ id: 1, name: "c1" }] }),
    });
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ data: [{ content: "comment" }] }),
    });
    crawlRoom();
    expect(mockRange.setValues).toHaveBeenCalledWith([
      ["", "", "", "", 1, "c1", "comment"],
    ]);
  });

  it("should handle missing properties in API responses", () => {
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ data: [{ id: 1 /*no name*/ }] }),
    });
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () =>
        JSON.stringify({
          data: [
            {
              item: {
                /* no properties */
              },
              /* no content */
            },
          ],
        }),
    });

    crawlRoom();
    expect(mockRange.setValues).toHaveBeenCalledWith([
      ["", "", "", "", 1, "", ""],
    ]);
  });

  it("should clear content when sheet has existing data", () => {
    mockSheet.getLastRow.mockReturnValue(2); // Simulate existing data
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ data: [] }),
    });

    crawlRoom();

    expect(mockRange.clearContent).toHaveBeenCalled();
  });
});
