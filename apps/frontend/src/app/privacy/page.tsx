// ref:3687 mc/陳彥輔/米球®
import Link from 'next/link';

export const metadata = {
  title: '隱私權政策',
  description: '本系統的個人資料蒐集告知事項:蒐集目的、資料類別、利用方式、當事人權利與聯絡管道',
};

/**
 * 隱私權政策(個人資料保護法第 8 條告知事項)的通用範本。
 *
 * ★ 給實際架設這套系統的單位:這一頁是範本,不是可以照抄就上線的法律文件。
 *   請依貴單位「實際的」蒐集與利用行為修改,尤其是第二條的特定目的代號、
 *   第三條的資料類別、第四條的利用期間與對象。寫得比實際做的多或少都是問題。
 *   單位名稱、地址與聯絡電話不寫在這裡,一律讀系統設定,見 /contact。
 *
 * 這一頁刻意寫得保守:只涵蓋這套系統本身會碰到的資料(使用者帳號、客戶聯絡人、
 * 到訪座標與照片、系統運作紀錄),不涉及任何特定行業的法遵要求。
 *
 * 第三節的「系統運作紀錄」與第五節的保留期不是文案,是照程式寫的:
 *   error_logs   errors/global-exception.filter.ts 把 5xx 的原始錯誤訊息原封不動寫進去,
 *                那段訊息可能夾帶觸發錯誤的值(姓名、電話、識別碼)。保留期
 *                ERROR_LOG_RETENTION_DAYS 出廠 30 天,後台錯誤記錄頁看得到。
 *   audit_logs   匯出(crm/export/crm-export.service.ts)、刪除與還原
 *                (crm/deletion/crm-deletion.service.ts)、單一登入的每次登入
 *                (auth/entra-audit.service.ts)都會寫。保留期 AUDIT_LOG_RETENTION_DAYS
 *                出廠 730 天。改了這幾個行為,這一頁要跟著改。
 */
export default function PrivacyPage() {
  return (
    <article aria-labelledby="privacy-title" className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-3">
        <p className="text-sm font-semibold text-muted-foreground">個人資料保護法第 8 條告知事項</p>
        <h1 id="privacy-title" className="page-h1">
          隱私權政策
        </h1>
        <p className="text-muted-foreground">
          本政策說明營運本系統的單位(以下稱本單位)在您使用本系統時,
          蒐集哪些個人資料、基於什麼目的蒐集、如何利用與保存,以及您就這些資料可以行使的權利
        </p>
      </header>

      <section aria-labelledby="privacy-who" className="space-y-3">
        <h2 id="privacy-who" className="page-h2">
          一、蒐集者
        </h2>
        <p>
          本政策的個人資料蒐集者為營運本系統的單位。本系統是內部作業工具,
          供訪查人員記錄客戶資料、到訪紀錄與訪查照片
        </p>
        <p className="page-subtle">
          本單位的名稱、地址與聯絡電話請見<Link href="/contact">聯絡管道</Link>頁,
          該頁的資料直接讀自系統設定
        </p>
      </section>

      <section aria-labelledby="privacy-purpose" className="space-y-3">
        <h2 id="privacy-purpose" className="page-h2">
          二、蒐集目的
        </h2>
        <p>本單位基於下列特定目的蒐集個人資料:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>〇九〇 消費者、客戶管理與服務:客戶聯繫、拜訪安排與後續服務</li>
          <li>〇六九 契約、類似契約或其他法律關係事務:洽談、簽訂與履行契約</li>
          <li>〇五二 內部管理:員工出勤與外勤工作紀錄之管理</li>
        </ul>
        <p className="page-subtle">實際適用的特定目的請依貴單位業務性質調整,不要沿用範本的代號</p>
      </section>

      <section aria-labelledby="privacy-category" className="space-y-3">
        <h2 id="privacy-category" className="page-h2">
          三、蒐集的個人資料類別
        </h2>
        <ul className="ml-5 list-disc space-y-1">
          <li>C001 辨識個人者:客戶聯絡人與負責人的姓名、職稱、電話與電子郵件、地址</li>
          {/*
            這一頁是伺服器端算好的靜態範本,讀不到後台設定(那是登入後才載入的),
            所以這裡用通用說法。實際適用的名稱請依貴單位所在地的法規自行改寫。
          */}
          <li>C003 政府資料中之辨識者:客戶的營業登記識別碼</li>
          <li>C011 個人描述:職稱與所屬部門</li>
          <li>
            系統使用者本人:登入帳號、姓名、所屬部門、角色,
            以及到訪打卡的時間與位置座標、現場拍攝的照片
          </li>
          <li>
            系統運作紀錄:系統發生錯誤時,會記下發生錯誤的功能、時間、操作者、來源 IP
            與瀏覽器資訊,以及該次錯誤的原始技術訊息。原始訊息由程式與資料庫產生,
            內容可能夾帶當時正在處理的資料(例如客戶姓名、電話或識別碼)。
            這類紀錄只有系統管理員在後台看得到,不會顯示給一般使用者,保存期間見第五節
          </li>
          <li>
            稽核紀錄:匯出名單、刪除與還原客戶這類會把資料帶出系統或消滅資料的操作,
            會記下操作者、時間、來源 IP、瀏覽器資訊,以及該次操作的對象與筆數
            (刪除與還原會記下該筆客戶的名稱)。啟用單一登入時,每一次登入的成功與失敗
            也會留下紀錄,含當次使用的電子郵件與失敗原因
          </li>
        </ul>
        <p className="page-subtle">
          本單位不蒐集個人資料保護法第 6
          條所稱之特種個人資料(病歷、醫療、基因、性生活、健康檢查與犯罪前科)
        </p>
      </section>

      <section aria-labelledby="privacy-use" className="space-y-3">
        <h2 id="privacy-use" className="page-h2">
          四、個人資料利用之期間、地區、對象及方式
        </h2>
        <p>
          利用期間:自資料建立起,至業務關係結束後依適用法令所定之保存年限屆滿為止。
          法定保存期間屆滿,或當事人依第六條請求刪除且無法令要求繼續保存時,
          本單位將刪除或去識別化該等資料
        </p>
        <p>
          利用地區:資料儲存或處理於本單位自行維運或委外之伺服器所在地。
          跨境儲存與處理時,本單位將要求受託者採取與本政策相當之安全保護措施
        </p>
        <p>利用對象:本單位內部承辦相關業務之人員;以及依法令或主管機關要求時之提供</p>
        <p>
          利用方式:透過本系統之表單填寫、資料儲存與處理,
          以及承辦人員為聯繫所進行之電話與電子郵件往來
        </p>
        <p>
          第三方地圖與地址定位:本系統的拜訪地圖會向外部地圖服務請求地圖圖磚,
          該請求由承辦人員的瀏覽器直接送出,對方會因此取得該人員的 IP
          位址與當時檢視的地圖座標範圍;地址自動定位(地理編碼)會把客戶地址送往
          外部地理編碼服務以換取座標。這兩項功能在出廠預設即為開啟,預設使用的是公開的 OpenStreetMap
          服務;管理者可在系統設定中關閉地址自動定位,
          並可將地圖圖磚與地理編碼改為指向自架或其他相容服務。
          本單位若啟用這些功能,即表示接受上述資料會傳輸給該第三方服務
        </p>
      </section>

      <section aria-labelledby="privacy-security" className="space-y-3">
        <h2 id="privacy-security" className="page-h2">
          五、個人資料之保護
        </h2>
        <p>
          本單位對所蒐集的個人資料採取適當的技術與組織性安全措施加以保護,
          防止資料被未經授權的存取、洩漏、竄改或毀損。連線採加密傳輸,存取權限依角色劃分
        </p>
        <p>訪查人員在本系統中原則上只看得到自己負責的客戶;看得到全部資料的角色由管理者指定</p>
        <p>
          留存紀錄的範圍,本單位據實說明如下:客戶資料的異動(例如更換負責人員、
          變更地址、標記結案)會寫進該筆客戶的時間軸,可以看到誰在什麼時候做了什麼;
          到訪打卡與照片存證留有時間、位置與拍攝者。這兩種紀錄跟著該筆客戶資料一起保存,
          該筆客戶資料永久刪除時一併刪除
        </p>
        <p>
          匯出名單、刪除客戶與還原客戶會另外寫進稽核紀錄,內容如第三節所述。
          這是為了在事後查得出「誰在什麼時候把哪些資料帶出系統或刪掉」,預設保存 730
          天,本單位可以調整(最短 90 天,也可以設定為永不刪除)。
          至於登入與帳號權限的異動,僅在本單位啟用單一登入時留有紀錄,未啟用時不留,
          同樣寫進稽核紀錄,保存期間相同
        </p>
        <p>
          系統發生錯誤時產生的系統運作紀錄,預設保存 30 天,到期後整筆刪除,本單位可以調整(最長 365
          天)。同一種錯誤在保留期內重複發生時併成一筆,只累加次數
        </p>
        <p>
          查詢畫面的部分:系統管理員在後台看得到系統運作紀錄,啟用單一登入時也看得到
          最近的登入紀錄;匯出、刪除與還原的稽核紀錄目前沒有查詢畫面,要調閱得由本單位
          直接查資料庫。要調閱上述任一種紀錄,請依第六節的方式向本單位提出
        </p>
      </section>

      <section aria-labelledby="privacy-rights" className="space-y-3">
        <h2 id="privacy-rights" className="page-h2">
          六、您得行使的權利
        </h2>
        <p>依個人資料保護法第 3 條,就本單位保有之您的個人資料,您得請求:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>查詢或請求閱覽</li>
          <li>請求製給複製本</li>
          <li>請求補充或更正</li>
          <li>請求停止蒐集、處理或利用</li>
          <li>請求刪除</li>
        </ul>
        <p>
          行使方式:請依<Link href="/contact">聯絡管道</Link>
          頁所載方式與本單位聯繫。本單位將於確認身分後依法處理;
          就查詢、閱覽或製給複製本,得酌收必要成本費用
        </p>
        <p className="page-subtle">
          法令另有規定應繼續保存之資料,於保存年限內無法應請求刪除,本單位將於回覆時說明其依據
        </p>
      </section>

      <section aria-labelledby="privacy-optional" className="space-y-3">
        <h2 id="privacy-optional" className="page-h2">
          七、不提供個人資料之影響
        </h2>
        <p>
          本系統標示為必填之欄位,是完成該項作業所必要的資料。
          未提供或提供不完整時,該筆資料無法建立或無法完成後續處理
        </p>
      </section>

      <section aria-labelledby="privacy-cookie" className="space-y-3">
        <h2 id="privacy-cookie" className="page-h2">
          八、Cookie、第三方請求與追蹤
        </h2>
        <p>
          第三方追蹤:本系統不投放廣告,不使用第三方分析工具,也不使用跨站追蹤技術。
          除維持登入狀態與系統正常運作所必要者外,不使用其他 Cookie。
          顯示偏好(淺色或深色)存在您自己的瀏覽器,不會回傳伺服器
        </p>
        <p>
          第三方請求:前一項指的是「追蹤」。與追蹤不同,本系統的拜訪地圖與地址定位
          功能會為了取得地圖圖磚與座標而向外部地圖服務發出請求,那會讓對方取得 發出請求者的 IP
          位址與相關座標,詳見第四節。這類請求是功能運作所需,
          不是為了分析或追蹤使用者,且可由管理者在系統設定中關閉或改指向自架服務
        </p>
      </section>

      <section aria-labelledby="privacy-change" className="space-y-3">
        <h2 id="privacy-change" className="page-h2">
          九、政策修訂與聯絡
        </h2>
        <p>本政策如有修訂,將直接更新於本頁。就本政策有關之問題,請聯絡本單位管理者</p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link href="/contact" className="btn btn-primary min-h-[44px] px-5">
            聯絡管道
          </Link>
          <Link href="/accessibility" className="btn min-h-[44px] px-5">
            無障礙聲明
          </Link>
        </div>
      </section>
    </article>
  );
}
