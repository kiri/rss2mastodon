/*
 RSSをmastodonへtoot
*/
const NAMESPACE_RSS = XmlService.getNamespace('http://purl.org/rss/1.0/');
const NAMESPACE_DC = XmlService.getNamespace("http://purl.org/dc/elements/1.1/");
const NAMESPACE_ATOM = XmlService.getNamespace('http://www.w3.org/2005/Atom');

const SPREAD_SHEET = SpreadsheetApp.getActiveSpreadsheet();
//const SPREADSHEET = SpreadsheetApp.openById(getScriptProperty('spreadsheet_id'));

const SCRIPT_START_TIME = Date.now();

function main() {
  initScriptProperty();

  const LOCK = LockService.getDocumentLock();
  try {
    LOCK.waitLock(0);
    Logger.log("Start: readRSSFeeds()");
    let rssfeeds = readRSSFeeds();
    Logger.log("End: readRSSFeeds()");

    Logger.log("Start: doToot()");
    let toot_entries_array = doToot(rssfeeds);
    Logger.log("End: doToot()");

    Logger.log("Start: saveEntries()");
    saveEntries(toot_entries_array);
    Logger.log("End: saveEntries()");
  } catch (e) {
    logException(e, "main()");
  } finally {
    LOCK.releaseLock();
  }
}

function saveEntries(array) {
  if (array) {
    // 履歴の取得
    const STORED_ENTRIES_SHEET = getSheet(SPREAD_SHEET, 'store');
    const STORED_ENTRIES = getSheetValues(STORED_ENTRIES_SHEET, 2, 1, 4); // タイトル、URL、コンテンツ、時刻を取得（A2(2,1)を起点に最終データ行までの4列分）

    // 最新のRSSとキャッシュを統合してシートを更新。古いキャッシュは捨てる。
    let max_millisec_age = Number(getScriptProperty('store_max_age')) * 60 * 1000;
    let merged_entries_array = array.concat(STORED_ENTRIES.filter(function (item) { return Date.now() < (new Date(item[3]).getTime() + max_millisec_age); }));
    STORED_ENTRIES_SHEET.clear();
    if (merged_entries_array?.length > 0) {
      STORED_ENTRIES_SHEET.getRange(2, 1, merged_entries_array.length, 4).setValues(merged_entries_array.sort((a, b) => new Date(b[3]).getTime() - new Date(a[3]).getTime())).removeDuplicates([2]);
    }
    SpreadsheetApp.flush();
  }
}

function readRSSFeeds() {
  // RSSフィードを列挙したfeedurlsシート [feed url][翻訳]
  const RSSFEEDS_SHEET = getSheet(SPREAD_SHEET, "feedurls");
  const RSSFEEDS = getSheetValues(RSSFEEDS_SHEET, 2, 1, 1);
  if (RSSFEEDS.length == 0) {
    RSSFEEDS.getRange(2, 1, 1, 1).setValues([['https://example.com/rss']]);
  }
  Logger.log(RSSFEEDS);

  let rssfeed_urls_list = [];
  {
    let temp_rssfeed_urls_list = [];
    RSSFEEDS.forEach(function (value, index, array) {
      temp_rssfeed_urls_list.push(value);
      if ((index + 1) % 10 == 0) {
        rssfeed_urls_list.push(temp_rssfeed_urls_list);
        temp_rssfeed_urls_list = [];
      }
    });
    rssfeed_urls_list.push(temp_rssfeed_urls_list);
    temp_rssfeed_urls_list = [];
  }

  let responses = [];
  try {
    rssfeed_urls_list.forEach(function (value, index, array) {
      Logger.log("rssfeed_urls_list index=" + index);
      if (Date.now() < (SCRIPT_START_TIME + 4 * 60 * 1000)) {// 開始から5分までは実行可
        let requests = [];
        for (let i = 0; i < value.length; i++) {
          let param = {
            url: value[i][0],
            method: 'get',
            followRedirects: false,
            muteHttpExceptions: true
          };
          requests.push(param);
        }

        let start_time = Date.now();
        responses = responses.concat(UrlFetchApp.fetchAll(requests));
        let end_time = Date.now();
        let wait_time = (value.length * 1000) - (end_time - start_time);
        Utilities.sleep(wait_time < 0 ? 0 : wait_time);
      }
    });
  } catch (e) {
    logException(e, "readRSSFeeds()");
    return;
  }

  // 履歴の取得
  const STORED_ENTRIES_SHEET = getSheet(SPREAD_SHEET, 'store');
  const STORED_ENTRY_URLS = getSheetValues(STORED_ENTRIES_SHEET, 2, 2, 1); // URLのみ取得（B2(2:2,B:2)を起点に最終データ行までの1列分) 

  // 記事の期限
  let max_millisec_age = Number(getScriptProperty('article_max_age')) * 60 * 1000;

  // 返り値のRSSフィードのリスト
  const RSSFEED_ENTRIES = [];
  responses.forEach(function (value, index, array) {
    const RSSFEED_URL = RSSFEEDS[index][0];
    if (value.getResponseCode() == 200 && Date.now() < (SCRIPT_START_TIME + 5 * 60 * 1000)) {
      const XML = XmlService.parse(value.getContentText());
      const ROOT = XML.getRootElement();

      // ATOM
      if (ROOT.getChildren('entry', NAMESPACE_ATOM).length > 0) {
        RSSFEED_TITLE = ROOT.getChildText('title', NAMESPACE_ATOM);
        ROOT.getChildren('entry', NAMESPACE_ATOM).forEach(function (entry) {
          const ENTRY_DATE = new Date(entry.getChildText('updated', NAMESPACE_ATOM));
          const ENTRY_URL = entry.getChild('link', NAMESPACE_ATOM).getAttribute('href').getValue();
          if (!isFound(STORED_ENTRY_URLS, ENTRY_URL) && Date.now() < (ENTRY_DATE.getTime() + max_millisec_age)) {
            let e = {
              ftitle: RSSFEED_TITLE,
              etitle: entry.getChildText('title', NAMESPACE_ATOM).replace(/(\')/gi, ''), // シングルクォーテーションは消す。
              econtent: entry.getChildText('content', NAMESPACE_ATOM)?.replace(/(<([^>]+)>)/gi, ''),
              eurl: ENTRY_URL,
              edate: ENTRY_DATE
            };
            e.options = composeToot(e);
            RSSFEED_ENTRIES.push(e);
          }
        });
        // RSS1.0
      } else if (ROOT.getChildren('item', NAMESPACE_RSS).length > 0) {
        RSSFEED_TITLE = ROOT.getChild('channel', NAMESPACE_RSS).getChildText('title', NAMESPACE_RSS);
        ROOT.getChildren('item', NAMESPACE_RSS).forEach(function (entry) {
          const ENTRY_DATE = new Date(entry.getChildText('date', NAMESPACE_DC));
          const ENTRY_URL = entry.getChildText('link', NAMESPACE_RSS);
          if (!isFound(STORED_ENTRY_URLS, ENTRY_URL) && Date.now() < (ENTRY_DATE.getTime() + max_millisec_age)) {
            let e = {
              ftitle: RSSFEED_TITLE,
              etitle: entry.getChildText('title', NAMESPACE_RSS).replace(/(\')/gi, ''), // シングルクォーテーションは消す。
              econtent: entry.getChildText('description', NAMESPACE_RSS)?.replace(/(<([^>]+)>)/gi, ''),
              eurl: ENTRY_URL,
              edate: ENTRY_DATE
            };
            e.options = composeToot(e);
            RSSFEED_ENTRIES.push(e);
          }
        });
        // RSS2.0
      } else if (ROOT.getChild('channel')?.getChildren('item').length > 0) {
        RSSFEED_TITLE = ROOT.getChild('channel').getChildText('title');
        ROOT.getChild('channel').getChildren('item').forEach(function (entry) {
          const ENTRY_DATE = new Date(entry.getChildText('pubDate'));
          const ENTRY_URL = entry.getChildText('link');
          if (!isFound(STORED_ENTRY_URLS, ENTRY_URL) && Date.now() < (ENTRY_DATE.getTime() + max_millisec_age)) {
            let e = {
              ftitle: RSSFEED_TITLE,
              etitle: entry.getChildText('title').replace(/(\')/gi, ''), // シングルクォーテーションは消す。
              econtent: entry.getChildText('description')?.replace(/(<([^>]+)>)/gi, ''),
              eurl: ENTRY_URL,
              edate: ENTRY_DATE
            };
            e.options = composeToot(e);
            RSSFEED_ENTRIES.push(e);
          }
        });
      } else {
        Logger.log("Unknown " + RSSFEED_URL);
      }
    } else {
      Logger.log("not value.getResponseCode() == 200 && Date.now() < (SCRIPT_START_TIME + 5 * 60 * 1000) " + RSSFEED_URL);
    }
  });
  Logger.log("RSSFEED_ENTRIES.length " + RSSFEED_ENTRIES?.length);
  return RSSFEED_ENTRIES.sort((a, b) => a.edate - b.edate);
}

function doToot(rssfeed_entries) {
  // Tootした後のRSS情報を記録する配列
  const current_entries_array = [];

  // スクリプトプロパティを取得
  let ratelimit_remaining = Number(getScriptProperty('ratelimit_remaining'));
  if (ratelimit_remaining <= 0) {
    return;
  }
  let ratelimit_limit = Number(getScriptProperty('ratelimit_limit'));
  let trigger_interval = Number(getScriptProperty('trigger_interval'));
  let ratelimit_reset_date = getScriptProperty('ratelimit_reset_date');

  // すでにToot済みのはこの時刻で統一
  const TIMESTAMP = new Date().toString();

  // レートリミット超えによる中断・スキップ判定用
  let ratelimit_break = false;
  let toot_count = 0;

  rssfeed_entries.forEach(function (value, index, array) {
    if (!ratelimit_break && Date.now() < (SCRIPT_START_TIME + 5.8 * 60 * 1000)) {
      if (value.options) {
        const TRIGGER_INTERVAL = trigger_interval;// mins 
        const RATELIMIT_WAIT_TIME = (new Date(ratelimit_reset_date).getTime() - Date.now()) / (60 * 1000);
        const CURRENT_RATELIMIT = Math.round(ratelimit_remaining * (RATELIMIT_WAIT_TIME < TRIGGER_INTERVAL ? 1 : TRIGGER_INTERVAL / RATELIMIT_WAIT_TIME));

        let response;
        try {
          let start_time = Date.now();
          response = UrlFetchApp.fetch(getScriptProperty('mastodon_url'), value.options);
          let end_time = Date.now();
          toot_count++;
          Logger.log("info Toot():%s %s", toot_count, value.etitle);
          let wait_time = (1 * 1000) - (end_time - start_time);
          Utilities.sleep(wait_time < 0 ? 0 : wait_time);
        } catch (e) {
          logException(e, "doToot()");
          Utilities.sleep(5 * 1000);
          return;
        }
        // レートリミット情報
        const RESPONSE_HEADERS = response.getHeaders();
        ratelimit_remaining = Number(RESPONSE_HEADERS['x-ratelimit-remaining']);
        ratelimit_reset_date = RESPONSE_HEADERS['x-ratelimit-reset'];
        ratelimit_limit = Number(RESPONSE_HEADERS['x-ratelimit-limit']);
        if (toot_count > CURRENT_RATELIMIT || response.getResponseCode() == 429) { // レートリミットを超え or 429 なら終了フラグを立てる
          ratelimit_break = true;
        } else if (response.getResponseCode() != 200) {
          Utilities.sleep(5 * 1000);
          return;
        }

        // Tootした/するはずだったRSS情報を配列に保存。後でまとめてstoreシートに書き込む
        current_entries_array.push([value.etitle, value.eurl, value.econtent, new Date().toString()]);
      } else {
        current_entries_array.push([value.etitle, value.eurl, value.econtent, TIMESTAMP]);
      }
    } else {
      Logger.log("not !ratelimit_break && Date.now() < (SCRIPT_START_TIME + 5.8 * 60 * 1000) " + value.etitle);
    }
  });

  // レートリミット情報をプロパティに保存
  setScriptProperty('ratelimit_reset_date', ratelimit_reset_date);
  setScriptProperty('ratelimit_remaining', ratelimit_remaining);
  setScriptProperty('ratelimit_limit', ratelimit_limit);

  Logger.log("setScriptProperty %s %s %s", ratelimit_reset_date, ratelimit_remaining, ratelimit_limit);

  return current_entries_array;
}

function composeToot(p) {
  let m = "";
  m = '📰 ' + p.etitle + '\n' + p.econtent + '\n';

  if (!p.econtent?.split('').some(char => char.charCodeAt() > 255)) {
    let start_time = Date.now();
    try {
      m = m + '\n📝 ' + LanguageApp.translate(p.econtent ? p.econtent : p.etitle, '', 'ja') + '\n';
    } catch (e) {
      logException(e, '')
    }
    let end_time = Date.now();
    let wait_time = (1 * 1000) - (end_time - start_time);
    Utilities.sleep(wait_time < 0 ? 0 : wait_time);
  }

  const SNIP = '✂\n';
  const URL_LEN = 30;
  const MAX_TOOT_LEN = 500;
  const ICON = '\n🔳 ';
  const DATESTRING = "(" + p.edate.toLocaleTimeString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }) + ")";
  m = m.length + ICON.length + DATESTRING.length + p.ftitle.length + 1 + URL_LEN < MAX_TOOT_LEN ? m : m.substring(0, MAX_TOOT_LEN - ICON.length - p.ftitle.length - DATESTRING.length - 1 - URL_LEN - SNIP.length) + SNIP;
  m = m + ICON + p.ftitle + DATESTRING + " " + p.eurl;

  const payload = {
    status: m,
    visibility: 'private'
  };
  const options = {
    method: 'post',
    payload: JSON.stringify(payload),
    headers: { Authorization: 'Bearer ' + getScriptProperty('mastodon_accesstoken') },
    contentType: 'application/json',
    muteHttpExceptions: true
  };
  return options;
}

// 配列から一致する値の有無確認
function isFound(array, data) {
  if (array.length == 0) {
    return false;
  }
  return array.some(v => v.includes(data));
}

// urlからFQDNを取得
function getFQDN(url) {
  const REGEX = /https?:\/\/[a-zA-Z0-9.\-]*/;
  return url.match(REGEX);
}

// シート取得（スプレッドシートObj, シート名）
function getSheet(s, n) {
  let ss = s.getSheetByName(n);
  if (!ss) {
    ss = s.insertSheet();
    ss.setName(n);
    SpreadsheetApp.flush();
  }
  return ss;
}

// シートから値取得（シートobj, 列, 行, 採取する列幅）
function getSheetValues(ss, row, col, width) {
  if (ss.getLastRow() - 1 > 0) {
    // getRange(行番号, 列番号, 行数, 列数)）
    return ss.getRange(row, col, ss.getLastRow() - 1, width).getValues();
  }
  return [];
}

function shuffleArray(array) {
  const cloneArray = [...array]
  for (let i = cloneArray.length - 1; i >= 0; i--) {
    let rand = Math.floor(Math.random() * (i + 1))
    let tmpStorage = cloneArray[i]
    cloneArray[i] = cloneArray[rand]
    cloneArray[rand] = tmpStorage
  }
  return cloneArray
}

// スクリプトプロパティがなかったとき用の初期設定
function initScriptProperty() {
  if (!getScriptProperty('trigger_interval') || !getScriptProperty('store_max_age') || !getScriptProperty('article_max_age') || !getScriptProperty('ratelimit_remaining') || !getScriptProperty('ratelimit_reset_date') || !getScriptProperty('ratelimit_limit')) {
    setScriptProperty('trigger_interval', 10); // minuites 
    setScriptProperty('store_max_age', 720); // minuites
    setScriptProperty('article_max_age', 120); // minuites
    setScriptProperty('ratelimit_reset_date', Date.now() + 3 * 60 * 60 * 1000);// miliseconds
    setScriptProperty('ratelimit_remaining', 300);
    setScriptProperty('ratelimit_limit', 300);
  }
  if (new Date(getScriptProperty('ratelimit_reset_date')).getTime() <= Date.now()) {
    setScriptProperty('ratelimit_reset_date', Date.now() + 3 * 60 * 60 * 1000);// miliseconds
    setScriptProperty('ratelimit_remaining', 300);
  }
}
// スクリプトプロパティ取得
function getScriptProperty(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}
// スクリプトプロパティ保存
function setScriptProperty(key, value) {
  return PropertiesService.getScriptProperties().setProperty(key, value);
}

function logException(e, str) {
  Logger.log(e.name + " " + str + ": " + e.message);
  Logger.log(e.name + " " + str + ": " + e.stack);
}
