/**
 * 客户端多选列表（P2-5）
 *
 * 原在 Library / AddServerModal / CreateSkillModal / Detail / PlatformServerDetail /
 * SkillDetail 等 9 处重复实现「ClientIcon + 名称 + 勾选态 + toggle」的按钮列表，
 * 样式类名逐字重复。现抽成 ClientMultiSelect：结构（图标/名称/勾选/点击）统一，
 * 各站点的配色与布局差异通过 props 原样透传，保证视觉零变化。
 */
import type {ClientInfo} from '../lib/electron';
import ClientIcon from './ClientIcon';

type Variant = 'sync' | 'uninstall' | 'install';

interface ClientMultiSelectProps {
    /** 已过滤、待渲染的客户端列表 */
    clients: ClientInfo[];
    /** 当前勾选的客户端 id 集合 */
    selected: string[];
    /** 点击切换某客户端勾选态 */
    onToggle: (id: string) => void;
    /** 容器布局类（grid / space-y 等），由调用方按原样传入 */
    className?: string;
    /** 图标尺寸，默认 24 */
    iconSize?: number;
    /** 勾选框样式：check=对勾 svg；square=方形勾选框（CreateSkillModal 用） */
    check?: 'check' | 'square';
    /** 勾选 svg 额外类（如 ms-auto / 尺寸 / 颜色），默认 w-5 h-5 */
    checkClassName?: string;
    /** 配色变体，决定默认 base/选中/未选/禁用 类 */
    variant?: Variant;
    /** 以下允许逐站点覆盖配色，保留原样 */
    baseClass?: string;
    selectedClass?: string;
    unselectedClass?: string;
    disabledClass?: string;
    /** install 变体：已安装的客户端 id（绿色 + 禁用 + 显示副标签） */
    disabledIds?: string[];
    /** install 变体副标签文案 */
    sublabel?: { installed: string; available: string };
    /** 勾选框前置（CreateSkillModal 用：方 checkbox 在图标之前） */
    leadingCheck?: boolean;
    /** 副标签与名称堆叠为两行（Detail/PlatformServerDetail/SkillDetail 用） */
    stackedSublabel?: boolean;
    /** 图标外层包裹样式（如圆角芯片背景），用于美化选项框 */
    iconWrapperClass?: string;
    /** 未选中时也显示空心圆勾选框（默认仅选中态显示对勾） */
    showEmptyCheck?: boolean;
    /** showEmptyCheck 选中态圆形徽标的背景/文字类（默认强调色），用于按变体换色 */
    checkBadgeClass?: string;
}

const VARIANT_CLASSES: Record<Variant, { base: string; selected: string; unselected: string; disabled: string }> = {
    sync: {
        base: 'flex items-center gap-3 p-3 rounded-md border transition-all text-start',
        selected: 'bg-[var(--color-accent)]/10 border-[var(--color-accent)]/30 text-[var(--color-accent)]',
        unselected: 'bg-[var(--color-surface-hover)] border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-muted)]',
        disabled: 'bg-[#34c759]/10 border-[#34c759]/30 text-[#34c759]',
    },
    uninstall: {
        base: 'flex items-center gap-3 p-3 rounded-md border transition-all text-start',
        selected: 'bg-[#ff3b30]/10 border-[#ff3b30]/30 text-[#ff3b30]',
        unselected: 'bg-[var(--color-surface-hover)] border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-muted)]',
        disabled: 'bg-[#34c759]/10 border-[#34c759]/30 text-[#34c759]',
    },
    install: {
        base: 'flex items-center gap-2 p-3 rounded-md border text-start transition-colors',
        selected: 'bg-[var(--color-accent)]/10 border-[var(--color-accent)]/30 text-[var(--color-accent)]',
        unselected: 'bg-[var(--color-surface-hover)] border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-muted)]',
        disabled: 'bg-[#34c759]/10 border-[#34c759]/30 text-[#34c759]',
    },
};

function CheckSvg({className}: { className?: string }) {
    return (
        <svg className={className ?? 'w-5 h-5'} fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"/>
        </svg>
    );
}

export default function ClientMultiSelect({
    clients,
    selected,
    onToggle,
    className,
    iconSize = 24,
    check = 'check',
    checkClassName,
    variant = 'sync',
    baseClass,
    selectedClass,
    unselectedClass,
    disabledClass,
    disabledIds,
    sublabel,
    leadingCheck,
    stackedSublabel,
    iconWrapperClass,
    showEmptyCheck,
    checkBadgeClass,
}: ClientMultiSelectProps) {
    const v = VARIANT_CLASSES[variant];
    const base = baseClass ?? v.base;
    const sel = selectedClass ?? v.selected;
    const uns = unselectedClass ?? v.unselected;
    const dis = disabledClass ?? v.disabled;
    const isInstall = variant === 'install';

    const renderCheck = (isSel: boolean) =>
        check === 'square' ? (
            <span
                className={`w-3.5 h-3.5 rounded-[4px] flex items-center justify-center ${isSel ? 'bg-[var(--color-accent)]' : 'border border-[var(--color-border)]'}`}>
                {isSel && <CheckSvg className="w-3 h-3 text-white"/>}
            </span>
        ) : showEmptyCheck ? (
            isSel ? (
                <span className={`grid place-items-center w-5 h-5 rounded-full ${checkBadgeClass ?? 'bg-[var(--color-accent)] text-white'} shrink-0`}>
                    <CheckSvg className="w-3 h-3"/>
                </span>
            ) : (
                <span className="w-5 h-5 rounded-full border border-[var(--color-border)] shrink-0"/>
            )
        ) : (
            <CheckSvg className={checkClassName}/>
        );

    return (
        <div className={className}>
            {clients.map(c => {
                const isSel = selected.includes(c.id);
                const isDis = disabledIds?.includes(c.id) ?? false;
                const cls = isSel ? sel : (isDis ? dis : uns);
                const showCheck = isSel || (isDis && isInstall) || (!!showEmptyCheck && !isDis);
                return (
                    <button
                        key={c.id}
                        type="button"
                        onClick={() => onToggle(c.id)}
                        disabled={isDis}
                        className={`${base} ${cls}`}
                    >
                        {showCheck && leadingCheck && renderCheck(isSel)}
                        {iconWrapperClass ? (
                            <span className={iconWrapperClass}><ClientIcon clientId={c.id} size={iconSize}/></span>
                        ) : (
                            <ClientIcon clientId={c.id} size={iconSize}/>
                        )}
                        {stackedSublabel ? (
                            <div className="flex-1 min-w-0">
                                <div className="text-[12px] font-medium">{c.name}</div>
                                {sublabel && (
                                    <div className="text-[12px] opacity-60">
                                        {isDis ? sublabel.installed : sublabel.available}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <>
                                <span className="flex-1 text-[13px] font-medium truncate">{c.name}</span>
                                {sublabel && (
                                    <span className="text-[12px] opacity-80">
                                        {isDis ? sublabel.installed : sublabel.available}
                                    </span>
                                )}
                            </>
                        )}
                        {showCheck && !leadingCheck && renderCheck(isSel)}
                    </button>
                );
            })}
        </div>
    );
}
