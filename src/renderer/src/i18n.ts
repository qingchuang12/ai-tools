import type {Resource} from 'i18next';
import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
// 初始语言同步 import，确保首屏立刻有翻译可用（不闪烁）；其余语言在切换时惰性加载。
import en from './locales/en.json';
import zh from './locales/zh.json';

/**
 * 支持的语言清单。
 * 覆盖：G8 主要语种（英/法/德/意/日/俄，美英加同属英语、加拿大另含法语）+
 *       联合国六大官方语言（阿拉伯语/中文/英语/法语/俄语/西班牙语），去重后共 9 种。
 * label 一律用该语言的**母语写法**（语言切换器不翻译语言名，这是通用做法）。
 */
export const SUPPORTED_LANGUAGES: { code: string; label: string; english: string }[] = [
    { code: 'en', label: 'English', english: 'English' },
    { code: 'zh', label: '简体中文', english: 'Chinese (Simplified)' },
    { code: 'ar', label: 'العربية', english: 'Arabic' },
    { code: 'de', label: 'Deutsch', english: 'German' },
    { code: 'es', label: 'Español', english: 'Spanish' },
    { code: 'fr', label: 'Français', english: 'French' },
    { code: 'it', label: 'Italiano', english: 'Italian' },
    { code: 'ja', label: '日本語', english: 'Japanese' },
    { code: 'ru', label: 'Русский', english: 'Russian' },
];

const SUPPORTED_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);

/** 阿拉伯语等 RTL 语言需要翻转文档方向 */
function isRtl(lng: string): boolean {
    return lng === 'ar';
}

/** 同步 <html> 的 lang / dir，保证字体排版与屏幕阅读器行为正确 */
export function applyDocumentLanguage(lng: string): void {
    try {
        document.documentElement.lang = lng;
        document.documentElement.dir = isRtl(lng) ? 'rtl' : 'ltr';
    } catch {
        // 非浏览器环境（测试）忽略
    }
}

// 语言持久化策略：
// - 用户曾在设置中选择过语言（localStorage 存在 'language' 键且为受支持语言）→ 保持该选择；
// - 从未选择过（无 'language' 键）→ 首次启动跟随系统语言（navigator.language），
//   命中受支持语言则用它，否则回退 'en'。
const savedLanguage = localStorage.getItem('language');

/** 系统语言 → 受支持语言码（按前缀匹配，zh-CN/ja-JP/de-DE 等带区域码的写法都能命中） */
function detectSystemLanguage(): string {
    const raw = (navigator.language || '').toLowerCase();
    const base = raw.split('-')[0];
    return SUPPORTED_CODES.includes(base) ? base : 'en';
}

const initialLng =
    savedLanguage && SUPPORTED_CODES.includes(savedLanguage) ? savedLanguage : detectSystemLanguage();

const resources: Resource = {
    en: { translation: en },
    zh: { translation: zh },
};

i18n
    .use(initReactI18next)
    .init({
        resources,
        lng: initialLng,
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false,
        },
    });

applyDocumentLanguage(initialLng);

/** 各语言包的动态加载器（按需加载，避免首屏打包全部 locale） */
const LOCALE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
    en: () => import('./locales/en.json'),
    zh: () => import('./locales/zh.json'),
    ar: () => import('./locales/ar.json'),
    de: () => import('./locales/de.json'),
    es: () => import('./locales/es.json'),
    fr: () => import('./locales/fr.json'),
    it: () => import('./locales/it.json'),
    ja: () => import('./locales/ja.json'),
    ru: () => import('./locales/ru.json'),
};

/**
 * 切换语言时按需加载目标语言包（若尚未加载），避免初始就把全部 locale 打进首屏。
 * 传入不受支持的语言码时回退 'en'。
 * @returns 加载完成后的语言码
 */
export async function ensureLanguageLoaded(lang: string): Promise<string> {
    const lng = SUPPORTED_CODES.includes(lang) ? lang : 'en';
    if (!i18n.hasResourceBundle(lng, 'translation')) {
        const mod = await LOCALE_LOADERS[lng]();
        i18n.addResourceBundle(lng, 'translation', mod.default, true, true);
    }
    applyDocumentLanguage(lng);
    return lng;
}

export default i18n;
