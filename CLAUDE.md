# Persona Agent — คู่มือสำหรับแก้ระบบ (โหมด editlogic)

ไฟล์นี้ถูกอ่านทุกครั้งที่ผู้ใช้สั่งแก้ระบบจากหน้าเว็บ (Claude Code ในเครื่อง มีแค่เครื่องมือ Read/Edit/Write/Glob/Grep รันคำสั่งไม่ได้)

## กติกา
- แก้เฉพาะโค้ดระบบ: `server/` (รวม `server/templates/` แม่แบบตัวละครใหม่), `src/`, `scripts/`, `index.html`, `vite.config.js`, `CLAUDE.md`
- ห้ามแตะ `data/` (ตัวละครแต่ละตัวอยู่ใน `data/personas/<id>/` ผู้ใช้แก้เองในแถบสอน) และ `node_modules/`
- ห้ามเพิ่ม dependency ใหม่ (รัน npm install ไม่ได้) ใช้ของที่มีหรือ Node built-in เท่านั้น
- สไตล์โค้ด: vanilla JS + ES modules, เยื้อง 4 ช่อง, double quotes, มี semicolon, trailing comma,
  UI เป็น template string ขึ้นต้นด้วย `/*html*/`, handler ประกาศบน `window`, เลือก DOM ด้วย `data-*`,
  Tailwind v4 ธีมมืด slate/sky, คอมเมนต์ภาษาอังกฤษสั้น ๆ อธิบาย "ทำไม", ข้อความใน UI เป็นภาษาไทย
- ป้องกันค่า undefined ด้วย optional chaining เสมอ ห้าม throw ตอน render
- เขียนไฟล์ข้อมูลผ่าน `server/fsutil.js` เท่านั้น (`updateText()` หรือ `withFileLock()` + `writeAtomic()`) ห้ามอ่านแล้ว `writeFile` ตรง ๆ เพราะหลายงานแก้ไฟล์เดียวกันพร้อมกันได้ (ข้อความหาย, ไฟล์ครึ่ง ๆ ตอนไฟดับ)
- งานที่ใช้เวลานานทำงานแบบ "ปักตัวละคร" (`pinProfile()` ใน `server/profiles.js`) path ไฟล์มาจาก `currentId()` ไม่ใช่ตัวที่เปิดอยู่ตอนนั้น · สลับตัวละครต้องผ่าน `switchExclusive()` ใน `server/brain.js`
- ค่าที่มาจากข้อมูล (ชื่อตัวละคร, id) ห้ามใส่ใน `onclick="fn('...')"` ให้ใส่ `data-*` แล้วอ่าน `this.dataset` แทน (`esc()` กันใน attribute ไม่ได้ เบราว์เซอร์ถอด `&#39;` กลับก่อนรัน JS)
- ห้ามลบการตรวจ `isKnownHost()` / `isOwnPage()` ใน `server/gate.js` มันกันเว็บอื่นสั่งแก้โค้ดผ่านเบราว์เซอร์ของผู้ใช้
- แก้ให้น้อยที่สุดเท่าที่ทำให้คำขอสำเร็จ แล้วสรุปเป็นภาษาไทยสั้น ๆ ว่าแก้ไฟล์ไหน อย่างไร
- ระบบสำรองไฟล์ให้อัตโนมัติก่อนทุกคำสั่ง และย้อนกลับได้จากหน้าเว็บ

## แผนที่ "เงื่อนไข" ของระบบ — อยากแก้เรื่องไหน ดูที่ไหน

| เรื่อง | ไฟล์ | จุดที่ต้องดู |
|---|---|---|
| ตอบช้า/เร็ว, อ่านแล้ว, ความเร็วพิมพ์ | `server/pacing.js` | `PACING` และ `planReply()` |
| กิจกรรมที่ทำให้ยังไม่อ่าน / อ่านแล้วตอบทีหลัง | `data/personas/<id>/persona.md` หัวข้อ "กิจกรรมระหว่างวัน" (ผู้ใช้แก้เอง) · ตัวอ่านอยู่ที่ `server/pacing.js` | `parseActivities()`, ค่าสำรอง `ACTIVITIES` |
| เลือกความจำ/สิ่งที่สอนที่ส่งให้สมอง, งบตัวอักษร | `server/recall.js` | `selectMemory()`, `selectTeachings()`, `CORE_TOPICS` |
| ตัววัดขนาด prompt, token ที่ใช้ | `server/brain.js` (`contextFor()`, `promptStats()`) + `src/components/chat.js` (`promptMeter()`) | |
| จัดระเบียบความจำอัตโนมัติ, ยกเลิกส่ง/แก้ไขข้อความ | `server/index.js` | `maybeTidyMemory()`, routes `/api/unsend`, `/api/edit` |
| ส่งออก/นำเข้าตัวละคร, สำรองไปโฟลเดอร์นอก | `server/portable.js` | `exportProfile()`, `importProfile()` (ห้ามเขียนชื่อไฟล์ที่ไม่ผ่านการตรวจ), `backupAll()` |
| แจ้งเตือน Web Push | `server/push.js` + `public/sw.js` + `src/main.js` (`renderNotify()`) | ส่งเมื่อ `away.isBeingViewed()` เป็น false |
| แชทวันก่อน ๆ | `server/store.js` (`previousDay()`) + `src/main.js` (`loadOlder()`) | |
| หลายตัวละคร, สลับ/สร้าง/ลบ, จุดสำรองความจำ | `server/profiles.js` | `createProfile()`, `snapshot()`, `restoreSnapshot()` |
| ตัวละครทักมาตอนปิดแชท, ตอบข้อความที่ค้างตอนปิดแชท, แท็บ/เครื่องที่ใช้งานอยู่ | `server/away.js` | ค่าคงที่ด้านบน, `answerWhileClosed()`, `startAwayScheduler()` |
| ข้อความที่ส่งแล้วแต่เธอยังไม่ตอบ (กันหายตอนรีเฟรช) | `server/store.js` + `server/index.js` | `addPending()`, `replyToPending()`, route `/api/send` |
| รูป, สติกเกอร์, ตอบกลับ, รีแอคชัน (ฝั่งสมอง) | `server/brain.js` | `<chat_features>` ใน `stablePrompt`, `turn()`, `addReaction()` |
| เก็บรีแอคชันในประวัติแชท (บรรทัด "รีแอค … โดย … ที่ข้อความ …" ใน log ของวันนั้น) | `server/store.js` | `logReaction()`, `parseEntries()` (คืน `reactions` ต่อ bubble) |
| รูป, สติกเกอร์, ตอบกลับ, รีแอคชัน (ฝั่งหน้าเว็บ) | `src/components/chat.js` | `bubble()`, `parseMessage()`, `STICKERS`, `REACTIONS` |
| ค้นหา, ดูรูปเต็ม, "เปิดอยู่ที่อื่น" | `src/components/overlays.js` | |
| เข้าจากเครื่องอื่น (LAN, Cloudflare Tunnel), รหัสเข้า, กันเดารหัส | `server/index.js` + `server/gate.js` | `accessGate()`, `isLocal()`, `LOCAL_ONLY` — ห้ามทำให้คำขอผ่าน tunnel ถูกนับเป็น local |
| กันเว็บอื่นยิงคำขอมาที่แอป (CSRF, DNS rebinding) | `server/gate.js` | `makeHostCheck()` (ชื่อ host ที่ยอมรับ, `ALLOWED_HOSTS`), `isOwnPage()` (POST ต้องเป็น JSON จากหน้าเดียวกัน) |
| ล็อกไฟล์, เขียนไฟล์แบบไม่พังกลางทาง | `server/fsutil.js` | `withFileLock()`, `writeAtomic()`, `updateText()` |
| ตอบข้อความเดียวกันซ้ำ / ตอบไม่สำเร็จแล้วลองใหม่ | `server/index.js` | `replyToPending()` (`inFlight` เก็บคำตอบที่กำลังเขียน) |
| รีสตาร์ทเองเมื่อล้ม, ย้อนโค้ดเมื่อ /api/health ไม่ตอบ | `scripts/run.js` | `start()`, `watchHealth()`, `MAX_CRASHES` |
| โลโก้แอป, manifest หน้าจอโฮม | `server/appicon.js` | `currentIcon()` (หา `logo.*` ใน `data/` แล้วโฟลเดอร์หลัก), `PUBLIC_PATHS` (เปิดได้โดยไม่ต้องมีรหัส ห้ามใส่อะไรที่เป็นข้อมูลส่วนตัว) |
| ค่าเริ่มต้นโหมด full role | `src/main.js` | `isFullRole: readPref("fullRole", true)` |
| เปิด/ปิด cloudflared | `scripts/run.js` | `startTunnel()` |
| เมื่อไหร่ "อ่านแล้วไม่ตอบ" ได้ | `server/brain.js` | `stablePrompt` หัวข้อ how_to_be_human |
| คำบอกตัวละครว่าตอบช้าเพราะอะไร | `server/brain.js` | `replyNoteFor()` |
| ภาษาแชท: ไหม→มั้ย, ตัดค่ะ/ครับ, พิมพ์ผิดแล้วแก้ | `server/humanize.js` | `humanize()` (ค่าเปิด/ปิดอยู่ใน `data/style.md` ผู้ใช้แก้เอง) |
| เลียนจังหวะผู้ใช้ / เตือนพูดซ้ำ | `server/humanize.js` | `userStyleNote()`, `repetitionNote()` |
| เวลาตื่น/นอน/ความเร็วพิมพ์ของตัวละคร | `data/persona.md` (ผู้ใช้แก้เอง) | หัวข้อ "จังหวะการตอบ" |
| อารมณ์กลับสู่ปกติเร็วแค่ไหน, เหงาเมื่อหายไปนาน, ความสนิทเพิ่มต่อข้อความ | `server/mood.js` | ค่าคงที่ด้านบน และ `passTime()` |
| ขั้นความสนิทและการพูดในแต่ละขั้น | `server/mood.js` | `STAGES` |
| คำสั่งที่ส่งให้ตัวละคร (วิธีคุยแบบคน, กฎจดความจำ, care) | `server/brain.js` | `stablePrompt`, `nowPrompt`, `JSON_REPLY_GUIDE` |
| เครื่องมือที่ตัวละครใช้ (จำ/สอน/อารมณ์/เรื่องค้าง/ไดอารี่) | `server/brain.js` | `TOOLS`, `HANDLERS` |
| จำนวน bubble สูงสุด, ระยะไม่ทักซ้ำ | `server/brain.js` | `MAX_BUBBLES`, `GREET_COOLDOWN_MS` |
| เรื่องค้าง / ไดอารี่ / คนรอบตัว (people.md) | `server/life.js` | `notePerson()`, `peopleFor()` |
| วันนี้ของเธอ: ค้นเน็ตตอนเช้า (อากาศ ซีรี่ ข่าว แผนของวัน เรื่องยาว), เมือง | `server/world.js` (test: `test/world.test.js`) | `maybeRefresh()` (เรียกจาก `away.js` ทุกนาที), `RESEARCH_SYSTEM`, `cleanFound()`, `renderToday()` · route `/api/today/refresh` |
| ลิงก์ที่เธอส่งได้ (ตัดลิงก์ที่แต่งเอง), เปิดลิงก์ที่ผู้ใช้ส่ง | `server/world.js` + `server/brain.js` | `checkShared()`, `checkReply()`, `turn()` (`web.fetch`, `turnOpenedLinks` กันหน้าเว็บสั่งสอนนิสัย) · ฝั่งหน้าเว็บ `withLinks()` ใน `src/components/chat.js` |
| จังหวะของแต่ละรอบ: ไม่ถามซ้ำ, ตอบสั้นตามผู้ใช้, ไม่ปิดด้วยคำถามทุกรอบ, ไม่ลาซ้ำ | `server/humanize.js` + `server/brain.js` | `rhythmFor()`, `isQuestion()`, `capBubbles()` · `<this_turn>` ใน `nowPrompt` |
| โค้ชตรวจแชทรายวัน (ข้อเสนอรอผู้ใช้กดรับ) | `server/coach.js` + การ์ดใน `src/components/teach.js` | `COACH_SYSTEM`, `maybeReview()` (เรียกจาก `away.js`), `decide()` · routes `/api/coach*` · ห้ามให้ข้อเสนอเปลี่ยนอะไรเองโดยไม่ผ่านการกดรับ |
| วันสำคัญ (dates.md), วันครบรอบที่คุยกัน | `server/life.js` | `noteDate()`, `upcomingDays()`, `firstChatDay()` · tool `remember_date` · `<special_days>` |
| วันไม่ปกติ (ยุ่ง/ไม่อยู่/ไม่สบาย), เป้าหมายระยะยาว, วันหยุด | `server/world.js` + `server/pacing.js` + `server/away.js` | `pickDayType()` (`ODD_DAY_CHANCE`), `DAY_KINDS`, `dayKind()`, `todayActivities()` |
| ทำอะไรด้วยกัน (ซีรี่ เพลง เกม) | `server/brain.js` | `<together>` ใน `stablePrompt` |
| ห่วงการใช้งาน (คุยดึก คุยเยอะ) | `server/usage.js` + `server/brain.js` | `recordUse()`, `careNote()`, `CARE_EVERY_MS` · เก็บแค่จำนวน ห้ามเก็บเนื้อหา |
| จำเลือนเรื่องเล็กที่เก่า | `server/recall.js` | `selectMemory({ fadeDays })`, `KEEP_TOPICS` |
| อ่าน/เขียนไฟล์ .md | `server/store.js` | |
| เรียก Claude ในเครื่อง / API | `server/llm.js` | |
| API ของหน้าเว็บ | `server/index.js` | `routes` |
| จังหวะฝั่งหน้าเว็บ: รวมข้อความที่พิมพ์ต่อกัน, รอผู้ใช้พิมพ์เสร็จ, อ่านแล้ว/ส่งแล้ว, ทักเมื่อเงียบ, พิมพ์แล้วลบ, ยกเลิกข้อความตัวเอง, ออฟไลน์ตอนวางมือถือ | `src/engine.js` (test: `test/engine.test.js`) · หน้าเว็บส่ง `ui` ให้จาก `src/main.js` | `schedule()`, `reply()`, `speak()`, `armIdle()`, `glance()` · engine ห้ามแตะ DOM เอง ให้เรียกผ่าน `ui` |
| ค่าตั้งค่าแอปที่แก้ในหน้าเว็บได้ (เดิมอยู่ใน .env) | `server/config.js` + การ์ดใน `src/components/teach.js` | `FIELDS` (เพิ่มค่าใหม่ที่นี่ที่เดียว ฟอร์มสร้างเอง), `getConfig()` |
| ความจำระยะสั้นแยกต่อตัวละคร, ตัวที่ไม่ได้เปิดตอบเอง | `server/brain.js` + `server/away.js` | `session()` / `me.*`, `everyCharacter()` |
| กันจดความจำซ้ำ | `server/store.js` + `server/textmatch.js` | `remember()`, `findSameFact()`, `SAME_FACT` |
| เปิด claude รอไว้ล่วงหน้า, system prompt คงที่ | `server/llm.js` + `server/brain.js` | `prepareSpare()`, `askClaudeCode({ keepWarm })`, `claudeCodeTurn()` (ส่วนที่เปลี่ยนทุกรอบอยู่ใน `<context>` ของข้อความ ไม่ใช่ system prompt) |
| ข้อความแบบไหนทำให้เธอหยุดพิมพ์ | `src/interrupt.js` | `shouldInterrupt()` |
| หยุดพิมพ์กลางคัน: ตัดคำตอบให้เหลือเฉพาะที่โผล่, ร่างที่ยังไม่ได้ส่ง | `src/engine.js` (`speak()`, `cutReply()`) + `server/brain.js` | `cutLastReply()`, `takeDraftNote()`, route `/api/cut` |
| หน้าตาแชท / สถานะ | `src/components/chat.js` | |
| หน้าตาแถบสอน | `src/components/teach.js` | |
| หน้าตาโหมด editlogic | `src/components/logic.js` | |
| หัวหน้าเว็บ, แถบ, โหมด full role | `src/components/header.js` | |

## หลังแก้
- แก้ไฟล์ใน `server/` หรือ `scripts/` ต้องรีสตาร์ทเซิร์ฟเวอร์ (หน้าเว็บมีปุ่มให้) ถ้าเปิดไม่ขึ้น หรือเปิดได้แต่ `/api/health` ไม่ตอบใน 30 วินาที ระบบจะย้อนกลับเอง
- ส่วนที่ไม่ต้องใช้สมองมี test ใน `test/` (ผู้ใช้รัน `npm test` เอง) ถ้าแก้ไฟล์ที่มี test ให้แก้ test ให้ตรงด้วย
- แก้ไฟล์ใน `src/` แค่โหลดหน้าเว็บใหม่
