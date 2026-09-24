import {lazy, Suspense, useEffect} from 'react';
import {Navigate, Route, Routes} from 'react-router-dom';
import Layout from './components/Layout';
import {ToastContainer} from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import ActivationModal from './components/ActivationModal';
import {useApplyTheme} from './lib/useTheme';
import {useActivationStore} from './store/activationStore';
import {useAccountStore} from './store/accountStore';

// 页面懒加载：避免 Settings / Inspector 等重依赖（CloudSyncManager、react-syntax-highlighter）
// 进入首屏 bundle，减小首屏解析/执行体积，加快启动到可交互。
const Store = lazy(() => import('./pages/Store'));
const Detail = lazy(() => import('./pages/Detail'));
const SkillDetail = lazy(() => import('./pages/SkillDetail'));
const Library = lazy(() => import('./pages/Library'));
const Inspector = lazy(() => import('./pages/Inspector'));
const History = lazy(() => import('./pages/History'));
const Settings = lazy(() => import('./pages/Settings'));

function App() {
  // 根据主题（浅/暗/自动）在 <html> 切换 dark 类，自动模式随系统配色变化
  useApplyTheme();

  // 初始化激活状态（全局单例 ticker：加载状态 + 每秒倒计时 / 到期降级）
  useEffect(() => {
    useActivationStore.getState().init();
  }, []);

  // 初始化账号会话：探测本地令牌是否已登录，命中则补拉 profile
  useEffect(() => {
    useAccountStore.getState().init();
  }, []);

  return (
    <>
      <Layout>
        <Suspense fallback={<div className="p-6 text-[var(--color-muted)]">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/store" replace />} />
            <Route path="/store" element={<ErrorBoundary><Store /></ErrorBoundary>} />
            {/* MCP Server 详情 */}
            <Route path="/detail/:source/:id" element={<Detail />} />
            {/* Skill 详情 */}
            <Route path="/skill/:id" element={<SkillDetail />} />
            {/* 兼容旧的 URL 格式 */}
            <Route path="/detail/:id" element={<Navigate to="/store" replace />} />
            {/* Library (原 Installed) */}
            <Route path="/library" element={<Library />} />
            <Route path="/installed" element={<Navigate to="/library" replace />} />
            <Route path="/inspector" element={<Inspector />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Suspense>
      </Layout>
      <ToastContainer />
      {/* 激活管理弹窗：全局单例，状态由 activationStore 驱动（徽标位于 Layout 左上角） */}
      <ActivationModal />
    </>
  );
}

export default App;