import React from 'react';
import ReactDOM from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {HashRouter} from 'react-router-dom';
import App from './App';
import {ensureLanguageLoaded, INITIAL_LANGUAGE} from './i18n';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 分钟
      retry: 2,
    },
  },
});

/**
 * 首次渲染前先确保初始语言包就位。
 *
 * en/zh 已在 i18n.ts 中静态打包（零延迟）；其余语言是惰性 chunk，若等到渲染后再加载，
 * 非 en/zh 系统（ja/ru/de/it/es/fr/ar）首装会先渲染一轮英文再切到目标语言——既闪烁，
 * 又让 i18n.language 与实际渲染语言不一致。
 *
 * 加载失败时照常渲染：i18next 的 fallbackLng('en') 兜底，避免整屏白屏。
 */
async function bootstrap(): Promise<void> {
  try {
    await ensureLanguageLoaded(INITIAL_LANGUAGE);
  } catch (err) {
    console.error('[i18n] 初始语言包加载失败，回退默认语言', err);
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </HashRouter>
      </QueryClientProvider>
    </React.StrictMode>
  );
}

void bootstrap();
