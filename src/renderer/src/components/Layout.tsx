/**
 * 应用布局组件 - Surge 风格
 * 支持左侧菜单宽度可拖拽调整
 */

import {ReactNode, useCallback, useEffect, useRef, useState} from 'react';
import {NavLink, useLocation} from 'react-router-dom';
import {useTranslation} from 'react-i18next';
import {useElectronAPI} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import {HistoryNavIcon, InspectorNavIcon, InstalledNavIcon, SettingsNavIcon, StoreNavIcon,} from './Icons';
import SyncTasksPanel from './SyncTasksPanel';
import ActivationBadge from './ActivationBadge';
import AdSlot from './ads/AdSlot';

interface LayoutProps {
    children: ReactNode;
}

// 侧边栏宽度限制
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 280;
const DEFAULT_SIDEBAR_WIDTH = 200;

export default function Layout({children}: LayoutProps) {
    const {t} = useTranslation();
    const location = useLocation();
    const api = useElectronAPI();
    const isMac = useIsMac();
    const [version, setVersion] = useState('');

    // 侧边栏宽度状态
    const [sidebarWidth, setSidebarWidth] = useState(() => {
        const saved = localStorage.getItem('sidebarWidth');
        return saved ? Math.min(Math.max(parseInt(saved, 10), MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH) : DEFAULT_SIDEBAR_WIDTH;
    });
    const [isResizing, setIsResizing] = useState(false);
    const sidebarRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        api.system.getVersion().then(setVersion);
    }, []);

    // 保存侧边栏宽度
    useEffect(() => {
        localStorage.setItem('sidebarWidth', String(sidebarWidth));
    }, [sidebarWidth]);

    // 处理拖拽
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
    }, []);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing) return;
            const newWidth = Math.min(Math.max(e.clientX, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH);
            setSidebarWidth(newWidth);
        };

        const handleMouseUp = () => {
            setIsResizing(false);
        };

        if (isResizing) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [isResizing]);

    // 详情页（/detail/*、/skill/*）本身不是导航项，需归属到某个侧边栏条目上高亮。
    // 默认归「商店」；但从我的库点进来的手动安装 Skill 例外——它在商店里根本不存在，
    // 详情页面包屑也写着「我的库」，侧边栏必须与之一致（由 from=library 标记）。
    const detailOwnerPath =
        location.pathname.startsWith('/detail') || location.pathname.startsWith('/skill')
            ? new URLSearchParams(location.search).get('from') === 'library'
                ? '/library'
                : '/store'
            : null;

    // 分组导航
    const navGroups = [
        {
            label: t('nav.discover') || 'DISCOVER',
            items: [
                {path: '/store', icon: StoreNavIcon, label: t('nav.store')},
            ],
        },
        {
            label: t('nav.manage') || 'MANAGE',
            items: [
                {path: '/library', icon: InstalledNavIcon, label: t('nav.library') || 'Library'},
                {path: '/inspector', icon: InspectorNavIcon, label: t('nav.inspector') || 'Inspector'},
            ],
        },
        {
            label: t('nav.system') || 'SYSTEM',
            items: [
                {path: '/history', icon: HistoryNavIcon, label: t('nav.history')},
                {path: '/settings', icon: SettingsNavIcon, label: t('nav.settings')},
            ],
        },
    ];

    return (
        <div className="flex h-screen bg-content-bg text-[var(--color-text)] overflow-hidden">
            {/* 侧边栏 */}
            <aside
                ref={sidebarRef}
                style={{width: sidebarWidth}}
                className="flex-shrink-0 bg-content-card flex flex-col border-e border-content-border relative"
            >
                {/* 顶部条：窗口拖拽区。mac 上为交通灯预留左侧空间，避免压住红绿灯；Windows 直接贴左。 */}
                <div className={`h-[38px] drag-region flex-shrink-0 ${isMac ? 'ps-20' : 'ps-3'}`} />

                {/* 广告位：免费版1 且未激活时渲染（激活即消失）；渠道未开通/未填充时收 0 高，不影响主功能 */}
                <div className="no-drag">
                    <AdSlot size="160x600" />
                </div>

                {/* 导航菜单：设为拖拽区，空白处可拖动窗口；导航项加 no-drag 保持可点击 */}
                <nav className="flex-1 py-2 overflow-y-auto drag-region">
                    {navGroups.map((group, groupIndex) => (
                        <div key={group.label} className={groupIndex > 0 ? 'mt-4' : ''}>
                            <div
                                className="px-4 py-1 text-[12px] font-semibold text-muted uppercase tracking-wider truncate">
                                {group.label}
                            </div>
                            {group.items.map((item) => {
                                const Icon = item.icon;
                                const isActive = location.pathname === item.path ||
                                    item.path === detailOwnerPath ||
                                    (item.path === '/library' && location.pathname === '/installed');

                                return (
                                    <NavLink
                                        key={item.path}
                                        to={item.path}
                                        className={`
                      flex items-center gap-3 mx-2 px-3 py-[7px] rounded-md text-[13px] no-drag
                      transition-colors duration-100
                      ${isActive
                                            ? 'bg-content-border text-[var(--color-text)] font-medium'
                                            : 'text-muted2 hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]'
                                        }
                    `}
                                    >
                                        <Icon active={isActive}/>
                                        <span className="truncate">{item.label}</span>
                                    </NavLink>
                                );
                            })}
                        </div>
                    ))}
                </nav>

                {/* 同步任务面板：左侧菜单栏、设置按钮下方，展示后台异步云同步队列 */}
                <SyncTasksPanel />

                {/* 底部状态：左侧版本号，右侧授权状态标识（点开激活管理弹窗） */}
                <div className="p-3 border-t border-content-border">
                    <div className="flex items-center justify-between text-[12px]">
                        <span className="text-muted2">{version ? `v${version}` : ''}</span>
                        <ActivationBadge />
                    </div>
                </div>

                {/* 拖拽调整宽度的手柄 */}
                <div
                    onMouseDown={handleMouseDown}
                    className={`
            absolute top-0 end-0 w-1 h-full cursor-col-resize
            hover:bg-[var(--color-accent)]/50 transition-colors
            ${isResizing ? 'bg-[var(--color-accent)]' : ''}
          `}
                />
            </aside>

            {/* 主内容区域 */}
            <main className="flex-1 flex flex-col overflow-hidden min-w-0">
                {/* 内容区域（标题栏由各页面头部自绘，含拖拽区，避免窗口与内容间多余空白）
                    改为 flex 列容器并加 min-h-0：让子页面用 flex-1 拿到「由 flex 推导的确定高度」，
                    而非依赖 height:100% 去解析一个「由 flex 推导」的祖先高度——
                    后者在懒加载冷挂载首帧会被 Chromium 解析为不确定高度，导致内容区高度算错、
                    中间栏错位（表现为连接后排版错乱，切菜单重挂载反而正常）。 */}
                <div className="flex-1 overflow-hidden flex flex-col min-h-0">
                    {children}
                </div>
            </main>
        </div>
    );
}
