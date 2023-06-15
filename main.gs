/*
 RSSをスプレットシートへ書き込み後、mastodonへtoot
*/
function main() {
  const LOCK = LockService.getDocumentLock();

  try {
    LOCK.waitLock(0);

    const SPREADSHEET = SpreadsheetApp.openById(getScriptProperty('spreadsheet_id'));
    const NS_RSS = XmlService.getNamespace('http://purl.org/rss/1.0/');

    // 初回実行記録シートからA2から最終行まで幅1列を取得
    const SHEET_FIRSTRUN_URLS = getSheet(SPREADSHEET, "firstrun");
    const FIRSTRUN_URLS = SHEET_FIRSTRUN_URLS.getLastRow() - 1 == 0 ? [] : getSheetValues(SHEET_FIRSTRUN_URLS, 2, 1, 1);
    Logger.log(FIRSTRUN_URLS);

    // RSSフィードを列挙したfeedurlsシートからA2から最終行まで幅4列を取得
    const SHEET_FEED_URLS = SPREADSHEET.getSheetByName("feedurls");
    if (!SHEET_FEED_URLS) {
      Logger.log("feedurlsシートがないので終了します。");
      return;
    }
    const FEED_INFO_ARRAY = getSheetValues(SHEET_FEED_URLS, 2, 1, 4);

    // feedurlsシートに記載されたURLをまとめて取得する
    const FETCH_RESPONSES = fetchAll(FEED_INFO_ARRAY);

    // Tootした数を数える
    let toot_count = 0;
    let ratelimit_break = false;

    // feedのレスポンスを順番に処理する
    for (i = 0; i < FEED_INFO_ARRAY.length; i++) {
      if (ratelimit_break == true) { break; }

      const FETCH_RESPONSE = FETCH_RESPONSES[i];

      if (FETCH_RESPONSE.getResponseCode() == 200) {
        const XML = XmlService.parse(FETCH_RESPONSE.getContentText());
        const [FEED_TITLE, FEED_ENTRIES_ARRAY] = getFeedEntries(XML, NS_RSS);

        // フィード情報
        const FEED_URL = FEED_INFO_ARRAY[i][0];
        const TRANS_FROM = FEED_INFO_ARRAY[i][1];
        const TRANS_TO = FEED_INFO_ARRAY[i][2];
        const FEED_CACHE_SHEET_NAME = FEED_INFO_ARRAY[i][3];
        Logger.log("[feed title] %s [feed url] %s", FEED_TITLE, FEED_URL);

        // キャッシュの取得
        const SHEET_FEED_CACHE = getSheet(SPREADSHEET, FEED_CACHE_SHEET_NAME);
        const FEED_CACHE_ENTRYTITLES = SHEET_FEED_CACHE.getLastRow() - 1 == 0 ? [] : getSheetValues(SHEET_FEED_CACHE, 2, 1, 1);  // タイトルのみ取得（A2(2,1)を起点に最終データ行までの1列分) 
        const FEED_CACHE_ENTRIES = SHEET_FEED_CACHE.getLastRow() - 1 == 0 ? [] : getSheetValues(SHEET_FEED_CACHE, 2, 1, 4);  // タイトル、URL、コンテンツ、時刻を取得（A2(2,1)を起点に最終データ行までの4列分）

        // 初回実行記録シートにURLが含まれているか
        const FIRSTRUN_FLAG = isFirstrun(FEED_URL, FIRSTRUN_URLS, SHEET_FIRSTRUN_URLS);
        // RSS情報を記録する配列
        let current_entries_array = [];

        // 条件が揃ったらTootする
        FEED_ENTRIES_ARRAY.forEach(function (entry) {
          if (ratelimit_break == true) { return; }

          const [ENTRY_TITLE, ENTRY_URL, ENTRY_DESCRIPTION] = getItem(XML, NS_RSS, entry, FEED_URL);
          if ((FEED_CACHE_ENTRYTITLES.length == 0 || !isFound(FEED_CACHE_ENTRYTITLES, ENTRY_TITLE)) && !FIRSTRUN_FLAG) {
            const TOOT_RESPONSE = doToot({ "feedtitle": FEED_TITLE, "entrytitle": ENTRY_TITLE, "entrycontent": ENTRY_DESCRIPTION, "entryurl": ENTRY_URL, "source": TRANS_FROM, "target": TRANS_TO });

            toot_count++;
            Logger.log("[ResponseCode] %s [ContentText] %s [Entry Title] %s", TOOT_RESPONSE.getResponseCode(), TOOT_RESPONSE.getContentText(), ENTRY_TITLE);
            const TOOT_RESPONSE_HEADERS = TOOT_RESPONSE.getHeaders();
            if (TOOT_RESPONSE.getResponseCode() != 200) {
              if (TOOT_RESPONSE.getResponseCode() == 429) {
                Logger.log("レートリミット残 %s %, リセット予定時刻 %s", 100 * TOOT_RESPONSE_HEADERS['x-ratelimit-remaining'] / TOOT_RESPONSE_HEADERS['x-ratelimit-limit'], new Date(TOOT_RESPONSE_HEADERS['x-ratelimit-reset']));
                throw new Error("HTTP 429");
              }
              return;
            }

            //今回のレートリミット
            const TRIGGER_INTERVAL = 10;// mins
            const RATELIMIT_REMAINING = TOOT_RESPONSE_HEADERS['x-ratelimit-remaining'];
            const RATELIMIT_LIMIT = TOOT_RESPONSE_HEADERS['x-ratelimit-limit'];
            const RATELIMIT_RESET_DATE = TOOT_RESPONSE_HEADERS['x-ratelimit-reset'];
            const CURRENT_RATELIMIT = RATELIMIT_REMAINING / ((new Date(RATELIMIT_RESET_DATE) - new Date()) / (TRIGGER_INTERVAL * 60 * 1000));
            Logger.log("レートリミット残数 %s レートリミット %s レートリミット残 %s %, リセット予定時刻 %s", RATELIMIT_REMAINING, RATELIMIT_LIMIT, 100 * RATELIMIT_REMAINING / RATELIMIT_LIMIT, new Date(RATELIMIT_RESET_DATE));
            if (toot_count > CURRENT_RATELIMIT) { // レートリミットを超えたら終了フラグを立てる 
              Logger.log("投稿数 %s が今回分リミット %s 回を超えました。", toot_count, CURRENT_RATELIMIT);
              ratelimit_break = true;
            }
          }
          // RSS情報を配列に保存。後でまとめてSHEETに書き込む
          current_entries_array.push([ENTRY_TITLE, ENTRY_URL, ENTRY_DESCRIPTION, new Date().toISOString()]);
        });
        if (FIRSTRUN_FLAG == true) {
          // 初回実行記録シートにURLが含まれてなかったら初回実行フラグを立ててシートに記録
          addFirstrunSheet(FEED_URL, FIRSTRUN_URLS, SHEET_FIRSTRUN_URLS);
        }
        // 最新のRSSとキャッシュを統合してシートを更新。古いキャッシュは捨てる。
        let some_mins_ago = new Date();
        some_mins_ago.setMinutes(some_mins_ago.getMinutes() - 720);
        let merged_entries_array = current_entries_array.concat(FEED_CACHE_ENTRIES.filter(function (item) { return new Date(item[3]) > some_mins_ago; }));
        SHEET_FEED_CACHE.clear();
        if (merged_entries_array.length > 0) {
          SHEET_FEED_CACHE.getRange(2, 1, merged_entries_array.length, 4).setValues(merged_entries_array).removeDuplicates([1]);
        }
        SpreadsheetApp.flush();
        Logger.log("[キャッシュ数] %s [カレント数] %s", FEED_CACHE_ENTRYTITLES.length, FEED_ENTRIES_ARRAY.length);
      } else {
        //ステータスが200じゃないときの処理
      }
    }
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

function doToot(p) {
  let m = "";
  m = p.entrytitle + "\n" + p.entrycontent + "\n";
  m = m.length + p.feedtitle.length + 1 + 30 < 500 ? m : m.substring(0, 500 - p.feedtitle.length - 1 - 30 - 7) + "(snip)\n";
  m = m + p.feedtitle + " " + p.entryurl;
  const RESPONSE = postToot(m);

  // 翻訳版のToot
  if (RESPONSE.getResponseCode() == 200 && p.source && p.target) {
    doToot({
      "feedtitle": LanguageApp.translate(p.feedtitle, p.source, p.target),
      "entrytitle": "【翻訳】\n" + LanguageApp.translate(p.entrytitle, p.source, p.target),
      "entrycontent": LanguageApp.translate(p.entrycontent, p.source, p.target),
      "entryurl": RESPONSE.url,
      "source": null,
      "target": null
    });
  }
  // 本編のステータスを返す
  return RESPONSE;
}

function postToot(status) {
  const payload = {
    "status": status,
    "visibility": "private"
  };
  const options = {
    "method": "post",
    "payload": JSON.stringify(payload),
    "headers": { "Authorization": "Bearer " + getScriptProperty('mastodon_accesstoken') },
    "contentType": "application/json",
    "muteHttpExceptions": true
  };
  try {
    const RESPONSE_FETCH_MASTODON_URL = UrlFetchApp.fetch(getScriptProperty('mastodon_url'), options);
    //Logger.log(RESPONSE_FETCH_MASTODON_URL);
    return RESPONSE_FETCH_MASTODON_URL;
  } catch (e) {
    Logger.log("[名前] %s\n[場所] %s(%s行目)\n[メッセージ] %s\n[StackTrace]\n%s", e.name, e.fileName, e.lineNumber, e.message, e.stack);
  }
}

function fetchAll(feedinfos) {
  let requests = [];

  for (let i = 0; i < feedinfos.length; i++) {
    let param = {
      url: feedinfos[i][0],
      method: 'get',
      followRedirects: false,
      muteHttpExceptions: true
    };
    requests.push(param);
  }

  return UrlFetchApp.fetchAll(requests);
}

function getFeedEntries(xml, namespace) {
  if (xml.getRootElement().getChildren('channel')[0]) {
    return [
      xml.getRootElement().getChildren('channel')[0].getChildText('title'),
      xml.getRootElement().getChildren('channel')[0].getChildren('item')
    ];
  } else {
    return [
      xml.getRootElement().getChildren('channel', namespace)[0].getChildText('title', namespace),
      xml.getRootElement().getChildren('item', namespace)
    ];
  }
}

function getItem(xml, namespace, element, feedurl) {
  let title = ""; let url = ""; let description = "";
  if (xml.getRootElement().getChildren('channel')[0]) {
    title = element.getChildText('title').replace(/(\')/gi, ''); // シングルクォーテーションは消す。
    url = element.getChildText('link');
    description = element.getChildText('description').replace(/(<([^>]+)>)/gi, '');
  } else {
    title = element.getChildText('title', namespace).replace(/(\')/gi, '');
    url = element.getChildText('link', namespace);
    description = element.getChildText('description', namespace).replace(/(<([^>]+)>)/gi, '');
  }
  if (getFQDN(url) == null) {
    url = getFQDN(feedurl) + url;
  }
  return [title, url, description];
}

// 配列から一致する値の有無確認
function isFound(array, data) {
  for (var i = 0; i < array.length; i++) {
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

function isFirstrun(feed_url, firstrun_urls_array, firstrun_urls_sheet) {
  if (!isFound(firstrun_urls_array, feed_url)) {
    Logger.log("初回実行 " + feed_url);
    return true;
  }
  return false;
}

function addFirstrunSheet(feed_url, firstrun_urls_array, firstrun_urls_sheet) {
  // 初回実行記録シートにURLが含まれてなかったら初回実行フラグを立ててシートに記録
  if (!isFound(firstrun_urls_array, feed_url)) {
    Logger.log("初回実行シートにFEEDを追加 " + feed_url);
    // FEED＿URLを配列firstrun_urlsに追加してfirstrun_sheetに書き込む
    firstrun_urls_array.push(feed_url);
    if (firstrun_urls_array.length > 0) {
      let array_2d = [];
      for (j = 0; j < firstrun_urls_array.length; j++) {
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
function getScriptProperty(id) {
  return PropertiesService.getScriptProperties().getProperty(id);
}
