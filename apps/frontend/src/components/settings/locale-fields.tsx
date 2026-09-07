// ref:3687 mc/陳彥輔/米球®
'use client';

/**
 * 時區與地區的輸入欄。安裝精靈與系統設定共用同一份。
 *
 * 為什麼不是純下拉:後端的 resolveTimeZone 收任何合法的 IANA 時區,
 * 之前前端兩處各寫死十三個選項(歐洲只有 Europe/London),等於把後端的能力鎖死。
 * 德國的組織選不到 Europe/Berlin,整套就跑在預設時區上,而打卡存證照片的浮水印
 * 會壓上錯的時間並標錯的 GMT 位移 —— 畫面上完全看不出來。
 *
 * 所以下拉只當常用捷徑,真正決定值的是旁邊那個文字欄,可以輸入任何
 * 合法的 IANA 時區代碼與 BCP 47 語言標籤。合法與否直接拿 Intl 試一次,
 * 不維護清單:瀏覽器認得什麼,後端的 Intl 就認得什麼。
 */

import { useEffect, useId, useState } from 'react';

/** 下拉裡的常用時區。這不是白名單,只是少打幾個字 */
export const COMMON_TIME_ZONES: readonly string[] = [
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Bangkok',
  'Asia/Kuala_Lumpur',
  'Asia/Jakarta',
  'Asia/Manila',
  'Asia/Ho_Chi_Minh',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Australia/Sydney',
  'Australia/Perth',
  'Pacific/Auckland',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Berlin',
  'Europe/Zurich',
  'Europe/Vienna',
  'Europe/Rome',
  'Europe/Prague',
  'Europe/Warsaw',
  'Europe/Stockholm',
  'Europe/Helsinki',
  'Europe/Athens',
  'Europe/Istanbul',
  'Europe/Moscow',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Cairo',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'America/Mexico_City',
  'America/Bogota',
  'America/New_York',
  'America/Toronto',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Vancouver',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
];

/** 下拉裡的常用語言標籤。同樣不是白名單 */
export const COMMON_LOCALES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'zh-TW', label: '正體中文(台灣)' },
  { value: 'zh-HK', label: '正體中文(香港)' },
  { value: 'zh-CN', label: '简体中文(中国)' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'de-DE', label: 'Deutsch (Deutschland)' },
  { value: 'fr-FR', label: 'Français (France)' },
  { value: 'es-ES', label: 'Español (España)' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'it-IT', label: 'Italiano (Italia)' },
  { value: 'nl-NL', label: 'Nederlands (Nederland)' },
  { value: 'pl-PL', label: 'Polski (Polska)' },
  { value: 'tr-TR', label: 'Türkçe (Türkiye)' },
  { value: 'ru-RU', label: 'Русский (Россия)' },
  { value: 'th-TH', label: 'ไทย (ไทย)' },
  { value: 'vi-VN', label: 'Tiếng Việt (Việt Nam)' },
  { value: 'id-ID', label: 'Bahasa Indonesia (Indonesia)' },
  { value: 'ms-MY', label: 'Bahasa Melayu (Malaysia)' },
];

/** 這個字串是不是這台機器的 Intl 認得的 IANA 時區 */
export function isValidTimeZone(tz: string): boolean {
  const t = tz.trim();
  if (t === '') return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: t });
    return true;
  } catch {
    return false;
  }
}

/** 這個字串是不是合法的 BCP 47 語言標籤 */
export function isValidLocale(tag: string): boolean {
  const t = tag.trim();
  if (t === '') return false;
  try {
    // getCanonicalLocales 對結構不合法的標籤丟 RangeError;
    // DateTimeFormat 再擋掉「結構合法但這台機器建不起來」的少數情形
    Intl.getCanonicalLocales(t);
    new Intl.DateTimeFormat(t);
    return true;
  } catch {
    return false;
  }
}

/** 時區與地區兩欄合起來的驗證,兩個頁面送出前都用它 */
export function localeFieldsError(timezone: string, locale: string): string | null {
  if (!isValidTimeZone(timezone)) {
    return `時區「${timezone}」不是合法的 IANA 時區代碼,請改成像 Europe/Berlin 這樣的寫法`;
  }
  if (!isValidLocale(locale)) {
    return `地區與語言「${locale}」不是合法的 BCP 47 語言標籤,請改成像 de-DE 這樣的寫法`;
  }
  return null;
}

const CUSTOM = '__custom__';

/**
 * 現在這個時區的時間與 GMT 位移。
 *
 * 只在掛載後算:伺服器端算出來的時間跟瀏覽器端不會一樣,直接在 render 算會 hydration 不一致。
 */
function useZonePreview(tz: string): string | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (now === null || !isValidTimeZone(tz)) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz.trim(),
      dateStyle: 'medium',
      timeStyle: 'long',
      hourCycle: 'h23',
    }).format(now);
  } catch {
    return null;
  }
}

export function TimeZoneField({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  const selectId = useId();
  const inputId = useId();
  const noteId = useId();
  const valid = isValidTimeZone(value);
  const preview = useZonePreview(value);
  const selectValue = COMMON_TIME_ZONES.includes(value) ? value : CUSTOM;

  return (
    <fieldset className="block">
      <legend className="mb-1 block text-sm font-medium">時區</legend>
      <label htmlFor={selectId} className="mb-1 block text-xs text-muted-foreground">
        常用時區(選了會填進下面那欄)
      </label>
      <select
        id={selectId}
        className="input"
        value={selectValue}
        onChange={(e) => {
          if (e.target.value !== CUSTOM) onChange(e.target.value);
        }}
      >
        {COMMON_TIME_ZONES.map((tz) => (
          <option key={tz} value={tz}>
            {tz}
          </option>
        ))}
        <option value={CUSTOM}>其他(在下面自行輸入)</option>
      </select>
      <label htmlFor={inputId} className="mb-1 mt-3 block text-xs text-muted-foreground">
        IANA 時區代碼(清單裡沒有的直接打,例如 Europe/Berlin)
      </label>
      <input
        id={inputId}
        type="text"
        inputMode="text"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="input"
        value={value}
        aria-invalid={!valid}
        aria-describedby={noteId}
        onChange={(e) => onChange(e.target.value)}
      />
      <p
        id={noteId}
        className={`mt-1 block text-xs ${valid ? 'text-muted-foreground' : 'text-destructive'}`}
        role={valid ? undefined : 'alert'}
      >
        {valid
          ? preview
            ? `這個時區現在是 ${preview}`
            : '時區代碼可用'
          : '這不是合法的 IANA 時區代碼,寫法是「區域/城市」,例如 Europe/Berlin、America/New_York'}
      </p>
      {hint ? <p className="mt-1 block text-xs text-muted-foreground">{hint}</p> : null}
    </fieldset>
  );
}

export function LocaleField({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  const selectId = useId();
  const inputId = useId();
  const noteId = useId();
  const valid = isValidLocale(value);
  const selectValue = COMMON_LOCALES.some((l) => l.value === value) ? value : CUSTOM;

  return (
    <fieldset className="block">
      <legend className="mb-1 block text-sm font-medium">地區與語言</legend>
      <label htmlFor={selectId} className="mb-1 block text-xs text-muted-foreground">
        常用語言(選了會填進下面那欄)
      </label>
      <select
        id={selectId}
        className="input"
        value={selectValue}
        onChange={(e) => {
          if (e.target.value !== CUSTOM) onChange(e.target.value);
        }}
      >
        {COMMON_LOCALES.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}({l.value})
          </option>
        ))}
        <option value={CUSTOM}>其他(在下面自行輸入)</option>
      </select>
      <label htmlFor={inputId} className="mb-1 mt-3 block text-xs text-muted-foreground">
        BCP 47 語言標籤(清單裡沒有的直接打,例如 de-AT)
      </label>
      <input
        id={inputId}
        type="text"
        inputMode="text"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="input"
        value={value}
        aria-invalid={!valid}
        aria-describedby={noteId}
        onChange={(e) => onChange(e.target.value)}
      />
      <p
        id={noteId}
        className={`mt-1 block text-xs ${valid ? 'text-muted-foreground' : 'text-destructive'}`}
        role={valid ? undefined : 'alert'}
      >
        {valid
          ? '語言標籤可用'
          : '這不是合法的 BCP 47 語言標籤,寫法是「語言-地區」,例如 de-DE、fr-CA'}
      </p>
      {/*
        這一句是常駐的,不是 hint 覆寫得掉的:下拉裡有 English (United States),
        選了介面不會變成英文,而目前沒有任何地方講這件事。裝完才發現是最差的順序。
      */}
      <p className="mt-1 block text-xs text-muted-foreground">
        這一格不是介面語言。介面文字目前只有正體中文,選哪一個都不會變。
        這一格決定的是日期與數字的格式、查重電話比對用的預設國碼,以及地圖查地址時
        送出的語言(回來的路名用哪一種語言)。
      </p>
      {hint ? <p className="mt-1 block text-xs text-muted-foreground">{hint}</p> : null}
    </fieldset>
  );
}
