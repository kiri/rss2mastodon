/*
 RSSをmastodonへPost
*/
const namespaceRSS = XmlService.getNamespace('http://purl.org/rss/1.0/');
const namespaceDC = XmlService.getNamespace("http://purl.org/dc/elements/1.1/");
const namespaceATOM = XmlService.getNamespace('http://www.w3.org/2005/Atom');

const spreadSheet = SpreadsheetApp.getActiveSpreadsheet();
//const SPREADSHEET = SpreadsheetApp.openById(getScriptProperty('spreadsheet_id'));

const scriptStartTime = Date.now();

function main() {
  initScriptProperty();

  const lock = LockService.getDocumentLock();
  try {
    lock.waitLock(0);
    let rssfeeds = readRSSFeeds();
    let postEntriesArray = doPost(rssfeeds);
    saveEntries(postEntriesArray);
  } catch (e) {
    logException(e, "main()");
  } finally {
    lock.releaseLock();
  }
}

function saveEntries(array) {
  if (array) {
    // 履歴の取得
    const storedEntriesSheet = getSheet(spreadSheet, 'store');
    const storedEntries = getSheetValues(storedEntriesSheet, 2, 1, 4); // タイトル、URL、コンテンツ、時刻を取得（A2(2,1)を起点に最終データ行までの4列分）

    // 最新のRSSとキャッシュを統合してシートを更新。古いキャッシュは捨てる。
    let maxMillisecTime = Number(getScriptProperty('store_max_time')) * 60 * 1000;
    let mergedEntriesArray = array.concat(storedEntries.filter(function (item) { return Date.now() < (new Date(item[3]).getTime() + maxMillisecTime); }));
    storedEntriesSheet.clear();
    if (mergedEntriesArray?.length > 0) {
      storedEntriesSheet.getRange(2, 1, mergedEntriesArray.length, 4).setValues(mergedEntriesArray.sort((a, b) => new Date(b[3]).getTime() - new Date(a[3]).getTime())).removeDuplicates([2]);
    }
    SpreadsheetApp.flush();
  }
}

function readRSSFeeds() {
  // RSSフィードを列挙したfeedurlsシート [feed url][翻訳]
  const rssFeedsSheet = getSheet(spreadSheet, "feedurls");
  const rssFeeds = getSheetValues(rssFeedsSheet, 2, 1, 1);
  if (rssFeeds.length == 0) {
    rssFeeds.getRange(2, 1, 1, 1).setValues([['https://example.com/rss']]);
    return [];
  }
  Logger.log(rssFeeds);

  let rssfeedUrlList = [];
  {
    let tempRssfeedUrlList = [];
    rssFeeds.forEach(function (value, index, array) {
      tempRssfeedUrlList.push(value);
      if ((index + 1) % 10 == 0) {
        rssfeedUrlList.push(tempRssfeedUrlList);
        tempRssfeedUrlList = [];
      }
    });
    rssfeedUrlList.push(tempRssfeedUrlList);
    tempRssfeedUrlList = [];
  }

  let responses = [];
  try {
    rssfeedUrlList.forEach(function (value, index, array) {
      Logger.log("rssfeed_urls_list index=" + index);
      if (Date.now() < (scriptStartTime + 2 * 60 * 1000)) {// 開始から2分までは実行可
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

        let startTime = Date.now();
        responses = responses.concat(UrlFetchApp.fetchAll(requests));
        let endTime = Date.now();
        let waitTime = (value.length * 1000) - (endTime - startTime);
        Utilities.sleep(waitTime < 0 ? 0 : waitTime);
      }
    });
  } catch (e) {
    logException(e, "readRSSFeeds()");
    return;
  }

  // 履歴の取得
  const storedEntriesSheet = getSheet(spreadSheet, 'store');
  const storedEntryUrls = getSheetValues(storedEntriesSheet, 2, 2, 1); // URLのみ取得（B2(2:2,B:2)を起点に最終データ行までの1列分) 

  // 記事の期限
  let maxMillisecTime = Number(getScriptProperty('article_max_time')) * 60 * 1000;
  let mastodonAccessToken = getScriptProperty('mastodon_accesstoken');

  // 返り値のRSSフィードのリスト
  const rssFeedEntries = [];
  responses.forEach(function (value, index, array) {
    const rssFeedUrl = rssFeeds[index][0];
    if (value.getResponseCode() == 200 && Date.now() < (scriptStartTime + 4 * 60 * 1000)) {// 開始から4分までは実行可
      let xml;
      try {
        xml = XmlService.parse(value.getContentText());
      } catch (e) { // parseで失敗することがある、よくわからないが、スキップする。
        logException(e, "readRSSFeeds()>responses.forEach");
        return;
      }
      const root = xml.getRootElement();

      // ATOM
      if (root.getChildren('entry', namespaceATOM).length > 0) {
        const rssFeedTitle = root.getChildText('title', namespaceATOM);
        root.getChildren('entry', namespaceATOM).forEach(function (entry) {
          const entryDate = new Date(entry.getChildText('updated', namespaceATOM));
          const entryUrl = entry.getChild('link', namespaceATOM).getAttribute('href').getValue();
          if (!isFound(storedEntryUrls, entryUrl) && Date.now() < (entryDate.getTime() + maxMillisecTime)) {
            let e = {
              ftitle: rssFeedTitle,
              etitle: entry.getChildText('title', namespaceATOM).replace(/(\')/gi, ''), // シングルクォーテーションは消す。
              econtent: entry.getChildText('content', namespaceATOM)?.replace(/(<([^>]+)>)/gi, ''),
              eurl: entryUrl,
              edate: entryDate,
              token: mastodonAccessToken
            };
            e.options = composeMessage(e);
            rssFeedEntries.push(e);
          }
        });
        // RSS1.0
      } else if (root.getChildren('item', namespaceRSS).length > 0) {
        const rssFeedTitle = root.getChild('channel', namespaceRSS).getChildText('title', namespaceRSS);
        root.getChildren('item', namespaceRSS).forEach(function (entry) {
          const entryDate = new Date(entry.getChildText('date', namespaceDC));
          const entryUrl = entry.getChildText('link', namespaceRSS);
          if (!isFound(storedEntryUrls, entryUrl) && Date.now() < (entryDate.getTime() + maxMillisecTime)) {
            let e = {
              ftitle: rssFeedTitle,
              etitle: entry.getChildText('title', namespaceRSS).replace(/(\')/gi, ''), // シングルクォーテーションは消す。
              econtent: entry.getChildText('description', namespaceRSS)?.replace(/(<([^>]+)>)/gi, ''),
              eurl: entryUrl,
              edate: entryDate,
              token: mastodonAccessToken
            };
            e.options = composeMessage(e);
            rssFeedEntries.push(e);
          }
        });
        // RSS2.0
      } else if (root.getChild('channel')?.getChildren('item').length > 0) {
        const rssFeedTitle = root.getChild('channel').getChildText('title');
        root.getChild('channel').getChildren('item').forEach(function (entry) {
          const entryDate = new Date(entry.getChildText('pubDate'));
          const entryUrl = entry.getChildText('link');
          if (!isFound(storedEntryUrls, entryUrl) && Date.now() < (entryDate.getTime() + maxMillisecTime)) {
            let e = {
              ftitle: rssFeedTitle,
              etitle: entry.getChildText('title').replace(/(\')/gi, ''), // シングルクォーテーションは消す。
              econtent: entry.getChildText('description')?.replace(/(<([^>]+)>)/gi, ''),
              eurl: entryUrl,
              edate: entryDate,
              token: mastodonAccessToken
            };
            e.options = composeMessage(e);
            rssFeedEntries.push(e);
          }
        });
      } else {
        Logger.log("Unknown " + rssFeedUrl);
      }
    } else {
      Logger.log("not value.getResponseCode() == 200 && Date.now() < (SCRIPT_START_TIME + 4 * 60 * 1000) " + rssFeedUrl);
    }
  });
  Logger.log("RSSFEED_ENTRIES.length " + rssFeedEntries?.length);
  return rssFeedEntries.sort((a, b) => a.edate - b.edate);
}

function doPost(rssfeedEntries) {
  // Postした後のRSS情報を記録する配列
  const currentEntriesArray = [];

  // スクリプトプロパティを取得
  let ratelimitRemaining = Number(getScriptProperty('ratelimit_remaining'));
  if (ratelimitRemaining <= 0) {
    return;
  }
  let ratelimitLimit = Number(getScriptProperty('ratelimit_limit'));
  let triggerInterval = Number(getScriptProperty('trigger_interval'));
  let ratelimitResetDate = getScriptProperty('ratelimit_reset_date');

  // レートリミット超えによる中断・スキップ判定用
  let ratelimitBreak = false;
  let postCount = 0;

  rssfeedEntries.forEach(function (value, index, array) {
    if (!ratelimitBreak && Date.now() < (scriptStartTime + 5.0 * 60 * 1000)) {// 開始から5分までは実行可
      const ratelimitWaitTime = (new Date(ratelimitResetDate).getTime() - Date.now()) / (60 * 1000);
      const currentRatelimit = Math.round(ratelimitRemaining * (ratelimitWaitTime < triggerInterval ? 1 : triggerInterval / ratelimitWaitTime));

      if (!currentEntriesArray.some(cv => cv[1] == value.eurl)) { // currentEntriesArrayにすでに含まれていたら実行しない
        let response;
        try {
          let startTime = Date.now();
          response = UrlFetchApp.fetch(getScriptProperty('mastodon_url'), value.options);
          let endTime = Date.now();
          postCount++;
          Logger.log("info Post():%s %s", postCount, value.etitle);
          let waitTime = (1 * 1000) - (endTime - startTime);
          Utilities.sleep(waitTime < 0 ? 0 : waitTime);
        } catch (e) {
          logException(e, "doPost()");
          Utilities.sleep(5 * 1000);
          return;
        }

        // レートリミット情報
        const responseHeaders = response.getHeaders();
        ratelimitRemaining = Number(responseHeaders['x-ratelimit-remaining']);
        ratelimitResetDate = responseHeaders['x-ratelimit-reset'];
        ratelimitLimit = Number(responseHeaders['x-ratelimit-limit']);
        if (postCount > currentRatelimit || response.getResponseCode() == 429) { // レートリミットを超え or 429 なら終了フラグを立てる
          ratelimitBreak = true;
        } else if (response.getResponseCode() != 200) {
          Utilities.sleep(5 * 1000);
          return;
        }
      } else {
        Logger.log("skip " + value.etitle);
      }
      // Postした/するはずだったRSS情報を配列に保存。後でまとめてstoreシートに書き込む
      currentEntriesArray.push([value.etitle, value.eurl, value.econtent, new Date().toString()]);
    } else {
      Logger.log("not !ratelimit_break && Date.now() < (SCRIPT_START_TIME + 5.0 * 60 * 1000) " + value.etitle);
    }
  });

  // レートリミット情報をプロパティに保存
  setScriptProperty('ratelimit_reset_date', ratelimitResetDate);
  setScriptProperty('ratelimit_remaining', ratelimitRemaining);
  setScriptProperty('ratelimit_limit', ratelimitLimit);

  Logger.log("setScriptProperty %s %s %s", ratelimitResetDate, ratelimitRemaining, ratelimitLimit);

  return currentEntriesArray;
}

function composeMessage(data) {
  let text = '📰 ' + data.etitle + '\n' + data.econtent + '\n';

  if (!data.etitle?.split('').some(char => char.charCodeAt() > 255 && !(char.charCodeAt() >= 8215 && char.charCodeAt() <= 8223))) { //‘とか’とかは除外
    let startTime = Date.now();
    try {
      text = text + '\n📝 ' + LanguageApp.translate(data.etitle + "\n" + data.econtent, '', 'ja') + '\n';
    } catch (e) {
      logException(e, '')
    }
    let endTime = Date.now();
    let waitTime = (1 * 1000) - (endTime - startTime);
    Utilities.sleep(waitTime < 0 ? 0 : waitTime);
  }

  const SNIP = '✂\n';
  const URL_LEN = 30;
  const MAX_TEXT_LEN = 500;
  const ICON = '\n🔳 ';
  const dateString = "(" + data.edate.toLocaleTimeString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }) + ")";
  text = ((text.length + ICON.length + dateString.length + data.ftitle.length + 1 + URL_LEN) < MAX_TEXT_LEN) ? text : (text.substring(0, MAX_TEXT_LEN - ICON.length - data.ftitle.length - dateString.length - 1 - URL_LEN - SNIP.length) + SNIP);
  text = text + ICON + data.ftitle + dateString + " " + data.eurl;

  const payload = {
    status: text,
    visibility: 'private'
  };
  const options = {
    method: 'post',
    headers: { Authorization: 'Bearer ' + data.token },
    contentType: 'application/json',
    payload: JSON.stringify(payload),
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
  return url.match(/https?:\/\/[a-zA-Z0-9.\-]*/);
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
  if (!getScriptProperty('trigger_interval') || !getScriptProperty('store_max_time') || !getScriptProperty('article_max_time') || !getScriptProperty('ratelimit_remaining') || !getScriptProperty('ratelimit_reset_date') || !getScriptProperty('ratelimit_limit')) {
    setScriptProperty('trigger_interval', 10); // minuites 
    setScriptProperty('store_max_time', 720); // minuites
    setScriptProperty('article_max_time', 120); // minuites
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
