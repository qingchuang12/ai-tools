import {useEffect, useState} from 'react';
import {useElectronAPI} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import {useTranslation} from 'react-i18next';

/**
 * 无边框窗口的自定义控制按钮（最小化 / 最大化·还原 / 关闭）。
 * macOS 使用原生交通灯，不渲染本组件。
 */
export default function WindowControls() {
    const api = useElectronAPI();
    const isMac = useIsMac();
    const {t} = useTranslation();
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
        if (isMac) return;
        let unsub: (() => void) | undefined;
        api.window.isMaximized().then(setIsMaximized).catch(() => {
        });
        unsub = api.window.onMaximizeChange((m) => setIsMaximized(m));
        return () => unsub?.();
    }, [api, isMac]);

    // macOS 由系统提供交通灯，不渲染自定义按钮
    if (isMac) return null;

    return (
        <div className="absolute end-0 top-0 h-full flex items-stretch no-drag">
            <button
                className="win-ctrl"
                onClick={() => api.window.minimize()}
                title={t('window.minimize')}
                aria-label={t('window.minimize')}
            >
                <svg viewBox="0 0 12 12">
                    <rect x="2" y="5.4" width="8" height="1.2" fill="currentColor"/>
                </svg>
            </button>
            <button
                className="win-ctrl"
                onClick={() => api.window.toggleMaximize()}
                title={isMaximized ? t('window.restore') : t('window.maximize')}
                aria-label={isMaximized ? t('window.restore') : t('window.maximize')}
            >
                {isMaximized ? (
                    <svg viewBox="0 0 12 12">
                        <rect x="3.4" y="2.2" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.1"/>
                        <path d="M2.2 4.6 V10.4 H8.1" fill="none" stroke="currentColor" strokeWidth="1.1"/>
                    </svg>
                ) : (
                    <svg viewBox="0 0 12 12">
                        <rect x="2.2" y="2.2" width="7.6" height="7.6" fill="none" stroke="currentColor" strokeWidth="1.2"/>
                    </svg>
                )}
            </button>
            <button
                className="win-ctrl win-ctrl-close"
                onClick={() => api.window.close()}
                title={t('window.close')}
                aria-label={t('window.close')}
            >
                <svg viewBox="0 0 12 12">
                    <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
            </button>
        </div>
    );
}
