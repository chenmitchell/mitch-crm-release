'use client';

// 把系統管理員設定的公司外觀(配色方案、側欄深淺、預設日夜模式)套到整個網站。
//
// 為什麼需要這一支:配色是全公司統一的,來源在伺服器,不是每個人自己按的。
// 頁面載入時 <head> 的 boot script 會先用 localStorage 的快取畫出上一次的樣子(避免閃色),
// 這支掛載後把伺服器的最新值覆蓋上去。管理者改了配色,所有人下次開頁面就會換過來。
//
// 設定從 useAppSettings() 拿,不自己打 /api/public/settings。
// 這一支原本自己 fetch 一次,而它就掛在 AppSettingsProvider 底下的第一行 ——
// 同一支端點在同一次載入被打兩次,而那支端點是每 60 秒 100 次的額度。
// 一間辦公室十幾個人共用一個對外 IP,早上同時開頁面就會撞到 429,
// 而這裡的 catch 是空的:拿到 429 只會安靜地維持預設配色,使用者看到配色偶爾跳掉,
// 查不出原因。改吃 context 之後,重試與「設定讀取失敗」的提示都由 Provider 統一負責。
//
// 這支不渲染任何東西。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useEffect } from 'react';
import { useAppSettingsContext } from '@/lib/app-settings';
import { applyOrgAppearance } from '@/lib/theme';

export function OrgAppearance() {
  const { settings, loading, failed } = useAppSettingsContext();
  const { themeScheme, themeSidebar, themeDefaultMode } = settings;

  useEffect(() => {
    // 還沒拿到伺服器的值、或重試完仍然拿不到,就不要套:那兩種情形下 settings 是出廠預設,
    // 套下去會把 boot script 剛用快取畫好的配色蓋成預設值。維持快取的配色是刻意的 ——
    // 一支設定 API 掛掉不該讓整個網站換一套顏色。
    if (loading || failed) return;
    applyOrgAppearance(themeScheme, themeSidebar, themeDefaultMode);
  }, [loading, failed, themeScheme, themeSidebar, themeDefaultMode]);

  return null;
}
