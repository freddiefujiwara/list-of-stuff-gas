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
      })
      .mockReturnValueOnce({
        getContentText: () =>
          JSON.stringify({
            Items: [
              {
                Item: {
                  itemName: "Rakuten Item",
                  itemPrice: 2000,
                  affiliateUrl: "http://example.com/rakuten",
                },
              },
            ],
          }),
      });

    crawlRoom();
    const expectedRow = [
      "Rakuten Item",
      "http://example.com/test.jpg",
      "http://example.com/rakuten",
      2000,
      1,
      "collection1",
      "Test comment",
    ];
    expect(mockRange.setValues).toHaveBeenCalledWith([expectedRow]);
    expect(Logger.log).toHaveBeenCalledWith("collection1");
    expect(Logger.log).toHaveBeenCalledWith("Rakuten Item");
    expect(Logger.log).toHaveBeenCalledWith([expectedRow]);
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

  it("should handle Rakuten API returning no items", () => {
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
    mockUrlFetchApp.fetch.mockReturnValueOnce({
      getContentText: () => JSON.stringify({ Items: [] }),
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
