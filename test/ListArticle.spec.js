import { describe, expect, it} from "vitest";
import {
buildItemLine,
buildListArticleBlocks,
extractSubscriptionNames,
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
genre: "服",
url: "",
comment: "",
},
],
variety: [],
others: [],
};

it("emits a heading per tab and a sub-heading per genre", () => {
const blocks = buildListArticleBlocks(itemsByTab, []);
const headings = blocks
.filter((b) => b.type === "heading1")
.map((b) => b.text);
expect(headings).toEqual([
"楽天ROOM",
"ワークマン",
"バラエティ（ダイソー・100均）",
"その他",
"サブスクリプション",
]);
const subHeadings = blocks
.filter((b) => b.type === "heading2")
.map((b) => b.text);
expect(subHeadings).toEqual(["暮らしにまつわる物", "服"]);
});

it("puts each item URL in its own link block and skips title-less and URL-less items appropriately", () => {
const blocks = buildListArticleBlocks(itemsByTab, []);
const links = blocks.filter((b) => b.type === "link").map((b) => b.text);
expect(links).toEqual([
"https://item.rakuten.co.jp/example/1/",
"https://workman.jp/shop/g/1",
]);
const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
expect(texts).toContain("クリップライト（¥2,029） 机用");
expect(texts).toContain("手袋（¥580）");
});

it("never writes a total or a sum of prices", () => {
const blocks = buildListArticleBlocks(itemsByTab, ["NHK"]);
const allText = blocks.map((b) => b.text).join("\n");
expect(allText).not.toContain("合計");
// 2029 + 1500 + 580 = 4109 must not appear anywhere
expect(allText).not.toContain("4,109");
expect(allText).not.toContain("4109");
});

it("ends with a subscriptions section listing names only", () => {
const blocks = buildListArticleBlocks(itemsByTab, ["NHK", "DAZN"]);
const tail = blocks.slice(-3);
expect(tail).toEqual([
{ type: "heading1", text: "サブスクリプション"},
{ type: "text", text: "NHK"},
{ type: "text", text: "DAZN"},
]);
});
});

describe("extractSubscriptionNames", () => {
it("returns service names only, skipping the header, blanks, the total row and school rows", () => {
const values = [
["Service", "Purpose", "Yearly Cost", "Monthly Cost", "Ratio"],
["NHK", "テレビ", "¥21,765", "¥1,814", "1.55%"],
["", "", "", "", ""],
["武南中学校", "学費", "¥931,986", "¥77,665", "66.4%"],
["合計", "", "¥1,403,230", "¥116,936", "100%"],
["DAZN", "野球", "¥27,600", "¥2,300", "1.97%"],
];
expect(extractSubscriptionNames(values)).toEqual(["NHK", "DAZN"]);
});

it("does not mutate the caller's values array", () => {
const values = [
["Service", "Purpose"],
["NHK", "テレビ"],
];
extractSubscriptionNames(values);
expect(values).toHaveLength(2);
});
});
