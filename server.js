const express = require('express');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
const path = require('path');
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

// Botni start qilish xabari
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `Assalomu alaykum! Neon Quiz tizimiga xush kelibsiz.\n\nSizning verifikatsiya uchun Telegram ID raqamingiz: \`\${chatId}\`\n\nUshbu ID raqamni nusxalab, veb-saytga kiriting.`, { parse_mode: 'Markdown' });
});

const verificationCodes = {};

// Neon.tech ulanishi
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(100) NOT NULL,
        score INT NOT NULL,
        passed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id VARCHAR(50);
    `);
    
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
        ('Neon.tech nima?', ARRAY['Bulutli PostgreSQL bazasi', 'JavaScript freymvorki', 'Rasm tahrirlagich', 'Grafikli dastur'], 0),
        ('PostgreSQL dasturlashda nima uchun ishlatiladi?', ARRAY['Dizayn chizish uchun', 'Ma''lumotlarni saqlash va boshqarish uchun', 'Saytni bezatish uchun', 'Kodni ishga tushirish uchun'], 1),
        ('Neon.tech-da "Branching" nima vazifani bajaradi?', ARRAY['Saytni hostingga yuklaydi', 'Bazaning tekin nusxasini yaratadi', 'Koddagi xatolarni topadi', 'Foydalanuvchini bloklaydi'], 1);
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
  verificationCodes[telegramId.toString()] = code.toString(); // Matn shakliga o'tkazib saqlaymiz

  try {
    await bot.sendMessage(telegramId, `Sizning verifikatsiya kodingiz: *${code}*`, { parse_mode: 'Markdown' });
    res.json({ success: true, message: 'Tasdiqlash kodi Telegram botingizga yuborildi!' });
  } catch (err) {
    res.status(500).json({ error: 'Botga kirib /start bosganingizni tekshiring!' });
  }
});

// API 2: Kodni tekshirish (Xatolik to'liq tuzatilgan qism!)
app.post('/api/verify-code', (req, res) => {
  const { telegramId, code } = req.body;
  
  const originalId = telegramId.toString();
  const inputCode = code.toString().trim();

  // Kod borligini va aniq mosligini tekshiramiz
  if (verificationCodes[originalId] && verificationCodes[originalId] === inputCode) {
    pool.query('SELECT id, question, options FROM questions ORDER BY id ASC')
      .then(result => res.json({ success: true, questions: result.rows }))
      .catch(() => res.status(500).json({ error: 'Savollarni olishda xatolik' }));
  } else {
    res.status(400).json({ success: false, error: 'Tasdiqlash kodi noto\'g\'ri!' });
  }
});

// API 3: Testni tugatish va Sertifikat berish
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
      const queryText = 'INSERT INTO users(full_name, telegram_id, score) VALUES(\$1, \$2, \$3)';
      await pool.query(queryText, [fullName, telegramId, Math.round(percent)]);

      // PDF yaratish
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape' });
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=Sertifikat.pdf`);
      doc.pipe(res);

      doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).lineWidth(5).stroke('#00e676');
      doc.moveDown(4);
      doc.fontSize(34).text('MUVAFFAQIYATLI TOPShIRGANLIK SERTIFIKATI', { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(28).fillColor('#00e676').text(fullName.toUpperCase(), { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(16).fillColor('#333333').text(`Neon.tech testidan muvaffaqiyatli o'tganingiz uchun berildi. Natija: ${Math.round(percent)}%`, { align: 'center' });
      
      doc.end();

      try {
        await bot.sendMessage(telegramId, `Tabriklaymiz, ${fullName}! Siz testdan ${Math.round(percent)}% bilan muvaffaqiyatli o'tdingiz va sertifikatingiz yuklab olindi! 🎉`);
      } catch (e) {
        console.log("Bot xabar yuborishda xato.");
      }

    } else {
      res.status(200).json({ passed: false, message: `Afsuski testdan o'tolmadingiz. Natijangiz: ${Math.round(percent)}%. O'tish uchun kamida 60% kerak.` });
    }
  } catch (err) {
    console.error("Katta xatolik backendda:", err);
    res.status(500).json({ message: 'Serverda yoki ma\'lumotlar bazasida xatolik yuz berdi.' });
  }
});

app.listen(PORT, () => console.log(`Server http://localhost:${PORT} portida tayyor!`));
