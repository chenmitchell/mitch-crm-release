// ref:3687 mc/陳彥輔/米球®
/**
 * 查重的比對鍵(純函式,與 Nest 無關,方便單獨測)。
 *
 * 這個檔存在的理由:查重的三個鍵(識別碼、電話、公司名)原本全部假設台灣資料。
 * 電話只把非數字去掉,公司名只剝九個中文後綴。失效方向是「漏抓」而不是「誤合併」,
 * 所以不會毀資料 —— 但查重頁回 0 組,使用者會以為名單是乾淨的,
 * 那比跳錯誤訊息更難發現。德國那種 `+49 30 12345678` / `030 12345678` /
 * `0049 30 12345678` 三種寫法混用的名單,原本會被分成三群各一筆,一組都列不出來。
 *
 * 為什麼介面只有正體中文,這裡卻剝德文、荷文、英文的法人格後綴:那不是殘留,
 * 是產品定位的一部分。介面語言決定的是誰看得懂這套系統,資料語言決定的是
 * 這套系統吃得下誰的名單。台灣公司的客戶名單本來就會有外商,把這幾組後綴刪掉,
 * 等於把適用範圍縮回一個國家,而且失效方式是安靜的:查重頁照樣回 0 組。
 * 要動這份清單,請先補測試案例,不要憑「用不到」刪。
 */

/** 全形英數與標點轉半形(U+FF01..U+FF5E → U+0021..U+007E;全形空白 → 半形空白) */
export function toHalfWidth(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else out += ch;
  }
  return out;
}

export function normalizeTaxId(v: string | null | undefined): string {
  return toHalfWidth(v ?? '').replace(/\s+/g, '');
}

/** 電話去掉所有非數字(保留給呼叫端判斷「有幾碼」用,不是比對鍵) */
export function normalizePhone(v: string | null | undefined): string {
  return toHalfWidth(v ?? '').replace(/\D/g, '');
}

/** 電話至少要有這麼多碼才拿來比對,理由見 phoneDuplicateKey */
export const MIN_PHONE_DIGITS = 8;

/**
 * 拿來當「電話相同」判定的鍵。數字不足 MIN_PHONE_DIGITS 碼就回 null(不比)。
 *
 * 門檻不能調低:一組系統只要有幾筆分機或門牌號碼被填進電話欄,門檻降到三碼
 * 就會把它們全部湊成一大群「疑似重複」,而合併是不可逆的動作。
 * 這個門檻改掉不會有型別錯誤也不會有畫面異常,所以由測試釘住。
 *
 * ── 國碼正規化 ────────────────────────────────────────────────
 * `defaultCallingCode` 是這個組織所在地的 E.164 冠碼(德國 49、台灣 886),
 * 由系統設定的「地區與語言」推出來(見 callingCodeForLocale)。給了它之後:
 *   1. `+` 或 `00` 開頭的一律當國際格式;`+49 (0)30` 這種把國內幹線 0 寫在
 *      括號裡的歐洲寫法,括號那個 0 先拿掉
 *   2. 國際格式且冠碼就是本地冠碼 → 剝掉冠碼,剩下的是「國內有效號碼」
 *   3. 國內格式 → 剝掉一個前導 0(幹線碼)
 *   4. 剩下的號碼當鍵;不是本地冠碼的國際號碼另外以 `+` 開頭成鍵,
 *      不會跟國內號碼撞在一起
 * 沒給 `defaultCallingCode`(單元測試,或設定的地區沒有地區子標籤)時,
 * 完全維持舊行為:純數字比對,不剝任何東西。
 *
 * 已知取捨:義大利的國內號碼保留前導 0(`06` 就是羅馬),第 3 步會多剝一個 0,
 * 所以義大利的國際寫法與國內寫法還是對不起來。要正確處理得帶進整套
 * libphonenumber 的號碼規則,成本遠高於查重這一格的價值。
 * 另外「沒有 + 也沒有 00、但開頭剛好是冠碼」(886912345678)無法與國內寫法
 * 區分,一律當國內號碼看待。
 */
export function phoneDuplicateKey(
  v: string | null | undefined,
  defaultCallingCode?: string,
): string | null {
  const raw = toHalfWidth(v ?? '').trim();
  // 位數門檻看的是原始數字量,與是不是國際格式無關 ——
  // 換成看剝完國碼的長度,一批本來比得到的短號會安靜地不再參與比對
  if (normalizePhone(raw).length < MIN_PHONE_DIGITS) return null;

  const cc = (defaultCallingCode ?? '').replace(/\D/g, '');
  if (!cc) return normalizePhone(raw);

  // `+49 (0)30 …`:括號裡的 0 是「撥國內時要補、撥國際時不要」的幹線碼,先拿掉
  const withoutTrunkParen = raw.replace(/\(\s*0\s*\)/g, '');
  const international = /^\s*(\+|00)/.test(withoutTrunkParen);
  let digits = withoutTrunkParen.replace(/\D/g, '');

  if (international) {
    // `00` 是多數國家的國際冠碼(NANP 是 011,那邊不會這樣寫,無妨)
    if (!withoutTrunkParen.trimStart().startsWith('+')) digits = digits.replace(/^00/, '');
    if (digits.startsWith(cc) && digits.length > cc.length) {
      // 本地號碼:剝掉冠碼,再剝一次可能被一起寫進來的幹線 0
      return digits.slice(cc.length).replace(/^0/, '');
    }
    // 外國號碼:自成一個命名空間,不會跟國內號碼撞號
    return `+${digits}`;
  }
  return digits.replace(/^0/, '');
}

/**
 * 公司名要剝掉的後綴。
 *
 * 分兩組是因為剝法不一樣:
 *   CJK 這一組直接比字尾(中文的公司後綴不用空白斷詞);
 *   LATIN 這一組**必須是獨立的詞**才剝 —— 否則 `ag` 會把「Bodega」剝成「Bodeg」、
 *   `as` 會把「Vegas」剝成「Veg」,把兩家不相干的公司併成一群。
 *   查重的失效方向必須是漏抓,不能是誤合併:合併不可逆。
 *
 * 這份清單目前寫死在程式裡,沒有後台設定。它不是「哪一行的分類」那種
 * 各組織不同的業務語彙,而是各國公司法的法人格後綴,加一個新國家等於加一筆常數。
 * check-hardcoded-vocab 的 company-suffix-literal 規則盯著這一類清單:
 * 這一份是唯一的來源(allowlist 放行),任何第二份複製品都會被擋在 CI。
 */
const CJK_COMPANY_SUFFIXES: readonly string[] = [
  '股份有限公司',
  '有限責任公司',
  '有限公司',
  '企業社',
  '企業行',
  '商行',
  '工作室',
  '事務所',
  '公司',
  '商號',
  '株式会社',
  '有限会社',
  '合同会社',
  '주식회사',
];

/** 拉丁字母的法人格後綴(小寫、已去掉點號)。只有整個詞相符才剝,理由見上面 */
const LATIN_COMPANY_SUFFIXES: readonly string[] = [
  // 德語區
  'gmbh',
  'mbh',
  'ug',
  'ohg',
  'kgaa',
  'gbr',
  'eg',
  'ev',
  'ag',
  'kg',
  // 英語區
  'incorporated',
  'corporation',
  'limited',
  'company',
  'inc',
  'corp',
  'llc',
  'llp',
  'lllp',
  'ltd',
  'plc',
  'lp',
  'co',
  // 法語 / 西語 / 葡語 / 義語
  'sarl',
  'sasu',
  'sas',
  'sca',
  'scs',
  'sprl',
  'srl',
  'spa',
  'sl',
  'slu',
  'sa',
  'cv',
  'lda',
  'eirl',
  // 荷語 / 北歐 / 東歐 / 其他
  'bvba',
  'bv',
  'nv',
  'aps',
  'oyj',
  'oy',
  'ab',
  'asa',
  'as',
  'sro',
  'kft',
  'doo',
  'dd',
  'ooo',
  'pao',
  'oao',
  'zao',
  // 亞太
  'pte',
  'pty',
  'sdn',
  'bhd',
  'tbk',
  'kk',
  'gk',
];

/**
 * 字尾可以直接吃掉的標點與連接詞(`Acme Inc.`、`GmbH & Co. KG` 這種寫法)。
 *
 * 刻意**不含括號**:`(未命名)` 是本系統給沒填名稱的客戶的佔位字串,
 * 剝掉右括號會讓它變成另一個值,而 groups() 正是靠這個值把未命名的客戶排除在外;
 * 剝了的話全組織的未命名客戶會被湊成同一群「疑似重複」。
 * 一般公司名的括號註記(`Acme (Berlin)`)也不該只剝掉一半。
 */
const TRAILING_NOISE_RE = /[\s,;:、,。&/\\|_+'"“”‘’`~!?\-–—·]+$/u;

/** 拉丁後綴的前一個字元要是「非字母數字」才算獨立的詞 */
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * 公司名正規化:全形轉半形、轉小寫、剝掉法人格後綴與尾端標點,最後去掉所有空白。
 *
 * 剝到不能再剝為止(`甲乙丙股份有限公司` 要剝掉整串、`X GmbH & Co. KG` 要剝兩層),
 * 但永遠不會剝成空字串 —— 一家真的就叫「有限公司」的客戶不該被歸零。
 */
export function normalizeCompanyName(v: string | null | undefined): string {
  // 點號在公司名裡幾乎都是縮寫記號(`S.A.`、`Inc.`、`s.r.o.`),先整批拿掉,
  // 後綴才比得到。代價是 `acme.com` 會變成 `acmecom`,對查重無害。
  let s = toHalfWidth(v ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .trim();

  let changed = true;
  while (changed && s.length) {
    changed = false;

    const trimmed = s.replace(TRAILING_NOISE_RE, '');
    if (trimmed.length && trimmed !== s) {
      s = trimmed;
      changed = true;
      continue;
    }

    for (const suf of CJK_COMPANY_SUFFIXES) {
      if (s.endsWith(suf) && s.length > suf.length) {
        s = s.slice(0, -suf.length);
        changed = true;
        break;
      }
    }
    if (changed) continue;

    for (const suf of LATIN_COMPANY_SUFFIXES) {
      if (!s.endsWith(suf) || s.length <= suf.length) continue;
      // 前一個字元是字母或數字 → 這是名字的一部分(vegas 的 as),不是後綴
      const before = s[s.length - suf.length - 1] ?? '';
      if (WORD_CHAR_RE.test(before)) continue;
      s = s.slice(0, -suf.length);
      changed = true;
      break;
    }
  }

  return s.replace(/\s+/g, '');
}
