/*
 RSSをmastodonへtoot
*/
function main() {
  const LOCK = LockService.getDocumentLock();
  try {
    LOCK.waitLock(0);
    // Add one line to use BetterLog https://github.com/peterherrmann/BetterLog
    Logger = BetterLog.useSpreadsheet(getScriptProperty('betterlog_id'));
    Logger.log("開始");
    const SPREADSHEET = SpreadsheetApp.openById(getScriptProperty('spreadsheet_id'));
    const NS_RSS = XmlService.getNamespace('http://purl.org/rss/1.0/');

    // 初回実行記録シートからA2から最終行まで幅1列を取得
    const FIRSTRUN_SHEET = getSheet(SPREADSHEET, "firstrun");
    const FIRSTRUN_URLS = getSheetValues(FIRSTRUN_SHEET, 2, 1, 1);
    //Logger.log(FIRSTRUN_URLS);

    // RSSフィードを列挙したfeedurlsシート [feed url][キャッシュシート名][翻訳]
    const FEED_SHEET = getSheet(SPREADSHEET, "feedurls");
    if (getSheetValues(FEED_SHEET, 2, 1, 3).length == 0) {
      Logger.log("feedurlsシートがカラです。");
      FEED_LIST.getRange(2, 1, 1, 3).setValues([['https://news.yahoo.co.jp/rss/topics/top-picks.xml', 'en', 'Default']]);
    }

    // feedurlsシートに記載されたURLをまとめて取得する [feed url][キャッシュシート名][翻訳]
    const FEED_LIST = getSheetValues(FEED_SHEET, 2, 1, 3);
    Logger.log(FEED_LIST);
    const FEED_RESPONSES = doFetchAllFeeds(FEED_LIST);

    // レートリミット初期値
    let initial_ratelimit_remaining = getScriptProperty('ratelimit_remaining');
    Logger.log("ratelimit_remaining %s, ratelimit_limit %s, ratelimit_reset_date %s", getScriptProperty('ratelimit_remaining'), getScriptProperty('ratelimit_limit'), getScriptProperty('ratelimit_reset_date'));

    // レートリミット超えで中断・スキップ判定用
    let ratelimit_break = false;

    // feedのレスポンスを順番に処理する
    for (let i = 0; i < FEED_RESPONSES.length; i++) {
      if (ratelimit_break == true) { break; }

      if (FEED_RESPONSES[i].getResponseCode() == 200) {
        const XML = XmlService.parse(FEED_RESPONSES[i].getContentText());
        const FEED_TITLE = getFeedTitle(XML, NS_RSS);
        const FEED_ENTRIES = getFeedEntries(XML, NS_RSS);

        // キャッシュの取得
        const FEED_CACHE_SHEET = getSheet(SPREADSHEET, FEED_LIST[i][1] ? FEED_LIST[i][1] : "Default");
        const FEED_CACHE_ENTRYTITLES = getSheetValues(FEED_CACHE_SHEET, 2, 1, 1); // タイトルのみ取得（A2(2,1)を起点に最終データ行までの1列分) 
        const FEED_CACHE_ENTRIES = getSheetValues(FEED_CACHE_SHEET, 2, 1, 4); // タイトル、URL、コンテンツ、時刻を取得（A2(2,1)を起点に最終データ行までの4列分）

        // 初回実行記録シートにURLが含まれているか
        const FIRSTRUN_FLAG = isFirstrun(FEED_LIST[i][0], FIRSTRUN_URLS, FIRSTRUN_SHEET);
        // RSS情報を記録する配列
        let current_entries_array = [];

        FEED_ENTRIES.forEach(function (entry) {
          if (ratelimit_break == true) { return; }

          const ENTRY_TITLE = getItemTitle(XML, NS_RSS, entry);
          const ENTRY_URL = getItemUrl(XML, NS_RSS, entry, FEED_LIST[i][0]);
          const ENTRY_DESCRIPTION = getItemDescription(XML, NS_RSS, entry);

          // 条件が揃ったらTootする
          if (!FIRSTRUN_FLAG && (FEED_CACHE_ENTRYTITLES.length == 0 || !isFound(FEED_CACHE_ENTRYTITLES, ENTRY_TITLE))) {
            const TOOT_RESPONSE = postToot({ "ftitle": FEED_TITLE, "etitle": ENTRY_TITLE, "econtent": ENTRY_DESCRIPTION, "eurl": ENTRY_URL, "to": FEED_LIST[i][2] });

            // レスポンスヘッダからレートリミットを得る
            const T_RES_HDS = TOOT_RESPONSE.getHeaders();
            if (!initial_ratelimit_remaining) { initial_ratelimit_remaining = Number(T_RES_HDS['x-ratelimit-remaining']) + 1; }// レートリミット残初期値
            const T_COUNT = initial_ratelimit_remaining - Number(T_RES_HDS['x-ratelimit-remaining']);

            // 今回適用するレートリミットを算出
            const T_INTERVAL = 10;// mins
            const R_WAIT_TIME = new Date(T_RES_HDS['x-ratelimit-reset']) - new Date();
            const C_RATELIMIT = Math.round(Number(T_RES_HDS['x-ratelimit-remaining']) * (T_INTERVAL * 60 * 1000 > R_WAIT_TIME ? 1 : T_INTERVAL * 60 * 1000 / R_WAIT_TIME));
            Logger.log("%s, %s, 今回RL残 %s %, TOOT数 %s, 今回RL残数 %s, RL残 %s %, RL残数 %s, RESET予定時刻 %s, RL %s", FEED_TITLE, ENTRY_TITLE, Math.ceil((C_RATELIMIT - T_COUNT) / C_RATELIMIT * 100), T_COUNT, C_RATELIMIT, Math.round(100 * Number(T_RES_HDS['x-ratelimit-remaining']) / Number(T_RES_HDS['x-ratelimit-limit'])), Number(T_RES_HDS['x-ratelimit-remaining']), new Date(T_RES_HDS['x-ratelimit-reset']).toLocaleString('ja-JP'), Number(T_RES_HDS['x-ratelimit-limit']));
            if (T_COUNT > C_RATELIMIT) { ratelimit_break = true; } // レートリミットを超えたら終了フラグを立てる 

            // レートリミット情報をプロパティに保存
            setScriptProperty('ratelimit_remaining', Number(T_RES_HDS['x-ratelimit-remaining']));
            setScriptProperty('ratelimit_limit', Number(T_RES_HDS['x-ratelimit-limit']));
            setScriptProperty('ratelimit_reset_date', T_RES_HDS['x-ratelimit-reset']);

            // レスポンスコードに応じて処理
            if (TOOT_RESPONSE.getResponseCode() == 429) {
              throw new Error("HTTP 429");
            } else if (TOOT_RESPONSE.getResponseCode() != 200) {
              Utilities.sleep(5 * 1000);
              return;
            }
          }
          // RSS情報を配列に保存。後でまとめてSHEETに書き込む
          current_entries_array.push([ENTRY_TITLE, ENTRY_URL, ENTRY_DESCRIPTION, new Date().toISOString()]);
        });
        if (FIRSTRUN_FLAG == true) {
          // 初回実行記録シートにURLが含まれてなかったら初回実行フラグを立ててシートに記録
          addFirstrunSheet(FEED_LIST[i][0], FIRSTRUN_URLS, FIRSTRUN_SHEET);
        }

        // 最新のRSSとキャッシュを統合してシートを更新。古いキャッシュは捨てる。
        let some_mins_ago = new Date();
        some_mins_ago.setMinutes(some_mins_ago.getMinutes() - 720);
        let merged_entries_array = current_entries_array.concat(FEED_CACHE_ENTRIES.filter(function (item) { return new Date(item[3]) > some_mins_ago; }));
        FEED_CACHE_SHEET.clear();
        if (merged_entries_array.length > 0) {
          FEED_CACHE_SHEET.getRange(2, 1, merged_entries_array.length, 4).setValues(merged_entries_array).removeDuplicates([1]);
        }
        SpreadsheetApp.flush();
        //Logger.log("[キャッシュ数] %s [カレント数] %s", FEED_CACHE_ENTRYTITLES.length, FEED_ENTRIES_ARRAY.length);
      } else {
        //ステータスが200じゃないときの処理
        Logger.log("feed:%s response:%s", FEED_LIST[i][1], FEED_RESPONSES[i].getResponseCode());
      }
    }
    Logger.log("ratelimit_remaining %s, ratelimit_limit %s, ratelimit_reset_date %s", getScriptProperty('ratelimit_remaining'), getScriptProperty('ratelimit_limit'), getScriptProperty('ratelimit_reset_date'));
    Logger.log("終了");
  } catch (e) {
    if (e.message === "HTTP 429") {
      Logger.log("[名前] %s [場所] %s(%s行目) [メッセージ] %s", e.name, e.fileName, e.lineNumber, e.message);
    } else {
      Logger.log("[名前] %s\n[場所] %s(%s行目)\n[メッセージ] %s\n[StackTrace]\n%s", e.name, e.fileName, e.lineNumber, e.message, e.stack);
    }
  } finally {
    LOCK.releaseLock();
  }
}

function postToot(p) {
  let m = "";
  m = p.etitle + "\n" + p.econtent + "\n";
  if (p.to) {
    m = m + "\n【翻訳】 " + LanguageApp.translate(p.etitle, "", p.to) + "\n" + LanguageApp.translate(p.econtent, "", p.to) + "\n";
  }
  
  m = m.length + p.ftitle.length + 1 + 30 < 500 ? m : m.substring(0, 500 - p.ftitle.length - 1 - 30 - 7) + "(snip)\n";
  m = m + p.ftitle + " " + p.eurl;

  const payload = {
    "status": m,
    "visibility": "private"
  };
  const options = {
    "method": "post",
    "payload": JSON.stringify(payload),
    "headers": { "Authorization": "Bearer " + getScriptProperty('mastodon_accesstoken') },
    "contentType": "application/json",
    "muteHttpExceptions": true
  };

  return UrlFetchApp.fetch(getScriptProperty('mastodon_url'), options);
}

function doFetchAllFeeds(feedlist) {
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

function getFeedTitle(xml, namespace) {
  if (xml.getRootElement().getChildren('channel')[0]) {
    return xml.getRootElement().getChildren('channel')[0].getChildText('title');
  } else {
    return xml.getRootElement().getChildren('channel', namespace)[0].getChildText('title', namespace);
  }
}

function getFeedEntries(xml, namespace) {
  if (xml.getRootElement().getChildren('channel')[0]) {
    return xml.getRootElement().getChildren('channel')[0].getChildren('item');
  } else {
    return xml.getRootElement().getChildren('item', namespace);
  }
}

function getItemTitle(xml, namespace, element) {
  let title = "";
  if (xml.getRootElement().getChildren('channel')[0]) {
    title = element.getChildText('title').replace(/(\')/gi, ''); // シングルクォーテーションは消す。
  } else {
    title = element.getChildText('title', namespace).replace(/(\')/gi, '');
  }
  return title;
}

function getItemUrl(xml, namespace, element, feedurl) {
  let url = "";
  if (xml.getRootElement().getChildren('channel')[0]) {
    url = element.getChildText('link');
  } else {
    url = element.getChildText('link', namespace);
  }
  if (getFQDN(url) == null) {
    url = getFQDN(feedurl) + url;
  }
  return url;
}

function getItemDescription(xml, namespace, element) {
  let description = "";
  if (xml.getRootElement().getChildren('channel')[0]) {
    description = element.getChildText('description')?.replace(/(<([^>]+)>)/gi, '');
  } else {
    description = element.getChildText('description', namespace)?.replace(/(<([^>]+)>)/gi, '');
  }
  return description;
}

// 配列から一致する値の有無確認
function isFound(array, data) {
  for (let i = 0; i < array.length; i++) {
    if (array[i].toString() === data) {
      return true;
    }
  }
  return false;
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
function isFirstrun(feed_url, firstrun_urls_array, firstrun_urls_sheet) {
  if (!isFound(firstrun_urls_array, feed_url)) {
    Logger.log("初回実行 " + feed_url);
    return true;
  }
  return false;
}

// 初回実行時にfirstrunsheetに追加
function addFirstrunSheet(feed_url, firstrun_urls_array, firstrun_urls_sheet) {
  // 初回実行記録シートにURLが含まれてなかったら初回実行フラグを立ててシートに記録
  if (!isFound(firstrun_urls_array, feed_url)) {
    Logger.log("初回実行シートにFEEDを追加 " + feed_url);
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