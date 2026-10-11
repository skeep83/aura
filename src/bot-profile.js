// Профиль бота на 17 языках: имя, описания, команды и приветствие /start.
// Устанавливаются через Bot API при старте — руками в @BotFather вбивать не нужно.
// Лимиты Telegram: имя ≤ 64, short_description ≤ 120, description ≤ 512 символов (проверяются в тестах).
// {app} и {time} подставляются при сборке.
const T = {
  en: {
    tag: 'video chat with the world', btn: 'Start',
    short: 'Random video chat with people worldwide. Swipe for the next person. Match by language, play games, catch the vibe ✨',
    intro: '✨ {app} — video chat with people from all over the world, right inside Telegram.',
    b: ['Swipe — and meet someone new', 'Match by language: practice English or meet locals', 'Mutual “vibe” — swap contacts only if you both want',
      'Mini-games in the call and a mask for the shy', 'Aura Hour every evening at {time} (UTC+3) 🔥'],
    foot: 'No sign-up, no recording. 18+, AI moderation.', cta: 'Tap “Start” 👇',
    cmds: ['Open video chat', 'Video chat room for your channel', 'Invite a friend — Premium for both', 'Stop Aura Hour reminders', 'Rules and privacy', 'Payment support'],
  },
  ru: {
    tag: 'видеочат со всем миром', btn: 'Начать',
    short: 'Видеочат со случайными людьми со всего мира. Свайп — новый собеседник. Подбор по языку, игры, взаимный вайб ✨',
    intro: '✨ {app} — видеочат с людьми со всего мира прямо в Telegram.',
    b: ['Свайп — и новый собеседник', 'Подбор по языку: практикуй английский с иностранцами', 'Взаимный «вайб» — обменяйтесь контактами, если понравились друг другу',
      'Игры в звонке и маска для стеснительных', 'Aura Hour каждый вечер в {time} по Москве 🔥'],
    foot: 'Без регистрации и записи видео. Только 18+, автомодерация.', cta: 'Жми «Начать» 👇',
    cmds: ['Открыть видеочат', 'Рулетка для своего канала', 'Пригласить друга — Premium обоим', 'Не напоминать об Aura Hour', 'Правила и конфиденциальность', 'Помощь с оплатой'],
  },
  uk: {
    tag: 'відеочат з усім світом', btn: 'Почати',
    short: 'Відеочат із випадковими людьми з усього світу. Свайп — новий співрозмовник. Підбір за мовою, ігри, взаємний вайб ✨',
    intro: '✨ {app} — відеочат з людьми з усього світу просто в Telegram.',
    b: ['Свайп — і новий співрозмовник', 'Підбір за мовою: практикуй англійську з іноземцями', 'Взаємний «вайб» — обмінюйтеся контактами, якщо сподобалися одне одному',
      'Ігри під час дзвінка та маска для сором’язливих', 'Aura Hour щовечора о {time} (UTC+3) 🔥'],
    foot: 'Без реєстрації та запису відео. Лише 18+, автомодерація.', cta: 'Тисни «Почати» 👇',
    cmds: ['Відкрити відеочат', 'Рулетка для свого каналу', 'Запросити друга — Premium обом', 'Не нагадувати про Aura Hour', 'Правила та конфіденційність', 'Допомога з оплатою'],
  },
  es: {
    tag: 'videochat con el mundo', btn: 'Iniciar',
    short: 'Videochat aleatorio con gente de todo el mundo. Desliza y conoce a alguien nuevo. Por idioma, juegos y vibe mutuo ✨',
    intro: '✨ {app} — videochat con personas de todo el mundo, directamente en Telegram.',
    b: ['Desliza y conoce a alguien nuevo', 'Conexión por idioma: practica inglés o conoce a locales', '«Vibe» mutuo: intercambien contactos solo si ambos quieren',
      'Minijuegos en la llamada y máscara para los tímidos', 'Aura Hour cada noche a las {time} (UTC+3) 🔥'],
    foot: 'Sin registro ni grabación. Solo +18, moderación con IA.', cta: 'Pulsa «Iniciar» 👇',
    cmds: ['Abrir videochat', 'Sala de videochat para tu canal', 'Invita a un amigo: Premium para ambos', 'No recordar Aura Hour', 'Reglas y privacidad', 'Ayuda con pagos'],
  },
  pt: {
    tag: 'videochat com o mundo', btn: 'Iniciar',
    short: 'Videochat aleatório com pessoas do mundo todo. Deslize e conheça alguém novo. Por idioma, jogos e vibe mútua ✨',
    intro: '✨ {app} — videochat com pessoas do mundo todo, direto no Telegram.',
    b: ['Deslize e conheça alguém novo', 'Match por idioma: pratique inglês ou conheça locais', '«Vibe» mútua: troquem contatos só se os dois quiserem',
      'Minijogos na chamada e máscara para os tímidos', 'Aura Hour toda noite às {time} (UTC+3) 🔥'],
    foot: 'Sem cadastro, sem gravação. Só +18, moderação por IA.', cta: 'Toque em «Iniciar» 👇',
    cmds: ['Abrir videochat', 'Sala de videochat do seu canal', 'Convide um amigo — Premium para os dois', 'Parar lembretes do Aura Hour', 'Regras e privacidade', 'Ajuda com pagamento'],
  },
  de: {
    tag: 'Videochat mit der Welt', btn: 'Start',
    short: 'Zufälliger Videochat mit Menschen weltweit. Wischen für die nächste Person. Match nach Sprache, Spiele, Vibe ✨',
    intro: '✨ {app} — Videochat mit Menschen aus aller Welt, direkt in Telegram.',
    b: ['Wischen — und jemand Neues kennenlernen', 'Match nach Sprache: Englisch üben oder Locals treffen', 'Gegenseitiger „Vibe“ — Kontakte nur tauschen, wenn beide wollen',
      'Minispiele im Call und eine Maske für Schüchterne', 'Aura Hour jeden Abend um {time} (UTC+3) 🔥'],
    foot: 'Ohne Anmeldung, ohne Aufzeichnung. Ab 18, KI-Moderation.', cta: 'Tippe auf „Start“ 👇',
    cmds: ['Videochat öffnen', 'Videochat-Raum für deinen Kanal', 'Freund einladen — Premium für beide', 'Keine Aura-Hour-Erinnerungen', 'Regeln und Datenschutz', 'Hilfe bei Zahlungen'],
  },
  fr: {
    tag: 'chat vidéo avec le monde', btn: 'Démarrer',
    short: 'Chat vidéo aléatoire avec des gens du monde entier. Swipe pour la suite. Par langue, mini-jeux et vibe mutuelle ✨',
    intro: '✨ {app} — chat vidéo avec des gens du monde entier, directement dans Telegram.',
    b: ['Swipe — et rencontre quelqu’un de nouveau', 'Match par langue : pratique l’anglais ou rencontre des locaux', '« Vibe » mutuelle : échangez vos contacts seulement si vous le voulez tous les deux',
      'Mini-jeux pendant l’appel et masque pour les timides', 'Aura Hour chaque soir à {time} (UTC+3) 🔥'],
    foot: 'Sans inscription, sans enregistrement. 18+ uniquement, modération IA.', cta: 'Appuie sur « Démarrer » 👇',
    cmds: ['Ouvrir le chat vidéo', 'Salon vidéo pour ta chaîne', 'Inviter un ami — Premium pour les deux', 'Ne plus rappeler l’Aura Hour', 'Règles et confidentialité', 'Aide au paiement'],
  },
  it: {
    tag: 'videochat con il mondo', btn: 'Avvia',
    short: 'Videochat casuale con persone da tutto il mondo. Scorri per la prossima. Match per lingua, giochi, vibe reciproca ✨',
    intro: '✨ {app} — videochat con persone da tutto il mondo, direttamente su Telegram.',
    b: ['Scorri e conosci qualcuno di nuovo', 'Match per lingua: pratica l’inglese o conosci gente del posto', '«Vibe» reciproca: scambiatevi i contatti solo se lo volete entrambi',
      'Minigiochi in chiamata e maschera per i timidi', 'Aura Hour ogni sera alle {time} (UTC+3) 🔥'],
    foot: 'Senza registrazione né video salvati. Solo 18+, moderazione IA.', cta: 'Tocca «Avvia» 👇',
    cmds: ['Apri il videochat', 'Stanza videochat per il tuo canale', 'Invita un amico — Premium per entrambi', 'Niente promemoria Aura Hour', 'Regole e privacy', 'Assistenza pagamenti'],
  },
  tr: {
    tag: 'dünyayla görüntülü sohbet', btn: 'Başlat',
    short: 'Dünyanın her yerinden rastgele kişilerle görüntülü sohbet. Kaydır, yeni biriyle tanış. Dil eşleşmesi, oyunlar ✨',
    intro: '✨ {app} — dünyanın dört bir yanından insanlarla görüntülü sohbet, doğrudan Telegram’da.',
    b: ['Kaydır ve yeni biriyle tanış', 'Dile göre eşleşme: İngilizce pratik yap ya da yerlilerle tanış', 'Karşılıklı «vibe» — ikiniz de isterseniz iletişim bilgilerinizi paylaşın',
      'Görüşmede mini oyunlar ve utangaçlar için maske', 'Her akşam {time}’de (UTC+3) Aura Hour 🔥'],
    foot: 'Üyelik yok, video kaydı yok. Yalnızca 18+, yapay zekâ moderasyonu.', cta: '«Başlat»a dokun 👇',
    cmds: ['Görüntülü sohbeti aç', 'Kanalın için sohbet odası', 'Arkadaşını davet et — ikinize Premium', 'Aura Hour hatırlatmalarını kapat', 'Kurallar ve gizlilik', 'Ödeme desteği'],
  },
  pl: {
    tag: 'wideoczat ze światem', btn: 'Start',
    short: 'Losowy wideoczat z ludźmi z całego świata. Przesuń, by poznać kolejną osobę. Dobór po języku, gry, wzajemny vibe ✨',
    intro: '✨ {app} — wideoczat z ludźmi z całego świata, prosto w Telegramie.',
    b: ['Przesuń — i poznaj kogoś nowego', 'Dobór po języku: ćwicz angielski z obcokrajowcami', 'Wzajemny „vibe” — wymieńcie kontakty tylko, gdy oboje chcecie',
      'Minigry w rozmowie i maska dla nieśmiałych', 'Aura Hour co wieczór o {time} (UTC+3) 🔥'],
    foot: 'Bez rejestracji i nagrywania. Tylko 18+, moderacja AI.', cta: 'Naciśnij „Start” 👇',
    cmds: ['Otwórz wideoczat', 'Pokój wideoczatu dla twojego kanału', 'Zaproś znajomego — Premium dla obojga', 'Wyłącz przypomnienia o Aura Hour', 'Zasady i prywatność', 'Pomoc z płatnościami'],
  },
  ar: {
    tag: 'دردشة فيديو مع العالم', btn: 'ابدأ',
    short: 'دردشة فيديو عشوائية مع أشخاص من حول العالم. اسحب لتتعرّف على شخص جديد. مطابقة حسب اللغة وألعاب ✨',
    intro: '✨ {app} — دردشة فيديو مع أشخاص من كل أنحاء العالم مباشرة في تيليجرام.',
    b: ['اسحب وتعرّف على شخص جديد', 'مطابقة حسب اللغة: تدرّب على الإنجليزية أو تعرّف على أهل البلد', '«فايب» متبادل — تبادلا جهات الاتصال فقط إذا رغبتما معًا',
      'ألعاب صغيرة أثناء المكالمة وقناع للخجولين', 'Aura Hour كل مساء الساعة {time} (UTC+3) 🔥'],
    foot: 'بدون إنشاء حساب ولا حفظ للفيديو. للبالغين +18 فقط، مع إشراف بالذكاء الاصطناعي.', cta: 'اضغط «ابدأ» 👇',
    cmds: ['افتح دردشة الفيديو', 'غرفة دردشة لقناتك', 'ادعُ صديقًا — Premium لكليكما', 'إيقاف تذكيرات Aura Hour', 'القواعد والخصوصية', 'المساعدة في الدفع'],
  },
  hi: {
    tag: 'दुनिया के साथ वीडियो चैट', btn: 'शुरू करें',
    short: 'दुनिया भर के अजनबियों से वीडियो चैट। स्वाइप करें, नया व्यक्ति मिलेगा। भाषा से मैच, गेम्स और आपसी वाइब ✨',
    intro: '✨ {app} — दुनिया भर के लोगों से वीडियो चैट, सीधे Telegram में।',
    b: ['स्वाइप करें — और किसी नए से मिलें', 'भाषा से मैच: अंग्रेज़ी का अभ्यास करें या स्थानीय लोगों से मिलें', 'आपसी «वाइब» — दोनों चाहें तभी कॉन्टैक्ट शेयर हों',
      'कॉल में मिनी-गेम्स और शर्मीले लोगों के लिए मास्क', 'हर शाम {time} (UTC+3) बजे Aura Hour 🔥'],
    foot: 'न रजिस्ट्रेशन, न वीडियो रिकॉर्डिंग। केवल 18+, AI मॉडरेशन।', cta: '«शुरू करें» दबाएँ 👇',
    cmds: ['वीडियो चैट खोलें', 'अपने चैनल के लिए वीडियो रूम', 'दोस्त को बुलाएँ — दोनों को Premium', 'Aura Hour रिमाइंडर बंद करें', 'नियम और गोपनीयता', 'भुगतान सहायता'],
  },
  id: {
    tag: 'video chat dengan dunia', btn: 'Mulai',
    short: 'Video chat acak dengan orang dari seluruh dunia. Geser untuk orang berikutnya. Cocok per bahasa, game, vibe ✨',
    intro: '✨ {app} — video chat dengan orang dari seluruh dunia, langsung di Telegram.',
    b: ['Geser — dan kenalan dengan orang baru', 'Cocokkan bahasa: latihan bahasa Inggris atau kenalan dengan warga lokal', '«Vibe» timbal balik — tukar kontak hanya jika kalian berdua mau',
      'Mini game saat panggilan dan masker untuk yang pemalu', 'Aura Hour setiap malam pukul {time} (UTC+3) 🔥'],
    foot: 'Tanpa daftar, tanpa rekaman. Hanya 18+, moderasi AI.', cta: 'Ketuk «Mulai» 👇',
    cmds: ['Buka video chat', 'Ruang video chat untuk kanalmu', 'Undang teman — Premium untuk berdua', 'Matikan pengingat Aura Hour', 'Aturan dan privasi', 'Bantuan pembayaran'],
  },
  fa: {
    tag: 'ویدیوچت با دنیا', btn: 'شروع',
    short: 'ویدیوچت تصادفی با آدم‌هایی از سراسر دنیا. بکش تا نفر بعدی بیاید. هم‌زبان‌یابی، بازی و وایب دوطرفه ✨',
    intro: '✨ {app} — ویدیوچت با آدم‌هایی از سراسر دنیا، مستقیم در تلگرام.',
    b: ['بکش و با یک نفر تازه آشنا شو', 'انتخاب بر اساس زبان: انگلیسی تمرین کن یا با محلی‌ها آشنا شو', '«وایب» دوطرفه — فقط اگر هر دو بخواهید، اطلاعات تماس رد و بدل می‌شود',
      'بازی‌های کوچک در تماس و ماسک برای خجالتی‌ها', 'هر شب ساعت {time} (UTC+3) — Aura Hour 🔥'],
    foot: 'بدون ثبت‌نام و بدون ضبط ویدیو. فقط ۱۸+، با نظارت هوش مصنوعی.', cta: 'روی «شروع» بزن 👇',
    cmds: ['باز کردن ویدیوچت', 'اتاق ویدیوچت برای کانالت', 'دعوت از دوست — Premium برای هر دو', 'خاموش کردن یادآور Aura Hour', 'قوانین و حریم خصوصی', 'پشتیبانی پرداخت'],
  },
  vi: {
    tag: 'video chat với thế giới', btn: 'Bắt đầu',
    short: 'Video chat ngẫu nhiên với mọi người khắp thế giới. Vuốt để gặp người tiếp theo. Ghép theo ngôn ngữ, trò chơi ✨',
    intro: '✨ {app} — video chat với mọi người khắp thế giới, ngay trong Telegram.',
    b: ['Vuốt — và gặp một người mới', 'Ghép theo ngôn ngữ: luyện tiếng Anh hoặc làm quen người bản xứ', '«Vibe» hai chiều — chỉ trao đổi liên hệ khi cả hai cùng muốn',
      'Trò chơi nhỏ trong cuộc gọi và mặt nạ cho người ngại ngùng', 'Aura Hour mỗi tối lúc {time} (UTC+3) 🔥'],
    foot: 'Không cần đăng ký, không ghi hình. Chỉ 18+, kiểm duyệt bằng AI.', cta: 'Nhấn «Bắt đầu» 👇',
    cmds: ['Mở video chat', 'Phòng video chat cho kênh của bạn', 'Mời bạn bè — cả hai nhận Premium', 'Tắt nhắc nhở Aura Hour', 'Quy tắc và quyền riêng tư', 'Hỗ trợ thanh toán'],
  },
  uz: {
    tag: 'butun dunyo bilan videochat', btn: 'Boshlash',
    short: 'Butun dunyodagi tasodifiy odamlar bilan videochat. Suring — yangi suhbatdosh. Til bo‘yicha tanlash, o‘yinlar ✨',
    intro: '✨ {app} — butun dunyodagi odamlar bilan videochat, to‘g‘ridan-to‘g‘ri Telegramda.',
    b: ['Suring — va yangi odam bilan tanishing', 'Til bo‘yicha tanlash: ingliz tilini mashq qiling yoki mahalliylar bilan tanishing', 'O‘zaro «vayb» — ikkalangiz xohlasangizgina kontakt almashasiz',
      'Qo‘ng‘iroqda mini-o‘yinlar va uyatchanlar uchun niqob', 'Har kuni kechqurun {time} da (UTC+3) Aura Hour 🔥'],
    foot: 'Ro‘yxatdan o‘tish va video yozuvi yo‘q. Faqat 18+, AI moderatsiya.', cta: '«Boshlash»ni bosing 👇',
    cmds: ['Videochatni ochish', 'Kanalingiz uchun videochat xonasi', 'Do‘stni taklif qiling — ikkalangizga Premium', 'Aura Hour eslatmalarini o‘chirish', 'Qoidalar va maxfiylik', 'To‘lov bo‘yicha yordam'],
  },
  kk: {
    tag: 'бүкіл әлеммен бейнечат', btn: 'Бастау',
    short: 'Әлемнің түкпір-түкпіріндегі кездейсоқ адамдармен бейнечат. Сырғыт — жаңа әңгімелесуші. Тіл бойынша, ойындар ✨',
    intro: '✨ {app} — әлемнің түкпір-түкпіріндегі адамдармен бейнечат, тікелей Telegram ішінде.',
    b: ['Сырғыт — жаңа адаммен таныс', 'Тіл бойынша іріктеу: ағылшынша жаттық немесе жергілікті адамдармен таныс', 'Өзара «вайб» — екеуің де қаласаң ғана контакт алмасасыңдар',
      'Қоңырау кезіндегі шағын ойындар және ұялшақтарға арналған маска', 'Күн сайын кешкі {time}-де (UTC+3) Aura Hour 🔥'],
    foot: 'Тіркелусіз, бейне жазылмайды. Тек 18+, AI модерация.', cta: '«Бастау» түймесін бас 👇',
    cmds: ['Бейнечатты ашу', 'Арнаңызға арналған бейнечат бөлмесі', 'Досыңды шақыр — екеуіңе Premium', 'Aura Hour еске салғыштарын өшіру', 'Ережелер мен құпиялылық', 'Төлем бойынша көмек'],
  },
};

const COMMANDS = ['start', 'room', 'invite', 'events_off', 'terms', 'paysupport'];
export const PROFILE_LANGS = Object.keys(T);

// Язык пользователя Telegram → язык профиля (по первым двум буквам), иначе английский
export function pickLang(code) {
  const l = String(code || '').slice(0, 2).toLowerCase();
  return T[l] ? l : 'en';
}

export function botProfile({ appName, eventTime }) {
  const fill = s => s.replaceAll('{app}', appName).replaceAll('{time}', eventTime);
  const out = {};
  for (const [lang, t] of Object.entries(T)) {
    const body = [fill(t.intro), '', ...t.b.map(x => '• ' + fill(x)), '', fill(t.foot), '', fill(t.cta)].join('\n');
    out[lang] = {
      name: `${appName} — ${t.tag}`,
      short: fill(t.short),
      description: body,
      button: `🎥 ${t.btn}`,
      commands: COMMANDS.map((command, i) => ({ command, description: t.cmds[i] })),
    };
  }
  return out;
}

// Сообщения бота пользователю (уведомления) на языках интерфейса; остальные — английский
const NOTE = {
  en: { vibe: '✨ Mutual vibe in {app}! Message them: {who}', referral: '🎉 A friend joined via your link — {n} day(s) of Premium for both of you!',
    remind: '🔥 <b>Aura Hour</b> starts in 5 minutes!\nShort {m}-minute rounds — the most people online at once.', open: '🎥 Join',
    compliment: "💌 Someone you talked to in {app} left you a compliment: <b>{what}</b>", wrapped: "✨ <b>Your week in {app}</b>\n{chats} chats · {min} min · {countries} new countries\nTap to see your aura type 👇", wrapped_btn: "🔮 My week",
    salute_premium: "🎆 You've received {n} salutes — a day of Premium is yours!", salutes_bought: "🎆 +{n} salutes! Send them in a call — tap 🎆 on the reaction bar.",
    c_smile: "Beautiful smile", c_funny: "So funny", c_smart: "Smart talk", c_kind: "Kind soul", c_voice: "Lovely voice", c_world: "Interesting world" },
  ru: { vibe: '✨ Взаимный вайб в {app}! Напишите: {who}', referral: '🎉 По вашей ссылке пришёл друг — вам обоим {n} сут. Premium!',
    remind: '🔥 <b>Aura Hour</b> начинается через 5 минут!\nКороткие раунды по {m} мин — максимум людей онлайн одновременно.', open: '🎥 Зайти',
    compliment: "💌 Собеседник в {app} оставил вам комплимент: <b>{what}</b>", wrapped: "✨ <b>Ваша неделя в {app}</b>\n{chats} разговоров · {min} мин · {countries} новых стран\nЖмите — узнайте свой тип ауры 👇", wrapped_btn: "🔮 Моя неделя",
    salute_premium: "🎆 Вы получили {n} салютов — дарим сутки Premium!", salutes_bought: "🎆 +{n} салютов! Отправляйте в звонке — кнопка 🎆 на панели реакций.",
    c_smile: "Красивая улыбка", c_funny: "Очень смешно", c_smart: "Умный разговор", c_kind: "Добрая душа", c_voice: "Приятный голос", c_world: "Интересный мир" },
  uk: { vibe: '✨ Взаємний вайб в {app}! Напишіть: {who}', referral: '🎉 За вашим посиланням прийшов друг — вам обом {n} доб. Premium!',
    remind: '🔥 <b>Aura Hour</b> починається за 5 хвилин!\nКороткі раунди по {m} хв — найбільше людей онлайн одночасно.', open: '🎥 Зайти',
    compliment: "💌 Співрозмовник в {app} залишив вам комплімент: <b>{what}</b>", wrapped: "✨ <b>Ваш тиждень в {app}</b>\n{chats} розмов · {min} хв · {countries} нових країн\nТисніть — дізнайтеся свій тип аури 👇", wrapped_btn: "🔮 Мій тиждень",
    salute_premium: "🎆 Ви отримали {n} салютів — даруємо добу Premium!", salutes_bought: "🎆 +{n} салютів! Надсилайте в дзвінку — кнопка 🎆 на панелі реакцій.",
    c_smile: "Гарна усмішка", c_funny: "Дуже смішно", c_smart: "Розумна розмова", c_kind: "Добра душа", c_voice: "Приємний голос", c_world: "Цікавий світ" },
  es: { vibe: '✨ ¡Vibe mutuo en {app}! Escríbele: {who}', referral: '🎉 Un amigo entró con tu enlace: ¡{n} día(s) de Premium para los dos!',
    remind: '🔥 ¡<b>Aura Hour</b> empieza en 5 minutos!\nRondas cortas de {m} min — la mayor cantidad de gente en línea.', open: '🎥 Entrar',
    compliment: "💌 Alguien con quien hablaste en {app} te dejó un cumplido: <b>{what}</b>", wrapped: "✨ <b>Tu semana en {app}</b>\n{chats} chats · {min} min · {countries} países nuevos\nToca para ver tu tipo de aura 👇", wrapped_btn: "🔮 Mi semana",
    salute_premium: "🎆 Recibiste {n} saludos — ¡un día de Premium para ti!", salutes_bought: "🎆 ¡+{n} saludos! Envíalos en una llamada con el botón 🎆.",
    c_smile: "Sonrisa bonita", c_funny: "Muy gracioso", c_smart: "Charla inteligente", c_kind: "Alma amable", c_voice: "Voz agradable", c_world: "Mundo interesante" },
  pt: { vibe: '✨ Vibe mútua no {app}! Escreva para: {who}', referral: '🎉 Um amigo entrou pelo seu link — {n} dia(s) de Premium para os dois!',
    remind: '🔥 <b>Aura Hour</b> começa em 5 minutos!\nRodadas curtas de {m} min — o máximo de gente online ao mesmo tempo.', open: '🎥 Entrar',
    compliment: "💌 Alguém com quem você falou no {app} deixou um elogio: <b>{what}</b>", wrapped: "✨ <b>Sua semana no {app}</b>\n{chats} conversas · {min} min · {countries} países novos\nToque para ver seu tipo de aura 👇", wrapped_btn: "🔮 Minha semana",
    salute_premium: "🎆 Você recebeu {n} saudações — um dia de Premium é seu!", salutes_bought: "🎆 +{n} saudações! Envie numa chamada pelo botão 🎆.",
    c_smile: "Sorriso lindo", c_funny: "Muito engraçado", c_smart: "Papo inteligente", c_kind: "Alma gentil", c_voice: "Voz agradável", c_world: "Mundo interessante" },
  de: { vibe: '✨ Gegenseitiger Vibe in {app}! Schreib: {who}', referral: '🎉 Ein Freund kam über deinen Link — {n} Tag(e) Premium für euch beide!',
    remind: '🔥 <b>Aura Hour</b> beginnt in 5 Minuten!\nKurze Runden à {m} Min — die meisten Leute gleichzeitig online.', open: '🎥 Rein',
    compliment: "💌 Jemand aus {app} hat dir ein Kompliment hinterlassen: <b>{what}</b>", wrapped: "✨ <b>Deine Woche in {app}</b>\n{chats} Chats · {min} Min · {countries} neue Länder\nTippe für deinen Aura-Typ 👇", wrapped_btn: "🔮 Meine Woche",
    salute_premium: "🎆 Du hast {n} Salute bekommen — ein Tag Premium gehört dir!", salutes_bought: "🎆 +{n} Salute! Verschicke sie im Call über 🎆.",
    c_smile: "Schönes Lächeln", c_funny: "Sehr lustig", c_smart: "Kluges Gespräch", c_kind: "Gute Seele", c_voice: "Schöne Stimme", c_world: "Spannende Welt" },
  tr: { vibe: '✨ {app}’da karşılıklı vibe! Yaz: {who}', referral: '🎉 Bir arkadaşın linkinle katıldı — ikinize {n} gün Premium!',
    remind: '🔥 <b>Aura Hour</b> 5 dakika sonra başlıyor!\n{m} dakikalık kısa turlar — aynı anda en çok kişi çevrimiçi.', open: '🎥 Katıl',
    compliment: "💌 {app}’da konuştuğun biri sana iltifat bıraktı: <b>{what}</b>", wrapped: "✨ <b>{app}’da haftan</b>\n{chats} sohbet · {min} dk · {countries} yeni ülke\nAura tipini görmek için dokun 👇", wrapped_btn: "🔮 Haftam",
    salute_premium: "🎆 {n} selam aldın — bir günlük Premium senin!", salutes_bought: "🎆 +{n} selam! Görüşmede 🎆 ile gönder.",
    c_smile: "Güzel gülüş", c_funny: "Çok komik", c_smart: "Akıllı sohbet", c_kind: "İyi kalpli", c_voice: "Hoş ses", c_world: "İlginç dünya" },
  id: { vibe: '✨ Vibe timbal balik di {app}! Kirim pesan: {who}', referral: '🎉 Temanmu bergabung lewat link-mu — Premium {n} hari untuk kalian berdua!',
    remind: '🔥 <b>Aura Hour</b> dimulai 5 menit lagi!\nRonde singkat {m} menit — paling banyak orang online bersamaan.', open: '🎥 Masuk',
    compliment: "💌 Seseorang di {app} memberimu pujian: <b>{what}</b>", wrapped: "✨ <b>Minggumu di {app}</b>\n{chats} obrolan · {min} mnt · {countries} negara baru\nKetuk untuk melihat tipe aura-mu 👇", wrapped_btn: "🔮 Mingguku",
    salute_premium: "🎆 Kamu menerima {n} salut — Premium sehari untukmu!", salutes_bought: "🎆 +{n} salut! Kirim saat panggilan lewat tombol 🎆.",
    c_smile: "Senyum manis", c_funny: "Lucu banget", c_smart: "Obrolan cerdas", c_kind: "Hati baik", c_voice: "Suara merdu", c_world: "Dunia menarik" },
};
export function note(lang, key, vars = {}) {
  const l = String(lang || '').slice(0, 2).toLowerCase();
  const d = NOTE[l] || (['kk', 'uz', 'be'].includes(l) ? NOTE.ru : NOTE.en);
  let s = d[key] || NOTE.en[key];
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
