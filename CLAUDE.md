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
- แก้ให้น้อยที่สุดเท่าที่ทำให้คำขอสำเร็จ แล้วสรุปเป็นภาษาไทยสั้น ๆ ว่าแก้ไฟล์ไหน อย่างไร
- ระบบสำรองไฟล์ให้อัตโนมัติก่อนทุกคำสั่ง และย้อนกลับได้จากหน้าเว็บ

## แผนที่ "เงื่อนไข" ของระบบ — อยากแก้เรื่องไหน ดูที่ไหน

| เรื่อง | ไฟล์ | จุดที่ต้องดู |
|---|---|---|
| ตอบช้า/เร็ว, อ่านแล้ว, ความเร็วพิมพ์ | `server/pacing.js` | `PACING` และ `planReply()` |
| กิจกรรมที่ทำให้ยังไม่อ่าน / อ่านแล้วตอบทีหลัง | `data/personas/<id>/persona.md` หัวข้อ "กิจกรรมระหว่างวัน" (ผู้ใช้แก้เอง) · ตัวอ่านอยู่ที่ `server/pacing.js` | `parseActivities()`, ค่าสำรอง `ACTIVITIES` |
| เลือกความจำ/สิ่งที่สอนที่ส่งให้สมอง, งบตัวอักษร | `server/recall.js` | `selectMemory()`, `selectTeachings()`, `CORE_TOPICS` |
| ตัววัดขนาด prompt, token ที่ใช้ | `server/brain.js` (`contextFor()`, `promptStats()`) + `src/componants/chat.js` (`promptMeter()`) | |
| จัดระเบียบความจำอัตโนมัติ, ยกเลิกส่ง/แก้ไขข้อความ | `server/index.js` | `maybeTidyMemory()`, routes `/api/unsend`, `/api/edit` |
| ส่งออก/นำเข้าตัวละคร, สำรองไปโฟลเดอร์นอก | `server/portable.js` | `exportProfile()`, `importProfile()` (ห้ามเขียนชื่อไฟล์ที่ไม่ผ่านการตรวจ), `backupAll()` |
| แจ้งเตือน Web Push | `server/push.js` + `public/sw.js` + `src/main.js` (`renderNotify()`) | ส่งเมื่อ `away.isBeingViewed()` เป็น false |
| แชทวันก่อน ๆ | `server/store.js` (`previousDay()`) + `src/main.js` (`loadOlder()`) | |
| หลายตัวละคร, สลับ/สร้าง/ลบ, จุดสำรองความจำ | `server/profiles.js` | `createProfile()`, `snapshot()`, `restoreSnapshot()` |
| ตัวละครทักมาตอนปิดแชท, ตอบข้อความที่ค้างตอนปิดแชท, แท็บ/เครื่องที่ใช้งานอยู่ | `server/away.js` | ค่าคงที่ด้านบน, `answerWhileClosed()`, `startAwayScheduler()` |
| ข้อความที่ส่งแล้วแต่เธอยังไม่ตอบ (กันหายตอนรีเฟรช) | `server/store.js` + `server/index.js` | `addPending()`, `replyToPending()`, route `/api/send` |
| รูป, สติกเกอร์, ตอบกลับ, รีแอคชัน (ฝั่งสมอง) | `server/brain.js` | `<chat_features>` ใน `stablePrompt`, `turn()`, `addReaction()` |
| รูป, สติกเกอร์, ตอบกลับ, รีแอคชัน (ฝั่งหน้าเว็บ) | `src/componants/chat.js` | `bubble()`, `parseMessage()`, `STICKERS`, `REACTIONS` |
| ค้นหา, ดูรูปเต็ม, "เปิดอยู่ที่อื่น" | `src/componants/overlays.js` | |
| เข้าจากเครื่องอื่น (LAN, Cloudflare Tunnel), รหัสเข้า, กันเดารหัส | `server/index.js` | `accessGate()`, `isLocal()`, `LOCAL_ONLY` — ห้ามทำให้คำขอผ่าน tunnel ถูกนับเป็น local |
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
| เรื่องค้าง / ไดอารี่ | `server/life.js` | |
| อ่าน/เขียนไฟล์ .md | `server/store.js` | |
| เรียก Claude ในเครื่อง / API | `server/llm.js` | |
| API ของหน้าเว็บ | `server/index.js` | `routes` |
| จังหวะฝั่งหน้าเว็บ: รวมข้อความที่พิมพ์ต่อกัน, รอผู้ใช้พิมพ์เสร็จ, อ่านแล้ว/ส่งแล้ว, ทักเมื่อเงียบ | `src/main.js` | ส่วน `engine`: `schedule()`, `reply()`, `armIdle()` |
| หน้าตาแชท / สถานะ | `src/componants/chat.js` | |
| หน้าตาแถบสอน | `src/componants/teach.js` | |
| หน้าตาโหมด editlogic | `src/componants/logic.js` | |
| หัวหน้าเว็บ, แถบ, โหมด full role | `src/componants/header.js` | |

## หลังแก้
- แก้ไฟล์ใน `server/` หรือ `scripts/` ต้องรีสตาร์ทเซิร์ฟเวอร์ (หน้าเว็บมีปุ่มให้) ถ้าเปิดไม่ขึ้นระบบจะย้อนกลับเอง
- แก้ไฟล์ใน `src/` แค่โหลดหน้าเว็บใหม่
