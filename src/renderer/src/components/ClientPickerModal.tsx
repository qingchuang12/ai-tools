import type {ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import type {ClientInfo} from '../lib/electron';
import Modal from './Modal';
import ClientMultiSelect from './ClientMultiSelect';

type PickerVariant = 'sync' | 'uninstall';

interface ClientPickerModalProps {
    /** 是否打开 */
    open: boolean;
    /** 标题 */
    title: string;
    /** 副标题 / 说明文字 */
    subtitle?: ReactNode;
    /** 已过滤、待渲染的客户端列表 */
    clients: ClientInfo[];
    /** 当前勾选的客户端 id 集合 */
    selected: string[];
    /** 点击切换某客户端勾选态 */
    onToggle: (id: string) => void;
    /** 点击确认 */
    onConfirm: () => void;
    /** 点击关闭（取消 / 遮罩） */
    onClose: () => void;
    /** 确认按钮文案（支持「进行中」态） */
    confirmLabel: ReactNode;
    /** 确认按钮禁用 */
    confirmDisabled?: boolean;
    /** 取消按钮文案 */
    cancelLabel?: ReactNode;
    /** 配色变体：sync=强调色；uninstall=危险红 */
    variant?: PickerVariant;
    /** uninstall：被卸载目标名称，显示在列表上方 */
    displayName?: string;
    /** uninstall：全选回调 */
    onSelectAll?: () => void;
    /** uninstall：全选按钮文案 */
    selectAllLabel?: ReactNode;
}

/**
 * 统一的「选择客户端」弹窗（P2-2，样式在第五批美化 + 本迭代统一）。
 * - sync：原 Library 中三处「同步到客户端」弹窗（单服务器 / 服务器批量 / Skill 批量）。
 * - uninstall：原 UninstallModal「卸载客户端选择」弹窗。
 * 两者共享同一视觉语言（圆角面板 + 图标芯片 + 圆形勾选徽标 + 已选计数），
 * 仅配色与确认按钮语义随 variant 变化。
 */
export default function ClientPickerModal({
    open,
    title,
    subtitle,
    clients,
    selected,
    onToggle,
    onConfirm,
    onClose,
    confirmLabel,
    confirmDisabled,
    cancelLabel,
    variant = 'sync',
    displayName,
    onSelectAll,
    selectAllLabel,
}: ClientPickerModalProps) {
    const {t} = useTranslation();
    const isUninstall = variant === 'uninstall';

    const theme = isUninstall
        ? {
            ring: 'border-[#ff3b30]/50 bg-[#ff3b30]/10 text-[#ff3b30]',
            pill: 'bg-[#ff3b30]/10 text-[#ff3b30]',
            badge: 'bg-[#ff3b30] text-white',
            btn: 'btn btn-danger disabled:opacity-50',
        }
        : {
            ring: 'border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 text-[var(--color-accent)]',
            pill: 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]',
            badge: 'bg-[var(--color-accent)] text-white',
            btn: 'btn btn-primary disabled:opacity-50',
        };

    return (
        <Modal isOpen={open} onClose={onClose} title={title}>
            <div className="space-y-3">
                {subtitle != null && (
                    <p className="text-[12px] leading-relaxed text-[var(--color-muted2)]">{subtitle}</p>
                )}

                {isUninstall && displayName != null && (
                    <div className="flex items-center justify-between">
                        <span className="text-[13px] font-medium text-[var(--color-text)] truncate">{displayName}</span>
                        {onSelectAll && (
                            <button
                                onClick={onSelectAll}
                                className="text-[12px] text-[var(--color-accent)] hover:underline flex-shrink-0 ms-2"
                            >
                                {selectAllLabel ?? (t('installed.selectAll') || 'Select All')}
                            </button>
                        )}
                    </div>
                )}

                <div className="flex items-center justify-between px-1">
                    <span className="text-[12px] text-[var(--color-muted2)]">
                        {t('library.clientCount', {count: clients.length})}
                    </span>
                    <span className={`rounded-full ${theme.pill} px-2 py-0.5 text-[12px] font-medium`}>
                        {t('library.selectedCount', {count: selected.length})}
                    </span>
                </div>

                <ClientMultiSelect
                    clients={clients}
                    selected={selected}
                    onToggle={onToggle}
                    variant={variant}
                    showEmptyCheck
                    checkBadgeClass={theme.badge}
                    iconSize={20}
                    iconWrapperClass="grid place-items-center w-9 h-9 rounded-lg bg-[var(--color-surface-hover)]/70 shrink-0"
                    className="flex flex-col gap-2 max-h-[320px] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)]/30 p-2"
                    baseClass="flex items-center gap-3 w-full p-3 rounded-lg border text-start transition-all duration-150"
                    unselectedClass="border-transparent text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]/60 hover:border-[var(--color-border)]"
                    selectedClass={theme.ring}
                />

                <div className="flex justify-end gap-2 pt-1">
                    <button onClick={onClose} className="btn btn-secondary">
                        {cancelLabel ?? (t('common.cancel') || 'Cancel')}
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={confirmDisabled}
                        className={theme.btn}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
