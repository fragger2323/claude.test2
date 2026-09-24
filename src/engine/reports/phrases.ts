/**
 * Plain-language renderings of findings for client-facing text, per language.
 * Only findings with a phrase here are used in template outreach (so wording stays human
 * and accurate). {year}/{value} placeholders are filled from the finding.
 */
export type OutreachLang = 'en' | 'pl' | 'ru' | 'uk' | 'de';
export const OUTREACH_LANGS: OutreachLang[] = ['en', 'pl', 'ru', 'uk', 'de'];

type P = Record<OutreachLang, string>;

export const FINDING_PHRASES: Record<string, P> = {
  'mobile.no_viewport_meta': {
    en: 'on a phone the site shows the desktop layout zoomed out, so the text is tiny',
    pl: 'na telefonie strona wyświetla się w pomniejszonej wersji desktopowej, więc tekst jest bardzo mały',
    ru: 'на телефоне сайт открывается в уменьшенной десктопной версии, и текст очень мелкий',
    uk: 'на телефоні сайт відкривається у зменшеній десктопній версії, тож текст дуже дрібний',
    de: 'auf dem Smartphone wird die Desktop-Ansicht verkleinert angezeigt, der Text ist sehr klein',
  },
  'mobile.horizontal_overflow_mobile': {
    en: 'on a phone the page is wider than the screen and scrolls sideways',
    pl: 'na telefonie strona jest szersza niż ekran i przewija się na boki',
    ru: 'на телефоне страница шире экрана и прокручивается вбок',
    uk: 'на телефоні сторінка ширша за екран і прокручується вбік',
    de: 'auf dem Smartphone ist die Seite breiter als der Bildschirm und verrutscht seitlich',
  },
  'mobile.text_overlap': {
    en: 'on a phone some text overlaps other text',
    pl: 'na telefonie część tekstów na siebie nachodzi',
    ru: 'на телефоне часть текста накладывается друг на друга',
    uk: 'на телефоні частина тексту накладається одна на одну',
    de: 'auf dem Smartphone überlappen sich einige Texte',
  },
  'mobile.small_text': {
    en: 'text on mobile is very small',
    pl: 'tekst na telefonie jest bardzo mały',
    ru: 'текст на телефоне очень мелкий',
    uk: 'текст на телефоні дуже дрібний',
    de: 'der Text ist auf dem Smartphone sehr klein',
  },
  'ux.cta_below_fold_mobile': {
    en: 'on a phone the booking/contact button only appears after scrolling',
    pl: 'na telefonie przycisk kontaktu lub zapisu pojawia się dopiero po przewinięciu',
    ru: 'на телефоне кнопка записи или связи появляется только после прокрутки',
    uk: 'на телефоні кнопка запису чи зв’язку з’являється лише після прокручування',
    de: 'auf dem Smartphone erscheint der Termin- bzw. Kontakt-Button erst nach dem Scrollen',
  },
  'ux.cta_below_fold_desktop': {
    en: 'the main call-to-action is not visible on the first screen',
    pl: 'główny przycisk akcji nie jest widoczny na pierwszym ekranie',
    ru: 'основная кнопка действия не видна на первом экране',
    uk: 'основна кнопка дії не видна на першому екрані',
    de: 'der wichtigste Call-to-Action ist auf dem ersten Bildschirm nicht sichtbar',
  },
  'ux.no_cta': {
    en: 'there is no clear button inviting visitors to book or get in touch',
    pl: 'brakuje wyraźnego przycisku zachęcającego do zapisu lub kontaktu',
    ru: 'нет явной кнопки, приглашающей записаться или связаться',
    uk: 'немає чіткої кнопки, яка запрошує записатися чи зв’язатися',
    de: 'es fehlt ein klarer Button für Terminbuchung oder Kontakt',
  },
  'ux.no_click_to_call': {
    en: "the phone number can't be tapped to call on mobile",
    pl: 'numeru telefonu nie da się kliknąć, żeby zadzwonić z komórki',
    ru: 'на номер телефона нельзя нажать, чтобы позвонить с мобильного',
    uk: 'на номер телефону не можна натиснути, щоб зателефонувати з мобільного',
    de: 'die Telefonnummer lässt sich auf dem Smartphone nicht antippen',
  },
  'ux.contact_not_in_nav': {
    en: "contact details aren't reachable from the main menu",
    pl: 'dane kontaktowe nie są dostępne z głównego menu',
    ru: 'контакты недоступны из главного меню',
    uk: 'контакти недоступні з головного меню',
    de: 'die Kontaktdaten sind über das Hauptmenü nicht erreichbar',
  },
  'ux.no_contact_form': {
    en: 'there is no enquiry form',
    pl: 'brakuje formularza kontaktowego',
    ru: 'нет формы для заявки',
    uk: 'немає форми для заявки',
    de: 'es gibt kein Anfrageformular',
  },
  'ux.trust_signals_not_found': {
    en: "reviews or testimonials aren't shown on the pages I looked at",
    pl: 'na przejrzanych podstronach nie widać opinii klientów',
    ru: 'на просмотренных страницах не видно отзывов клиентов',
    uk: 'на переглянутих сторінках не видно відгуків клієнтів',
    de: 'auf den angesehenen Seiten sind keine Kundenbewertungen zu sehen',
  },
  'tech.broken_internal_links': {
    en: 'some internal links lead to error pages',
    pl: 'część linków na stronie prowadzi do stron z błędem',
    ru: 'часть внутренних ссылок ведёт на страницы с ошибкой',
    uk: 'частина внутрішніх посилань веде на сторінки з помилкою',
    de: 'einige interne Links führen auf Fehlerseiten',
  },
  'tech.js_errors': {
    en: 'some scripts on the page throw errors while loading',
    pl: 'część skryptów zgłasza błędy podczas ładowania strony',
    ru: 'часть скриптов выдаёт ошибки при загрузке страницы',
    uk: 'частина скриптів видає помилки під час завантаження сторінки',
    de: 'einige Skripte erzeugen beim Laden Fehler',
  },
  'tech.https_missing': {
    en: "the site doesn't open over HTTPS, so browsers mark it as not secure",
    pl: 'strona nie otwiera się przez HTTPS, więc przeglądarki oznaczają ją jako niezabezpieczoną',
    ru: 'сайт не открывается по HTTPS, и браузеры помечают его как небезопасный',
    uk: 'сайт не відкривається через HTTPS, і браузери позначають його як небезпечний',
    de: 'die Seite ist nicht per HTTPS erreichbar und wird im Browser als „nicht sicher“ markiert',
  },
  'perf.page_weight': {
    en: 'the homepage downloads several megabytes, which is slow on mobile data',
    pl: 'strona główna pobiera kilka megabajtów, co spowalnia ładowanie na telefonie',
    ru: 'главная страница весит несколько мегабайт, что замедляет загрузку на мобильном интернете',
    uk: 'головна сторінка важить кілька мегабайтів, що сповільнює завантаження на мобільному інтернеті',
    de: 'die Startseite lädt mehrere Megabyte, was mobil spürbar bremst',
  },
  'perf.large_images': {
    en: 'some images are much heavier than they need to be',
    pl: 'część zdjęć jest znacznie cięższa, niż potrzeba',
    ru: 'некоторые изображения гораздо тяжелее, чем нужно',
    uk: 'деякі зображення значно важчі, ніж потрібно',
    de: 'einige Bilder sind deutlich größer als nötig',
  },
  'perf.lcp_mobile': {
    en: 'the main content takes a while to appear on a phone',
    pl: 'główna treść pojawia się na telefonie z opóźnieniem',
    ru: 'основной контент на телефоне появляется с задержкой',
    uk: 'основний контент на телефоні з’являється із затримкою',
    de: 'der Hauptinhalt erscheint auf dem Smartphone mit Verzögerung',
  },
  'seo.meta_description_missing': {
    en: 'the homepage is missing a description for search results',
    pl: 'stronie głównej brakuje opisu dla wyników wyszukiwania',
    ru: 'у главной страницы нет описания для поисковой выдачи',
    uk: 'головна сторінка не має опису для пошукової видачі',
    de: 'der Startseite fehlt eine Beschreibung für Suchergebnisse',
  },
  'seo.h1_missing': {
    en: 'the homepage has no main heading',
    pl: 'strona główna nie ma głównego nagłówka',
    ru: 'у главной страницы нет основного заголовка',
    uk: 'головна сторінка не має основного заголовка',
    de: 'die Startseite hat keine Hauptüberschrift',
  },
  'visual.copyright_old': {
    en: 'the footer still shows © {year}',
    pl: 'w stopce wciąż widnieje © {year}',
    ru: 'в подвале сайта до сих пор указан © {year}',
    uk: 'у футері сайту досі вказано © {year}',
    de: 'im Footer steht noch © {year}',
  },
  'visual.legacy_markup': {
    en: 'the page is built with techniques from before mobile-friendly design',
    pl: 'strona jest zbudowana technikami sprzed ery stron dopasowanych do telefonów',
    ru: 'страница сделана по технологиям времён до адаптивного дизайна',
    uk: 'сторінку зроблено за технологіями часів до адаптивного дизайну',
    de: 'die Seite nutzt Techniken aus der Zeit vor responsivem Design',
  },
  'a11y.contrast': {
    en: 'some text has low contrast and is hard to read',
    pl: 'część tekstu ma niski kontrast i trudno ją przeczytać',
    ru: 'часть текста низкоконтрастная и плохо читается',
    uk: 'частина тексту має низький контраст і погано читається',
    de: 'manche Texte haben zu wenig Kontrast und sind schwer lesbar',
  },
  no_website: {
    en: "I couldn't find a website for {company} — only directory listings",
    pl: 'nie udało mi się znaleźć strony internetowej {company} — tylko wpisy w katalogach',
    ru: 'мне не удалось найти сайт {company} — только карточки в каталогах',
    uk: 'мені не вдалося знайти сайт {company} — лише картки в каталогах',
    de: 'ich konnte keine Website von {company} finden – nur Verzeichniseinträge',
  },
};

/** Map a finding code to its phrase key (handles suffixed codes like perf.lcp_mobile / ux.overlay_mobile). */
export function phraseKey(code: string): string | null {
  if (FINDING_PHRASES[code]) return code;
  if (code === 'mobile.horizontal_overflow_tablet') return null;
  if (code === 'perf.oversized_images') return 'perf.large_images';
  if (code.startsWith('seo.title')) return 'seo.meta_description_missing';
  return null;
}

export function renderPhrase(code: string, lang: OutreachLang, vars: Record<string, string> = {}): string | null {
  const key = phraseKey(code);
  if (!key) return null;
  let s = FINDING_PHRASES[key]![lang];
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s.includes('{') ? null : s;
}

export function langFor(input: string | null | undefined): OutreachLang {
  const l = (input ?? 'en').toLowerCase().slice(0, 2);
  return (OUTREACH_LANGS as string[]).includes(l) ? (l as OutreachLang) : 'en';
}
