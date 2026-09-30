const express = require('express');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
const path = require('path');
const axios = require('axios'); // Internetdan logotipni xatosiz yuklash uchun
require('dotenv').config();

// Telegram kutubxonasini chaqirish
const TelegramBotPackage = require('node-telegram-bot-api');
const TelegramBot = TelegramBotPackage.default || TelegramBotPackage;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Botni start qilish xabari (Bojxona tizimiga moslandi)
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `Assalomu alaykum! Sirdaryo viloyati bojxona boshqarmasi xodimlarining huquqiy savodxonligini oshirish platformasining rasmiy botiga xush kelibsiz.\n\nSizning verifikatsiya uchun Telegram ID raqamingiz: *${chatId}*\n\nUshbu ID raqamni nusxalab, veb-saytga kiriting.`, { parse_mode: 'Markdown' });
});

const verificationCodes = {};

// Neon.tech ulanishi
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  try {
    // 1. Foydalanuvchilar (Natijalar) jadvali
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(100) NOT NULL,
        score INT NOT NULL,
        passed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ustunlarni tekshirish va majburiy qo'shish
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id VARCHAR(50);`);
    
    // ⚠️ YANGI QO'SHILGAN QISM: Sertifikat raqamini bazada saqlash uchun ustun
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS certificate_no VARCHAR(50);`);
    
    // 2. Savollar jadvali
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        question TEXT NOT NULL,
        options TEXT[] NOT NULL,
        correct_answer INT NOT NULL
      );
    `);

    const res = await pool.query('SELECT COUNT(*) FROM questions');
    if (parseInt(res.rows.count) === 0) {
      await pool.query(`
        INSERT INTO questions (question, options, correct_answer) VALUES 
        ('O''zbekiston Respublikasining Konstitutsiyasiga ko''ra, barcha fuqarolar qonun oldida qanday huquqqa ega?', ARRAY['Tengdirlar', 'Kamsitiladilar', 'Alohida imtiyozga egadirlar', 'Cheklangandirlar'], 0),
        ('Bojxona to''g''risidagi qonun hujjatlarining vazifalari nimalardan iborat?', ARRAY['Iqtisodiy xavfsizlikni ta''minlash va bojxona nazoratini olib borish', 'Dasturlar yaratish', 'Soliqlarni butunlay bekor qilish', 'Tashqi savdoni taqiqlash'], 0),
        ('Davlat bojxona xizmati organlari xodimlarining huquqiy maqomi qaysi qonun bilan tartibga solinadi?', ARRAY['"Davlat bojxona xizmati to''g''risida"gi Qonun', 'Mehnat kodeksi', 'Fuqarolik kodeksi', 'Ma''muriy javobgarlik to''g''risidagi kodeks'], 0);
      `);
      console.log('Savollar yuklandi!');
    }
  } catch (err) {
    console.error('Baza xatosi:', err);
  }
}
initDatabase();

// API 1: Telegramga Kod yuborish
app.post('/api/send-code', async (req, res) => {
  const { telegramId } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'Telegram ID shart!' });

  const code = Math.floor(1000 + Math.random() * 9000).toString();
  verificationCodes[telegramId.toString()] = code.toString();

  try {
    await bot.sendMessage(telegramId, `Huquqiy savodxonlik platformasi uchun tasdiqlash kodingiz: *${code}*`, { parse_mode: 'Markdown' });
    res.json({ success: true, message: 'Tasdiqlash kodi Telegram botingizga yuborildi!' });
  } catch (err) {
    res.status(500).json({ error: 'Botga kirib /start bosganingizni tekshiring!' });
  }
});

// API 2: Kodni tekshirish
app.post('/api/verify-code', (req, res) => {
  const { telegramId, code } = req.body;
  const originalId = telegramId.toString();
  const inputCode = code.toString().trim();

  if (verificationCodes[originalId] && verificationCodes[originalId] === inputCode) {
    pool.query('SELECT id, question, options FROM questions ORDER BY id ASC')
      .then(result => res.json({ success: true, questions: result.rows }))
      .catch(() => res.status(500).json({ error: 'Savollarni olishda xatolik' }));
  } else {
    res.status(400).json({ success: false, error: 'Tasdiqlash kodi noto\'g\'ri!' });
  }
});

// API: Admin Paneldan yangi huquqiy savol qo'shish
app.post('/api/add-question', async (req, res) => {
  const { secretKey, question, options, correctAnswer } = req.body;
  if (secretKey !== "admin123") return res.status(403).json({ success: false, error: "Taqiqlangan!" });
  try {
    const insertQuery = 'INSERT INTO questions(question, options, correct_answer) VALUES($1, $2, $3)';
    await pool.query(insertQuery, [question, options, parseInt(correctAnswer)]);
    res.json({ success: true, message: "Yangi savol Neon bazasiga qo'shildi!" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Xatolik yuz berdi." });
  }
});

// API 3: Testni tugatish va Bojxona sertifikatini berish (RAQAM INTEGRATSIYASI BILAN)
app.post('/api/submit-quiz', async (req, res) => {
  const { fullName, telegramId, answers } = req.body;

  if (!fullName || !answers) {
    return res.status(400).json({ message: 'Ma\'lumotlar to\'liq emas!' });
  }

  try {
    const result = await pool.query('SELECT id, correct_answer FROM questions ORDER BY id ASC');
    const questions = result.rows;

    let score = 0;
    questions.forEach(q => {
      if (answers[q.id] !== undefined && parseInt(answers[q.id]) === q.correct_answer) {
        score++;
      }
    });

    const percent = (score / questions.length) * 100;

    if (percent >= 60) {
      // 📝 1. UNIKAL SERTIFIKAT RAQAMINI GENERATSIYA QILISH
      const joriyYil = new Date().getFullYear();
      const tasodifiyRaqam = Math.floor(1000 + Math.random() * 9000);
      const sertifikatRaqami = `DBX-SRD-${joriyYil}-${tasodifiyRaqam}`;

      // 📝 2. ERTIFIKAT RAQAMINI FOYDALANUVChI NATIJASI BILAN BIRGA BAZAGA YOZISh
      const queryText = 'INSERT INTO users(full_name, telegram_id, score, certificate_no) VALUES($1, $2, $3, $4)';
      await pool.query(queryText, [fullName, telegramId, Math.round(percent), sertifikatRaqami]);

      // 📜 LANDSCAPE formatida A4 o'lchamli rasmiy blanka ochish
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape' });
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=Huquqiy_Sertifikat_${sertifikatRaqami}.pdf`);
      doc.pipe(res);

      // 🎨 RASMIY BOJXONA STRUKTURASI RAMKASI (To'q yashil va Oltinrang)
      doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).lineWidth(8).stroke('#0a3d24'); 
      doc.rect(32, 32, doc.page.width - 64, doc.page.height - 64).lineWidth(2).stroke('#d4af37'); 

      // 🏛 FONGA EXCLUSIV SHAFFAF GERB CHIZISH (Watermark effekti)
      doc.save();
      doc.opacity(0.04); 
      doc.circle(doc.page.width / 2, doc.page.height / 2, 140).lineWidth(15).stroke('#0a3d24');
      doc.circle(doc.page.width / 2, doc.page.height / 2, 110).lineWidth(3).stroke('#0a3d24');
      doc.restore();

      // ⭐ Rasmiy logotipni internetdan xavfsiz yuklab olib joylashtirish
      try {
        const logoUrl = "https://customs.uz";
        const response = await axios.get(logoUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(response.data, 'binary');
        doc.image(imageBuffer, doc.page.width / 2 - 35, 45, { width: 70 });
      } catch (imageErr) {
        console.error("Logotip yuklashda muammo:", imageErr);
      }

      // Logotip joylashgani sababli keyingi matnlar koordinatasini pastroqqa suramiz
      doc.y = 125;

      // 🏢 VAZIRLIK VA BOSHQARMA NOMALARI (Yuqori shlyapa)
      doc.fillColor('#0a3d24').fontSize(11).text("O'ZBEKISTON RESPUBLIKASI IQTISODIYOT VA MOLIYA VAZIRLIGI HUZURIDAGI BOJXONA QO'MITASI", { align: 'center', font: 'Helvetica-Bold', lineGap: 4 });
      doc.fillColor('#d4af37').fontSize(14).text("SIRDARYO VILOYATI BOJXONA BOSHQARMASI", { align: 'center', font: 'Helvetica-Bold' });
      
      doc.moveDown(1);
      doc.moveTo(doc.page.width / 2 - 150, doc.y).lineTo(doc.page.width / 2 + 150, doc.y).lineWidth(1).stroke('#d4af37');
      
      // 🏆 SERTIFIKAT NOMALANISHI
      doc.moveDown(2.5);
      doc.fillColor('#1a1a1a').fontSize(42).text('SERTIFIKAT', { align: 'center', font: 'Helvetica-Bold', letterSpacing: 4 });
      
      // 📋 YANGI QO'SHILGAN QISM: SERTIFIKAT SERIYA RAQAMINI TEPADA KO'RSATISH
      doc.moveDown(0.3);
      doc.fillColor('#d4af37').fontSize(13).text(`Reestr raqami: ${sertifikatRaqami}`, { align: 'center', font: 'Helvetica-Bold' });

      // 👥 XODIMNING ISM-FAMILIYASI
      doc.moveDown(0.8);
      doc.fillColor('#555555').fontSize(15).text("Ushbu hujjat huquqiy savodxonlik sinovidan muvaffaqiyatli o'tgan xodim:", { align: 'center', font: 'Helvetica' });
      
      doc.moveDown(0.8);
      doc.fillColor('#0a3d24').fontSize(28).text(fullName.toUpperCase(), { align: 'center', font: 'Helvetica-Bold' });
      doc.moveTo(doc.page.width / 2 - 200, doc.y + 4).lineTo(doc.page.width / 2 + 200, doc.y + 4).lineWidth(1.5).stroke('#d4af37');

      // 📝 TASDIQLOVCHI NIZOM MATNI
      doc.moveDown(2.2);
      doc.fillColor('#2d3748').fontSize(14).text(
        `Davlat bojxona xizmati organlari xodimlarining huquqiy savodxonligini oshirish dasturi doirasida o'tkazilgan maxsus test sinovlaridan *${Math.round(percent)}%* natija ko'rsatganligi munosabati bilan taqdim etildi.`, 
        { align: 'center', font: 'Helvetica', width: 600, columns: 1, lineGap: 5 }
      );
      
// 🕒 FUTTER QISMI: SANA, VERIFIKATSIYA ID VA KODLAR
doc.moveDown(3.5);
const bugun = new Date().toLocaleDateString('uz-UZ');
doc.fillColor('#718096').fontSize(10).text(`Berilgan sana: ${bugun}`, 50, doc.y, { liked: true });
doc.text(`Verifikatsiya ID: DBX-SRD-${telegramId}`, doc.page.width - 300, doc.y, { align: 'right' });
doc.end();
try {
await bot.sendMessage(telegramId, `Tabriklaymiz! Sizning Sirdaryo VB huquqiy savodxonlik sertifikatingiz generatsiya qilindi va yuklab olindi! \n\n📜 Sertifikat reestr raqami: *${sertifikatRaqami}*`, { parse_mode: 'Markdown' });
} catch (e) {
console.log("Bot xabar yuborishda xato.");
}
} else {
res.status(200).json({ passed: false, message: `Afsuski testdan o'tolmadingiz. Natijangiz: ${Math.round(percent)}%. O'tish uchun kamida 60% kerak. Qaytadan urinib ko'ring!` });
}
} catch (err) {
console.error("Katta xatolik backendda:", err);
res.status(500).json({ message: 'Serverda yoki malumotlar bazasida xatolik yuz berdi.' });
}
});
app.listen(PORT, () => console.log(`Server http://localhost:${PORT} portida tayyor!`));
