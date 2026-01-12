const SPREADSHEET_ID = '1yxnHhfAT2cEF50hvajHoLMsW_sf7JlxnjFKeDFLNAkc';

// Simple fetch JSON helper
const fetchJson = url => JSON.parse(UrlFetchApp.fetch(url).getContentText());

const getSheet = name => SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);

const clearSheet = (sh = getSheet('room')) => {
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, 7).clearContent();
  }
};

const getRakutenItem = code => {
  if (!code) return null;
  const url =
    'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20170706' +
    '?format=json' +
    '&affiliateId=0ca3304d.a811038d.0ca3304e.80024f1e' +
    '&applicationId=1070485698719039334' +
    `&itemCode=${code.replace(';', '%3A')}`;
  const data = fetchJson(url);
  return data?.Items?.[0]?.Item;
};

const createRow = (item, c, x) => {
  const rakutenItem = getRakutenItem(item.key);
  if (rakutenItem) {
    item.name = rakutenItem.itemName;
    item.price = rakutenItem.itemPrice;
    item.url = rakutenItem.affiliateUrl;
  }
  Logger.log(item.name);
  return [
    item.name || '',
    item.picture?.url || '',
    item.url || '',
    item.price || '',
    1,
    c.name || '',
    x.content || '',
  ];
};

export function crawlRoom() {
  clearSheet();

  const collections = fetchJson('http://a.ze.gs/collections.json').data || [];
  const rows = collections.flatMap(c => {
    Logger.log(c.name);
    const collects = fetchJson(`http://a.ze.gs/collects_${c.id}.json`).data || [];
    return collects.map(x => createRow(x.item || {}, c, x));
  });

  Logger.log(rows);
  if (rows.length) {
    getSheet('room').getRange(2, 1, rows.length, 7).setValues(rows);
  }
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

export function doGet(e) {
  const sheetNames = ["room", "workman", "variety", "others"];
  const ranges = sheetNames.map(name => `${name}!A:Z`);

  const response = Sheets.Spreadsheets.Values.batchGet(SPREADSHEET_ID, { ranges });
  const result = response.valueRanges.flatMap(valueRange => {
    return sheetValuesToObjects(valueRange.values);
  });

  return createJsonpOutput(result, e.parameter.callback);
}
