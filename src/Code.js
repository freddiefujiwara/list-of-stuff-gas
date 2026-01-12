const SPREADSHEET_ID = '1yxnHhfAT2cEF50hvajHoLMsW_sf7JlxnjFKeDFLNAkc';

// Simple fetch JSON helper
const fetchJson = url => JSON.parse(UrlFetchApp.fetch(url).getContentText());

function crawlRoom() {
	const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
	const sh = ss.getSheetByName('room');

	// Clear old data (keep header row)
	const lastRow = sh.getLastRow();
	if (lastRow > 1) {
		sh.getRange(2, 1, lastRow - 1, 7).clearContent();
	}

	// Build rows first, then write once
	const rows = [];
	const collections = fetchJson('http://a.ze.gs/collections.json').data || [];

	collections.forEach(c => {
			const collects = fetchJson(`http://a.ze.gs/collects_${c.id}.json`).data || [];
			Logger.log(c.name);
			collects.forEach(x => {
					const item = x.item || {};
					const code = (item.key || '').replace(';', '%3A');

					// Get name/price from Rakuten (if available)
					if (code) {
					const url =
					'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20170706' +
					'?format=json' +
					'&affiliateId=0ca3304d.a811038d.0ca3304e.80024f1e' +
					'&applicationId=1070485698719039334' +
					`&itemCode=${code}`;

					const data = fetchJson(url);
					const rakutenItem = data?.Items?.[0]?.Item;

					if (rakutenItem) {
					item.name = rakutenItem.itemName;
					item.price = rakutenItem.itemPrice;
					// item.url = rakutenItem.affiliateUrl; // optional
					}
					}

					rows.push([
							item.name || '',                 // title
							item.picture?.url || '',         // image
							item.url || '',                  // url
							item.price || '',                // price
							1,                               // unit
							c.name || '',                    // genre
							x.content || '',                 // comment
					]);
					Logger.log(item.name);
			});
	});
	Logger.log(rows);
	// Write to sheet (one shot)
	if (rows.length) sh.getRange(2, 1, rows.length, 7).setValues(rows);
}

// Export modules for testing
if (typeof module !== 'undefined') {
  module.exports = { crawlRoom, doGet };
}

function doGet(e) {
	let result = [];
	const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
	["room", "workman", "variety", "others"].forEach(tab => {
			const target = ss.getSheetByName(tab);
			const values = target.getDataRange().getValues();
			const headers = values.shift();
			result = result.concat(values.map((row) => {
						let data = {};
						row.map((column, index) => {
								data[headers[index]] = column;
								});
						return data;
						}));
			});

	const output = ContentService.createTextOutput();
	if (e.parameter.callback === undefined) {
		output.setMimeType(ContentService.MimeType.JSON);
		output.setContent(JSON.stringify(result));
	} else {
		output.setMimeType(ContentService.MimeType.JAVASCRIPT);
		output.setContent(e.parameter.callback + "&&" + e.parameter.callback + "(" + JSON.stringify(result) + ");");
	}
	return output;
}
