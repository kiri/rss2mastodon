/*
 RSSをmastodonへtoot
*/
const NAMESPACE_RSS = XmlService.getNamespace('http://purl.org/rss/1.0/');
const NAMESPACE_DC = XmlService.getNamespace("http://purl.org/dc/elements/1.1/");
const NAMESPACE_ATOM = XmlService.getNamespace('http://www.w3.org/2005/Atom');

const SPREAD_SHEET = SpreadsheetApp.getActiveSpreadsheet();
//const SPREADSHEET = SpreadsheetApp.openById(getScriptProperty('spreadsheet_id'));

function main() {
  initScriptProperty();

  const LOCK = LockService.getDocumentLock();
  try {
    LOCK.waitLock(0);
    doToot(readRSSFeeds());
  } catch (e) {
    Logger.log("error main():" + e.message);
  } finally {
    LOCK.releaseLock();
  }
}

function readRSSFeeds() {
  // RSSフィードを列挙したfeedurlsシート [feed url][翻訳]
  const RSSFEEDS_SHEET = getSheet(SPREAD_SHEET, "feedurls");
  const RSSFEEDS = getSheetValues(RSSFEEDS_SHEET, 2, 1, 2);
  if (RSSFEEDS.length == 0) {
    RSSFEEDS.getRange(2, 1, 1, 2).setValues([['https://example.com/rss', 'en']]);
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
      let start_time = new Date();
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
      responses = responses.concat(UrlFetchApp.fetchAll(requests));
      let end_time = new Date();
      let wait_time = (value.length * 1000) - (end_time - start_time);
      wait_time = wait_time < 0 ? 0 : wait_time;
      Logger.log("wait_time: " + wait_time);
      Utilities.sleep(wait_time);
    });
  } catch (e) {
    // GASのエラーとか
    Logger.log("error getRSSEntries():" + e.message);
    Logger.log("1-1:" + RSSFEEDS);
    return;
  }

  // fetchRSSFeedsのレスポンスをバラして1つの配列に詰め直す
  const RSSFEED_ENTRIES = [];
  let some_mins_ago = new Date();
  some_mins_ago.setMinutes(some_mins_ago.getMinutes() - Number(getScriptProperty('article_max_age')));// 古さの許容範囲

  // 初回実行記録シートからA2から最終行まで幅1列を取得
  const FIRSTRUN_URLS_SHEET = getSheet(SPREAD_SHEET, "firstrun");
  const FIRSTRUN_URLS = getSheetValues(FIRSTRUN_URLS_SHEET, 2, 1, 1);

  responses.forEach(function (value, index, array) {
    const RSSFEED_URL = RSSFEEDS[index][0];
    const TRANSLATE_TO = RSSFEEDS[index][1];

    if (value.getResponseCode() == 200) {
      const XML = XmlService.parse(value.getContentText());
      const ROOT = XML.getRootElement();

      //let RSS_TYPE;
      let RSSFEED_TITLE, ENTRY_TITLE, ENTRY_URL, ENTRY_DESCRIPTION , ENTRY_DATE;
      // ATOM
      if (ROOT.getChildren('entry', NAMESPACE_ATOM).length > 0) {
        //RSS_TYPE = 3;
        //Logger.log("ATOM " + RSSFEED_URL);
        RSSFEED_TITLE = XML.getRootElement().getChildText('title', NAMESPACE_ATOM);
        XML.getRootElement().getChildren('entry', NAMESPACE_ATOM).forEach(function (entry) {
          ENTRY_TITLE = entry.getChildText('title', NAMESPACE_ATOM).replace(/(\')/gi, '');
          ENTRY_URL = entry.getChild('link', NAMESPACE_ATOM).getAttribute('href').getValue();
          ENTRY_DESCRIPTION = entry.getChildText('content', NAMESPACE_ATOM)?.replace(/(<([^>]+)>)/gi, '');
          ENTRY_DATE = new Date(entry.getChildText('updated', NAMESPACE_ATOM));

          if (some_mins_ago < ENTRY_DATE || isFirstrun(RSSFEED_URL, FIRSTRUN_URLS)) { // 期限内 or 初回実行 
            //Logger.log({ ftitle: RSSFEED_TITLE, etitle: ENTRY_TITLE, econtent: ENTRY_DESCRIPTION, eurl: ENTRY_URL, to: TRANSLATE_TO, feed_url: RSSFEED_URL, edate: ENTRY_DATE });
            RSSFEED_ENTRIES.push({ ftitle: RSSFEED_TITLE, etitle: ENTRY_TITLE, econtent: ENTRY_DESCRIPTION, eurl: ENTRY_URL, to: TRANSLATE_TO, feed_url: RSSFEED_URL, edate: ENTRY_DATE });
          }
        });
        // RSS1.0
      } else if (ROOT.getChildren('item', NAMESPACE_RSS).length > 0) {
        //RSS_TYPE = 2;
        //Logger.log("RSS1.0 " + RSSFEED_URL);
        RSSFEED_TITLE = XML.getRootElement().getChild('channel', NAMESPACE_RSS).getChildText('title', NAMESPACE_RSS);//getRSSFeedTitle(RSS_TYPE, XML);
        XML.getRootElement().getChildren('item', NAMESPACE_RSS).forEach(function (entry) {
          ENTRY_TITLE = entry.getChildText('title', NAMESPACE_RSS).replace(/(\')/gi, '');//getEntryTitle(RSS_TYPE, entry);
          ENTRY_URL = entry.getChildText('link', NAMESPACE_RSS);
          ENTRY_DESCRIPTION = entry.getChildText('description', NAMESPACE_RSS)?.replace(/(<([^>]+)>)/gi, '');//getEntryDescription(RSS_TYPE, entry);
          ENTRY_DATE = new Date( entry.getChildText('date', NAMESPACE_DC));

          if (some_mins_ago < ENTRY_DATE || isFirstrun(RSSFEED_URL, FIRSTRUN_URLS)) { // 期限内 or 初回実行 
            RSSFEED_ENTRIES.push({ ftitle: RSSFEED_TITLE, etitle: ENTRY_TITLE, econtent: ENTRY_DESCRIPTION, eurl: ENTRY_URL, to: TRANSLATE_TO, feed_url: RSSFEED_URL, edate: ENTRY_DATE });
          }
        });
        // RSS2.0
      } else if (ROOT.getChild('channel')?.getChildren('item').length > 0) {
        //RSS_TYPE = 1;
        //Logger.log("RSS2.0 " + RSSFEED_URL);
        RSSFEED_TITLE = XML.getRootElement().getChild('channel').getChildText('title');//getRSSFeedTitle(RSS_TYPE, XML);
        XML.getRootElement().getChild('channel').getChildren('item').forEach(function (entry) {
          ENTRY_TITLE = entry.getChildText('title').replace(/(\')/gi, ''); // シングルクォーテーションは消す。getEntryTitle(RSS_TYPE, entry);
          ENTRY_URL = entry.getChildText('link');
          ENTRY_DESCRIPTION = entry.getChildText('description')?.replace(/(<([^>]+)>)/gi, '');//getEntryDescription(RSS_TYPE, entry);
          ENTRY_DATE = new Date(entry.getChildText('date'));

          if (some_mins_ago < ENTRY_DATE || isFirstrun(RSSFEED_URL, FIRSTRUN_URLS)) { // 期限内 or 初回実行 
            RSSFEED_ENTRIES.push({ ftitle: RSSFEED_TITLE, etitle: ENTRY_TITLE, econtent: ENTRY_DESCRIPTION, eurl: ENTRY_URL, to: TRANSLATE_TO, feed_url: RSSFEED_URL, edate: ENTRY_DATE });
          }
        });
      } else {
        Logger.log("Unknown " + RSSFEED_URL);
      }
    } else {
      Logger.log("not 200: " + RSSFEED_URL);
    }
  });
  return RSSFEED_ENTRIES.sort((a, b) => a.edate - b.edate);
}

function doToot(rssfeed_entries) {
  // Tootした後のRSS情報を記録する配列
  const current_entries_array = [];
  const firstrun_urls = [];

  // スクリプトプロパティを取得
  let ratelimit_remaining = Number(getScriptProperty('ratelimit_remaining'));
  if (ratelimit_remaining <= 0) {
    return;
  }
  let ratelimit_limit = Number(getScriptProperty('ratelimit_limit'));
  let trigger_interval = Number(getScriptProperty('trigger_interval'));
  let store_max_age = Number(getScriptProperty('store_max_age'));
  let ratelimit_reset_date = getScriptProperty('ratelimit_reset_date');

  // キャッシュの取得
  const STORED_ENTRIES_SHEET = getSheet(SPREAD_SHEET, 'store');
  const STORED_ENTRIES = getSheetValues(STORED_ENTRIES_SHEET, 2, 1, 4); // タイトル、URL、コンテンツ、時刻を取得（A2(2,1)を起点に最終データ行までの4列分）
  const STORED_ENTRY_URLS = getSheetValues(STORED_ENTRIES_SHEET, 2, 2, 1); // URLのみ取得（B2(2:2,B:2)を起点に最終データ行までの1列分) 

  // 初回実行記録シートからA2から最終行まで幅1列を取得
  const FIRSTRUN_URLS_SHEET = getSheet(SPREAD_SHEET, "firstrun");
  const FIRSTRUN_URLS = getSheetValues(FIRSTRUN_URLS_SHEET, 2, 1, 1);

  // すでにToot済みのはこの時刻で統一
  const TIMESTAMP = new Date().toString();
  // レートリミット超えによる中断・スキップ判定用
  let ratelimit_break = false;
  let toot_count = 0;
  rssfeed_entries.forEach(function (value, index, array) {
    if (!ratelimit_break) {
      if (!isFirstrun(value.feed_url, FIRSTRUN_URLS) && !isFound(STORED_ENTRY_URLS, value.eurl)) {
        const TRIGGER_INTERVAL = trigger_interval;// mins 
        const RATELIMIT_WAIT_TIME = (new Date(ratelimit_reset_date) - new Date()) / (60 * 1000);
        const CURRENT_RATELIMIT = Math.round(ratelimit_remaining * (RATELIMIT_WAIT_TIME < TRIGGER_INTERVAL ? 1 : TRIGGER_INTERVAL / RATELIMIT_WAIT_TIME));

        let response;
        try {
          let start_time = new Date();
          response = doPost(value);
          let end_time = new Date();
          toot_count++;
          Logger.log("info Toot():%s %s", toot_count, value);
          let wait_time = (1 * 1000) - (end_time - start_time);
          wait_time = wait_time < 0 ? 0 : wait_time;
          Logger.log("wait_time: " + wait_time);
          Utilities.sleep(wait_time);
        } catch (e) {
          // GASのエラーとか
          Logger.log("error Toot():" + e.message);
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
        // TootしたものをToot済みのものとして足す
        STORED_ENTRY_URLS.push([value.eurl]);

        // Tootした/するはずだったRSS情報を配列に保存。後でまとめてstoreシートに書き込む
        current_entries_array.push([value.etitle, value.eurl, value.econtent, new Date().toString()]);
      } else {
        current_entries_array.push([value.etitle, value.eurl, value.econtent, TIMESTAMP]);
      }

      if (isFirstrun(value.feed_url, FIRSTRUN_URLS)) {
        // FirstRunのfeed urlを保存
        firstrun_urls.push(value.feed_url);
      }
    }
  });

  // レートリミット情報をプロパティに保存
  setScriptProperty('ratelimit_reset_date', ratelimit_reset_date);
  setScriptProperty('ratelimit_remaining', ratelimit_remaining);
  setScriptProperty('ratelimit_limit', ratelimit_limit);
  Logger.log("setScriptProperty %s %s %s", ratelimit_reset_date, ratelimit_remaining, ratelimit_limit);

  // 初回実行記録シートにURL記録
  addFirstrunSheet(Array.from(new Set(FIRSTRUN_URLS.concat(firstrun_urls))), FIRSTRUN_URLS_SHEET);

  // 最新のRSSとキャッシュを統合してシートを更新。古いキャッシュは捨てる。
  let some_mins_ago = new Date();
  some_mins_ago.setMinutes(some_mins_ago.getMinutes() - store_max_age);
  let merged_entries_array = current_entries_array.concat(STORED_ENTRIES.filter(function (item) { return new Date(item[3]) > some_mins_ago; }));
  STORED_ENTRIES_SHEET.clear();
  if (merged_entries_array.length > 0) {
    //merged_entries_array.sort((a, b) => new Date(b[3]) - new Date(a[3]));
    STORED_ENTRIES_SHEET.getRange(2, 1, merged_entries_array.length, 4).setValues(merged_entries_array.sort((a, b) => new Date(b[3]) - new Date(a[3]))).removeDuplicates([2]);
  }
  SpreadsheetApp.flush();
}

function doPost(p) {
  let m = "";
  m = '📰 ' + p.etitle + '\n' + p.econtent + '\n';
  if (p.to) {
    m = m + '\n📝 ' + LanguageApp.translate(p.econtent ? p.econtent : p.etitle, '', p.to) + '\n';
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

  return UrlFetchApp.fetch(getScriptProperty('mastodon_url'), options);
}

/* function readRSSFeed(feed_url_list) {
  let requests = [];
  for (let i = 0; i < feed_url_list.length; i++) {
    let param = {
      url: feed_url_list[i][0],
      method: 'get',
      followRedirects: false,
      muteHttpExceptions: true
    };
    requests.push(param);
  }
  return UrlFetchApp.fetchAll(requests);
} */

/* function getRSSFeedTitle(rsstype, xml) {
  let feedtitle = "";
  switch (rsstype) {
    case 1:
      feedtitle = xml.getRootElement().getChildren('channel')[0].getChildText('title');
      break;
    case 2:
      feedtitle = xml.getRootElement().getChildren('channel', NAMESPACE_RSS)[0].getChildText('title', NAMESPACE_RSS);
      break;
  }
  return feedtitle;
} */

/* function getRSSFeedEntries(rsstype, xml) {
  let feedentries = [];
  switch (rsstype) {
    case 1:
      feedentries = xml.getRootElement().getChildren('channel')[0].getChildren('item');
      break;
    case 2:
      feedentries = xml.getRootElement().getChildren('item', NAMESPACE_RSS);
      break;
  }
  return feedentries;
} */

/* function getEntryTitle(rsstype, element) {
  let title = "";
  switch (rsstype) {
    case 1:
      title = element.getChildText('title').replace(/(\')/gi, ''); // シングルクォーテーションは消す。
      break;
    case 2:
      title = element.getChildText('title', NAMESPACE_RSS).replace(/(\')/gi, '');
      break;
  }
  return title;
} */

/* function getEntryUrl(rsstype, element, feedurl) {
  let url = "";
  switch (rsstype) {
    case 1:
      url = element.getChildText('link');
      break;
    case 2:
      url = element.getChildText('link', NAMESPACE_RSS);
      break;
  }
  if (getFQDN(url) == null) {
    url = getFQDN(feedurl) + url;
  }
  return url;
} */

/* function getEntryDescription(rsstype, element) {
  let description = "";
  switch (rsstype) {
    case 1:
      description = element.getChildText('description')?.replace(/(<([^>]+)>)/gi, '');
      break;
    case 2:
      description = element.getChildText('description', NAMESPACE_RSS)?.replace(/(<([^>]+)>)/gi, '');
      break;
  }
  return description;
} */

/* function getEntryDate(rsstype, element) {
  let date = "";
  switch (rsstype) {
    case 1:
      date = element.getChildText('pubDate');
      break;
    case 2:
      date = element.getChildText('date', NAMESPACE_DC);
      break;
  }
  return date;
} */

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

// 初回実行？
function isFirstrun(feed_url, firstrun_urls_array) {
  if (!isFound(firstrun_urls_array, feed_url)) {
    return true;
  }
  return false;
}

// 初回実行時にfirstrunsheetに追加
function addFirstrunSheet(firstrun_urls_array, firstrun_urls_sheet) {
  if (firstrun_urls_array.length > 0) {
    let array_2d = [];
    for (let j = 0; j < firstrun_urls_array.length; j++) {
      array_2d[j] = [firstrun_urls_array[j]];
    }
    firstrun_urls_sheet.clear();
    firstrun_urls_sheet.getRange(2, 1, array_2d.length, 1).setValues(array_2d);
    SpreadsheetApp.flush();
  }
  return;
}

// スクリプトプロパティがなかったとき用の初期設定
function initScriptProperty() {
  if (!getScriptProperty('trigger_interval') || !getScriptProperty('store_max_age') || !getScriptProperty('article_max_age') || !getScriptProperty('ratelimit_remaining') || !getScriptProperty('ratelimit_reset_date') || !getScriptProperty('ratelimit_limit')) {
    setScriptProperty('trigger_interval', 10); // minuites 
    setScriptProperty('store_max_age', 720); // minuites
    setScriptProperty('article_max_age', 120); // minuites
    setScriptProperty('ratelimit_reset_date', new Date() + 3 * 60 * 60 * 1000);// miliseconds
    setScriptProperty('ratelimit_remaining', 300);
    setScriptProperty('ratelimit_limit', 300);
  }
  if (new Date(getScriptProperty('ratelimit_reset_date')) <= new Date()) {
    setScriptProperty('ratelimit_reset_date', new Date() + 3 * 60 * 60 * 1000);// miliseconds
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
