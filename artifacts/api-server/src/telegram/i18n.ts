export type LanguageCode =
  | "en"
  | "hi"
  | "es"
  | "fr"
  | "de"
  | "pt"
  | "ar"
  | "bn"
  | "ru"
  | "zh";

export interface LanguageOption {
  code: LanguageCode;
  label: string;
}

export const languageOptions: LanguageOption[] = [
  { code: "en", label: "🇬🇧 English" },
  { code: "hi", label: "🇮🇳 हिन्दी" },
  { code: "es", label: "🇪🇸 Español" },
  { code: "fr", label: "🇫🇷 Français" },
  { code: "de", label: "🇩🇪 Deutsch" },
  { code: "pt", label: "🇧🇷 Português" },
  { code: "ar", label: "🇸🇦 العربية" },
  { code: "bn", label: "🇧🇩 বাংলা" },
  { code: "ru", label: "🇷🇺 Русский" },
  { code: "zh", label: "🇨🇳 中文" },
];

type TranslationKey =
  | "languageChoose"
  | "languageSet"
  | "help"
  | "loginFirst"
  | "queueEmpty"
  | "queueCleared"
  | "transferPaused"
  | "transferResumed"
  | "transferCancelled"
  | "transferSpeed"
  | "speedSet"
  | "settings"
  | "privacy"
  | "logoutDone"
  | "ping"
  | "noHistory"
  | "history"
  | "stats"
  | "logs"
  | "filterUsage"
  | "filterSet"
  | "filterCleared"
  | "maxSizeUsage"
  | "maxSizeSet"
  | "maxSizeCleared"
  | "notifySet"
  | "destination"
  | "scheduleUsage"
  | "scheduleSet"
  | "scheduleCleared"
  | "duplicates"
  | "skipDone";

const en: Record<TranslationKey, string> = {
  languageChoose: "Choose your language:",
  languageSet: "Language changed to {language}.",
  help: "Use /login, send a source URL, choose files, create a queue, then send .sendhere in the destination chat.",
  loginFirst: "Send /login first.",
  queueEmpty: "Your queue is empty.",
  queueCleared: "Queue cleared.",
  transferPaused: "Transfer paused. Use /resume to continue.",
  transferResumed: "Transfer resumed.",
  transferCancelled: "Transfer cancelled and queue cleared.",
  transferSpeed: "Transfer speed: {speed}",
  speedSet: "Transfer speed set to {speed}.",
  settings: "Settings\nLanguage: {language}\nSpeed: {speed}\nNotifications: {notify}\nMaximum file size: {maxSize}\nFilter: {filter}",
  privacy: "Your Telegram session and queue state are stored in the configured data directory. Login messages are deleted immediately and secrets are never sent to the bot owner.",
  logoutDone: "Telegram session removed. Send /login to connect again.",
  ping: "Pong. Bot is online.",
  noHistory: "No completed transfers yet.",
  history: "Recent transfers:\n{items}",
  stats: "Transfer statistics\nTransfers: {transfers}\nFiles sent: {sent}\nFailed: {failed}\nDuplicates skipped: {duplicates}",
  logs: "Recent errors:\n{items}",
  filterUsage: "Usage: /filter text or /filter off",
  filterSet: "Filter set to: {filter}",
  filterCleared: "Filter cleared.",
  maxSizeUsage: "Usage: /maxsize 500 or /maxsize off (MB)",
  maxSizeSet: "Maximum file size set to {size} MB.",
  maxSizeCleared: "Maximum file size limit cleared.",
  notifySet: "Completion notifications are now {state}.",
  destination: "Current destination: {destination}\nUse .sendhere in the destination chat to change it.",
  scheduleUsage: "Usage: /schedule minutes, or /schedule off",
  scheduleSet: "Transfer will start {minutes} minutes after .sendhere.",
  scheduleCleared: "Scheduled start cleared.",
  duplicates: "Duplicates skipped: {count}. Already-sent items are removed when a new queue is created.",
  skipDone: "Skipped: {name}",
};

const localized = (
  overrides: Partial<Record<TranslationKey, string>>,
): Record<TranslationKey, string> => ({ ...en, ...overrides });

const translations: Record<LanguageCode, Record<TranslationKey, string>> = {
  en,
  hi: {
    languageChoose: "अपनी भाषा चुनें:",
    languageSet: "भाषा {language} पर सेट हो गई।",
    help: "/login भेजें, source URL भेजें, files चुनें, queue बनाएं और destination chat में .sendhere भेजें।",
    loginFirst: "पहले /login भेजें।",
    queueEmpty: "आपकी queue खाली है।",
    queueCleared: "Queue साफ कर दी गई।",
    transferPaused: "Transfer रोक दिया गया। जारी रखने के लिए /resume भेजें।",
    transferResumed: "Transfer फिर से शुरू हो गया।",
    transferCancelled: "Transfer cancel करके queue साफ कर दी गई।",
    transferSpeed: "Transfer speed: {speed}",
    speedSet: "Transfer speed {speed} कर दी गई।",
    settings: "Settings\nभाषा: {language}\nSpeed: {speed}\nNotifications: {notify}\nअधिकतम file size: {maxSize}\nFilter: {filter}",
    privacy: "आपका Telegram session और queue state configured data directory में save होता है। Login messages तुरंत delete किए जाते हैं।",
    logoutDone: "Telegram session हटा दिया गया। फिर connect करने के लिए /login भेजें।",
    ping: "Pong. Bot online है।",
    noHistory: "अभी कोई completed transfer नहीं है।",
    history: "Recent transfers:\n{items}",
    stats: "Transfer statistics\nTransfers: {transfers}\nFiles sent: {sent}\nFailed: {failed}\nDuplicates skipped: {duplicates}",
    logs: "Recent errors:\n{items}",
    filterUsage: "उपयोग: /filter text या /filter off",
    filterSet: "Filter set है: {filter}",
    filterCleared: "Filter हटा दिया गया।",
    maxSizeUsage: "उपयोग: /maxsize 500 या /maxsize off (MB)",
    maxSizeSet: "Maximum file size {size} MB कर दी गई।",
    maxSizeCleared: "Maximum file size limit हटा दी गई।",
    notifySet: "Completion notifications अब {state} हैं।",
    destination: "Current destination: {destination}\nबदलने के लिए destination chat में .sendhere भेजें।",
    scheduleUsage: "उपयोग: /schedule minutes या /schedule off",
    scheduleSet: ".sendhere के {minutes} मिनट बाद transfer शुरू होगा।",
    scheduleCleared: "Scheduled start हटा दिया गया।",
    duplicates: "Duplicates skipped: {count}। नई queue बनाते समय पहले भेजे items हटेंगे।",
    skipDone: "Skip किया गया: {name}",
  },
  es: {
    languageChoose: "Elige tu idioma:",
    languageSet: "Idioma cambiado a {language}.",
    help: "Usa /login, envía una URL de origen, elige archivos, crea una cola y envía .sendhere en el chat destino.",
    loginFirst: "Envía /login primero.",
    queueEmpty: "Tu cola está vacía.",
    queueCleared: "Cola borrada.",
    transferPaused: "Transferencia pausada. Usa /resume para continuar.",
    transferResumed: "Transferencia reanudada.",
    transferCancelled: "Transferencia cancelada y cola borrada.",
    transferSpeed: "Velocidad: {speed}",
    speedSet: "Velocidad configurada a {speed}.",
    settings: "Ajustes\nIdioma: {language}\nVelocidad: {speed}\nNotificaciones: {notify}\nTamaño máximo: {maxSize}\nFiltro: {filter}",
    privacy: "Tu sesión de Telegram y el estado de la cola se guardan en el directorio de datos configurado. Los mensajes de inicio de sesión se borran inmediatamente.",
    logoutDone: "Sesión de Telegram eliminada. Usa /login para conectarte de nuevo.",
    ping: "Pong. El bot está en línea.",
    noHistory: "Aún no hay transferencias completadas.",
    history: "Transferencias recientes:\n{items}",
    stats: "Estadísticas\nTransferencias: {transfers}\nEnviados: {sent}\nFallidos: {failed}\nDuplicados omitidos: {duplicates}",
    logs: "Errores recientes:\n{items}",
    filterUsage: "Uso: /filter texto o /filter off",
    filterSet: "Filtro configurado: {filter}",
    filterCleared: "Filtro eliminado.",
    maxSizeUsage: "Uso: /maxsize 500 o /maxsize off (MB)",
    maxSizeSet: "Tamaño máximo configurado a {size} MB.",
    maxSizeCleared: "Límite de tamaño eliminado.",
    notifySet: "Las notificaciones ahora están {state}.",
    destination: "Destino actual: {destination}\nUsa .sendhere en el chat destino para cambiarlo.",
    scheduleUsage: "Uso: /schedule minutos o /schedule off",
    scheduleSet: "La transferencia comenzará {minutes} minutos después de .sendhere.",
    scheduleCleared: "Inicio programado eliminado.",
    duplicates: "Duplicados omitidos: {count}.",
    skipDone: "Omitido: {name}",
  },
  fr: localized({
    languageChoose: "Choisissez votre langue :",
    languageSet: "Langue changée en {language}.",
    help: "Utilisez /login, envoyez une URL source, choisissez les fichiers, créez une file puis envoyez .sendhere dans le chat de destination.",
    queueEmpty: "Votre file est vide.",
    queueCleared: "File supprimée.",
    transferPaused: "Transfert en pause. Utilisez /resume pour continuer.",
    transferResumed: "Transfert repris.",
    transferCancelled: "Transfert annulé et file supprimée.",
    transferSpeed: "Vitesse de transfert : {speed}",
    speedSet: "Vitesse réglée sur {speed}.",
    settings: "Paramètres\nLangue : {language}\nVitesse : {speed}\nNotifications : {notify}\nTaille maximale : {maxSize}\nFiltre : {filter}",
    privacy: "Votre session Telegram et l'état de la file sont conservés dans le dossier de données configuré. Les messages de connexion sont supprimés immédiatement.",
    logoutDone: "Session Telegram supprimée. Utilisez /login pour vous reconnecter.",
    ping: "Pong. Le bot est en ligne.",
    noHistory: "Aucun transfert terminé pour le moment.",
    filterUsage: "Utilisation : /filter texte ou /filter off",
    maxSizeUsage: "Utilisation : /maxsize 500 ou /maxsize off (Mo)",
    notifySet: "Les notifications de fin sont maintenant {state}.",
    destination: "Destination actuelle : {destination}\nUtilisez .sendhere dans le chat de destination pour la changer.",
    scheduleUsage: "Utilisation : /schedule minutes ou /schedule off",
    duplicates: "Doublons ignorés : {count}.",
    skipDone: "Ignoré : {name}",
  }),
  de: localized({
    languageChoose: "Sprache auswählen:",
    languageSet: "Sprache auf {language} geändert.",
    help: "Nutze /login, sende eine Quell-URL, wähle Dateien, erstelle eine Warteschlange und sende .sendhere im Zielchat.",
    queueEmpty: "Deine Warteschlange ist leer.",
    queueCleared: "Warteschlange gelöscht.",
    transferPaused: "Übertragung pausiert. Mit /resume fortsetzen.",
    transferResumed: "Übertragung fortgesetzt.",
    transferCancelled: "Übertragung abgebrochen und Warteschlange gelöscht.",
    transferSpeed: "Übertragungsgeschwindigkeit: {speed}",
    speedSet: "Geschwindigkeit auf {speed} gesetzt.",
    settings: "Einstellungen\nSprache: {language}\nGeschwindigkeit: {speed}\nBenachrichtigungen: {notify}\nMaximale Dateigröße: {maxSize}\nFilter: {filter}",
    privacy: "Deine Telegram-Sitzung und der Warteschlangenstatus werden im konfigurierten Datenordner gespeichert. Login-Nachrichten werden sofort gelöscht.",
    logoutDone: "Telegram-Sitzung entfernt. Mit /login erneut verbinden.",
    ping: "Pong. Der Bot ist online.",
    noHistory: "Noch keine abgeschlossenen Übertragungen.",
    filterUsage: "Verwendung: /filter Text oder /filter off",
    maxSizeUsage: "Verwendung: /maxsize 500 oder /maxsize off (MB)",
    notifySet: "Abschlussbenachrichtigungen sind jetzt {state}.",
    destination: "Aktuelles Ziel: {destination}\nZum Ändern .sendhere im Zielchat senden.",
    scheduleUsage: "Verwendung: /schedule Minuten oder /schedule off",
    duplicates: "Übersprungene Duplikate: {count}.",
    skipDone: "Übersprungen: {name}",
  }),
  pt: localized({
    languageChoose: "Escolha seu idioma:",
    languageSet: "Idioma alterado para {language}.",
    help: "Use /login, envie uma URL de origem, escolha os arquivos, crie a fila e envie .sendhere no chat de destino.",
    queueEmpty: "Sua fila está vazia.",
    queueCleared: "Fila limpa.",
    transferPaused: "Transferência pausada. Use /resume para continuar.",
    transferResumed: "Transferência retomada.",
    transferCancelled: "Transferência cancelada e fila limpa.",
    transferSpeed: "Velocidade da transferência: {speed}",
    speedSet: "Velocidade definida para {speed}.",
    settings: "Configurações\nIdioma: {language}\nVelocidade: {speed}\nNotificações: {notify}\nTamanho máximo: {maxSize}\nFiltro: {filter}",
    privacy: "Sua sessão do Telegram e o estado da fila ficam no diretório de dados configurado. Mensagens de login são apagadas imediatamente.",
    logoutDone: "Sessão do Telegram removida. Use /login para conectar novamente.",
    ping: "Pong. O bot está online.",
    noHistory: "Nenhuma transferência concluída ainda.",
    filterUsage: "Uso: /filter texto ou /filter off",
    maxSizeUsage: "Uso: /maxsize 500 ou /maxsize off (MB)",
    notifySet: "As notificações de conclusão estão {state}.",
    destination: "Destino atual: {destination}\nUse .sendhere no chat de destino para alterá-lo.",
    scheduleUsage: "Uso: /schedule minutos ou /schedule off",
    duplicates: "Duplicados ignorados: {count}.",
    skipDone: "Ignorado: {name}",
  }),
  ar: localized({
    languageChoose: "اختر لغتك:",
    languageSet: "تم تغيير اللغة إلى {language}.",
    help: "استخدم /login، أرسل رابط المصدر، اختر الملفات، أنشئ قائمة ثم أرسل .sendhere في محادثة الوجهة.",
    queueEmpty: "قائمتك فارغة.",
    queueCleared: "تم مسح القائمة.",
    transferPaused: "تم إيقاف النقل مؤقتاً. استخدم /resume للمتابعة.",
    transferResumed: "تم استئناف النقل.",
    transferCancelled: "تم إلغاء النقل ومسح القائمة.",
    transferSpeed: "سرعة النقل: {speed}",
    speedSet: "تم ضبط السرعة على {speed}.",
    settings: "الإعدادات\nاللغة: {language}\nالسرعة: {speed}\nالإشعارات: {notify}\nالحجم الأقصى: {maxSize}\nالفلتر: {filter}",
    privacy: "يتم حفظ جلسة Telegram وحالة القائمة في مجلد البيانات المحدد. تحذف رسائل تسجيل الدخول فوراً.",
    logoutDone: "تم حذف جلسة Telegram. استخدم /login للاتصال من جديد.",
    ping: "Pong. البوت يعمل.",
    noHistory: "لا توجد عمليات نقل مكتملة بعد.",
    filterUsage: "الاستخدام: /filter نص أو /filter off",
    maxSizeUsage: "الاستخدام: /maxsize 500 أو /maxsize off (MB)",
    notifySet: "إشعارات الإكمال الآن {state}.",
    destination: "الوجهة الحالية: {destination}\nاستخدم .sendhere في محادثة الوجهة لتغييرها.",
    scheduleUsage: "الاستخدام: /schedule دقائق أو /schedule off",
    duplicates: "العناصر المكررة التي تم تخطيها: {count}.",
    skipDone: "تم التخطي: {name}",
  }),
  bn: localized({
    languageChoose: "আপনার ভাষা বেছে নিন:",
    languageSet: "ভাষা {language} করা হয়েছে।",
    help: "/login পাঠান, সোর্স URL পাঠান, ফাইল বাছুন, queue তৈরি করুন এবং destination chat-এ .sendhere পাঠান।",
    queueEmpty: "আপনার queue খালি।",
    queueCleared: "Queue মুছে ফেলা হয়েছে।",
    transferPaused: "Transfer থামানো হয়েছে। চালাতে /resume পাঠান।",
    transferResumed: "Transfer আবার শুরু হয়েছে।",
    transferCancelled: "Transfer বাতিল এবং queue মুছে ফেলা হয়েছে।",
    transferSpeed: "Transfer speed: {speed}",
    speedSet: "Transfer speed {speed} করা হয়েছে।",
    settings: "Settings\nভাষা: {language}\nSpeed: {speed}\nNotifications: {notify}\nসর্বোচ্চ file size: {maxSize}\nFilter: {filter}",
    privacy: "আপনার Telegram session এবং queue state নির্ধারিত data directory-তে সংরক্ষিত হয়। Login message সঙ্গে সঙ্গে মুছে ফেলা হয়।",
    logoutDone: "Telegram session মুছে ফেলা হয়েছে। আবার connect করতে /login পাঠান।",
    ping: "Pong. Bot online আছে।",
    noHistory: "এখনও কোনো completed transfer নেই।",
    filterUsage: "ব্যবহার: /filter text অথবা /filter off",
    maxSizeUsage: "ব্যবহার: /maxsize 500 অথবা /maxsize off (MB)",
    notifySet: "Completion notification এখন {state}।",
    destination: "বর্তমান destination: {destination}\nবদলাতে destination chat-এ .sendhere পাঠান।",
    scheduleUsage: "ব্যবহার: /schedule minutes অথবা /schedule off",
    duplicates: "যে duplicate বাদ গেছে: {count}।",
    skipDone: "বাদ দেওয়া হয়েছে: {name}",
  }),
  ru: localized({
    languageChoose: "Выберите язык:",
    languageSet: "Язык изменён на {language}.",
    help: "Используйте /login, отправьте URL источника, выберите файлы, создайте очередь и отправьте .sendhere в чате назначения.",
    queueEmpty: "Очередь пуста.",
    queueCleared: "Очередь очищена.",
    transferPaused: "Передача приостановлена. Используйте /resume для продолжения.",
    transferResumed: "Передача возобновлена.",
    transferCancelled: "Передача отменена, очередь очищена.",
    transferSpeed: "Скорость передачи: {speed}",
    speedSet: "Скорость установлена: {speed}.",
    settings: "Настройки\nЯзык: {language}\nСкорость: {speed}\nУведомления: {notify}\nМаксимальный размер: {maxSize}\nФильтр: {filter}",
    privacy: "Сессия Telegram и состояние очереди хранятся в указанной папке данных. Сообщения входа удаляются сразу.",
    logoutDone: "Сессия Telegram удалена. Для подключения снова используйте /login.",
    ping: "Pong. Бот работает.",
    noHistory: "Завершённых передач пока нет.",
    filterUsage: "Использование: /filter текст или /filter off",
    maxSizeUsage: "Использование: /maxsize 500 или /maxsize off (МБ)",
    notifySet: "Уведомления о завершении теперь {state}.",
    destination: "Текущая цель: {destination}\nДля изменения отправьте .sendhere в чате назначения.",
    scheduleUsage: "Использование: /schedule минуты или /schedule off",
    duplicates: "Пропущено дубликатов: {count}.",
    skipDone: "Пропущено: {name}",
  }),
  zh: localized({
    languageChoose: "选择你的语言：",
    languageSet: "语言已切换为 {language}。",
    help: "使用 /login，发送来源链接，选择文件，创建队列，然后在目标聊天中发送 .sendhere。",
    queueEmpty: "队列为空。",
    queueCleared: "队列已清空。",
    transferPaused: "传输已暂停。使用 /resume 继续。",
    transferResumed: "传输已恢复。",
    transferCancelled: "传输已取消，队列已清空。",
    transferSpeed: "传输速度：{speed}",
    speedSet: "传输速度已设置为 {speed}。",
    settings: "设置\n语言：{language}\n速度：{speed}\n通知：{notify}\n最大文件大小：{maxSize}\n筛选：{filter}",
    privacy: "Telegram 会话和队列状态保存在配置的数据目录中。登录消息会立即删除。",
    logoutDone: "Telegram 会话已删除。使用 /login 重新连接。",
    ping: "Pong。机器人在线。",
    noHistory: "还没有完成的传输。",
    filterUsage: "用法：/filter 文本 或 /filter off",
    maxSizeUsage: "用法：/maxsize 500 或 /maxsize off (MB)",
    notifySet: "完成通知现在为 {state}。",
    destination: "当前目标：{destination}\n在目标聊天中发送 .sendhere 可更改。",
    scheduleUsage: "用法：/schedule 分钟 或 /schedule off",
    duplicates: "已跳过重复项：{count}。",
    skipDone: "已跳过：{name}",
  }),
};

export function languageLabel(code: LanguageCode): string {
  return languageOptions.find((option) => option.code === code)?.label ?? "English";
}

export function translate(
  language: LanguageCode | undefined,
  key: TranslationKey,
  values: Record<string, string | number> = {},
): string {
  const template = (translations[language ?? "en"] ?? en)[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values[name] ?? `{${name}}`),
  );
}