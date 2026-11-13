# AUDIT ROUND 8 — הביקורת הרחבה (The Broad Sweep)

**תאריך:** 2026-11-13 · **היקף:** 4 סריקות עומק מקבילות (lib core / scripts / API routes / DB+store) · **37 קבצים תוקנו** · **~40 ממצאים מוכחים, 34 תוקנו בגל זה**

שיטה: ארבע יחידות ביקורת עצמאיות קראו כל קובץ שורה-שורה, אימתו ממצאים מול ה-DB החי, ושניים מהם ריפרודקציה אמפירית (ניסוי CAS על שורת DB אמיתית; ניסוי כתיבה מקבילית ל-tmp). כל תיקון לווה בהערת שורש מתועדת בקוד ("round 8").

---

## CRITICAL — שניים, שניהם הוכחו חי

### C1. דוח"ב ראשון על משימה חדשה לא נשמר אף פעם — CAS השוואה `null` מול `""`
`mission/report/route.ts:201` — `where: { report: fresh.report ?? "" }`. משימה שזה עתה נערכה נושאת `report = NULL`; Prisma מתרגם `""` ל-`report = ''` שאף פעם לא תואם ל-NULL → `cas.count === 0` בכל 3 הניסיונות → 500 "Report distillation failed". **הלולאה האבולוציונית של המשימות הידניות הייתה שבורה לחלוטין.**
**הוכחה חיה (לפני תיקון, על משימה 31):** CAS עם `?? ""` → count 0;‏ CAS עם `report: fresh.report` → count 1.
**תיקון:** השוואה ישירה (Prisma מתרגם `null` ל-`IS NULL`).
**אימות לאחר תיקון:** משימת בדיקה 32 (report=null) — POST דוח"ב ראשון → `ok:true`, DNA #1753 נולד, historyCount:1, HTTP 200. (נוקה מיד אחר כך; הספרייה חזרה ל-1752 מדויק.)

### C2. ה-PAT הודפס לקונסולה בכל כשל push
`push-with-db-token.mjs` — הטוקן היה מוטמע ב-URL של ה-push; פלט השגיאה של git מכיל את ה-URL עם הפרטיים, והשורה הדפיסה אותו. בנוסף `process.exit(0)` בסוף דרס את `exitCode=1` — **push שנכשל יצא תמיד 0** והאוטומציה "האמינה" שהגיבוי עבר.
**תיקון:** header אימות במקום URL (`git -c http.extraheader`), סקרב של שני הערוצים, `process.exit(process.exitCode ?? 0)`.

---

## HIGH — שמונה

| # | באג | קובץ | תיקון |
|---|-----|------|-------|
| H1 | **Path traversal דרך draftId** — `../../dna-snapshot` מחק קובץ .json כלשהו (כולל ה-snapshot של ההחלמה!), publishDraft מחק את הקובץ שחצה אחרי create | chimera-draft.ts | ואלידציית `/^[a-f0-9]{8}$/` בכל גישה לנתיב. **אומת חי:** DELETE עם traversal → 404, ה-snapshot לא נפגע |
| H2 | **כתיבות snapshot מקביליות משחיתות קובץ** — 4 מערכות כותבות fire-and-forget לאותו tmp משותף; ריפרודקציה: JSON פגום + rename ENOENT; dna-restore היה קורס בדיוק ברגע ה-recycle | dna-snapshot.ts | tmp ייחודי (pid+uuid) + תור promise בתהליך |
| H3 | **קובץ הטוקן post-recycle לא קיים** — daily-cycle ו-license-backfill חיפשו `upload/טוקן טיטפקס10.secret`; הקובץ האמיתי `upload/token.secret` → המחזור האוטומטי מת ב-FATAL לפני ה-restore | daily-cycle.mjs, license-backfill.mjs | שני השמות, נתיבים אבסולוטיים |
| H4 | **Blackout 30 יום של findings-desk** — needsHuman רשם `reviewed[name]` עם checkedAt=now וסתר את ההבטחה "retry next tick"; confirmedRate ניפח "unverified" כמאוששים | findings-desk.mjs | needsHuman לא סוגר חלון קדנציה; המדד מוציא unverified |
| H5 | **Snapshot פגום עוקף את מגן הניוון-לאחור** — catch אחד בלע "חסר" ו"פגום" → snapGenes=0 → ספרייה רזה דורסת את ה-20MB בגיט | daily-cycle.mjs | הבחנה ENOENT/פגום; פגום = דלת-סגורה (fail closed) |
| H6 | **export/pack השמיט בשקט 1152/1752 גנים** — take:600 תחת BINARY collation כלל 98 ריפו בלבד; **100% מגני השדה הושמטו** בזמן שהכותרת טענה "(N born from the field)" | export/pack/route.ts | גני שדה תמיד בפנים; כותרת + stats מדווחים included/omitted. **אומת חי:** `632 of 1752 (32 field-born, 1120 omitted)` |
| H7 | **משימות voided "קמות לתחייה"** — STATUS_RANK ללא voided → advanceStatus("voided","done") החזיר done; 24/30 משימות הפקה; דוח"ב היה מגדיל **DNA חדש מהבדיון שטוהר** | mission-status.ts + שומרי 409 ב-report/autopilot | voided בדרגה 4 (טרמינלי). **אומת חי:** report על משימה 2 → 409; autopilot → 409 |
| H8 | **allDone בלע כשל transient כטרמינלי** — timeout בפאזה האחרונה עצר את המשאבה/ה-hunt לפני ה-retry שהמנגנון מבטיח | autopilot.ts | only permanent failures סוגרים פאזה; כשל-שעבר נמחק בהצלחה |

---

## MEDIUM — עשרים וארבעה תוקנו (נקודות עיקריות)

**משפחת שער האמת (הדירקטיבה של הקמפיין):**
- **chimeraName לא נסרק** — שם כמו `fable-5-1-router` דלף ל-DB/UI/הזרקת skills ללא שער. כעת במערך הסריקה (genesis.ts).
- **Evolved queries בלי סריקה** — שאילתת בדיון `claude-opus-5-5 filename:CLAUDE.md` עברה את כל הוואלידציות, הוצגה ב-UI, **ובוצעה** בדור 2+ שורפת מכסה. כעת סינון detectClaudeModels פחות authority-confirmed, הסיבה מתועדת ב-rationale. **אומת אדברסרי:** opus-5-5/fable-5-1/sonnet-5-5 → DROP; opus-4-6 (authority) ו-4-5 → KEEP.
- **parseTriage "not elite" → elite** — התאמת מחרוזת חלקית העלתה מועמד שנדחה מפורשות לדרגת עילית. כעת token מדויק + שלילות. **אומת:** "not elite" → noise.

**מרוצי lost-update:**
- **stageGrow** — קריאה בת 110 שניות + כתיבה לא-מותנית מחקה דוח"ב ידני שנחת בחלון. הועתק דפוס ה-CAS המלא (re-read + compare-and-swap + 3 ניסיונות).
- **publishDraft TOCTOU** — דאבל-קליק = שתי שורות כימרה זהות (אין unique על שם). נעילת in-flight + בדיקת התנגשות צמודה ל-create + תוצאת deleteDraft לא נבלעת.
- **retryLiveHunt** — check-then-act נתן שני hunts רצים. דגל retrying + updateMany מותנה.

**חוזה שגיאות וואלידציה:**
- search/synthesis/watchlist/intel — null-body ושדות שגויי-טיפ קרסו מחוץ ל-try → 500 לא-JSON של ה-framework. **אומת חי:** ארבעתם מחזירים 400 נקי.
- CSRF — GET היה פטור מקור; `/api/analyze` (GET שורף ~25 קריאות מאומתות + כותב DB) היה ניתן להפעלה מ-`<img>` מוסתר בכל דף זדוני שהבעלים מבקר בו. middleware כעת חוסם Origin/Referer חוצה-מקור על ה-GET היקר.
- autopilot full-run — 4 פאזות × 220s במקרה גרוע מול maxDuration 300 → הרג באמצע. תקציב-זמן אמיתי + remaining מחושב מהמצב הסופי (הנוסחה הישנה ספרה-פעמיים פאזה שנכשלה-transient ואז הצליחה).
- genesis/drafts — publish ללא try (500 גולמי), DELETE החזיר ok:false עם 200 (apiFetch "הצליח" למחוק כלום). כעת 500/404 כהלכה.

**סקריפטים ואמת מבצעית:**
- dna-restore — parse מחוץ ל-try; **P2002 על DB שצמח מחדש חלקית** (upsert עם id מפורש → התנגשות מפתח → RESTORE_FAIL באמצע, חצי-ספרייה) → id-first/natural-key/create עם skip רועש; ענפי update לא שחזרו license/models/evidence → שוחזרים.
- dna-snapshot — writeFileSync 20MB לא-אטומי → tmp+rename (pid+uuid). **אומת חי:** הרצה, פרוס, אפס יתומי tmp.
- hunt-live — sweep זומבי ("running" לנצח אחרי מוות שרת) → שומת 10 דק' מה-daily-cycle; סטטוסי רשימה לא נבדקו (500 התחפש ל"אין hunt פעיל"); מוני take:12 הוצגו כאמת הספרייה → `total`.
- license-backfill — GraphQL 200-with-errors נעל ריפו לצמיתות כ-"none" (כל הזכויות שמורות) → chunk נכשל נופל בשלמותו.
- daily-cycle — regex retry תלוי-רישיות ("TimeoutError" לא נתפס) + retry של POST לא-אידמפוטנטי → case-insensitive, GET בלבד.
- findings-desk — בלי try סביב review → רשומה אחת גרועה הפילה את הטיק והשמידה את כל הביקורות שהושלמו; `--recheck-days` בסוף argv → NaN → ביטול שקט של ה-recheck לנצח.
- change-history — dnaAfter=0 (default) איפס את prevDna והעניק ל-hunt הבא את כל הספרייה כ-genesAdded; diff מול .bak שאף אחד לא כותב → diff אמיתי מהזיכרון. **אומת חי:** gens=32 (+0), ממוצעים כנים.
- truth-migration — שלושה JSON.parse לא-שמורים; האחד בתוך `!dry` → --dry עבר, הריצה האמיתית קרסה חצי-מוטציה. safeParse בכל מקום.
- radar-report — ספרייה ריקה → "NaN%" בדוח הציבורי המחויב → RADAR_SKIP fail-fast.

**כתיבה/זיכרון:**
- empty-mine strikes נספרו **לפני** שער האיכות — ריפו שכל הגנים שלו נדחו דווח "פורה", אף פעם לא נחסם, ונכרה מחדש מ-GitHub **בכל sweep לנצח**. כעת `artifacts` = kept post-gate, `rawFound` = אמת הגילוי. reposWithFindings כנה.
- genesis/mine — עקף את gateArtifacts (דלת אחורית לגניבות של "גן #133 בן 11 בתים") → אותו שער, אותו מקור.
- authorityCheckedAt היה write-only — miss ודאי נבדק מחדש בכל בניית ארסנל (עד 3 שאילתות אמיתיות למחזור, לנצח) → backoff 7 ימים.
- grepRawFile בלע שגיאות רשת והחזיר null → ראיה אמיתית סומנה "refuted" לצמיתות והוזנה ל-LLM כ-"ground truth". כעת רק 404/422/miss מפריכים; אחרת נזרק → check.error.
- export-מדגמי של G5: `\n` בלבד שבר CRLF; "undefined" חשוף פסל פרוזה תקנית של TS → `\r?\n` + placeholder-shaped.

**היגיינה:** TOKEN_KEY יוצא (ביטול כפילות מפתח), take:100 מה-name-guard הוסר, findFirst דטרמיניסטי, verify-remote-head/backup-pat עם timeout+סטטוס אמיתי, ‏/tmp/pat.bak (dump סודי חד-כיווני) הוסר, check-state מפרסר findings אמיתי, סכמה מתעדת voided.

---

## מה נבדק ונמצא תקין (לא תוקן כי אין באג)
- נעילות live-hunt/sweep/autopilot/harvest/audit — חד-פעמיות נאכפת; zai.ts בשרת בלבד; matcher ה-middleware מכסה את כל ה-mutations; כל קריאות ה-LLM דרך התור הסריאלי עם timeout מסומן; ה-setting blobs (frontierLedger/mineAttempts/queryYieldStats) נכתבים בטרנזקציה עם re-read; ה-PAT מחוץ ל-snapshot ול-export, חזרה מסוככת.

## אימות end-to-end שבוצע
lint נקי (0 errors) · tsc נקי · traversal נחסם (404, snapshot שלם) · **דוח"ב ראשון על NULL-report נשמר (היה 500 תמידי)** · voided → 409 בשני השערים · 400 נקי בארבע ואלידציות · export/pack הוגן (632/1752, 32 field) · מסנן אמת אדברסרי (DROP/KEEP מדויק) · change-history + dna-snapshot מופעלים בהצלחה · UI מרונדר במלואו באגלוט מלא + מובייל, אפס שגיאות קונסולה, footer דביק בעמוד קצר ונדחק בעמוד ארוך · ה-DB חזר לבדיקת-סוף נקייה: 1752 גנים / 30 משימות / 24 voided / 6 כימרות.

## מה נשאר במודע (מתועד, לא תוקן)
- `change-history.json` מתרענן רק בהרצת סקריפט (הרצנו עכשיו; אין hook אוטומטי) — מועמד לשילוב ב-writeDnaSnapshot.
- ‏`Mission.report` JSON עמוק ללא schema enforcement — הגנות safeParse בקוד מכסות.
- כתיבת PAT plaintext ב-DB — החלטת עיצוב מתועדת (החזרה מסוככת, אין לוגים, אין client).
- ‏`Chimera.name` בלי @@unique — נאכף כעת בשלוש שכבות קוד; אילוץ DB אחרי דה-דופליקציה היסטורית.
