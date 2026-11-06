import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildItemLine,
  buildListArticleBlocks,
  extractSubscriptions,
  generateListArticleDraft,
  normalizeArticleUrl,
  setupListArticleTrigger,
  splitTitle,
} from "../src/Code.js";

describe("buildItemLine", () => {
it("formats title, price, unit and comment", () => {
expect(
buildItemLine({
title: "耐久撥水キャンバススリッポン",
price: 1500,
unit: 2,
comment: "ブラック",
})
).toBe("耐久撥水キャンバススリッポン（¥1,500 ×2） ブラック");
});

it("accepts prices stored as strings, with or without a yen mark", () => {
expect(buildItemLine({ title: "つめ切り", price: "500", unit: 1})).toBe(
"つめ切り（¥500）"
);
expect(buildItemLine({ title: "体組成計", price: "¥4,380", unit: 1})).toBe(
"体組成計（¥4,380）"
);
});

it("omits the detail part when price is blank and unit is 1", () => {
expect(buildItemLine({ title: "メモ", price: "", unit: 1, comment: ""})).toBe(
"メモ"
);
expect(buildItemLine({ title: "メモ", unit: 3})).toBe("メモ（×3）");
});
});

describe("normalizeArticleUrl", () => {
it("percent-encodes raw Japanese text and spaces", () => {
expect(
normalizeArticleUrl("https://www.google.com/search?q=ワークマン 手袋")
).toBe(
"https://www.google.com/search?q=%E3%83%AF%E3%83%BC%E3%82%AF%E3%83%9E%E3%83%B3%20%E6%89%8B%E8%A2%8B"
);
});

it("leaves plain ASCII URLs and existing encodings untouched", () => {
expect(normalizeArticleUrl("https://example.com/a?x=1&y=2")).toBe(
"https://example.com/a?x=1&y=2"
);
expect(normalizeArticleUrl("https://example.com/%E3%83%AF")).toBe(
"https://example.com/%E3%83%AF"
);
});
});

describe("buildListArticleBlocks", () => {
const itemsByTab = {
room: [
{
title: "クリップライト",
price: 2029,
unit: 1,
genre: "暮らしにまつわる物",
url: "https://item.rakuten.co.jp/example/1/",
comment: "机用",
},
{ title: "", price: 1, unit: 1, genre: "暮らしにまつわる物", url: "x"},
],
workman: [
{
title: "スリッポン",
price: "1500",
unit: 2,
genre: "服",
url: "https://workman.jp/shop/g/1",
comment: "",
},
{
title: "手袋",
price: 580,
unit: 1,
genre: "暮らしにまつわる物",
url: "https://www.google.com/search?q=ワークマン 手袋",
comment: "",
},
{
title: "メモ帳",
price: 100,
unit: 1,
genre: "服",
url: "",
comment: "予備",
},
],
variety: [],
others: [],
};

it("groups items from all tabs under one heading per genre", () => {
const blocks = buildListArticleBlocks(itemsByTab, []);
const headings = blocks
.filter((b) => b.type === "heading2")
.map((b) => b.text);
expect(headings).toEqual([
"暮らしにまつわる物",
"服",
"サブスクリプション",
]);
expect(blocks.some((b) => b.type === "heading1")).toBe(false);
// the genre section holds the room item first, then the workman one
const genreStart = blocks.findIndex(
(b) => b.type === "heading2" && b.text === "暮らしにまつわる物"
);
const genreLinks = blocks
.slice(genreStart)
.filter((b) => b.type === "link")
.map((b) => b.text);
expect(genreLinks[0]).toBe("https://item.rakuten.co.jp/example/1/");
});

it("puts a [[目次]] marker directly under every section heading", () => {
const blocks = buildListArticleBlocks(itemsByTab, [
{ name: "Suno", url: "https://suno.com/" },
]);
const tocs = blocks.filter((b) => b.type === "toc");
expect(tocs.length).toBe(3);
// each toc sits directly after its heading
blocks.forEach((b, i) => {
if (b.type === "heading2") expect(blocks[i + 1].type).toBe("toc");
});
// and no item or service name is a heading, so the TOC lists genres only
expect(blocks.some((b) => b.type === "heading3")).toBe(false);
});

it("puts each item's numbered name directly above its card", () => {
const blocks = buildListArticleBlocks(itemsByTab, []);
const start = blocks.findIndex(
(b) => b.type === "heading2" && b.text === "暮らしにまつわる物"
);
expect(blocks.slice(start, start + 7)).toEqual([
{ type: "heading2", text: "暮らしにまつわる物" },
{ type: "toc" },
{ type: "text", text: "1. クリップライト" },
{ type: "link", text: "https://item.rakuten.co.jp/example/1/" },
{ type: "text", text: "机用" },
{ type: "text", text: "2. 手袋" },
{
type: "link",
text: "https://www.google.com/search?q=%E3%83%AF%E3%83%BC%E3%82%AF%E3%83%9E%E3%83%B3%20%E6%89%8B%E8%A2%8B",
},
]);
// numbering restarts per genre, and URL-less items get a numbered line too
const clothesStart = blocks.findIndex(
(b) => b.type === "heading2" && b.text === "服"
);
expect(blocks[clothesStart + 2]).toEqual({
type: "text",
text: "1. スリッポン",
});
expect(blocks[clothesStart + 4].text.startsWith("2. メモ帳")).toBe(true);
});

it("puts the comment below the card and encodes search URLs", () => {
const blocks = buildListArticleBlocks(itemsByTab, []);
const cardIndex = blocks.findIndex(
(b) => b.type === "link" && b.text === "https://item.rakuten.co.jp/example/1/"
);
expect(blocks[cardIndex + 1]).toEqual({ type: "text", text: "机用" });
// no caption line with title and price is emitted for carded items
const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
expect(texts).not.toContain("クリップライト（¥2,029） 机用");
const links = blocks.filter((b) => b.type === "link").map((b) => b.text);
expect(links).toContain(
"https://www.google.com/search?q=%E3%83%AF%E3%83%BC%E3%82%AF%E3%83%9E%E3%83%B3%20%E6%89%8B%E8%A2%8B"
);
});

it("falls back to the full text line for items without a URL", () => {
const blocks = buildListArticleBlocks(itemsByTab, []);
const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
expect(texts).toContain("2. メモ帳（¥100） 予備");
});

it("never writes a total or a sum of prices", () => {
const blocks = buildListArticleBlocks(itemsByTab, []);
const allText = blocks.map((b) => b.text).join("\n");
expect(allText).not.toContain("合計");
// 2029 + 1500 + 580 = 4109 must not appear anywhere
expect(allText).not.toContain("4,109");
expect(allText).not.toContain("4109");
});

it("ends with a subscriptions section: name, then its URL when present", () => {
const blocks = buildListArticleBlocks(itemsByTab, [
{ name: "NHK", url: "https://www.nhk.or.jp/" },
{ name: "DAZN", url: "" },
]);
const tail = blocks.slice(-5);
expect(tail).toEqual([
{ type: "heading2", text: "サブスクリプション"},
{ type: "toc" },
{ type: "text", text: "NHK"},
{ type: "link", text: "https://www.nhk.or.jp/"},
{ type: "text", text: "DAZN"},
]);
});
});

describe("extractSubscriptions", () => {
it("returns name/URL pairs, skipping the header, blanks, the total row and school rows", () => {
const values = [
["Service", "Purpose", "Yearly Cost", "Monthly Cost", "Ratio", "URL"],
["NHK", "テレビ", "¥21,765", "¥1,814", "1.55%", "https://www.nhk.or.jp/"],
["", "", "", "", "", ""],
["武南中学校", "学費", "¥931,986", "¥77,665", "66.4%", ""],
["合計", "", "¥1,403,230", "¥116,936", "100%", ""],
["DAZN", "野球", "¥27,600", "¥2,300", "1.97%", ""],
];
expect(extractSubscriptions(values)).toEqual([
{ name: "NHK", url: "https://www.nhk.or.jp/" },
{ name: "DAZN", url: "" },
]);
});

it("does not mutate the caller's values array", () => {
const values = [
["Service", "Purpose"],
["NHK", "テレビ"],
];
extractSubscriptions(values);
expect(values).toHaveLength(2);
});
});

describe("generateListArticleDraft", () => {
  const sheetValues = {
    room: [
      ["title", "image", "url", "price", "unit", "genre", "comment"],
      ["クリップライト", "img", "https://example.com/1", 2029, 1, "暮らし", "机用"],
    ],
    workman: [["title", "image", "url", "price", "unit", "genre", "comment"]],
    variety: [["title", "image", "url", "price", "unit", "genre", "comment"]],
    others: [["title", "image", "url", "price", "unit", "genre", "comment"]],
    subscriptions: [
      ["Service", "Purpose", "Yearly Cost", "Monthly Cost", "Ratio", "URL"],
      ["NHK", "テレビ", "¥21,765", "¥1,814", "1.55%", "https://www.nhk.or.jp/"],
    ],
  };

  let mockBody;
  let mockDoc;
  let mockProperties;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBody = {
      clear: vi.fn(),
      appendParagraph: vi.fn(() => ({
        setHeading: vi.fn(),
        appendText: vi.fn(() => ({ setLinkUrl: vi.fn() })),
      })),
    };
    mockDoc = {
      getId: vi.fn(() => "doc-id"),
      getUrl: vi.fn(() => "https://docs.example/doc-id"),
      getBody: vi.fn(() => mockBody),
      saveAndClose: vi.fn(),
    };
    mockProperties = {
      getProperty: vi.fn(() => null),
      setProperty: vi.fn(),
    };
    global.SpreadsheetApp = {
      openById: vi.fn(() => ({
        getSheetByName: vi.fn((name) => ({
          getDataRange: () => ({ getValues: () => sheetValues[name] }),
        })),
      })),
    };
    global.PropertiesService = {
      getScriptProperties: vi.fn(() => mockProperties),
    };
    global.DocumentApp = {
      create: vi.fn(() => mockDoc),
      openById: vi.fn(() => mockDoc),
      ParagraphHeading: { HEADING1: "HEADING1", HEADING2: "HEADING2" },
    };
    global.DriveApp = {
      getFileById: vi.fn(() => ({ moveTo: vi.fn() })),
      getFolderById: vi.fn(() => ({})),
    };
    global.Logger = { log: vi.fn() };
  });

  it("creates the dummy doc on first run and stores its ID", () => {
    const url = generateListArticleDraft();
    expect(global.DocumentApp.create).toHaveBeenCalledWith("持ち物リスト（試作）");
    expect(mockProperties.setProperty).toHaveBeenCalledWith(
      "LIST_ARTICLE_DUMMY_DOC_ID",
      "doc-id"
    );
    expect(mockBody.clear).toHaveBeenCalled();
    expect(url).toBe("https://docs.example/doc-id");
    const written = mockBody.appendParagraph.mock.calls.map((c) => c[0]);
    expect(written).toContain("https://example.com/1");
    expect(written).toContain("1. クリップライト");
    expect(written).toContain("机用");
    expect(written).not.toContain("クリップライト（¥2,029） 机用");
    expect(written).toContain("NHK");
    expect(written).toContain("https://www.nhk.or.jp/");
    expect(written.join("\n")).not.toContain("21,765");
  });

  it("reuses the stored dummy doc on later runs", () => {
    mockProperties.getProperty.mockReturnValue("existing-id");
    generateListArticleDraft();
    expect(global.DocumentApp.openById).toHaveBeenCalledWith("existing-id");
    expect(global.DocumentApp.create).not.toHaveBeenCalled();
    expect(mockBody.clear).toHaveBeenCalled();
  });
});

describe("setupListArticleTrigger", () => {
  it("deletes only the generator's existing triggers, then creates exactly one 6-hour trigger", () => {
    const ownTrigger = { getHandlerFunction: () => "generateListArticleDraft" };
    const otherTrigger = { getHandlerFunction: () => "crawlRoom" };
    const builder = {
      timeBased: vi.fn(() => builder),
      everyHours: vi.fn(() => builder),
      create: vi.fn(),
    };
    global.ScriptApp = {
      getProjectTriggers: vi.fn(() => [ownTrigger, otherTrigger]),
      deleteTrigger: vi.fn(),
      newTrigger: vi.fn(() => builder),
    };

    setupListArticleTrigger();

    expect(global.ScriptApp.deleteTrigger).toHaveBeenCalledTimes(1);
    expect(global.ScriptApp.deleteTrigger).toHaveBeenCalledWith(ownTrigger);
    expect(global.ScriptApp.newTrigger).toHaveBeenCalledWith(
      "generateListArticleDraft"
    );
    expect(builder.everyHours).toHaveBeenCalledWith(6);
    expect(builder.create).toHaveBeenCalledTimes(1);
  });
});

describe("splitTitle", () => {
it("drops promotional brackets and splits at the first property token", () => {
expect(
splitTitle("【マラソンセール中 P10倍!】 ジョンソン カビキラー 特大 サイズ 本体 1000g")
).toEqual({ name: "ジョンソン カビキラー", props: "特大 サイズ 本体 1000g" });
});

it("treats model numbers and colours as properties", () => {
expect(
splitTitle("ヤザワコーポレーション 照明器具（クリップライト） CLX60X02WH ホワイト")
).toEqual({
name: "ヤザワコーポレーション 照明器具（クリップライト）",
props: "CLX60X02WH ホワイト",
});
});

it("keeps a bare model number in the name and caps long names", () => {
const { name, props } = splitTitle(
"Anker 543 エコフレンドリー USB-C & USB-C ケーブル 植物由来素材 240W 急速充電 (0.9m)"
);
expect(name).toBe("Anker 543 エコフレンドリー USB-C USB-C");
  expect(props).toContain("ケーブル");
expect(props).toContain("240W");
expect(props).toContain("(0.9m)");
});

it("splits a compatibility-list title after the generic name", () => {
expect(
splitTitle("【楽天1位獲得】iPhone 保護フィルム iPhone18 pro Duo 10H ガラスザムライ")
).toEqual({
name: "iPhone 保護フィルム",
props: "iPhone18 pro Duo 10H ガラスザムライ",
});
});

it("moves non-promotional brackets into the properties", () => {
expect(splitTitle("【Office 2019 H&B】Panasonic Let's note CF-SZ6")).toEqual({
name: "Panasonic Let's note",
props: "Office 2019 H&B CF-SZ6",
});
expect(splitTitle("【新品】CASIO カシオ スクール電卓 AZ-26S")).toEqual({
name: "CASIO カシオ スクール電卓",
props: "新品 AZ-26S",
});
});

it("returns a space-less title whole and handles blanks", () => {
expect(splitTitle("耐久撥水キャンバススリッポン")).toEqual({
name: "耐久撥水キャンバススリッポン",
props: "",
});
expect(splitTitle("")).toEqual({ name: "", props: "" });
expect(splitTitle(undefined)).toEqual({ name: "", props: "" });
});
});
