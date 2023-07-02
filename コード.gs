/*
 RSSをmastodonへtoot
*/
const NS_RSS = XmlService.getNamespace('http://purl.org/rss/1.0/');
//const SPREADSHEET = SpreadsheetApp.openById(getScriptProperty('spreadsheet_id'));
const SPREADSHEET = SpreadsheetApp.getActiveSpreadsheet();

function main() {
  // スクリプトプロパティがなかったとき用の初期設定  
  if (!getScriptProperty('trigger_interval') || !getScriptProperty('cache_max_age') || !getScriptProperty('ratelimit_remaining') || !getScriptProperty('ratelimit_reset_date') || !getScriptProperty('ratelimit_limit')) {
    setScriptProperty('trigger_interval', 10); // minuites 
    setScriptProperty('cache_max_age', 120); // minuites
    setScriptProperty('ratelimit_reset_date', new Date() + 3 * 60 * 60 * 1000);// miliseconds
    setScriptProperty('ratelimit_remaining', 300);
    setScriptProperty('ratelimit_limit', 300);
  }
  if (new Date(getScriptProperty('ratelimit_reset_date')) <= new Date()) {
    setScriptProperty('ratelimit_reset_date', new Date() + 3 * 60 * 60 * 1000);// miliseconds
    setScriptProperty('ratelimit_remaining', 300);
  }

  const LOCK = LockService.getDocumentLock();
  try {
    LOCK.waitLock(0);
    doMastodon(getRSSEntries());
    /*
        // このあたりはFeedを収集する処理
        // RSSフィードを列挙したfeedurlsシート [feed url][翻訳]
        const FEED_SHEET = getSheet(SPREADSHEET, "feedurls");
        const FEED_LIST = getSheetValues(FEED_SHEET, 2, 1, 2);
        if (FEED_LIST.length == 0) {
          FEED_LIST.getRange(2, 1, 1, 2).setValues([['https://example.com/rss', 'en']]);
        }
    
        let feed_list = [];
        {
          let temp_feed_list = [];
          FEED_LIST.forEach(function (value, index, array) {
            temp_feed_list.push(value);
            if ((index + 1) % 10 == 0) {
              feed_list.push(temp_feed_list);
              temp_feed_list = [];
            }
          });
          feed_list.push(temp_feed_list);
          temp_feed_list = [];
        }
    
        let feed_responses = [];
        try {
          feed_list.forEach(function (value, index, array) {
            feed_responses = feed_responses.concat(getAllFeeds(value));
            Utilities.sleep(value.length * 1000);
            Logger.log("value.length: %s", value.length);
          });
          Logger.log("feed_responses.length: %s", feed_responses.length);
        } catch (e) {
          // GASのエラーとか
          Logger.log("1:" + e.message);
          Logger.log("1-1:" + FEED_LIST);
          return;
        }
    
        // feedのレスポンスから、RSSエントリを全部1つの配列に入れる。
        let rss_entries = [];
        feed_responses.forEach(function (value, index, array) {
          array[index].feed_url = FEED_LIST[index][0];
          array[index].translate_to = FEED_LIST[index][1];
    
          if (value.getResponseCode() == 200) {
            // RSSエントリを取り出す
            const XML = XmlService.parse(value.getContentText());
            const FEED_TITLE = getFeedTitle(XML);
            const FEED_ENTRIES = getFeedEntries(XML);
            const RSSTYPE = XML.getRootElement().getChildren('channel')[0] ? 1 : 2;
    
            FEED_ENTRIES.forEach(function (entry) {
              const ENTRY_TITLE = getItemTitle(RSSTYPE, entry);
              const ENTRY_URL = getItemUrl(RSSTYPE, entry, entry.feed_url);
              const ENTRY_DESCRIPTION = getItemDescription(RSSTYPE, entry);
              rss_entries.push({ ftitle: FEED_TITLE, etitle: ENTRY_TITLE, econtent: ENTRY_DESCRIPTION, eurl: ENTRY_URL, to: value.translate_to, feed_url: value.feed_url });
            });
          }
        });
        Logger.log("rss_entries.length: %s", rss_entries.length);
    
        // このあたりからマストドンへTootする処理
        // レートリミット超えによる中断・スキップ判定用
        let ratelimit_break = false;
        let t_count = 0;
    
        // Tootした後のRSS情報を記録する配列
        let current_entries_array = [];
        let firstrun_urls = [];
    
        // スクリプトプロパティを取得
        let trigger_interval = Number(getScriptProperty('trigger_interval'));
        let cache_max_age = Number(getScriptProperty('cache_max_age'));
        let ratelimit_reset_date = getScriptProperty('ratelimit_reset_date');
        let ratelimit_remaining = Number(getScriptProperty('ratelimit_remaining'));
        let ratelimit_limit = Number(getScriptProperty('ratelimit_limit'));
        if (ratelimit_remaining == 0) {
          ratelimit_break = true;
        }
    
        // キャッシュの取得
        const FEED_CACHE_SHEET = getSheet(SPREADSHEET, 'cache');
        const FEED_CACHE_ENTRIES = getSheetValues(FEED_CACHE_SHEET, 2, 1, 4); // タイトル、URL、コンテンツ、時刻を取得（A2(2,1)を起点に最終データ行までの4列分）
        let feed_cache_entrytitles = getSheetValues(FEED_CACHE_SHEET, 2, 1, 1); // タイトルのみ取得（A2(2,1)を起点に最終データ行までの1列分) 
        Logger.log("feed_cache_entrytitles.length: %s", feed_cache_entrytitles.length);
    
        // 初回実行記録シートからA2から最終行まで幅1列を取得
        const FIRSTRUN_SHEET = getSheet(SPREADSHEET, "firstrun");
        const FIRSTRUN_URLS = getSheetValues(FIRSTRUN_SHEET, 2, 1, 1);
    
        rss_entries.forEach(function (value, index, array) {
          if (!ratelimit_break) {
            if (!isFirstrun(value.feed_url, FIRSTRUN_URLS) && !isFound(feed_cache_entrytitles, value.etitle)) {
              const T_INTERVAL = trigger_interval;// mins 
              const R_WAIT_TIME = (new Date(ratelimit_reset_date) - new Date()) / (60 * 1000);
              const C_RATELIMIT = Math.round(ratelimit_remaining * (R_WAIT_TIME < T_INTERVAL ? 1 : T_INTERVAL / R_WAIT_TIME));
    
              let toot_response;
              try {
                toot_response = postToot(value);
                t_count++;
                Logger.log("5-1:%s %s", t_count, value);
                Utilities.sleep(1 * 1000);
              } catch (e) {
                // GASのエラーとか
                Logger.log("5:" + e.message);
                Utilities.sleep(5 * 1000);
                return;
              }
              // レートリミット情報
              const T_RES_HDS = toot_response.getHeaders();
              ratelimit_remaining = Number(T_RES_HDS['x-ratelimit-remaining']);
              ratelimit_reset_date = T_RES_HDS['x-ratelimit-reset'];
              ratelimit_limit = Number(T_RES_HDS['x-ratelimit-limit']);
              if (t_count > C_RATELIMIT || toot_response.getResponseCode() == 429) { // レートリミットを超え or 429 なら終了フラグを立てる
                ratelimit_break = true;
              } else if (toot_response.getResponseCode() != 200) {
                Utilities.sleep(5 * 1000);
                return;
              }
              // TootしたものをToot済みのものとして足す
              feed_cache_entrytitles.push([value.etitle]);
            }
            // Tootした/するはずだったRSS情報を配列に保存。後でまとめてcacheに書き込む
            current_entries_array.push([value.etitle, value.eurl, value.econtent, new Date().toISOString()]);
    
            if (isFirstrun(value.feed_url, FIRSTRUN_URLS)) {
              // FirstRunのfeed urlを保存
              firstrun_urls.push(value.feed_url);
            }
          }
        });
        Logger.log("feed_cache_entrytitles.length: %s", feed_cache_entrytitles.length);
        Logger.log("current_entries_array.length: %s", current_entries_array.length);
    
        // レートリミット情報をプロパティに保存
        setScriptProperty('ratelimit_reset_date', ratelimit_reset_date);
        setScriptProperty('ratelimit_remaining', ratelimit_remaining);
        setScriptProperty('ratelimit_limit', ratelimit_limit);
        Logger.log("setScriptProperty %s %s %s", ratelimit_reset_date, ratelimit_remaining, ratelimit_limit);
        //
        firstrun_urls.forEach(function (value, index, array) {
          // 初回実行記録シートにURLが含まれてなかったら初回実行フラグを立ててシートに記録
          addFirstrunSheet(value, FIRSTRUN_URLS, FIRSTRUN_SHEET);
        });
    
        // 最新のRSSとキャッシュを統合してシートを更新。古いキャッシュは捨てる。
        let some_mins_ago = new Date();
        some_mins_ago.setMinutes(some_mins_ago.getMinutes() - cache_max_age);
        let merged_entries_array = current_entries_array.concat(FEED_CACHE_ENTRIES.filter(function (item) { return new Date(item[3]) > some_mins_ago; }));
        FEED_CACHE_SHEET.clear();
        if (merged_entries_array.length > 0) {
          FEED_CACHE_SHEET.getRange(2, 1, merged_entries_array.length, 4).setValues(merged_entries_array).removeDuplicates([1]);
        }
        SpreadsheetApp.flush();
    */
  } catch (e) {
    // 
    Logger.log("8:" + e.message);
  } finally {
    LOCK.releaseLock();
  }
}

function getRSSEntries() {
  // このあたりはFeedを収集する処理
  // RSSフィードを列挙したfeedurlsシート [feed url][翻訳]
  const FEED_SHEET = getSheet(SPREADSHEET, "feedurls");
  const FEED_LIST = getSheetValues(FEED_SHEET, 2, 1, 2);
  if (FEED_LIST.length == 0) {
    FEED_LIST.getRange(2, 1, 1, 2).setValues([['https://example.com/rss', 'en']]);
  }

  let feed_list = [];
  {
    let temp_feed_list = [];
    FEED_LIST.forEach(function (value, index, array) {
      temp_feed_list.push(value);
      if ((index + 1) % 10 == 0) {
        feed_list.push(temp_feed_list);
        temp_feed_list = [];
      }
    });
    feed_list.push(temp_feed_list);
    temp_feed_list = [];
  }

  let feed_responses = [];
  try {
    feed_list.forEach(function (value, index, array) {
      feed_responses = feed_responses.concat(getAllFeeds(value));
      Utilities.sleep(value.length * 1000);
      Logger.log("value.length: %s", value.length);
    });
    Logger.log("feed_responses.length: %s", feed_responses.length);
  } catch (e) {
    // GASのエラーとか
    Logger.log("1:" + e.message);
    Logger.log("1-1:" + FEED_LIST);
    return;
  }

  // feedのレスポンスから、RSSエントリを全部1つの配列に入れる。
  let rss_entries = [];
  feed_responses.forEach(function (value, index, array) {
    array[index].feed_url = FEED_LIST[index][0];
    array[index].translate_to = FEED_LIST[index][1];

    if (value.getResponseCode() == 200) {
      // RSSエントリを取り出す
      const XML = XmlService.parse(value.getContentText());
      const FEED_TITLE = getFeedTitle(XML);
      const FEED_ENTRIES = getFeedEntries(XML);
      const RSSTYPE = XML.getRootElement().getChildren('channel')[0] ? 1 : 2;

      FEED_ENTRIES.forEach(function (entry) {
        const ENTRY_TITLE = getItemTitle(RSSTYPE, entry);
        const ENTRY_URL = getItemUrl(RSSTYPE, entry, entry.feed_url);
        const ENTRY_DESCRIPTION = getItemDescription(RSSTYPE, entry);
        rss_entries.push({ ftitle: FEED_TITLE, etitle: ENTRY_TITLE, econtent: ENTRY_DESCRIPTION, eurl: ENTRY_URL, to: value.translate_to, feed_url: value.feed_url });
      });
    }
  });
  Logger.log("rss_entries.length: %s", rss_entries.length);

  return rss_entries;
}

function doMastodon(rss_entries) {
  // このあたりからマストドンへTootする処理
  // レートリミット超えによる中断・スキップ判定用
  let ratelimit_break = false;
  let t_count = 0;

  // Tootした後のRSS情報を記録する配列
  let current_entries_array = [];
  let firstrun_urls = [];

  // スクリプトプロパティを取得
  let trigger_interval = Number(getScriptProperty('trigger_interval'));
  let cache_max_age = Number(getScriptProperty('cache_max_age'));
  let ratelimit_reset_date = getScriptProperty('ratelimit_reset_date');
  let ratelimit_remaining = Number(getScriptProperty('ratelimit_remaining'));
  let ratelimit_limit = Number(getScriptProperty('ratelimit_limit'));
  if (ratelimit_remaining == 0) {
    ratelimit_break = true;
  }

  // キャッシュの取得
  const FEED_CACHE_SHEET = getSheet(SPREADSHEET, 'cache');
  const FEED_CACHE_ENTRIES = getSheetValues(FEED_CACHE_SHEET, 2, 1, 4); // タイトル、URL、コンテンツ、時刻を取得（A2(2,1)を起点に最終データ行までの4列分）
  let feed_cache_entrytitles = getSheetValues(FEED_CACHE_SHEET, 2, 1, 1); // タイトルのみ取得（A2(2,1)を起点に最終データ行までの1列分) 
  Logger.log("feed_cache_entrytitles.length: %s", feed_cache_entrytitles.length);

  // 初回実行記録シートからA2から最終行まで幅1列を取得
  const FIRSTRUN_SHEET = getSheet(SPREADSHEET, "firstrun");
  const FIRSTRUN_URLS = getSheetValues(FIRSTRUN_SHEET, 2, 1, 1);

  rss_entries.forEach(function (value, index, array) {
    if (!ratelimit_break) {
      if (!isFirstrun(value.feed_url, FIRSTRUN_URLS) && !isFound(feed_cache_entrytitles, value.etitle)) {
        const T_INTERVAL = trigger_interval;// mins 
        const R_WAIT_TIME = (new Date(ratelimit_reset_date) - new Date()) / (60 * 1000);
        const C_RATELIMIT = Math.round(ratelimit_remaining * (R_WAIT_TIME < T_INTERVAL ? 1 : T_INTERVAL / R_WAIT_TIME));

        let toot_response;
        try {
          toot_response = postToot(value);
          t_count++;
          Logger.log("5-1:%s %s", t_count, value);
          Utilities.sleep(1 * 1000);
        } catch (e) {
          // GASのエラーとか
          Logger.log("5:" + e.message);
          Utilities.sleep(5 * 1000);
          return;
        }
        // レートリミット情報
        const T_RES_HDS = toot_response.getHeaders();
        ratelimit_remaining = Number(T_RES_HDS['x-ratelimit-remaining']);
        ratelimit_reset_date = T_RES_HDS['x-ratelimit-reset'];
        ratelimit_limit = Number(T_RES_HDS['x-ratelimit-limit']);
        if (t_count > C_RATELIMIT || toot_response.getResponseCode() == 429) { // レートリミットを超え or 429 なら終了フラグを立てる
          ratelimit_break = true;
        } else if (toot_response.getResponseCode() != 200) {
          Utilities.sleep(5 * 1000);
          return;
        }
        // TootしたものをToot済みのものとして足す
        feed_cache_entrytitles.push([value.etitle]);
      }
      // Tootした/するはずだったRSS情報を配列に保存。後でまとめてcacheに書き込む
      current_entries_array.push([value.etitle, value.eurl, value.econtent, new Date().toISOString()]);

      if (isFirstrun(value.feed_url, FIRSTRUN_URLS)) {
        // FirstRunのfeed urlを保存
        firstrun_urls.push(value.feed_url);
      }
    }
  });
  Logger.log("feed_cache_entrytitles.length: %s", feed_cache_entrytitles.length);
  Logger.log("current_entries_array.length: %s", current_entries_array.length);

  // レートリミット情報をプロパティに保存
  setScriptProperty('ratelimit_reset_date', ratelimit_reset_date);
  setScriptProperty('ratelimit_remaining', ratelimit_remaining);
  setScriptProperty('ratelimit_limit', ratelimit_limit);
  Logger.log("setScriptProperty %s %s %s", ratelimit_reset_date, ratelimit_remaining, ratelimit_limit);
  //
  firstrun_urls.forEach(function (value, index, array) {
    // 初回実行記録シートにURLが含まれてなかったら初回実行フラグを立ててシートに記録
    addFirstrunSheet(value, FIRSTRUN_URLS, FIRSTRUN_SHEET);
  });

  // 最新のRSSとキャッシュを統合してシートを更新。古いキャッシュは捨てる。
  let some_mins_ago = new Date();
  some_mins_ago.setMinutes(some_mins_ago.getMinutes() - cache_max_age);
  let merged_entries_array = current_entries_array.concat(FEED_CACHE_ENTRIES.filter(function (item) { return new Date(item[3]) > some_mins_ago; }));
  FEED_CACHE_SHEET.clear();
  if (merged_entries_array.length > 0) {
    FEED_CACHE_SHEET.getRange(2, 1, merged_entries_array.length, 4).setValues(merged_entries_array).removeDuplicates([1]);
  }
  SpreadsheetApp.flush();
}

function postToot(p) {
  let m = "";
  m = '📰 ' + p.etitle + '\n' + p.econtent + '\n';
  if (p.to) {
    m = m + '\n📝 ' + LanguageApp.translate(p.econtent ? p.econtent : p.etitle, '', p.to) + '\n';
  }
  const SNIP = '✂\n';
  const URL_LEN = 30;
  const MAX_TOOT_LEN = 500;
  const ICON = '\n🔳 ';
  m = m.length + ICON.length + p.ftitle.length + 1 + URL_LEN < MAX_TOOT_LEN ? m : m.substring(0, MAX_TOOT_LEN - ICON.length - p.ftitle.length - 1 - URL_LEN - SNIP.length) + SNIP;
  m = m + ICON + p.ftitle + " " + p.eurl;

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

function getAllFeeds(feedlist) {
  let requests = [];

  for (let i = 0; i < feedlist.length; i++) {
    let param = {
      url: feedlist[i][0],
      method: 'get',
      followRedirects: false,
      muteHttpExceptions: true
    };
    requests.push(param);
  }

  return UrlFetchApp.fetchAll(requests);
}

function getFeedTitle(xml) {
  if (xml.getRootElement().getChildren('channel')[0]) {
    return xml.getRootElement().getChildren('channel')[0].getChildText('title');
  } else {
    return xml.getRootElement().getChildren('channel', NS_RSS)[0].getChildText('title', NS_RSS);
  }
}

function getFeedEntries(xml) {
  if (xml.getRootElement().getChildren('channel')[0]) {
    return xml.getRootElement().getChildren('channel')[0].getChildren('item');
  } else {
    return xml.getRootElement().getChildren('item', NS_RSS);
  }
}

function getItemTitle(rsstype, element) {
  let title = "";
  switch (rsstype) {
    case 1:
      title = element.getChildText('title').replace(/(\')/gi, ''); // シングルクォーテーションは消す。
      break;
    case 2:
      title = element.getChildText('title', NS_RSS).replace(/(\')/gi, '');
      break;
  }
  return title;
}

function getItemUrl(rsstype, element, feedurl) {
  let url = "";
  switch (rsstype) {
    case 1:
      url = element.getChildText('link');
      break;
    case 2:
      url = element.getChildText('link', NS_RSS);
      break;
  }
  if (getFQDN(url) == null) {
    url = getFQDN(feedurl) + url;
  }
  return url;
}

function getItemDescription(rsstype, element) {
  let description = "";
  switch (rsstype) {
    case 1:
      description = element.getChildText('description')?.replace(/(<([^>]+)>)/gi, '');
      break;
    case 2:
      description = element.getChildText('description', NS_RSS)?.replace(/(<([^>]+)>)/gi, '');
      break;
  }
  return description;
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

// 初回実行？
function isFirstrun(feed_url, firstrun_urls_array) {
  if (!isFound(firstrun_urls_array, feed_url)) {
    //Logger.log("初回実行 " + feed_url);
    return true;
  }
  return false;
}

// 初回実行時にfirstrunsheetに追加
function addFirstrunSheet(feed_url, firstrun_urls_array, firstrun_urls_sheet) {
  // 初回実行記録シートにURLが含まれてなかったら初回実行フラグを立ててシートに記録
  if (!isFound(firstrun_urls_array, feed_url)) {
    //Logger.log("初回実行シートにFEEDを追加 " + feed_url);
    // FEED＿URLを配列firstrun_urlsに追加してfirstrun_sheetに書き込む
    firstrun_urls_array.push(feed_url);
    if (firstrun_urls_array.length > 0) {
      let array_2d = [];
      for (let j = 0; j < firstrun_urls_array.length; j++) {
        array_2d[j] = [firstrun_urls_array[j]];
      }
      firstrun_urls_sheet.clear();
      firstrun_urls_sheet.getRange(2, 1, array_2d.length, 1).setValues(array_2d);
      SpreadsheetApp.flush();
    }
  }
  return;
}

// スクリプトプロパティ取得
function getScriptProperty(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}
// スクリプトプロパティ保存
function setScriptProperty(key, value) {
  return PropertiesService.getScriptProperties().setProperty(key, value);
}
